// ── Exhaustive validation of the soundness-gated classifier ──
// The claim to make checkable (Christopher, 2026-06-15): proper pattern
// identification — every NAME is sound, and we measure how complete the
// naming is. Method: drive a canonical solve over many small boards; at each
// step, for every cell the classifier NAMES a shape, confirm against an
// INDEPENDENT brute-force oracle (all mine layouts consistent with the
// revealed clues) that the cell really is safe/mine. The solver is never
// trusted as its own judge — the oracle is plain enumeration.
//
// Also reports: the name distribution, and the GATE's effect — how often the
// ungated geometry namer (classifyPattern) claims a shape the gate rejects
// (incidental geometry that doesn't actually force the square).
//
// Usage: node scripts/validate-proof-classify.mjs [rows] [cols] [trials]
import { makeBoard, recalcAdjacency } from '../test/helpers.mjs';
import { findDeducibleFrontier } from '../src/logic/boardSolver.js';
import { classifyByProof } from '../src/logic/proofClassify.js';
import { classifyPattern } from '../src/logic/patternNames.js';

const ROWS = +(process.argv[2] || 4);
const COLS = +(process.argv[3] || 5);
const TRIALS = +(process.argv[4] || 4000);

const SHAPES_ARR = ['1-2-2-1', '1-2-1', '1-3-1', '2-2-2', 'triangle', 'hole', '1-2', '1-1', 'pair'];
const SHAPES = new Set(SHAPES_ARR);

// Deterministic LCG so runs are reproducible (scripts may not use Math.random
// in workflows; this is a local validation tool, but keep it seeded anyway).
let _s = 0x2545f491;
const rand = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function flood(board, rows, cols, r, c) {
  const q = [[r, c]];
  while (q.length) {
    const [rr, cc] = q.pop(); const ce = board[rr][cc];
    if (ce.isRevealed || ce.isMine || ce.isFlagged) continue;
    ce.isRevealed = true;
    if (ce.adjacentMines === 0) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue; const nr = rr + dr, nc = cc + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) q.push([nr, nc]);
    }
  }
}

// Independent oracle: enumerate EVERY assignment of mines to the hidden cells
// that satisfies all revealed plain clues; return per-hidden-cell whether it
// is ever a mine / ever safe across consistent layouts. truly-safe = never a
// mine; truly-mine = always a mine. No solver involved.
function oracle(board, rows, cols) {
  const total = rows * cols;
  const hidden = [];
  for (let i = 0; i < total; i++) {
    const cell = board[Math.floor(i / cols)][i % cols];
    if (!cell.isRevealed) hidden.push(i);
  }
  const pos = new Map(); hidden.forEach((h, i) => pos.set(h, i));
  // Revealed clues: (neighbors among hidden, required mine count).
  const clues = [];
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const cell = board[r][c];
    if (!cell.isRevealed || cell.isMine) continue;
    let need = cell.adjacentMines; const mask = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue; const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const ni = nr * cols + nc; const nb = board[nr][nc];
      if (nb.isRevealed) { if (nb.isMine) need--; }
      else mask.push(pos.get(ni));
    }
    clues.push({ mask, need });
  }
  const n = hidden.length;
  if (n > 22) return null; // too large to brute-force; skip this state
  const everMine = new Uint8Array(n), everSafe = new Uint8Array(n);
  let consistent = 0;
  for (let a = 0; a < (1 << n); a++) {
    let ok = true;
    for (const cl of clues) {
      let cnt = 0; for (const b of cl.mask) cnt += (a >> b) & 1;
      if (cnt !== cl.need) { ok = false; break; }
    }
    if (!ok) continue;
    consistent++;
    for (let i = 0; i < n; i++) { if ((a >> i) & 1) everMine[i] = 1; else everSafe[i] = 1; }
  }
  return { hidden, pos, everMine, everSafe, consistent };
}

const FLAG_MINES = process.env.NOFLAG !== '1';
const names = {};
let classified = 0, soundnessViolations = 0, gateRejections = 0, statesChecked = 0;
let totalDeduced = 0, regionCount = 0;
const violationExamples = [], gateExamples = [];

for (let t = 0; t < TRIALS; t++) {
  // Random density 12–28%.
  const board = makeBoard(ROWS, COLS);
  const density = 0.12 + rand() * 0.16;
  let mines = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (rand() < density) { board[r][c].isMine = true; mines++; }
  if (mines === 0 || mines === ROWS * COLS) continue;
  recalcAdjacency(board);
  // Open at a 0-cell if one exists (a real first click); else a random safe.
  let opened = false;
  for (let r = 0; r < ROWS && !opened; r++) for (let c = 0; c < COLS && !opened; c++) {
    if (!board[r][c].isMine && board[r][c].adjacentMines === 0) { flood(board, ROWS, COLS, r, c); opened = true; }
  }
  if (!opened) { for (let r = 0; r < ROWS && !opened; r++) for (let c = 0; c < COLS && !opened; c++) if (!board[r][c].isMine) { flood(board, ROWS, COLS, r, c); opened = true; } }

  // Each cell is classified ONCE, at the state where it is first deduced
  // (a frontier cell persists across steps until revealed/flagged — counting
  // it every step would massively inflate the totals).
  const seen = new Set();
  let guard = 200;
  while (guard-- > 0) {
    // Flag model matches the classifier: with FLAG_MINES the loop flags proven
    // mines and reads the frontier flags-AWARE so they don't re-report.
    const fb = findDeducibleFrontier(board, { respectFlags: FLAG_MINES });
    if (fb.safe.length === 0 && fb.mines.length === 0) break;
    const orc = oracle(board, ROWS, COLS);
    if (orc) {
      statesChecked++;
      const check = (cell, kind) => {
        const key = kind + ':' + (cell.row * COLS + cell.col);
        if (seen.has(key)) return;
        seen.add(key);
        totalDeduced++;
        const res = classifyByProof(board, { row: cell.row, col: cell.col, kind }, { rows: ROWS, cols: COLS, respectFlags: FLAG_MINES });
        if (res.name === 'region') regionCount++;
        if (res.name && res.name !== 'region') {
          classified++;
          names[res.name] = (names[res.name] || 0) + 1;
          // Ground-truth the named cell.
          const idx = orc.pos.get(cell.row * COLS + cell.col);
          if (idx != null) {
            const trulySafe = orc.everMine[idx] === 0;
            const trulyMine = orc.everSafe[idx] === 0;
            const good = kind === 'safe' ? trulySafe : trulyMine;
            if (!good) {
              soundnessViolations++;
              if (violationExamples.length < 8) violationExamples.push({ t, cell: [cell.row, cell.col], kind, name: res.name });
            }
          }
        } else {
          // Gate REJECTED a shape the ungated namer would have claimed?
          const un = classifyPattern(board, { row: cell.row, col: cell.col, kind, tier: cell.tier, sources: cell.sources || [] }, { rows: ROWS, cols: COLS });
          if (un.name && SHAPES.has(un.name)) {
            gateRejections++;
            if (gateExamples.length < 8) gateExamples.push({ t, cell: [cell.row, cell.col], kind, ungated: un.name, gated: res.name });
          }
        }
      };
      for (const s of fb.safe) check(s, 'safe');
      for (const m of fb.mines) check(m, 'mine');
    }
    // Advance the canonical solve: flag proven mines, flood safes.
    if (FLAG_MINES) for (const m of fb.mines) board[m.row][m.col].isFlagged = true;
    let progressed = false;
    for (const s of fb.safe) { if (!board[s.row][s.col].isRevealed) { flood(board, ROWS, COLS, s.row, s.col); progressed = true; } }
    if (!progressed && fb.mines.length === 0) break;
  }
}

console.log(`board ${ROWS}x${COLS}, ${TRIALS} trials, flagMines=${FLAG_MINES}, ${statesChecked} solver states oracle-checked`);
console.log(`deduced cells: ${totalDeduced}  named: ${classified} (${(100 * classified / totalDeduced).toFixed(1)}%)  region: ${regionCount} (${(100 * regionCount / totalDeduced).toFixed(1)}%)`);
console.log(`SOUNDNESS VIOLATIONS (named but oracle disagrees): ${soundnessViolations}`);
if (violationExamples.length) console.log('  examples:', JSON.stringify(violationExamples));
console.log(`gate rejections (ungated claimed a shape, gate said region/none): ${gateRejections}`);
if (gateExamples.length) console.log('  examples:', JSON.stringify(gateExamples.slice(0, 5)));
console.log('name distribution:');
for (const k of [...SHAPES_ARR, 'count']) if (names[k]) console.log('  ' + k.padEnd(9), names[k]);
