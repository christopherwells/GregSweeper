// generateBoard must ship walls-consistent boards (2026-07-11 audit, Q4).
//
// Challenge walls levels pre-apply their wall set (options.wallEdges) so the
// constructive generator builds a wall-aware mine layout. Two paths inside
// generateBoard then LOST the walls:
//   1. The anti-zero-cluster clone copied only isMine/adjacentMines, so
//      redistributeMines recalculated every number WITHOUT walls and the
//      acceptance solve certified the wall-less clone — which was returned
//      bare. The caller re-attaches the walls, and applyGimmicks keeps
//      pre-applied walls without a recalc, so the stale non-wall-aware
//      numbers reached the player on a wall-aware board: numbers that do
//      not count what the topology says, on which the certifier can
//      "prove" cells the real board doesn't support.
//   2. The rejection-sampling fallback (constructive tries exhausted)
//      ignored options.wallEdges entirely — same inconsistency.
// Both now attach the walls to every board the function builds, so the
// adjacency passes and the acceptance solve always see the real board.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBoard } from '../src/logic/boardGenerator.js';
import { countAdjacentMines } from '../src/logic/gimmicks.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';

// A horizontal wall run across the middle of a 10x10 (same edge-key format
// as gimmicks.wallKey: smaller endpoint first).
function midWall() {
  const edges = new Set();
  for (let c = 2; c <= 7; c++) edges.add(`4,${c}-5,${c}`);
  return edges;
}

test('REGRESSION: a walls board survives generateBoard with its walls and wall-aware numbers', () => {
  const wallEdges = midWall();
  let wallsMattered = false;

  for (const seed of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']) {
    const rng = createDailyRNG(`walls-redistribution-${seed}`);
    // 26% density → the constructive branch; maxZeroCluster finite → the
    // anti-zero-cluster clone path runs on every candidate.
    const board = generateBoard(10, 10, 26, 5, 5, rng, {
      maxZeroCluster: 3, hasGimmicks: true, wallEdges,
    });

    assert.ok(board._wallEdges && board._wallEdges.size === wallEdges.size,
      `seed ${seed}: the returned board must carry the walls it was generated for`);

    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const cell = board[r][c];
        const expected = cell.isMine ? 0 : countAdjacentMines(board, r, c);
        assert.equal(cell.adjacentMines, expected,
          `seed ${seed}: cell ${r},${c} shows ${cell.adjacentMines} but the wall-aware count is ${expected}`);
        // Track whether the wall set actually changed some number vs a
        // walls-blind count — proves the fixture bites.
        if (!cell.isMine) {
          let blind = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = r + dr, nc = c + dc;
              if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10 && board[nr][nc].isMine) blind++;
            }
          }
          if (blind !== expected) wallsMattered = true;
        }
      }
    }
  }

  assert.ok(wallsMattered,
    'fixture sanity: at least one generated board must have a cell whose wall-aware count differs from the blind 3x3 count');
});
