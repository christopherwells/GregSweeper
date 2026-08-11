// Re-price the Climb library under the model of the day, and RE-BIN.
//
//   node scripts/reprice-climb-library.mjs [--dry-run]
//
// His design (2026-08-11): when a refit moves the equations, boards are
// never tossed for having the wrong par; they move to the level whose
// window now holds them, and only the shortfall left after re-binning is
// for generation to cover. So this tool conserves boards absolutely: a
// board leaves a level only to enter another one, or to wait in
// reserve.json until a future model puts a bin under it again.
//
// The pricing follows the pool-features lesson: solving is expensive and
// model-independent, pricing is not. Every board carries (or gains, once)
// a stored feature vector, and after that first backfill a full-library
// reprice is seconds of predictPar calls, cheap enough for the nightly
// refit to run unattended. The backfill re-solves from the stored opener,
// which is also an integrity pass: a board that fails to re-certify would
// have failed the round-trip audit too, and the tool refuses to continue
// past one.
//
// Re-binning is STABILITY-FIRST: a board still inside its level's window
// stays put, so a quiet refit moves nothing. Movers are placed hardest
// board first (hard boards are the scarce resource), each into an eligible
// level (window holds its par, the introduction schedule and debut rules
// allow its shape and stack, the face cap has room), preferring levels
// under their board minimum, then levels whose hard floor the board meets,
// then the nearest window center. What remains is the deficit manifest,
// written beside the library for the top-up tool and printed for the
// refit log.
//
// The ENDLESS bins (2026-08-11) join the same night under their own, single
// window bound: a board belongs to them exactly while its par sits at or
// above the 400s floor. Boards flow BOTH ways: an endless board a refit
// prices under 400s tries the ladder levels like any mover, and a ladder
// board that outgrew every window lands in the endless pages instead of
// reserve. Ladder levels get first refusal on every mover because they
// carry minimums and windows; endless has neither.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import {
  parFloor, parWindowTop, hardFloor, minBoardsFor,
  intakeRules, boardAllowedAtLevel, PAR_FLOOR_SHAPE_RELIEF, OUT_DIR,
  ENDLESS_PAR_FLOOR, ENDLESS_FACE_CAP, ENDLESS_INDEX,
} from './build-climb-library.mjs';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { computeDailyFeatures, predictPar } from '../src/logic/dailyFeatures.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const DRY = process.argv.includes('--dry-run');
const RESERVE_URL = new URL('reserve.json', OUT_DIR);
const DEFICITS_URL = new URL('deficits.json', OUT_DIR);
const RELIEF = PAR_FLOOR_SHAPE_RELIEF;
const FACE_CAP = 2;

// ── Load everything ─────────────────────────────────────────────────────
const files = readdirSync(OUT_DIR).filter((f) => /^level-\d+\.json$/.test(f)).sort();
const levels = files.map((f) => {
  const j = JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8'));
  return {
    file: f, json: j, level: j.level,
    lo: parFloor(j.level) * RELIEF, hi: parWindowTop(j.level),
    hardMin: hardFloor(j.level), min: minBoardsFor(j.level),
    rules: intakeRules(j.level, j.intro),
  };
});
const reserve = existsSync(RESERVE_URL)
  ? JSON.parse(readFileSync(RESERVE_URL, 'utf8')).boards
  : [];

// The ENDLESS bins re-bin on the same night (2026-08-11). Their one window
// bound is the 400s par floor — there are no per-level windows past the
// crown, and each shape's ceiling is a BUILD-time admission rule, not a
// membership bound a refit can evict a board over. Tolerant of absence so
// the tool still runs on a checkout that predates the endless library.
const endlessPages = readdirSync(OUT_DIR)
  .filter((f) => /^endless-\d+\.json$/.test(f))
  .sort()
  .map((f) => ({ file: f, json: JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8')) }));
const hasEndless = endlessPages.length > 0;
const endlessBoardCount = () => endlessPages.reduce((a, p) => a + p.json.boards.length, 0);

const totalIn = levels.reduce((a, L) => a + L.json.boards.length, 0) + reserve.length
  + endlessBoardCount();
console.log(`${levels.length} level files + ${endlessPages.length} endless pages (${endlessBoardCount()} boards) + ${reserve.length} reserve = ${totalIn} boards`);

// ── Backfill features where absent, then re-price every board ───────────
let backfilled = 0;
const t0 = Date.now();
function ensureFeatures(b, where) {
  if (b.features) return;
  const d = deserializeBoard(b.payload);
  const fc = d.firstClick;
  const check = isBoardSolvable(d.board, d.rows, d.cols, Math.floor(fc / d.cols), fc % d.cols);
  if (!check.solvable || check.remainingUnknowns !== 0) {
    throw new Error(`${where}: stored board does not re-certify from its opener (seed ${b.seed})`);
  }
  b.features = computeDailyFeatures({
    board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines,
    activeGimmicks: d.activeGimmicks || [], rngSeed: b.payload.rngSeed || b.seed,
  }, check);
  backfilled++;
  if (backfilled % 100 === 0) {
    console.log(`  ...backfilled ${backfilled} feature vectors, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
for (const L of levels) for (const b of L.json.boards) ensureFeatures(b, `L${L.level}`);
for (const P of endlessPages) for (const b of P.json.boards) ensureFeatures(b, P.file);
for (const b of reserve) ensureFeatures(b, 'reserve');
if (backfilled) console.log(`backfilled ${backfilled} feature vectors in ${Math.round((Date.now() - t0) / 1000)}s`);

for (const L of levels) for (const b of L.json.boards) b.par = predictPar(b.features);
for (const P of endlessPages) for (const b of P.json.boards) b.par = predictPar(b.features);
for (const b of reserve) b.par = predictPar(b.features);

// ── Stability pass: in-window boards stay; the rest go homeless ─────────
const homeless = reserve.splice(0, reserve.length);
let movedOut = 0;
for (const L of levels) {
  const stay = [], leave = [];
  for (const b of L.json.boards) {
    (b.par >= L.lo && b.par <= L.hi ? stay : leave).push(b);
  }
  L.json.boards = stay;
  movedOut += leave.length;
  homeless.push(...leave);
}
let endlessOut = 0;
for (const P of endlessPages) {
  const stay = [], leave = [];
  for (const b of P.json.boards) {
    (b.par >= ENDLESS_PAR_FLOOR ? stay : leave).push(b);
  }
  P.json.boards = stay;
  endlessOut += leave.length;
  homeless.push(...leave);
}
console.log(`re-priced: ${movedOut} ladder boards left their window, ${endlessOut} endless boards fell under the ${ENDLESS_PAR_FLOOR}s floor, ${homeless.length - movedOut - endlessOut} were in reserve`);

// ── Placement: hardest first, neediest level first ──────────────────────
const faceCount = (L, face) => L.json.boards.filter((b) => b.face === face).length;
const endlessFaceCount = (face) => endlessPages.reduce(
  (a, P) => a + P.json.boards.filter((b) => b.face === face).length, 0);
homeless.sort((a, b) => b.hard - a.hard);
let placed = 0;
let placedEndless = 0;
const stillHomeless = [];
for (const b of homeless) {
  const eligible = levels.filter((L) => b.par >= L.lo && b.par <= L.hi
    && boardAllowedAtLevel(b, L.rules)
    && faceCount(L, b.face) < FACE_CAP);
  if (eligible.length) {
    eligible.sort((A, B) => {
      const defA = Math.max(0, A.min - A.json.boards.length);
      const defB = Math.max(0, B.min - B.json.boards.length);
      if (defA !== defB) return defB - defA;
      const hardA = b.hard >= A.hardMin ? 0 : 1;
      const hardB = b.hard >= B.hardMin ? 0 : 1;
      if (hardA !== hardB) return hardA - hardB;
      const cA = Math.abs(b.par - (A.lo + A.hi) / 2);
      const cB = Math.abs(b.par - (B.lo + B.hi) / 2);
      return cA - cB;
    });
    eligible[0].json.boards.push(b);
    placed++;
    continue;
  }
  // No ladder level takes it: the ENDLESS bins are the catch-all above
  // their floor (a 750s board that outgrew L250's window is exactly what
  // the zone wants). Ladder levels get first refusal because they carry
  // minimums and windows; endless has neither. Into the smallest page, so
  // page sizes stay even for the fetch.
  if (hasEndless && b.par >= ENDLESS_PAR_FLOOR && endlessFaceCount(b.face) < ENDLESS_FACE_CAP) {
    const smallest = endlessPages.reduce((m, P) => (P.json.boards.length < m.json.boards.length ? P : m));
    smallest.json.boards.push(b);
    placedEndless++;
    continue;
  }
  stillHomeless.push(b);
}
console.log(`re-binned ${placed} to ladder levels, ${placedEndless} to endless pages; ${stillHomeless.length} to reserve`);

// ── Conservation, vintage, write ─────────────────────────────────────────
const totalOut = levels.reduce((a, L) => a + L.json.boards.length, 0)
  + endlessBoardCount() + stillHomeless.length;
if (totalOut !== totalIn) {
  throw new Error(`board conservation violated: ${totalIn} in, ${totalOut} out`);
}
const fp = modelFingerprint();
const deficits = [];
for (const L of levels) {
  const have = L.json.boards.length;
  if (have < L.min) deficits.push({ level: L.level, have, need: L.min });
}

if (!DRY) {
  for (const L of levels) {
    L.json.parModel = fp;
    for (const b of L.json.boards) delete b.parModel; // one vintage story: the file's
    writeFileSync(new URL(L.file, OUT_DIR), JSON.stringify(L.json));
  }
  for (const P of endlessPages) {
    P.json.parModel = fp;
    for (const b of P.json.boards) delete b.parModel;
    writeFileSync(new URL(P.file, OUT_DIR), JSON.stringify(P.json));
  }
  if (hasEndless) {
    writeFileSync(ENDLESS_INDEX, JSON.stringify({
      parModel: fp,
      parFloor: ENDLESS_PAR_FLOOR,
      boards: endlessBoardCount(),
      pages: endlessPages.length,
      counts: endlessPages.map((P) => P.json.boards.length),
    }));
  }
  writeFileSync(RESERVE_URL, JSON.stringify({ parModel: fp, boards: stillHomeless }));
  writeFileSync(DEFICITS_URL, JSON.stringify({ parModel: fp, deficits }));
}

console.log(`${DRY ? '[dry-run] ' : ''}library re-priced under ${fp};`
  + `${hasEndless ? ` endless holds ${endlessBoardCount()};` : ''}`
  + ` ${deficits.length} levels under their minimum`
  + (deficits.length ? ` (worst: ${deficits.slice(0, 8).map((d) => `L${d.level} ${d.have}/${d.need}`).join(', ')}${deficits.length > 8 ? ', ...' : ''})` : ''));
if (deficits.length) {
  console.log('generation owed: node scripts/topup-climb-library.mjs --fill  (see deficits.json)');
}
