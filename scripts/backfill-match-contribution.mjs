// Measure the gimmick-contribution features for every board already in the
// match library, IN PLACE.
//
// Match rows reach the refit as `match_<hash>` fit rows carrying whatever
// feature vector the library stored at generation, and the library's builder
// never asked for the contribution keys, so 0 of the first 48 played match
// boards carried one (measured 2026-08-14). The contribution study could
// therefore never see a Challenge board, however many were played. The builder
// now takes `{ contribution: true }` for new boards; this pass covers the
// ~2,759 that already exist.
//
// NOTHING MOVES. A board keeps its page and its index, because `page:idx` is
// the seen-cycle key on every player's device, and re-generating the library to
// pick up a feature would hand every device a different board at every address.
// Same discipline as reprice-match-library.mjs: pages rewrite their numbers in
// place and the index is rebuilt from the pages just written.
//
// The strip-solve reads the board's OWN stored opener, the same anchor its
// certificate and its par features use, so the measurement means the same
// thing it means on a daily. A board whose payload will not deserialize, or
// whose opener sits on a mine, is COUNTED AND SKIPPED rather than measured from
// somewhere else: a contribution feature computed from a different opener is a
// different quantity, and one silently mixed into the study is worse than a
// board the study never saw.
//
// Idempotent and resumable: a board that already carries the keys is left
// alone unless --force. Solving is the whole cost, so re-running after an
// interrupt is cheap.
//
// --FIT-ROWS RECOVERS THE ROWS ALREADY PLAYED. The pass above fixes the library
// and therefore every match from now on, but it cannot reach the 51 boards
// people had already played by 2026-08-14: those submitted their dailyMeta
// before the builder measured anything, and dailyMeta is WRITE-ONCE, so no
// client will ever add the keys to them. They are recoverable anyway, because
// a match row's key is a deterministic hash of its board's seed (matchRowKey),
// so a played row maps back to the exact library board it came from. This mode
// emits those vectors into the same committed backfill file the study already
// coalesces over for historical dailies, which is the mechanism that exists for
// precisely this case. Reads Firebase to learn WHICH rows were played;
// everything it writes comes from the local library.
//
// Usage:
//   node scripts/backfill-match-contribution.mjs [--dry-run] [--limit N] [--force]
//   node scripts/backfill-match-contribution.mjs --fit-rows [--dry-run]

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { computeContributionFeatures, CONTRIBUTION_FEATURE_KEYS } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { matchRowKey } from '../src/logic/matchCodes.js';
import { OUT_DIR, writeMatchIndexFiles, matchPageNames } from './match-index-files.mjs';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const CONTRIB_BACKFILL = new URL('./data/gimmick-contribution.json', import.meta.url);
// The two locked counts ride the ordinary feature vector rather than the
// strip-solve, but the R study reads all twelve from one frame, so a backfill
// row that carried only the measured ten would leave the join half-empty.
const BACKFILL_KEYS = [...CONTRIBUTION_FEATURE_KEYS, 'lockedMineCount', 'lockedNumberCount'];

function hasContribution(features) {
  return !!features && CONTRIBUTION_FEATURE_KEYS.some((k) => features[k] !== undefined);
}

/**
 * Measure one stored board, or say why it could not be measured. Pure enough to
 * test: everything it needs arrives in the record.
 *
 * @param {object} rec  a library board record ({ payload, features, ... })
 * @returns {{ok: true, contribution: object} | {ok: false, reason: string}}
 */
export function measureStoredBoard(rec) {
  if (!rec || !rec.payload) return { ok: false, reason: 'no payload' };
  let d;
  try {
    d = deserializeBoard(rec.payload);
  } catch (err) {
    return { ok: false, reason: `payload will not deserialize (${err.message})` };
  }
  const { board, rows, cols, activeGimmicks, firstClick } = d;
  const fr = Math.floor(firstClick / cols);
  const fc = firstClick % cols;
  const opener = board[fr] && board[fr][fc];
  if (!opener) return { ok: false, reason: 'opener outside the board' };
  // The certifier's own precondition. An opener on a mine means the stored
  // board and its stored opener disagree, which is a different bug; this pass
  // must not paper over it by measuring from somewhere else.
  if (opener.isMine) return { ok: false, reason: 'stored opener is a mine' };
  try {
    const contribution = computeContributionFeatures(board, rows, cols, fr, fc, activeGimmicks);
    // The solver leaks isRevealed onto cells; the board is discarded here, but
    // the habit is the one every other caller keeps.
    cleanSolverArtifacts(board);
    return { ok: true, contribution };
  } catch (err) {
    return { ok: false, reason: `strip-solve failed (${err.message})` };
  }
}

/** Every library board keyed by the fit-row key its plays submit under. */
function libraryByRowKey() {
  const byKey = new Map();
  for (const name of matchPageNames()) {
    const page = JSON.parse(readFileSync(new URL(name, OUT_DIR), 'utf8'));
    for (const rec of page.boards) {
      if (rec && rec.seed) byKey.set(matchRowKey(rec.seed), rec);
    }
  }
  return byKey;
}

async function mainFitRows() {
  const dry = process.argv.includes('--dry-run');
  const byKey = libraryByRowKey();

  const res = await fetch(`${DB_BASE}/dailyMeta.json`);
  if (!res.ok) throw new Error(`GET dailyMeta -> ${res.status}`);
  const meta = (await res.json()) || {};
  const played = Object.entries(meta).filter(([k]) => k.startsWith('match_'));

  const file = JSON.parse(readFileSync(CONTRIB_BACKFILL, 'utf8'));
  const existing = new Set(file.rows.map((r) => r.date));

  let alreadyMeta = 0;
  let alreadyFile = 0;
  let unmatched = 0;
  const added = [];
  for (const [key, row] of played) {
    // A row whose own meta carries the keys needs nothing: the study prefers
    // the meta copy, so a backfill entry beside it would be dead weight.
    if (BACKFILL_KEYS.some((k) => (row.features || {})[k] !== undefined
      && CONTRIBUTION_FEATURE_KEYS.includes(k))) { alreadyMeta++; continue; }
    if (existing.has(key)) { alreadyFile++; continue; }
    const rec = byKey.get(key);
    // A key with no board is NOT invented a vector. It means the library no
    // longer holds the board that row was played on, and a fabricated zero
    // would read to the study as "this modifier contributed nothing".
    if (!rec || !rec.features) { unmatched++; continue; }
    const out = { date: key, gimmicks: (rec.spec && rec.spec.gimmicks ? rec.spec.gimmicks : []).slice() };
    for (const k of BACKFILL_KEYS) out[k] = Number(rec.features[k]) || 0;
    added.push(out);
  }

  if (added.length && !dry) {
    file.rows = [...file.rows, ...added];
    file.generatedAt = new Date().toISOString();
    // ONE-space indent, matching what the daily backfill wrote. Re-indenting
    // rewrites all 2,370 existing lines and buries 51 real additions in a diff
    // nobody can review.
    writeFileSync(CONTRIB_BACKFILL, `${JSON.stringify(file, null, 1)}\n`);
  }
  console.log(`backfill-match-contribution --fit-rows: ${played.length} played match row(s);`
    + ` ${added.length} recovered, ${alreadyMeta} already carried keys in their own meta,`
    + ` ${alreadyFile} already in the backfill, ${unmatched} unmatched to a library board`
    + ` (file now ${file.rows.length + (dry ? added.length : 0)} rows)`
    + (dry ? ' (dry run: nothing written)' : ''));
  if (unmatched) {
    console.log('  unmatched rows are LEFT OUT, never zero-filled: no board, no measurement.');
  }
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
  if (!Number.isFinite(limit) && limitArg > -1) {
    console.error('backfill-match-contribution: --limit needs a number');
    process.exit(1);
  }

  const pageNames = matchPageNames();
  if (pageNames.length === 0) {
    console.error('backfill-match-contribution: no pages found, nothing to do');
    process.exit(1);
  }

  let boards = 0;
  let already = 0;
  let measured = 0;
  const skipped = new Map();
  const t0 = Date.now();

  const loaded = pageNames.map((name) => {
    const url = new URL(name, OUT_DIR);
    const page = JSON.parse(readFileSync(url, 'utf8'));
    let touched = false;
    for (const rec of page.boards) {
      boards++;
      if (measured >= limit) continue;
      if (!force && hasContribution(rec.features)) { already++; continue; }
      const res = measureStoredBoard(rec);
      if (!res.ok) {
        skipped.set(res.reason, (skipped.get(res.reason) || 0) + 1);
        continue;
      }
      rec.features = { ...(rec.features || {}), ...res.contribution };
      measured++;
      touched = true;
    }
    if (touched && !dry) writeFileSync(url, JSON.stringify(page));
    return page;
  });

  // Rebuilt from the pages just written, because every index row encodes its
  // feature vector POSITIONALLY against a header derived from the boards: new
  // keys mean a new header, and a row left over from the old one would decode
  // into the wrong features entirely.
  const written = writeMatchIndexFiles(loaded.map((p) => p.boards), modelFingerprint(), { dry });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`backfill-match-contribution: ${boards} boards over ${pageNames.length} pages`
    + ` in ${Object.keys(written.shards).length} shards, ${written.corners} corners;`
    + ` ${measured} measured, ${already} already carried keys, ${secs}s`
    + (dry ? ' (dry run: nothing written)' : ''));
  for (const [reason, n] of [...skipped].sort((a, b) => b[1] - a[1])) {
    console.log(`  skipped ${n}: ${reason}`);
  }
}

// Guarded the way the other sweeps are, so the test can import
// measureStoredBoard without the pass running.
const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
  if (process.argv.includes('--fit-rows')) {
    mainFitRows().catch((err) => {
      console.error('backfill-match-contribution --fit-rows failed:', err.message);
      process.exit(1);
    });
  } else {
    main();
  }
}
