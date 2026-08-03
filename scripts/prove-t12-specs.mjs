// Prove concrete Challenge-250 T12 candidate specs at the ruled summit
// (par-per-cell 3.60), one per shape, under the ruled constraints: certified
// no-guess generation on every probe seed, worst-case generation at or under
// the 2-second cap, fitted par inside the 8-minute ceiling, and median
// par-per-cell in the summit band. Run after any generator or equation
// change that could move the summit (the re-roll change is what made the
// Cubes and heavy-stack rows possible at all).
//
//   node scripts/prove-t12-specs.mjs
//
// Also demonstrates the 8-clue structural refusal (Christopher's mechanism,
// 2026-08-03): a safe cell ringed by eight mines is provable only through
// the global mine-counter endgame, which the certifier does not model, so a
// plain board containing an 8 can never certify. The demonstration builds
// one and shows the shipped solver refusing it, with a control board that
// certifies so the refusal is the 8, not the harness.

import { generateTilingBoard } from '../src/logic/tilingGenerator.js';
import { buildTiling } from '../src/logic/tilingGeometry.js';
import { computeDailyFeatures, predictPar } from '../src/logic/dailyFeatures.js';
import { generateBoard, createEmptyBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { recalcAllAdjacency } from '../src/logic/gimmicks.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

const T12 = 3.60;
const PPC_BAND = [3.35, 4.0];   // accepted summit band around 3.60
const GEN_CAP_MS = 2000;         // the ruled cap, as measured (no margin)
const PAR_CEILING = 480;         // the 8-minute ceiling
const K = 10;

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The seven candidates. Sizes/densities picked from the density sweep's
// measured rows; Cubes rides the re-roll generator on its stacked route;
// Paving is the constructed heavy-stack spec (gimmickLevel drives the
// intensity ramp — level 115 sits in the old ladder's deep end).
const CANDIDATES = [
  { label: 'Classic 11x11 d0.45 plain', rect: { rows: 11, cols: 11, mines: 54 } },
  { label: 'Honeycomb 110c d0.34 plain', tiling: { type: 'hex', M: 11, N: 10, mines: 37 } },
  { label: 'Octagons 98c d0.34 plain', tiling: { type: '4.8.8', M: 7, N: 8, mines: 33 } },
  { label: 'Petals 72c d0.34 plain', tiling: { type: 'floret', M: 3, N: 4, mines: 24 } },
  { label: 'Kites 36c d0.34 plain', tiling: { type: 'deltoidal', M: 2, N: 3, mines: 12 } },
  // 72c d0.36 stacked also lands the band (ppc 3.98) but one probe seed hit
  // 3.5s; the 60-cell route has 2x cap headroom at the same summit.
  { label: '3D Cubes 60c d0.38 stacked', tiling: { type: 'rhombille', M: 4, N: 5, mines: 23, gimmicks: ['locked', 'sonar', 'walls'] } },
  { label: 'Paving 112c d0.24 heavy-stack', tiling: { type: 'cairo', M: 8, N: 8, mines: 27, gimmicks: ['locked', 'sonar', 'walls'], gimmickLevel: 115 } },
];

let failures = 0;
console.log(`T12 = ${T12} s/cell; accept ppc in [${PPC_BAND[0]}, ${PPC_BAND[1]}], worst gen <= ${GEN_CAP_MS}ms, par <= ${PAR_CEILING}s\n`);
for (const cand of CANDIDATES) {
  const pars = [], ppcs = [], times = [];
  let ok = 0;
  for (let k = 0; k < K; k++) {
    const seed = `t12:${cand.label}:${k}`;
    const t0 = Date.now();
    let board, rows, cols, check, cells, gims = [];
    if (cand.rect) {
      ({ rows, cols } = cand.rect);
      cells = rows * cols;
      const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
      board = generateBoard(rows, cols, cand.rect.mines, fr, fc, createDailyRNG(seed));
      check = board ? isBoardSolvable(board, rows, cols, fr, fc) : null;
      if (board) cleanSolverArtifacts(board);
    } else {
      const t = cand.tiling;
      gims = t.gimmicks || [];
      cells = buildTiling(t.type, t.M, t.N).total;
      const res = generateTilingBoard({
        type: t.type, M: t.M, N: t.N, mines: t.mines, seed,
        gimmicks: gims, gimmickLevel: t.gimmickLevel || 1,
      });
      if (res) ({ board, rows, cols, check } = res);
    }
    const ms = Date.now() - t0;
    times.push(ms);
    const certified = check && check.solvable && check.remainingUnknowns === 0;
    if (!certified) continue;
    ok++;
    const mines = cand.rect ? cand.rect.mines : cand.tiling.mines;
    const f = computeDailyFeatures(
      { board, rows, cols, totalMines: mines, activeGimmicks: gims, rngSeed: seed }, check,
    );
    const par = predictPar(f);
    pars.push(par);
    ppcs.push(par / cells);
  }
  const worst = Math.max(...times);
  const medPpc = ppcs.length ? median(ppcs) : NaN;
  const medPar = pars.length ? median(pars) : NaN;
  const pass = ok === K && worst <= GEN_CAP_MS && medPar <= PAR_CEILING
    && medPpc >= PPC_BAND[0] && medPpc <= PPC_BAND[1];
  if (!pass) failures++;
  console.log(`${pass ? ' PASS' : ' FAIL'}  ${cand.label.padEnd(34)} ${ok}/${K} certified`
    + `  worst ${String(worst).padStart(5)}ms  par ${medPar.toFixed(0).padStart(4)}s  ppc ${medPpc.toFixed(2)}`);
}

// ── The 8-clue structural refusal ─────────────────────────────────────────
console.log('\n8-clue refusal demonstration (9x9, safe centre ringed by its board\'s only eight mines):');
{
  const board = createEmptyBoard(9, 9);
  for (const [r, c] of [[3, 3], [3, 4], [3, 5], [4, 3], [4, 5], [5, 3], [5, 4], [5, 5]]) {
    board[r][c].isMine = true;
  }
  recalcAllAdjacency(board);
  const check = isBoardSolvable(board, 9, 9, 0, 0);
  cleanSolverArtifacts(board);
  const refused = !(check.solvable && check.remainingUnknowns === 0);
  console.log(`  8-board: solvable=${check.solvable} remainingUnknowns=${check.remainingUnknowns}`
    + ` -> ${refused ? 'REFUSED (the 8-cell is unprovable without a global mine count)' : 'CERTIFIED (unexpected!)'}`);
  if (!refused || check.remainingUnknowns !== 1) failures++;

  // Control: the same ring minus one mine. The freed neighbor reveals a clue
  // ADJACENT to the centre, so constraints can finally name it — the refusal
  // above is the 8, not the harness.
  const ctrl = createEmptyBoard(9, 9);
  for (const [r, c] of [[3, 3], [3, 4], [3, 5], [4, 3], [4, 5], [5, 3], [5, 4]]) {
    ctrl[r][c].isMine = true;
  }
  recalcAllAdjacency(ctrl);
  const cCheck = isBoardSolvable(ctrl, 9, 9, 0, 0);
  cleanSolverArtifacts(ctrl);
  const certified = cCheck.solvable && cCheck.remainingUnknowns === 0;
  console.log(`  7-ring control: solvable=${cCheck.solvable} remainingUnknowns=${cCheck.remainingUnknowns}`
    + ` -> ${certified ? 'CERTIFIED (control passes)' : 'REFUSED (control failed — investigate)'}`);
  if (!certified) failures++;
}

if (failures) { console.error(`\n*** ${failures} PROOF(S) FAILED ***`); process.exit(1); }
console.log('\nEvery T12 candidate proves out, and the 8-refusal demonstration holds.');
