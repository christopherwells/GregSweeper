// ── Worm Tiles: pure worm logic ─────────────────────────
// A worm egg (`cell.isWormEgg`) sits on a plain numbered safe cell and looks
// like any other hidden cell. Revealing it hatches a worm that crawls over
// REVEALED cells, temporarily covering the numbers it sits on, then burrows
// away after a fixed number of moves.
//
// The contract that keeps this daily-safe: worms delay information, they
// never destroy it. The board data (egg positions, numbers, mines) is static
// and canonical; only the render-time overlay moves. The solver is entirely
// worm-blind — boardSolver never reads `isWormEgg` — so certification, the
// Lens, receipts, and the load-bearing filter are untouched.
//
// Determinism split: worm LENGTH is derived from the board's seed identity
// (same daily/weekly board ⇒ same lengths for every player); the WALK
// (direction + cadence) is deliberately luck, so it takes an injectable rng.
//
// This module is pure (no DOM, no state import) and node-tested in
// test/worms.test.mjs. The runtime lifecycle lives in timerManager
// (heartbeat) and gameActions (hatch triggers); rendering in wormRenderer.

import { createDailyRNG } from './seededRandom.js';

export const WORM_MIN_LEN = 2;
export const WORM_MAX_LEN = 5;
// Hard cap on eggs per board (intensity clamp, like mirror/wormhole's
// Math.min(intensity, 3)) — keeps same-day walk-luck spread small on
// instrumented modes.
export const WORM_MAX_PER_BOARD = 3;
// A worm burrows after this many moves (boxed-in turns still count, so a
// stranded worm can't squat forever).
export const WORM_LIFETIME_MOVES = 20;
// Each move happens on its own uniform 1-4s clock.
export const WORM_MOVE_MIN_MS = 1000;
export const WORM_MOVE_MAX_MS = 4000;

// Deterministic 2-5 segment length for the egg at (r, c). Seeded from the
// board's identity so every player on the same canonical board hatches the
// same worm; only the walk is luck.
export function wormLengthFor(seedIdentity, r, c) {
  const rng = createDailyRNG(`${seedIdentity}:worm:${r}:${c}`);
  return WORM_MIN_LEN + Math.floor(rng() * (WORM_MAX_LEN - WORM_MIN_LEN + 1));
}

function rollMoveDelay(rng) {
  return WORM_MOVE_MIN_MS + Math.floor(rng() * (WORM_MOVE_MAX_MS - WORM_MOVE_MIN_MS));
}

// Hatch a worm at the just-revealed egg cell. Spawns fully coiled (every
// segment on the egg cell) so a lone revealed cell in fog can't strand it —
// it unspools as it finds revealed neighbors to crawl onto.
export function hatchWorm(r, c, seedIdentity, rng = Math.random) {
  const length = wormLengthFor(seedIdentity, r, c);
  const segments = [];
  for (let i = 0; i < length; i++) segments.push({ r, c });
  return {
    segments,               // segments[0] is the head
    movesLeft: WORM_LIFETIME_MOVES,
    nextMoveMs: rollMoveDelay(rng),
  };
}

// Rebuild live worms from a persisted snapshot (segments + movesLeft only —
// move clocks reset on resume, the lenient direction, same as plate timers).
export function rehydrateWorms(saved, rng = Math.random) {
  if (!Array.isArray(saved)) return [];
  const worms = [];
  for (const w of saved) {
    if (!w || !Array.isArray(w.segments) || w.segments.length === 0) continue;
    const movesLeft = typeof w.movesLeft === 'number' ? w.movesLeft : 0;
    if (movesLeft <= 0) continue;
    worms.push({
      segments: w.segments.map(s => ({ r: s.r, c: s.c })),
      movesLeft,
      nextMoveMs: rollMoveDelay(rng),
    });
  }
  return worms;
}

const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// One crawl step: the head moves to a random orthogonal REVEALED neighbor
// (self-overlap is fine — the worm may double back over its own body), the
// body follows snake-style. No revealed neighbor ⇒ the worm stays put but
// the move still counts, so a boxed-in worm still burrows on schedule.
// `isRevealed(r, c)` must return false out of bounds.
export function stepWorm(worm, isRevealed, rng = Math.random) {
  const head = worm.segments[0];
  const options = [];
  for (const [dr, dc] of ORTHO) {
    const nr = head.r + dr;
    const nc = head.c + dc;
    if (isRevealed(nr, nc)) options.push({ r: nr, c: nc });
  }
  let moved = false;
  if (options.length > 0) {
    const next = options[Math.floor(rng() * options.length)];
    worm.segments.unshift(next);
    worm.segments.pop();
    moved = true;
  }
  worm.movesLeft--;
  worm.nextMoveMs = rollMoveDelay(rng);
  return moved;
}

// Advance every worm's clock by dtMs; step the ones that are due; drop the
// ones out of moves. Mutates `worms` in place (splices burrowed worms) and
// returns { moved, burrowed } so the caller can re-render / play sounds.
export function tickWorms(worms, dtMs, isRevealed, rng = Math.random) {
  const moved = [];
  const burrowed = [];
  for (let i = worms.length - 1; i >= 0; i--) {
    const worm = worms[i];
    worm.nextMoveMs -= dtMs;
    if (worm.nextMoveMs > 0) continue;
    if (stepWorm(worm, isRevealed, rng)) moved.push(worm);
    if (worm.movesLeft <= 0) {
      burrowed.push(worm);
      worms.splice(i, 1);
    }
  }
  return { moved, burrowed };
}

// Set of "r,c" keys currently covered by any worm segment (self-overlapping
// segments collapse to one key). Render + tests read this.
export function wormCoveredCells(worms) {
  const covered = new Set();
  for (const worm of worms) {
    for (const seg of worm.segments) covered.add(`${seg.r},${seg.c}`);
  }
  return covered;
}

// Pure overlay layout: map every worm segment to its cell's rect via the
// injected `cellRect(r, c) -> {left, top, width, height} | null` (the DOM
// half lives in wormRenderer). Segments whose cell has no rect are skipped.
export function wormOverlayLayout(worms, cellRect) {
  const out = [];
  worms.forEach((worm, wormIndex) => {
    worm.segments.forEach((seg, segIndex) => {
      const rect = cellRect(seg.r, seg.c);
      if (!rect) return;
      out.push({
        wormIndex, segIndex, isHead: segIndex === 0,
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      });
    });
  });
  return out;
}
