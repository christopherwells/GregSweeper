// The match library's standing contract, and its refit-drift alarm.
//
// The library stores ~900 pre-generated boards over the proven
// CHALLENGE_POOL specs (scripts/build-match-library.mjs); the config
// sheet's time bands filter on each board's STORED par, so the nightly
// refit must re-price the file (scripts/reprice-match-library.mjs) or the
// sheet quietly mislabels its bands. These tests hold the data to that
// contract under the model of the day, the climbLibrary pattern applied to
// the match bins:
//
//   - vintage lockstep: every file carries the CURRENT model fingerprint,
//     with the remedy named in the failure;
//   - price honesty: every board's stored par is exactly predictPar of its
//     own stored features;
//   - index honesty: the per-shape index shards reproduce the page files row
//     for row (the two are written by one function, matchIndexRow, and
//     this is the alarm if a partial rewrite ever splits them), and the
//     summary's corner counts answer a rule set with exactly the number the
//     deal's own row filter would, which is what makes the split safe;
//   - the deduction floor: no stored board is over on the opening click
//     (his immediately-done ruling; the pool's easiest corner certified at
//     work 1 when probed, which is why the build enforces the floor);
//   - stocked corners: the bands the sheet sells have real supply in every
//     shape where supply structurally exists (rhombille tops out near 130s
//     and deltoidal near 200s, so their 'long' cells are the pool's truth
//     and deliberately NOT pinned).

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { OUT_DIR } from '../scripts/build-match-library.mjs';
import {
  SUMMARY_FILE, LEGACY_INDEX_FILE, matchPageNames,
} from '../scripts/match-index-files.mjs';
import {
  parseMatchIndex, parseMatchSummary, countEligibleCorners, eligibleRows,
  matchIndexRow, matchIndexFeatureKeys, timeBandOf, MATCH_TIME_BANDS,
  matchShardFileForRow,
} from '../src/logic/matchRules.js';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { CLIMB_MIN_DEDUCTIONS } from '../src/logic/challenge250.js';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { recalcAllAdjacency, recomputeDisplayedMines } from '../src/logic/gimmicks.js';

const summary = JSON.parse(readFileSync(SUMMARY_FILE, 'utf8'));
const pageNames = matchPageNames(OUT_DIR);
const pages = pageNames.map((f) => JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8')));
const boards = pages.flatMap((p) => p.boards);
const SHAPES = ['rect', ...TILING_TYPES];
// ONE FILE PER CORNER since 2026-08-14, so the shard set is read off the
// directory rather than composed from SHAPES: the corner axis includes the
// modifier SET, and there is no list of those to iterate.
const shardNames = readdirSync(OUT_DIR).filter((f) => /^mx-.+\.json$/.test(f)).sort();
const shards = Object.fromEntries(shardNames
  .map((f) => [f, JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8'))]));
/** Every shard's rows, parsed and concatenated: what a deal over everything sees. */
const allRows = shardNames.flatMap((f) => parseMatchIndex(shards[f]) || []);

test('the match library is real, sharded, and its summary tells the truth', () => {
  assert.equal(pages.length, summary.pages, 'page files match the summary page count');
  assert.ok(boards.length >= 800, `${boards.length} boards is too few to be the real library`);
  assert.equal(boards.length, summary.boards);
  assert.deepEqual(summary.counts, pages.map((p) => p.boards.length));
  pages.forEach((p, i) => assert.equal(p.page, i, `page file ${i} numbers itself`));

  // ONE SHARD PER OCCUPIED CORNER, and every board in exactly one of them. A
  // corner whose file went missing would deal nothing while the summary went
  // on advertising it, which is this split's own failure mode.
  assert.equal(shardNames.length, summary.corners.length,
    'every occupied corner needs its own shard file, and no file may outlive its corner');
  assert.equal(allRows.length, boards.length, 'the shards together hold every board exactly once');
  // The summary's per-shape totals still have to add up, even though nothing
  // is stored per shape any more: the sheet's supply line reads them.
  const byShape = {};
  for (const r of allRows) byShape[r.shape] = (byShape[r.shape] || 0) + 1;
  assert.deepEqual(summary.shards, byShape);
  // A row must live in the file its own corner names. Anywhere else and the
  // deal, which asks for files BY corner, would never find it.
  for (const f of shardNames) {
    for (const r of parseMatchIndex(shards[f])) {
      assert.equal(matchShardFileForRow(r), f, `${r.page}#${r.idx} is in the wrong shard`);
    }
  }

  // The monolith is GONE, not merely unread. Leaving it would make the
  // nightly re-price keep a second copy of every row in step forever, which
  // is the payload the split exists to stop paying.
  assert.ok(!existsSync(LEGACY_INDEX_FILE),
    'match-index.json still exists; the split replaces it rather than adding to it');
});

test('the summary counts what the deal can actually reach', () => {
  // The split's load-bearing equality: the sheet renders a number from the
  // SUMMARY and the deal draws from the SHARDS, so a corner key that does not
  // reproduce boardMatchesRules' own decisions would advertise supply nobody
  // can be dealt. Swept over rule sets rather than spot-checked, because the
  // modifier test is a SUBSET test and the disagreements would live in the
  // combinations, not in the simple cases.
  const corners = parseMatchSummary(summary);
  assert.ok(corners && corners.length > 0, 'the shipped summary must parse');
  const MODS = ['walls', 'liar', 'mystery', 'locked', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];
  const TIMES = ['any', ...MATCH_TIME_BANDS.map((b) => b.key)];
  const DENSITIES = ['any', 'sparse', 'standard', 'dense'];
  let nonZero = 0;
  for (let t = 0; t < 240; t++) {
    // Deterministic sweep: a fixed bit pattern per trial, so a failure is
    // reproducible rather than a flake nobody can re-run.
    const rules = {
      shapes: SHAPES.filter((_, i) => (t >> i) & 1),
      mods: MODS.filter((_, i) => (t >> (i % 7)) & 1 || i % 3 === t % 3),
      time: TIMES[t % TIMES.length],
      density: DENSITIES[(t >> 2) % DENSITIES.length],
      count: 5,
    };
    if (!rules.shapes.length) continue;
    const filtered = eligibleRows(allRows, rules).length;
    assert.equal(countEligibleCorners(corners, rules), filtered,
      `the summary and the shards disagree on ${JSON.stringify(rules)}`);
    if (filtered > 0) nonZero++;
  }
  assert.ok(nonZero >= 100,
    `only ${nonZero} sweep rule sets found any supply — the sweep is not exercising the equality`);
});

test('LOCKSTEP: every file is priced under the model of the day', () => {
  const fp = modelFingerprint();
  const stale = [];
  if (summary.parModel !== fp) stale.push(`match-summary.json (${summary.parModel})`);
  for (const [shape, file] of Object.entries(shards)) {
    if (file.parModel !== fp) stale.push(`match-index-${shape}.json (${file.parModel})`);
  }
  pages.forEach((p, i) => {
    if (p.parModel !== fp) stale.push(`match-${String(i).padStart(3, '0')}.json (${p.parModel})`);
  });
  assert.deepEqual(stale, [],
    `these files were priced under an older model than the shipped ${fp}; `
    + 'run: node scripts/reprice-match-library.mjs');
});

test('every board prices from its own stored features', () => {
  for (const b of boards) {
    assert.ok(b.features, `${b.seed} stores its feature vector`);
    const par = Math.round(predictPar(b.features) * 10) / 10;
    assert.ok(Math.abs(par - b.par) < 0.06,
      `${b.seed}: stored par ${b.par} vs predictPar ${par}; run scripts/reprice-match-library.mjs`);
  }
});

test('the shard rows reproduce the page files row for row', () => {
  // The header is derived from the boards, so a feature key that reached the
  // pages and not the shards would show up here as a shorter union. It is
  // derived over EVERY board rather than per shard, so the positional
  // encoding means the same thing in all seven files.
  const keys = matchIndexFeatureKeys(boards);
  const expected = new Map();
  pages.forEach((p, pi) => p.boards.forEach((b, i) => {
    expected.set(`${pi}:${i}`, matchIndexRow(pi, i, b, keys));
  }));
  // Keyed by FILE now, not by shape: the corner axis includes the modifier
  // set, so the filename is the only handle. Placement is already proven
  // above, against each row's own corner; what this checks is that the row
  // BYTES and the header match the pages.
  for (const f of shardNames) {
    assert.deepEqual(shards[f].featureKeys, keys,
      `${f}'s shard header must match the boards it describes`);
    for (const row of shards[f].rows) {
      const want = expected.get(`${row[0]}:${row[1]}`);
      assert.ok(want, `shard row p${row[0]}#${row[1]} names a board no page holds`);
      assert.deepEqual(row, want);
      expected.delete(`${row[0]}:${row[1]}`);
    }
  }
  assert.deepEqual([...expected.keys()], [], 'these stored boards reached no shard');
  assert.ok(allRows.length === boards.length, 'the client parser accepts every shipped shard');
});

test('every shipped index row carries a usable feature vector', () => {
  // Mission steering scores on these numbers, and a vector that silently
  // arrived empty would steer nothing while every test above stayed green.
  const parsed = allRows;
  const need = ['cellCount', 'totalMines', 'density', 'clueShare3'];
  for (const r of parsed) {
    for (const k of need) {
      assert.ok(Number.isFinite(r.features[k]),
        `${r.key} has no ${k}: steering cannot score it`);
    }
    assert.ok(r.features.cellCount > 0, `${r.key} has cellCount ${r.features.cellCount}`);
  }
  // Non-vacuity: the modifier counts must actually vary, or "a real count
  // outranks a bare presence" is a claim about a column of ones.
  const compass = parsed.map((r) => r.features.compassCellCount || 0).filter((n) => n > 0);
  assert.ok(compass.length > 20, `only ${compass.length} boards carry compass cells`);
  assert.ok(new Set(compass).size > 1, 'compassCellCount never varies: the vector is degenerate');
});

test('REGRESSION: no stored board is over on the opening click (his immediately-done ruling)', () => {
  // The pool's easiest corner certified at work 1 when probed (a 25-cell
  // rect), so the build's floor is what stands between the sheet's Quick
  // band and one-click boards.
  for (const b of boards) {
    assert.ok(b.work >= CLIMB_MIN_DEDUCTIONS,
      `${b.seed}: ${b.work} decisions is under the ${CLIMB_MIN_DEDUCTIONS}-decision floor`);
  }
});

test('seeds are unique across the whole library', () => {
  const seen = new Set();
  for (const b of boards) {
    assert.ok(!seen.has(b.seed), `${b.seed} appears twice`);
    seen.add(b.seed);
  }
});

test('every payload deserializes and its mine count is honest', () => {
  for (const b of boards) {
    const d = deserializeBoard(b.payload);
    let mines = 0;
    for (const row of d.board) for (const cell of row) { if (cell.isMine) mines++; }
    assert.equal(mines, d.totalMines, `${b.seed}: payload mines vs totalMines`);
    assert.equal(mines, b.spec.mines, `${b.seed}: payload mines vs spec`);
    assert.ok(Number.isInteger(d.firstClick), `${b.seed}: stored opener`);
  }
});

test('a deterministic sample re-certifies from its stored opener', () => {
  // The full ground-truth audit + no-guess proof on all ~900 boards is the
  // runtime's job one board at a time (certifyStoredBoard at install); here
  // a fixed-stride sample proves the pipeline end to end without minutes of
  // CI. Stride chosen so every shape lands in the sample.
  const sample = boards.filter((_, i) => i % 90 === 0);
  assert.ok(sample.length >= 8, 'the sample must be real');
  for (const b of sample) {
    const d = deserializeBoard(b.payload);
    const stored = d.board.flat().map((c) => [c.adjacentMines, c.displayedMines]);
    recalcAllAdjacency(d.board);
    recomputeDisplayedMines(d.board);
    const flat = d.board.flat();
    for (let i = 0; i < flat.length; i++) {
      assert.deepEqual([flat[i].adjacentMines, flat[i].displayedMines], stored[i],
        `${b.seed}: stored numbers must describe the stored mines (cell ${i})`);
    }
    const fc = d.firstClick;
    const check = isBoardSolvable(d.board, d.rows, d.cols, Math.floor(fc / d.cols), fc % d.cols);
    assert.ok(check.solvable && check.remainingUnknowns === 0,
      `${b.seed}: stored board no longer certifies from its opener`);
  }
});

test('the bands the sheet sells are stocked', () => {
  const cnt = {};
  for (const b of boards) {
    const band = timeBandOf(b.par);
    cnt[band] = (cnt[band] || 0) + 1;
    cnt[`${b.spec.shape}|${band}`] = (cnt[`${b.spec.shape}|${band}`] || 0) + 1;
  }
  for (const band of MATCH_TIME_BANDS) {
    assert.ok((cnt[band.key] || 0) >= 100, `band ${band.key} holds ${cnt[band.key] || 0} boards`);
  }
  for (const shape of SHAPES) {
    for (const band of ['quick', 'short']) {
      assert.ok((cnt[`${shape}|${band}`] || 0) >= 10,
        `${shape} x ${band} holds ${cnt[`${shape}|${band}`] || 0} boards; the sheet sells this corner`);
    }
  }
});

// ── The nightly refit actually re-prices it ─────────────────────────────
//
// The lockstep test above reddens when the library is stale, which only
// helps if something re-prices it every night. Source-scanned in the
// poolReprice pattern: the workflow is the one place this is wired, and a
// rename or a dropped step is exactly the silent failure the alarm cannot
// distinguish from a human forgetting.

test('the nightly refit re-prices the match library and commits it', () => {
  const wf = readFileSync(new URL(
    '../.github/workflows/refit-par-model.yml', import.meta.url), 'utf8');
  assert.match(wf, /node scripts\/reprice-match-library\.mjs/,
    'the refit no longer re-prices the match library');
  assert.match(wf, /git add [^\n]*scripts\/data\/match-library/,
    'the refit re-prices the library but never commits it');
  // A price-only night would otherwise report "nothing to commit" and throw
  // the re-price away.
  assert.match(wf, /git diff --quiet [^\n]*scripts\/data\/match-library/,
    'a price-only change would be seen as nothing to commit');
  assert.ok(wf.indexOf('reprice-match-library') < wf.indexOf('Commit and push'),
    'the re-price runs after the commit step, so its result is never committed');
  // Allowed to fail without costing the night its model fit, then reported
  // with the remedy named (the pool re-price's own contract).
  assert.match(wf, /id: matchreprice\s+continue-on-error: true/,
    'a failed re-price would abort the workflow before the model is committed');
  assert.match(wf, /steps\.matchreprice\.outcome == 'failure'/,
    'nothing checks the re-price outcome, so a failure would pass silently');
});
