// Crux extraction + teaser materialization. cruxExtract is the single
// source of truth the win receipt AND the daily crux teaser read from, so
// the crux it finds must be a genuine safe deduction, and the teaser it
// materializes must re-prove that square FROM THE NUMBERS A PLAYER SEES —
// no mine layout, no walls, exactly the open grid the teaser renders.
//
// Run: node --test test/cruxExtract.test.mjs

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractCrux, materializeCrux, cruxPayloadFromBoard } from '../src/logic/cruxExtract.js';
import { isBoardSolvable, findDeducibleFrontier } from '../src/logic/boardSolver.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import { serializeBoard, deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { makeBoard, recalcAdjacency } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A solvable plain (no-gimmick) board for a seed, center first click.
function buildPlainBoard(seed) {
  const rows = 9, cols = 9, totalMines = 12, fr = 4, fc = 4;
  const board = generateBoard(rows, cols, totalMines, fr, fc, createDailyRNG(seed));
  cleanSolverArtifacts(board);
  const check = isBoardSolvable(board, rows, cols, fr, fc);
  cleanSolverArtifacts(board);
  return { board, rows, cols, totalMines, solvable: check.solvable || check.remainingUnknowns === 0 };
}

// The first fixed seed whose board needs a tier>=1 step. Deterministic:
// same seeds every run, so the test never flakes.
function firstCruxBoard() {
  for (let i = 0; i < 60; i++) {
    const seed = `cruxtest-${i}`;
    const b = buildPlainBoard(seed);
    if (!b.solvable) continue;
    const crux = extractCrux(b.board, b.rows, b.cols);
    if (crux && crux.tier >= 1) return { ...b, crux, seed };
  }
  throw new Error('fixed seed sweep found no tier>=1 crux board');
}

// Rebuild the OPEN grid the teaser renderer shows from a payload (numbers
// only — no mines, no walls) and ask the solver to prove the answer. This
// is the strongest check: it proves the SHIPPED payload is solvable to the
// answer exactly as the player sees it.
function answerProvableFromPayload(payload) {
  const board = makeBoard(payload.rows, payload.cols);
  const revealed = new Map();
  for (const cell of payload.cells) revealed.set(`${cell.r},${cell.c}`, cell.n);
  for (let r = 0; r < payload.rows; r++) {
    for (let c = 0; c < payload.cols; c++) {
      const k = `${r},${c}`;
      if (revealed.has(k)) {
        board[r][c].isRevealed = true;
        board[r][c].adjacentMines = revealed.get(k);
        board[r][c].displayedMines = revealed.get(k);
      }
    }
  }
  const f = findDeducibleFrontier(board, { respectFlags: false });
  if (f.contradiction) return null;
  return f.safe.find(s => s.row === payload.answer.r && s.col === payload.answer.c) || null;
}

test('extractCrux finds a tier>=1 SAFE deduction with a pre-crux snapshot', () => {
  const { board, rows, cols, crux } = firstCruxBoard();
  assert.ok(crux, 'expected a crux');
  assert.ok(crux.tier >= 1 && crux.tier <= 3, `tier in 1..3, got ${crux.tier}`);
  // The crux is a reveal, so its square is genuinely safe on the real board.
  assert.equal(board[crux.cell.row][crux.cell.col].isMine, false,
    'the crux square must be safe (the trace only records reveals)');
  assert.ok(Array.isArray(crux.sources) && crux.sources.length > 0, 'sources present');
  // The snapshot is the state BEFORE the crux: the answer is still hidden.
  assert.ok(crux.cruxSim, 'cruxSim captured');
  assert.equal(crux.cruxSim[crux.cell.row * cols + crux.cell.col], 0,
    'the answer must be unrevealed in the pre-crux snapshot');
  assert.equal(typeof crux.sentence, 'string');
  assert.ok(crux.sentence.length > 0, 'a plain-language sentence is produced');
});

test('materializeCrux ships a payload that re-proves the answer as rendered', () => {
  const { board, rows, cols, crux } = firstCruxBoard();
  const payload = materializeCrux(board, rows, cols, crux);
  assert.ok(payload, 'expected a materialized teaser');
  // Shape.
  for (const k of ['rows', 'cols', 'cells', 'answer', 'sources', 'tier', 'sentence']) {
    assert.ok(k in payload, `payload.${k} present`);
  }
  assert.ok(payload.rows <= 9 && payload.cols <= 9, 'mini stays phone-sized');
  assert.ok(payload.answer.r >= 0 && payload.answer.r < payload.rows);
  assert.ok(payload.answer.c >= 0 && payload.answer.c < payload.cols);
  // The answer is NOT among the revealed clues (the player must find it).
  assert.ok(!payload.cells.some(c => c.r === payload.answer.r && c.c === payload.answer.c),
    'the answer square must be hidden in the teaser');
  // The strongest check: solve the open grid the player actually sees.
  const proven = answerProvableFromPayload(payload);
  assert.ok(proven, 'the answer must be provably safe from the shown numbers alone');
  assert.ok(proven.tier >= 1, 'the answer must take more than a single clue (never a tier-0 giveaway)');
  // Payload stays small.
  assert.ok(JSON.stringify(payload).length < 2000, 'payload under 2KB');
});

test('a breather board (everything falls to counting) yields no crux', () => {
  // 4x4 with one corner mine: the center click floods the whole board and
  // plain counting flags the corner. No tier>=1 step exists.
  const board = makeBoard(4, 4);
  board[0][0].isMine = true;
  recalcAdjacency(board);
  const crux = extractCrux(board, 4, 4);
  assert.equal(crux, null, 'a pure-counting board has no crux');
  assert.equal(cruxPayloadFromBoard(board, 4, 4), null, 'and no teaser');
});

test('serialize round-trip preserves the crux (receipt on a loaded canonical == teaser)', () => {
  const { board, rows, cols, totalMines, crux } = firstCruxBoard();
  const raw = serializeBoard({ board, rows, cols, totalMines, rngSeed: 'rt', activeGimmicks: [] });
  const restored = deserializeBoard(raw);
  const crux2 = extractCrux(restored.board, restored.rows, restored.cols);
  assert.ok(crux2, 'crux survives the round-trip');
  assert.deepEqual(crux2.cell, crux.cell, 'same crux square after serialize/deserialize');
  assert.equal(crux2.tier, crux.tier, 'same tier');
});

test('real canonical fixture materializes correctly or skips gracefully', () => {
  const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'dailyBoard-2026-06-14.json'), 'utf8'));
  const { board, rows, cols } = deserializeBoard(raw);
  const payload = cruxPayloadFromBoard(board, rows, cols);
  // A real board either yields a correct teaser or none (breather / walls /
  // gimmick-entangled). Never a broken one.
  if (payload === null) return;
  const proven = answerProvableFromPayload(payload);
  assert.ok(proven, 'a shipped teaser must re-prove its answer from the shown numbers');
  assert.ok(payload.rows <= 9 && payload.cols <= 9);
});
