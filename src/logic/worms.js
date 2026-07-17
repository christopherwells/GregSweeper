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
// A worm burrows after its own move budget (boxed-in turns still count,
// so a stranded worm can't squat forever). Each EGG gets its own roll in
// [30, 80], seeded from the board identity + the egg's cell — one worm
// can feel like it's around forever while another is a short cameo, but
// every player on a canonical board sees the same budgets (Christopher's
// ruling: per-worm variety, zero cross-player variability). Worms hatch
// at different times and each counts down alone, so they never bury in
// sync.
export const WORM_LIFETIME_MIN_MOVES = 30;
export const WORM_LIFETIME_MAX_MOVES = 80;
// Each move happens on its own uniform 1-4s clock.
export const WORM_MOVE_MIN_MS = 1000;
export const WORM_MOVE_MAX_MS = 4000;
// Movement bias: worms dislike mines. Each candidate cell's weight is
// WORM_NUMBER_AVERSION^adjacentMines, so open ground (0) is favored and
// every extra adjacent mine multiplies the cell's chance down. Light by
// design (Christopher's spec): a 0 vs a 4 is roughly a four-to-one
// preference, never a rule — the walk stays luck, just luck with a nose.
export const WORM_NUMBER_AVERSION = 0.7;

// Deterministic 2-5 segment length for the egg at (r, c). Seeded from the
// board's identity so every player on the same canonical board hatches the
// same worm; only the walk is luck.
export function wormLengthFor(seedIdentity, r, c) {
  const rng = createDailyRNG(`${seedIdentity}:worm:${r}:${c}`);
  return WORM_MIN_LEN + Math.floor(rng() * (WORM_MAX_LEN - WORM_MIN_LEN + 1));
}

// Deterministic per-EGG move budget in [30, 80]. Seeded like the length:
// each egg's worm gets its own roll, and every player on a canonical
// board gets the same one.
export function wormLifetimeFor(seedIdentity, r, c) {
  const rng = createDailyRNG(`${seedIdentity}:wormlife:${r}:${c}`);
  return WORM_LIFETIME_MIN_MOVES
    + Math.floor(rng() * (WORM_LIFETIME_MAX_MOVES - WORM_LIFETIME_MIN_MOVES + 1));
}

// Deterministic per-EGG color tone in [0, 1): 0 = the theme's dark
// endpoint (brown on the base design), 1 = the light endpoint (cream).
// Same seeding family as length/lifetime, so a board's brood shows the
// same mix of siblings to every player. Purely cosmetic — the walk, the
// solver, and the par model never read it.
export function wormToneFor(seedIdentity, r, c) {
  return createDailyRNG(`${seedIdentity}:wormtone:${r}:${c}`)();
}

// Linear hex-color interpolation for the tone ramp (t = 0 → a, t = 1 → b).
// Lives here (with wormOverlayLayout) so the color math is node-testable;
// wormRenderer supplies the theme's endpoint tokens.
export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = Math.min(1, Math.max(0, t));
  const ch = (sa, sb) => Math.round(sa + (sb - sa) * k);
  const r = ch((pa >> 16) & 255, (pb >> 16) & 255);
  const g = ch((pa >> 8) & 255, (pb >> 8) & 255);
  const bl = ch(pa & 255, pb & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

// The par-model exposure measure: total segment-moves the board's eggs are
// pre-programmed to spend — Σ per-egg (length × lifetime) — in HUNDREDS
// (so the value runs ~0.6-12, the same range as the other count features,
// and its log-multiplier coefficient lands in the family's scale). Fully
// structural — derived from egg positions + the seed identity, no runtime
// randomness — so dailyMeta's wormLoad is a verify-sweep hard-fail key.
export const WORM_LOAD_SCALE = 100;
export function wormLoadFor(eggs, seedIdentity) {
  if (!Array.isArray(eggs) || eggs.length === 0) return 0;
  let segmentMoves = 0;
  for (const egg of eggs) {
    segmentMoves += wormLengthFor(seedIdentity, egg.r, egg.c)
      * wormLifetimeFor(seedIdentity, egg.r, egg.c);
  }
  return segmentMoves / WORM_LOAD_SCALE;
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
    movesLeft: wormLifetimeFor(seedIdentity, r, c),
    tone: wormToneFor(seedIdentity, r, c),
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
      // Old saves predate tones; a mid-ramp default keeps them visible.
      tone: typeof w.tone === 'number' ? w.tone : 0.5,
      nextMoveMs: rollMoveDelay(rng),
    });
  }
  return worms;
}

const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// One crawl step: the head moves to an orthogonal REVEALED neighbor chosen
// by mine-aversion weighting (self-overlap is fine — the worm may double
// back over its own body), the body follows snake-style. No revealed
// neighbor ⇒ the worm stays put but the move still counts, so a boxed-in
// worm still burrows on schedule.
// `numberAt(r, c)` returns the cell's adjacent-mine count when the worm may
// stand there (revealed), else null — including out of bounds.
export function stepWorm(worm, numberAt, rng = Math.random) {
  const head = worm.segments[0];
  const options = [];
  let totalWeight = 0;
  for (const [dr, dc] of ORTHO) {
    const nr = head.r + dr;
    const nc = head.c + dc;
    const n = numberAt(nr, nc);
    if (n === null || n === undefined) continue;
    const weight = Math.pow(WORM_NUMBER_AVERSION, n);
    totalWeight += weight;
    options.push({ r: nr, c: nc, weight });
  }
  let moved = false;
  if (options.length > 0) {
    // Roulette pick over the aversion weights: lower numbers draw the worm,
    // higher numbers repel it, nothing is ever off-limits.
    let roll = rng() * totalWeight;
    let next = options[options.length - 1];
    for (const opt of options) {
      roll -= opt.weight;
      if (roll <= 0) { next = opt; break; }
    }
    worm.segments.unshift({ r: next.r, c: next.c });
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
export function tickWorms(worms, dtMs, numberAt, rng = Math.random) {
  const moved = [];
  const burrowed = [];
  for (let i = worms.length - 1; i >= 0; i--) {
    const worm = worms[i];
    worm.nextMoveMs -= dtMs;
    if (worm.nextMoveMs > 0) continue;
    if (stepWorm(worm, numberAt, rng)) moved.push(worm);
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
