// The soundness-gated classifier must never name a shape the board does not
// actually prove. This is the guarantee the player-facing technique stats
// rest on: a name is returned only when the cited clues PROVABLY force the
// square. We check that against an INDEPENDENT brute-force oracle (every mine
// layout consistent with the revealed clues) — the solver is never its own
// judge. A scaled-down, seeded version of scripts/validate-proof-classify.mjs
// so the invariant lives in CI.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoard, recalcAdjacency } from './helpers.mjs';

const { findDeducibleFrontier } = await import('../src/logic/boardSolver.js');
const { classifyByProof } = await import('../src/logic/proofClassify.js');

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

// Independent oracle: per hidden cell, is it ever a mine / ever safe across
// every assignment that satisfies the revealed clues? No solver involved.
function oracle(board, rows, cols) {
  const total = rows * cols;
  const hidden = [];
  for (let i = 0; i < total; i++) if (!board[Math.floor(i / cols)][i % cols].isRevealed) hidden.push(i);
  const pos = new Map(); hidden.forEach((h, i) => pos.set(h, i));
  const clues = [];
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols), c = i % cols, cell = board[r][c];
    if (!cell.isRevealed || cell.isMine) continue;
    let need = cell.adjacentMines; const mask = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue; const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nb = board[nr][nc];
      if (nb.isRevealed) { if (nb.isMine) need--; } else mask.push(pos.get(nr * cols + nc));
    }
    clues.push({ mask, need });
  }
  const n = hidden.length;
  if (n > 20) return null;
  const everMine = new Uint8Array(n), everSafe = new Uint8Array(n);
  for (let a = 0; a < (1 << n); a++) {
    let ok = true;
    for (const cl of clues) { let cnt = 0; for (const b of cl.mask) cnt += (a >> b) & 1; if (cnt !== cl.need) { ok = false; break; } }
    if (!ok) continue;
    for (let i = 0; i < n; i++) { if ((a >> i) & 1) everMine[i] = 1; else everSafe[i] = 1; }
  }
  return { pos, everMine, everSafe };
}

function sweep(flagMines) {
  let _s = 0x9e3779b1;
  const rand = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ROWS = 4, COLS = 4, TRIALS = 400;
  let named = 0, violations = 0; const dist = {};
  const ex = [];
  for (let t = 0; t < TRIALS; t++) {
    const board = makeBoard(ROWS, COLS);
    const density = 0.14 + rand() * 0.14;
    let mines = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (rand() < density) { board[r][c].isMine = true; mines++; }
    if (mines === 0 || mines === ROWS * COLS) continue;
    recalcAdjacency(board);
    let opened = false;
    for (let r = 0; r < ROWS && !opened; r++) for (let c = 0; c < COLS && !opened; c++) if (!board[r][c].isMine && board[r][c].adjacentMines === 0) { flood(board, ROWS, COLS, r, c); opened = true; }
    if (!opened) for (let r = 0; r < ROWS && !opened; r++) for (let c = 0; c < COLS && !opened; c++) if (!board[r][c].isMine) { flood(board, ROWS, COLS, r, c); opened = true; }
    const seen = new Set();
    let guard = 80;
    while (guard-- > 0) {
      const fb = findDeducibleFrontier(board, { respectFlags: flagMines });
      if (fb.safe.length === 0 && fb.mines.length === 0) break;
      const orc = oracle(board, ROWS, COLS);
      if (orc) {
        const check = (cell, kind) => {
          const key = kind + ':' + (cell.row * COLS + cell.col);
          if (seen.has(key)) return; seen.add(key);
          const res = classifyByProof(board, { row: cell.row, col: cell.col, kind }, { rows: ROWS, cols: COLS, respectFlags: flagMines });
          if (!res.name || res.name === 'region') return;
          named++; dist[res.name] = (dist[res.name] || 0) + 1;
          const idx = orc.pos.get(cell.row * COLS + cell.col);
          if (idx == null) return;
          const good = kind === 'safe' ? orc.everMine[idx] === 0 : orc.everSafe[idx] === 0;
          if (!good) { violations++; if (ex.length < 5) ex.push({ t, cell: [cell.row, cell.col], kind, name: res.name }); }
        };
        for (const s of fb.safe) check(s, 'safe');
        for (const m of fb.mines) check(m, 'mine');
      }
      if (flagMines) for (const m of fb.mines) board[m.row][m.col].isFlagged = true;
      let progressed = false;
      for (const s of fb.safe) if (!board[s.row][s.col].isRevealed) { flood(board, ROWS, COLS, s.row, s.col); progressed = true; }
      if (!progressed && fb.mines.length === 0) break;
    }
  }
  return { named, violations, dist, ex };
}

test('every named shape matches the brute-force oracle (flags-aware)', () => {
  const r = sweep(true);
  assert.equal(r.violations, 0, `unsound names: ${JSON.stringify(r.ex)}`);
  assert.ok(r.named > 200, `expected a healthy sample of named cells, got ${r.named}`);
});

test('every named shape matches the brute-force oracle (flags-blind)', () => {
  const r = sweep(false);
  assert.equal(r.violations, 0, `unsound names: ${JSON.stringify(r.ex)}`);
  assert.ok(r.named > 200, `expected a healthy sample of named cells, got ${r.named}`);
});

test('a clean wall 1-2-1 is named 1-2-1, gated by the proof', () => {
  // clues 1,2,1 at (1,1),(1,2),(1,3); mines under the outer 1s; rows 0+1
  // revealed, row 2 hidden. The square under the 2 is the 1-2-1's safe cell.
  const board = makeBoard(3, 5);
  board[2][1].isMine = true; board[2][3].isMine = true;
  recalcAdjacency(board);
  for (let c = 0; c < 5; c++) { board[0][c].isRevealed = true; board[1][c].isRevealed = true; }
  const res = classifyByProof(board, { row: 2, col: 2, kind: 'safe' }, { rows: 3, cols: 5 });
  assert.equal(res.name, '1-2-1');
});
