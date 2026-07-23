// Repair the stale `adjacentMines` counts left on MINE cells in historical
// canonical boards.
//
// The invariant is "a mine carries no number, so its adjacentMines is ALWAYS
// 0" (see the Modifier system / adjacency notes in CLAUDE.md). Four copies of
// the adjacency counter used to exist and they disagreed on exactly that
// branch: the old `calculateAdjacency` SKIPPED mine cells, so a cell that
// `swapMines` promoted from safe to mine KEPT the count it held while safe.
// That stale value was serialized into the canonical. The producer was fixed
// on 2026-07-10 (one adjacency primitive, `countAdjacentMines`), so no board
// written since can carry it — this tool cleans up what was already stored.
//
// WHY THIS IS SAFE TO RUN ON PLAYED BOARDS. The frozen-board contract protects
// what the player sees and what the certifier proves. Neither reads a mine's
// own count: `recomputeDisplayedMines` writes no number onto a mine, and every
// feature that touches adjacency (`clueShares`, `nonZeroSafeCellCount`,
// `zeroClusterCount`) skips mine cells explicitly. Measured across all 15
// affected boards before writing this: zero displayed-number changes, identical
// certification verdicts, identical feature vectors, identical par — and
// setting every mine's count to 99 and recomputing still changes 0 displayed
// numbers. `--dry-run` re-proves all of that per board and is the DEFAULT.
//
// Signatures are not a concern: every affected board predates SIGNATURE_EPOCH
// (2026-07-06) and none carries a `sig`, which the script re-checks per board
// and REFUSES to touch a signed payload (repairing one would invalidate it —
// it would need re-signing with the Actions key instead).
//
// Usage (via GH Actions workflow_dispatch, FIREBASE_SERVICE_ACCOUNT set):
//   node scripts/repair-mine-adjacency.mjs [--apply] [--path dailyBoard|weeklyBoard]
//
// Default is a dry run over BOTH canonical paths. Service-account auth is
// required only for --apply (the canonical paths are write-once for clients).

import { createSign } from 'node:crypto';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { recomputeDisplayedMines } from '../src/logic/gimmicks.js';
import { computeDailyFeatures, predictPar } from '../src/logic/dailyFeatures.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${signer.sign(serviceAccount.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function dbGet(path) {
  const r = await fetch(`${DB_BASE}/${path}.json`);
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json();
}

/**
 * Which stored cells violate the mine-carries-no-number invariant.
 * @returns {number[]} flat indices into the payload's `cells` array
 */
export function staleMineCells(raw) {
  if (!raw || !Array.isArray(raw.cells)) return [];
  const bad = [];
  raw.cells.forEach((cell, i) => {
    if (cell && cell.isMine === true && typeof cell.adjacentMines === 'number' && cell.adjacentMines !== 0) {
      bad.push(i);
    }
  });
  return bad;
}

/**
 * Re-prove, for THIS board, that zeroing those counts is unobservable:
 * identical displayed numbers, identical certification, identical features,
 * identical par. Returns the per-board evidence so a dry run can print it and
 * an --apply run can refuse anything that does not come back clean.
 */
export function proveRepairInert(raw) {
  const snapshot = (repair) => {
    const d = deserializeBoard(raw);
    if (repair) for (const row of d.board) for (const c of row) if (c.isMine) c.adjacentMines = 0;
    const displayed = d.board.flat().map((c) => c.displayedMines);
    const fr = Math.floor(d.firstClick / d.cols), fc = d.firstClick % d.cols;
    const check = isBoardSolvable(d.board, d.rows, d.cols, fr, fc);
    cleanSolverArtifacts(d.board);
    const features = computeDailyFeatures({
      board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines,
      activeGimmicks: d.activeGimmicks, rngSeed: d.rngSeed || '',
    }, check);
    return { displayed, check, features, par: predictPar(features) };
  };
  const before = snapshot(false);
  const after = snapshot(true);
  const displayedDiffs = before.displayed.filter((v, i) => v !== after.displayed[i]).length;
  const featureDiffs = Object.keys(before.features)
    .filter((k) => JSON.stringify(before.features[k]) !== JSON.stringify(after.features[k]));
  const certSame = before.check.solvable === after.check.solvable
    && before.check.remainingUnknowns === after.check.remainingUnknowns
    && before.check.totalClicks === after.check.totalClicks
    && before.check.techniqueLevel === after.check.techniqueLevel;
  return {
    inert: displayedDiffs === 0 && certSame && featureDiffs.length === 0 && before.par === after.par,
    displayedDiffs, certSame, featureDiffs, par: before.par, parAfter: after.par,
  };
}

/** The repaired payload: every mine's adjacentMines forced to 0. */
export function repairPayload(raw) {
  const out = { ...raw, cells: raw.cells.map((c) => ({ ...c })) };
  for (const cell of out.cells) if (cell.isMine === true) cell.adjacentMines = 0;
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const pathArg = args.includes('--path') ? args[args.indexOf('--path') + 1] : null;
  const paths = pathArg ? [pathArg] : ['dailyBoard', 'weeklyBoard'];

  console.log(`repair-mine-adjacency ${apply ? '(APPLY)' : '(DRY RUN — pass --apply to write)'}`);

  let accessToken = null;
  if (apply) {
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!saJson) {
      console.error('FIREBASE_SERVICE_ACCOUNT env not set — cannot bypass the write-once rule');
      process.exit(1);
    }
    accessToken = await getAccessToken(JSON.parse(saJson));
  }

  let totalBoards = 0, totalCells = 0, refused = 0, written = 0;

  for (const path of paths) {
    const all = await dbGet(path);
    for (const key of Object.keys(all || {}).sort()) {
      const raw = all[key];
      const bad = staleMineCells(raw);
      if (bad.length === 0) continue;
      totalBoards++;
      totalCells += bad.length;

      // A signed payload cannot be edited without re-signing, and this tool
      // has no signing key. Every board the bug can have touched predates the
      // signature epoch, so a signed one here means something unexpected.
      if (typeof raw.sig === 'string') {
        console.log(`✗ ${path}/${key}: ${bad.length} stale cell(s) but the payload is SIGNED — refusing`);
        refused++;
        continue;
      }

      const proof = proveRepairInert(raw);
      const summary = `${bad.length} stale mine count(s) | displayedDiffs=${proof.displayedDiffs} `
        + `certSame=${proof.certSame} featureDiffs=${proof.featureDiffs.join(',') || 'none'} `
        + `par ${proof.par}`;
      if (!proof.inert) {
        console.log(`✗ ${path}/${key}: ${summary} — NOT INERT, refusing`);
        refused++;
        continue;
      }
      console.log(`${apply ? '→' : '·'} ${path}/${key}: ${summary}`);

      if (!apply) continue;
      const repaired = repairPayload(raw);
      const url = `${DB_BASE}/${path}/${key}.json?access_token=${encodeURIComponent(accessToken)}`;
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(repaired),
      });
      if (!r.ok) throw new Error(`PUT ${path}/${key} failed: ${r.status} ${await r.text()}`);
      written++;
    }
  }

  console.log(`\n${totalBoards} board(s) carry ${totalCells} stale mine count(s); `
    + `${refused} refused; ${apply ? `${written} repaired` : 'nothing written (dry run)'}`);
  if (refused > 0) process.exit(1);
}

// Guarded so the pure helpers above import cleanly under node --test.
if (process.argv[1] && process.argv[1].endsWith('repair-mine-adjacency.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
