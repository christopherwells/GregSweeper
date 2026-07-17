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
// Each move happens on its own uniform 1-4s clock, scaled by the worm's
// PACE trait — a per-egg roll in [0.8, 1.3] (seeded like length/lifetime/
// tone, so every player sees the same fast and slow worms). Noticeably
// different, deliberately not hugely: the quickest worms average ~2.0s a
// move, the slowest ~3.25s (Christopher's spec).
export const WORM_MOVE_MIN_MS = 1000;
export const WORM_MOVE_MAX_MS = 4000;
export const WORM_PACE_MIN = 0.8;
export const WORM_PACE_MAX = 1.3;
// Movement bias: worms dislike mines. Each candidate cell's weight is
// WORM_NUMBER_AVERSION^adjacentMines, so open ground (0) is favored and
// every extra adjacent mine multiplies the cell's chance down. Light by
// design (Christopher's spec): a 0 vs a 4 is roughly a four-to-one
// preference, never a rule — the walk stays luck, just luck with a nose.
export const WORM_NUMBER_AVERSION = 0.7;
// Momentum: about half the worm's steps first try to CONTINUE its last
// heading when the cell straight ahead is walkable; only then does the
// aversion roulette pick. A pure roulette walk backtracks so much its net
// travel grows like the square root of its moves — worms paced in place
// (Christopher's report). The correlated walk actually tours the board.
export const WORM_PERSIST_PROB = 0.5;
// Backtracking (stepping straight back the way it came) is strongly
// downweighted in the roulette: the reverse candidate keeps a twentieth
// of its weight, which lands near a 5% reversal chance in a corridor and
// under 2% in open field (Christopher's spec). A dead end is the
// exception — when reverse is the only walkable option the worm takes it
// rather than freezing.
export const WORM_BACKTRACK_WEIGHT = 0.05;

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

// Deterministic per-EGG pace factor in [WORM_PACE_MIN, WORM_PACE_MAX].
// Multiplies every move delay: below 1 is a quick worm, above 1 a slow
// one. NOT cosmetic — a slower worm parks on numbers longer and lives
// longer in wall-clock, which is why wormLoadFor weights by it.
export function wormPaceFor(seedIdentity, r, c) {
  const rng = createDailyRNG(`${seedIdentity}:wormpace:${r}:${c}`);
  return WORM_PACE_MIN + rng() * (WORM_PACE_MAX - WORM_PACE_MIN);
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

// The par-model exposure measure: pace-weighted segment-moves the board's
// eggs are pre-programmed to spend — Σ per-egg (length × lifetime × pace)
// — in HUNDREDS (so the value runs ~0.5-15, the same range as the other
// count features, and its log-multiplier coefficient lands in the family's
// scale). Pace belongs in the measure: a slow worm covers numbers longer
// per move AND lives longer in wall-clock. Fully structural — derived from
// egg positions + the seed identity, no runtime randomness — so
// dailyMeta's wormLoad is a verify-sweep hard-fail key.
export const WORM_LOAD_SCALE = 100;
export function wormLoadFor(eggs, seedIdentity) {
  if (!Array.isArray(eggs) || eggs.length === 0) return 0;
  let segmentMoves = 0;
  for (const egg of eggs) {
    segmentMoves += wormLengthFor(seedIdentity, egg.r, egg.c)
      * wormLifetimeFor(seedIdentity, egg.r, egg.c)
      * wormPaceFor(seedIdentity, egg.r, egg.c);
  }
  return segmentMoves / WORM_LOAD_SCALE;
}

function rollMoveDelay(rng, pace = 1) {
  return (WORM_MOVE_MIN_MS + Math.floor(rng() * (WORM_MOVE_MAX_MS - WORM_MOVE_MIN_MS))) * pace;
}

// Hatch a worm at the just-revealed egg cell. Spawns fully coiled (every
// segment on the egg cell) so a lone revealed cell in fog can't strand it —
// it unspools as it finds revealed neighbors to crawl onto.
export function hatchWorm(r, c, seedIdentity, rng = Math.random) {
  const length = wormLengthFor(seedIdentity, r, c);
  const pace = wormPaceFor(seedIdentity, r, c);
  const segments = [];
  for (let i = 0; i < length; i++) segments.push({ r, c });
  return {
    segments,               // segments[0] is the head
    movesLeft: wormLifetimeFor(seedIdentity, r, c),
    tone: wormToneFor(seedIdentity, r, c),
    pace,
    nextMoveMs: rollMoveDelay(rng, pace),
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
    const pace = typeof w.pace === 'number' ? w.pace : 1;
    const worm = {
      segments: w.segments.map(s => ({ r: s.r, c: s.c })),
      movesLeft,
      // Old saves predate tones/pace; neutral defaults keep them whole.
      tone: typeof w.tone === 'number' ? w.tone : 0.5,
      pace,
      nextMoveMs: rollMoveDelay(rng, pace),
    };
    // Heading survives a resume so momentum picks up where it left off.
    if (w.lastDir && typeof w.lastDir.dr === 'number' && typeof w.lastDir.dc === 'number') {
      worm.lastDir = { dr: w.lastDir.dr, dc: w.lastDir.dc };
    }
    worms.push(worm);
  }
  return worms;
}

const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// One crawl step: with WORM_PERSIST_PROB the head first tries to continue
// its last heading (momentum); otherwise — or when the way ahead is not
// walkable — an orthogonal REVEALED neighbor is chosen by mine-aversion
// weighting. Self-overlap is fine (the worm may double back over its own
// body); the body follows snake-style. No revealed neighbor ⇒ the worm
// stays put but the move still counts, so a boxed-in worm still burrows
// on schedule (its heading survives the wait).
// `numberAt(r, c)` returns the cell's adjacent-mine count when the worm may
// stand there (revealed), else null — including out of bounds.
export function stepWorm(worm, numberAt, rng = Math.random) {
  const head = worm.segments[0];

  // Momentum first: keep going the way we were going, about half the time.
  let next = null;
  if (worm.lastDir && rng() < WORM_PERSIST_PROB) {
    const nr = head.r + worm.lastDir.dr;
    const nc = head.c + worm.lastDir.dc;
    const ahead = numberAt(nr, nc);
    if (ahead !== null && ahead !== undefined) next = { r: nr, c: nc };
  }

  if (!next) {
    const options = [];
    let totalWeight = 0;
    for (const [dr, dc] of ORTHO) {
      const nr = head.r + dr;
      const nc = head.c + dc;
      const n = numberAt(nr, nc);
      if (n === null || n === undefined) continue;
      let weight = Math.pow(WORM_NUMBER_AVERSION, n);
      // Reversing the heading is a near-wasted move — suppress it hard.
      // When it's the ONLY option the roulette still lands on it (its
      // tiny weight is the whole total), so dead ends resolve naturally.
      if (worm.lastDir && dr === -worm.lastDir.dr && dc === -worm.lastDir.dc) {
        weight *= WORM_BACKTRACK_WEIGHT;
      }
      totalWeight += weight;
      options.push({ r: nr, c: nc, weight });
    }
    if (options.length > 0) {
      // Roulette pick over the aversion weights: lower numbers draw the
      // worm, higher numbers repel it, nothing is ever off-limits.
      let roll = rng() * totalWeight;
      next = options[options.length - 1];
      for (const opt of options) {
        roll -= opt.weight;
        if (roll <= 0) { next = opt; break; }
      }
    }
  }

  let moved = false;
  if (next) {
    worm.lastDir = { dr: next.r - head.r, dc: next.c - head.c };
    worm.segments.unshift({ r: next.r, c: next.c });
    worm.segments.pop();
    moved = true;
  }
  worm.movesLeft--;
  worm.nextMoveMs = rollMoveDelay(rng, worm.pace || 1);
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
