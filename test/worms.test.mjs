// Worm Tiles (2026-07-16) — pure worm logic, egg placement, and the
// L101 capstone ladder. The contract under test: worms delay information
// but never destroy it (eggs sit only on plain numbered safe cells, the
// post-hatch cell is an ordinary number, the solver never reads
// isWormEgg), worm LENGTH is deterministic per canonical board while the
// WALK is luck, and a worm always burrows on schedule even when boxed in.
//
// Run: node --test test/worms.test.mjs

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WORM_MIN_LEN, WORM_MAX_LEN, WORM_MAX_PER_BOARD,
  WORM_LIFETIME_MIN_MOVES, WORM_LIFETIME_MAX_MOVES, WORM_LOAD_SCALE,
  WORM_MOVE_BASE_MS,
  WORM_PACE_MIN, WORM_PACE_MAX, WORM_PERSIST_PROB,
  wormLengthFor, wormLifetimeFor, wormToneFor, wormPaceFor, wormLoadFor,
  mixHex, hatchWorm, stepWorm, tickWorms, rehydrateWorms, wormCoveredCells,
  wormOverlayLayout, wormHatchEvent, markWormBurrowed, finalizeWormEvents, wormSegmentSize,
  buildWormCrawlTopology, wormCellCenterUnitOffsets,
} from '../src/logic/worms.js';
import { buildWireframe } from '../src/logic/tilingGeometry.js';
import { buildTiling488, buildTiling, containerFor, TILING_TYPES } from '../src/logic/tilingGeometry.js';

// Fixed-sequence rng for pinning exact branch behavior (repeats the last
// value once the sequence is exhausted).
const seqRng = (...vals) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};
import { createEmptyBoard } from '../src/logic/boardGenerator.js';
import {
  applyGimmicks, clearGimmickProperties, getGimmicksForLevel, recalcAllAdjacency,
} from '../src/logic/gimmicks.js';
import { getDifficultyForLevel } from '../src/logic/difficulty.js';
import { mulberry32 } from '../src/logic/seededRandom.js';

// ── Pure worm logic ─────────────────────────────────────

test('worm length is deterministic per (seed identity, cell) and spans the 2-5 band', () => {
  assert.equal(wormLengthFor('2026-07-16', 3, 4), wormLengthFor('2026-07-16', 3, 4));
  const lengths = new Set();
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const len = wormLengthFor('2026-07-16', r, c);
      assert.ok(len >= WORM_MIN_LEN && len <= WORM_MAX_LEN, `length ${len} outside band`);
      lengths.add(len);
    }
  }
  assert.ok(lengths.size > 1, 'lengths must vary across cells, not collapse to one value');
});

test('hatchWorm spawns fully coiled on the egg cell with a fresh pace-scaled clock', () => {
  const worm = hatchWorm(2, 5, 'seed-x', mulberry32(1));
  assert.equal(worm.segments.length, wormLengthFor('seed-x', 2, 5));
  assert.ok(worm.segments.every(s => s.r === 2 && s.c === 5), 'coiled spawn: every segment on the egg');
  assert.equal(worm.movesLeft, wormLifetimeFor('seed-x', 2, 5));
  assert.equal(worm.pace, wormPaceFor('seed-x', 2, 5));
  assert.equal(worm.nextMoveMs, WORM_MOVE_BASE_MS * worm.pace,
    'the first move clock is the SET cadence: base times the worm\'s own pace (his 2026-08-03 ruling)');
});

test('pace is a per-EGG trait: noticeably fast and slow worms, identical for every player', () => {
  assert.equal(wormPaceFor('2026-07-20:trial3', 4, 4), wormPaceFor('2026-07-20:trial3', 4, 4));
  const paces = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = wormPaceFor('2026-07-20:trial3', r, c);
      assert.ok(p >= WORM_PACE_MIN && p <= WORM_PACE_MAX, `pace ${p} outside band`);
      paces.push(p);
    }
  }
  assert.ok(Math.max(...paces) - Math.min(...paces) > 0.2, 'paces must spread, not collapse');
  // A quick worm rolls quicker clocks than a slow one, move after move.
  const quick = { segments: [{ r: 0, c: 0 }], movesLeft: 99, pace: WORM_PACE_MIN, nextMoveMs: 0 };
  const slow = { segments: [{ r: 0, c: 0 }], movesLeft: 99, pace: WORM_PACE_MAX, nextMoveMs: 0 };
  stepWorm(quick, () => null, mulberry32(51));
  stepWorm(slow, () => null, mulberry32(51)); // same rng stream -> same base roll
  assert.ok(quick.nextMoveMs < slow.nextMoveMs, 'pace scales the rolled delay');
  assert.equal(quick.nextMoveMs, WORM_MOVE_BASE_MS * WORM_PACE_MIN, 'set pace: quick worm cadence is exact');
  assert.equal(slow.nextMoveMs, WORM_MOVE_BASE_MS * WORM_PACE_MAX, 'set pace: slow worm cadence is exact');
});

test('lifetime is per-EGG: each worm owns its 30-80 budget, identical for every player', () => {
  // Deterministic per (seed, cell): every player on the canonical board
  // hatches this exact worm with this exact budget.
  assert.equal(wormLifetimeFor('2026-07-20:trial3', 1, 1), wormLifetimeFor('2026-07-20:trial3', 1, 1));
  // Different eggs on the SAME board roll their own budgets — one worm can
  // squat for what feels like forever while another is a short cameo.
  const budgets = new Set();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const life = wormLifetimeFor('2026-07-20:trial3', r, c);
      assert.ok(life >= WORM_LIFETIME_MIN_MOVES && life <= WORM_LIFETIME_MAX_MOVES, `lifetime ${life} outside band`);
      budgets.add(life);
    }
  }
  assert.ok(budgets.size > 5, 'per-egg budgets must vary within one board, not collapse');
});

test('tone is per-EGG and deterministic: a brood of siblings, identical for every player', () => {
  assert.equal(wormToneFor('2026-07-20:trial3', 2, 2), wormToneFor('2026-07-20:trial3', 2, 2));
  const tones = new Set();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const t = wormToneFor('2026-07-20:trial3', r, c);
      assert.ok(t >= 0 && t < 1, `tone ${t} outside [0, 1)`);
      tones.add(Math.round(t * 100));
    }
  }
  assert.ok(tones.size > 10, 'tones must spread across the ramp, not collapse');
  // The hatch carries it, and old saves rehydrate to neutral defaults.
  const worm = hatchWorm(2, 5, 'seed-x', mulberry32(1));
  assert.equal(worm.tone, wormToneFor('seed-x', 2, 5));
  const legacy = rehydrateWorms([{ segments: [{ r: 0, c: 0 }], movesLeft: 9 }], mulberry32(2));
  assert.equal(legacy[0].tone, 0.5);
  assert.equal(legacy[0].pace, 1);
  const kept = rehydrateWorms([{ segments: [{ r: 0, c: 0 }], movesLeft: 9, tone: 0.83, pace: 1.2, lastDir: { dr: -1, dc: 0 } }], mulberry32(3));
  assert.equal(kept[0].tone, 0.83);
  assert.equal(kept[0].pace, 1.2);
  assert.deepEqual(kept[0].lastDir, { dr: -1, dc: 0 }, 'heading survives a resume');
});

test('mixHex interpolates the tone ramp endpoint-to-endpoint and clamps t', () => {
  assert.equal(mixHex('#8f5b38', '#eedcbc', 0), '#8f5b38');
  assert.equal(mixHex('#8f5b38', '#eedcbc', 1), '#eedcbc');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#000000', '#ffffff', -3), '#000000', 'clamps below');
  assert.equal(mixHex('#000000', '#ffffff', 7), '#ffffff', 'clamps above');
  // Channel padding: a mix landing under 0x100000 keeps its leading zero.
  assert.equal(mixHex('#000000', '#0000ff', 0.5).length, 7);
});

test('wormLoadFor: sum of per-egg length x lifetime x pace in hundreds, deterministic, zero without eggs', () => {
  const seed = '2026-07-21:trial0';
  const eggs = [{ r: 2, c: 3 }, { r: 7, c: 1 }];
  const expected = (
    wormLengthFor(seed, 2, 3) * wormLifetimeFor(seed, 2, 3) * wormPaceFor(seed, 2, 3)
    + wormLengthFor(seed, 7, 1) * wormLifetimeFor(seed, 7, 1) * wormPaceFor(seed, 7, 1)
  ) / WORM_LOAD_SCALE;
  assert.equal(wormLoadFor(eggs, seed), expected);
  assert.equal(wormLoadFor(eggs, seed), wormLoadFor(eggs, seed), 'stable across calls');
  assert.equal(wormLoadFor([], seed), 0);
  assert.equal(wormLoadFor(null, seed), 0);
});

test('staggered worms count down alone: a late hatch never buries with an early one', () => {
  // Two worms mid-life with different remaining budgets; the heartbeat
  // steps both, and only the spent one buries — the other keeps crawling
  // on its own count.
  const worms = [
    { segments: [{ r: 0, c: 0 }], movesLeft: 1, nextMoveMs: 0 },  // on its last move
    { segments: [{ r: 3, c: 3 }], movesLeft: 40, nextMoveMs: 0 }, // mid-life
  ];
  const { burrowed } = tickWorms(worms, 250, () => null, mulberry32(41));
  assert.equal(burrowed.length, 1, 'only the spent worm buries');
  assert.equal(worms.length, 1);
  assert.equal(worms[0].movesLeft, 39, 'the survivor keeps its own countdown');
});

test('stepWorm moves the head only onto revealed cells; the body follows snake-style', () => {
  const worm = { segments: [{ r: 1, c: 1 }, { r: 1, c: 1 }], movesLeft: 5, nextMoveMs: 0 };
  const onlyEast = (r, c) => (r === 1 && c === 2 ? 0 : null);
  const moved = stepWorm(worm, onlyEast, mulberry32(7));
  assert.equal(moved, true);
  assert.deepEqual(worm.segments[0], { r: 1, c: 2 }, 'head takes the one revealed neighbor');
  assert.deepEqual(worm.segments[1], { r: 1, c: 1 }, 'body follows into the old head cell');
  assert.deepEqual(worm.lastDir, { dr: 0, dc: 1 }, 'the move sets the heading for momentum');
  assert.equal(worm.movesLeft, 4);
  assert.equal(worm.nextMoveMs, WORM_MOVE_BASE_MS * (worm.pace || 1), 'a fresh SET-cadence delay is applied');
});

test('momentum: about half the steps continue the last heading, even past the aversion', () => {
  // Head between open ground west (0) and heavy mine country east (4),
  // heading EAST. A persist roll under WORM_PERSIST_PROB keeps it going
  // east despite the aversion strongly preferring west.
  const field = (r, c) => {
    if (r !== 0) return null;
    if (c === 0) return 0;
    if (c === 2) return 4;
    return null;
  };
  const east = { segments: [{ r: 0, c: 1 }], movesLeft: 9, lastDir: { dr: 0, dc: 1 }, nextMoveMs: 0 };
  stepWorm(east, field, seqRng(WORM_PERSIST_PROB - 0.1, 0.5));
  assert.deepEqual(east.segments[0], { r: 0, c: 2 }, 'kept its heading into the 4');

  // A persist roll ABOVE the threshold falls through to the roulette,
  // where the first (tiny) draw lands on the better west cell. Heading
  // NORTH so west is a lateral turn, not a (suppressed) reversal.
  const turned = { segments: [{ r: 0, c: 1 }], movesLeft: 9, lastDir: { dr: -1, dc: 0 }, nextMoveMs: 0 };
  stepWorm(turned, field, seqRng(WORM_PERSIST_PROB + 0.1, 0.01, 0.5));
  assert.deepEqual(turned.segments[0], { r: 0, c: 0 }, 'roulette turned it toward open ground');
  assert.deepEqual(turned.lastDir, { dr: 0, dc: -1 }, 'the turn becomes the new heading');

  // Blocked ahead: the persist roll succeeds but the way is fog — falls
  // back to the roulette instead of stalling.
  const blocked = { segments: [{ r: 0, c: 1 }], movesLeft: 9, lastDir: { dr: 0, dc: 1 }, nextMoveMs: 0 };
  const westOnly = (r, c) => (r === 0 && c === 0 ? 0 : null);
  stepWorm(blocked, westOnly, seqRng(0.0, 0.5, 0.5));
  assert.deepEqual(blocked.segments[0], { r: 0, c: 0 }, 'blocked heading falls back to the roulette');

  // Boxed in entirely: stays put, spends the move, keeps its heading.
  const boxed = { segments: [{ r: 0, c: 0 }], movesLeft: 3, lastDir: { dr: 0, dc: 1 }, nextMoveMs: 0 };
  stepWorm(boxed, () => null, seqRng(0.0, 0.5));
  assert.equal(boxed.movesLeft, 2);
  assert.deepEqual(boxed.lastDir, { dr: 0, dc: 1 }, 'heading survives the wait');
});

test('backtracking is strongly downweighted: ~5% in a corridor, guaranteed at a dead end', () => {
  // Corridor: heading east, only forward and back are walkable. The
  // reverse candidate keeps 1/20 of its weight, so the roulette reverses
  // only when the draw lands in its ~4.8% sliver.
  const corridor = (r, c) => (r === 0 && (c === 0 || c === 2) ? 0 : null);
  const reversed = { segments: [{ r: 0, c: 1 }], movesLeft: 9, lastDir: { dr: 0, dc: 1 }, nextMoveMs: 0 };
  stepWorm(reversed, corridor, seqRng(WORM_PERSIST_PROB + 0.1, 0.03, 0.5));
  assert.deepEqual(reversed.segments[0], { r: 0, c: 0 }, 'a draw inside the sliver still reverses (never forbidden)');

  const pressedOn = { segments: [{ r: 0, c: 1 }], movesLeft: 9, lastDir: { dr: 0, dc: 1 }, nextMoveMs: 0 };
  stepWorm(pressedOn, corridor, seqRng(WORM_PERSIST_PROB + 0.1, 0.10, 0.5));
  assert.deepEqual(pressedOn.segments[0], { r: 0, c: 2 }, 'a draw outside the sliver presses on');

  // Dead end: reverse is the only walkable option — the worm takes it
  // (stuck means turn around, not freeze).
  const deadEnd = { segments: [{ r: 0, c: 1 }], movesLeft: 9, lastDir: { dr: 0, dc: 1 }, nextMoveMs: 0 };
  const onlyBack = (r, c) => (r === 0 && c === 0 ? 0 : null);
  stepWorm(deadEnd, onlyBack, seqRng(WORM_PERSIST_PROB + 0.1, 0.9, 0.5));
  assert.deepEqual(deadEnd.segments[0], { r: 0, c: 0 }, 'a dead end resolves by turning around');

  // Open field, seeded long run: reversals stay rare.
  const open = () => 0;
  const worm = { segments: [{ r: 0, c: 0 }], movesLeft: 9999, nextMoveMs: 0 };
  const rng = mulberry32(83);
  let reversals = 0;
  const MOVES = 500;
  for (let i = 0; i < MOVES; i++) {
    const before = worm.lastDir ? { ...worm.lastDir } : null;
    stepWorm(worm, open, rng);
    if (before && worm.lastDir.dr === -before.dr && worm.lastDir.dc === -before.dc) reversals++;
  }
  assert.ok(reversals / MOVES <= 0.05, `reversal rate ${reversals / MOVES} must stay at or under 5%`);
});

test('REGRESSION: the correlated walk actually travels (pure roulette paced in place)', () => {
  // Open field, everything walkable: over 80 moves the worm should tour,
  // not shuffle around its egg. Deterministic under the seeded rng; the
  // floors are loose so constant tuning cannot flake them.
  const open = () => 0;
  const worm = { segments: [{ r: 0, c: 0 }], movesLeft: 999, nextMoveMs: 0 };
  const rng = mulberry32(97);
  const visited = new Set(['0,0']);
  let maxDist = 0;
  for (let i = 0; i < 80; i++) {
    stepWorm(worm, open, rng);
    const h = worm.segments[0];
    visited.add(`${h.r},${h.c}`);
    maxDist = Math.max(maxDist, Math.abs(h.r) + Math.abs(h.c));
  }
  assert.ok(visited.size >= 30, `toured ${visited.size} distinct cells in 80 moves`);
  assert.ok(maxDist >= 8, `ranged ${maxDist} cells from the egg`);
});

test('a boxed-in worm stays put but still spends the move (no immortal squatter)', () => {
  const worm = { segments: [{ r: 0, c: 0 }, { r: 0, c: 0 }], movesLeft: 2, nextMoveMs: 0 };
  const moved = stepWorm(worm, () => null, mulberry32(3));
  assert.equal(moved, false);
  assert.deepEqual(worm.segments, [{ r: 0, c: 0 }, { r: 0, c: 0 }]);
  assert.equal(worm.movesLeft, 1, 'boxed-in turns still count toward burrowing');
});

test('self-overlap: the head may crawl back over its own body', () => {
  // Only two revealed cells exist; the head's sole revealed neighbor is a
  // cell its own body occupies — the move must still be legal.
  const worm = { segments: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 0 }], movesLeft: 5, nextMoveMs: 0 };
  const twoCells = (r, c) => (r === 0 && (c === 0 || c === 1) ? 1 : null);
  const moved = stepWorm(worm, twoCells, mulberry32(11));
  assert.equal(moved, true);
  assert.deepEqual(worm.segments[0], { r: 0, c: 1 }, 'head stacks onto its own body cell');
});

test('the walk is lightly biased: away from big numbers, toward open ground', () => {
  // Head between open ground (0) to the west and heavy mine country (4) to
  // the east. Aversion 0.7 weights them 1 vs 0.7^4 ≈ 0.24, so the expected
  // west rate is ~0.81. Deterministic under the seeded rng; the loose band
  // keeps the pin from being brittle to constant tuning (any aversion in
  // roughly (0.55, 0.85) stays inside it).
  const numberAt = (r, c) => {
    if (r !== 0) return null;
    if (c === 0) return 0;
    if (c === 2) return 4;
    return null;
  };
  const rng = mulberry32(29);
  const TRIALS = 500;
  let west = 0;
  for (let i = 0; i < TRIALS; i++) {
    const worm = { segments: [{ r: 0, c: 1 }, { r: 0, c: 1 }], movesLeft: 5, nextMoveMs: 0 };
    stepWorm(worm, numberAt, rng);
    if (worm.segments[0].c === 0) west++;
  }
  assert.ok(west / TRIALS > 0.6 && west / TRIALS < 0.95,
    `open ground should draw the worm most but not all of the time (west rate ${west / TRIALS})`);

  // Equal numbers on both sides: no systematic drift — the bias is about
  // mines, not direction.
  const flat = (r, c) => (r === 0 && (c === 0 || c === 2) ? 2 : null);
  const rng2 = mulberry32(31);
  let west2 = 0;
  for (let i = 0; i < TRIALS; i++) {
    const worm = { segments: [{ r: 0, c: 1 }, { r: 0, c: 1 }], movesLeft: 5, nextMoveMs: 0 };
    stepWorm(worm, flat, rng2);
    if (worm.segments[0].c === 0) west2++;
  }
  assert.ok(west2 / TRIALS > 0.4 && west2 / TRIALS < 0.6,
    `equal numbers must stay near-uniform (west rate ${west2 / TRIALS})`);
});

test('REGRESSION: a tiling worm crawls only to REVEALED graph neighbors (Coastline)', () => {
  // On a 4.8.8 tiling the worm walks the neighbor GRAPH, not a dr/dc step, so
  // every move must land on a graph neighbor of the previous head — including
  // moves onto the small interstitial SQUARES, which are graph-neighbors of the
  // octagons around them.
  const T = buildTiling488(4, 5);
  const { cols } = containerFor(T.total);
  const idxToRC = (i) => ({ r: Math.floor(i / cols), c: i % cols });
  const rcToIdx = (r, c) => r * cols + c;
  const topology = {
    neighborsOf: (r, c) => T.adj[rcToIdx(r, c)].map(idxToRC),
    posOf: (r, c) => { const p = T.cellPos[rcToIdx(r, c)]; return { x: p.cx, y: p.cy }; },
  };
  const numberAt = () => 0; // whole board revealed, no mines: always walkable
  const start = idxToRC(T.octIndex(1, 2));
  const worm = { segments: [{ ...start }, { ...start }, { ...start }], movesLeft: 60, pace: 1, nextMoveMs: 0 };
  const rng = mulberry32(7);
  let landedOnSquare = false;
  for (let step = 0; step < 60; step++) {
    const prev = { ...worm.segments[0] };
    stepWorm(worm, numberAt, rng, topology);
    const head = worm.segments[0];
    if (head.r === prev.r && head.c === prev.c) continue; // stayed put
    const nbrs = T.adj[rcToIdx(prev.r, prev.c)].map(idxToRC);
    assert.ok(nbrs.some(n => n.r === head.r && n.c === head.c),
      `step ${step}: head moved to a real graph neighbor of the previous head`);
    if (T.cellPos[rcToIdx(head.r, head.c)].shape === 'sq') landedOnSquare = true;
  }
  // Over 60 moves on a mixed lattice a worm should visit at least one square.
  assert.ok(landedOnSquare, 'a tiling worm crawls onto interstitial squares, not just octagons');
});

test('tickWorms advances clocks, steps due worms, and splices out burrowed ones', () => {
  const worms = [
    { segments: [{ r: 0, c: 0 }], movesLeft: 1, nextMoveMs: 200 }, // due this tick, last move
    { segments: [{ r: 0, c: 1 }], movesLeft: 5, nextMoveMs: 900 }, // not due
  ];
  const { moved, burrowed } = tickWorms(worms, 250, () => null, mulberry32(5));
  assert.equal(burrowed.length, 1, 'the spent worm burrows');
  assert.equal(worms.length, 1, 'burrowed worms are removed in place');
  assert.equal(worms[0].nextMoveMs, 650, 'a non-due worm only pays the tick');
  assert.equal(moved.length, 0, 'a boxed-in step is not a visual move');
});

test('rehydrateWorms restores segments + movesLeft with fresh clocks; drops spent or malformed worms', () => {
  const live = rehydrateWorms([
    { segments: [{ r: 1, c: 2 }, { r: 1, c: 3 }], movesLeft: 7 },
    { segments: [{ r: 0, c: 0 }], movesLeft: 0 },  // already spent
    { segments: [], movesLeft: 5 },                // malformed
    null,
  ], mulberry32(9));
  assert.equal(live.length, 1);
  assert.deepEqual(live[0].segments, [{ r: 1, c: 2 }, { r: 1, c: 3 }]);
  assert.equal(live[0].movesLeft, 7);
  assert.equal(live[0].nextMoveMs, WORM_MOVE_BASE_MS * (live[0].pace || 1));
  assert.deepEqual(rehydrateWorms(undefined), [], 'pre-worm saves rehydrate to no worms');
});

test('wormCoveredCells collapses self-overlapping segments to one key', () => {
  const covered = wormCoveredCells([
    { segments: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 0 }] },
    { segments: [{ r: 2, c: 2 }] },
  ]);
  assert.deepEqual([...covered].sort(), ['0,0', '0,1', '2,2']);
});

test('wormOverlayLayout maps segments to cell rects, flags the head, skips missing rects', () => {
  const worms = [{ segments: [{ r: 0, c: 1 }, { r: 0, c: 0 }, { r: 5, c: 5 }] }];
  const cellRect = (r, c) => (r > 1 ? null : { left: c * 30, top: r * 30, width: 30, height: 30 });
  const layout = wormOverlayLayout(worms, cellRect);
  assert.equal(layout.length, 2, 'the off-board segment is skipped');
  assert.deepEqual(layout[0], {
    wormIndex: 0, segIndex: 0, isHead: true, left: 30, top: 0, width: 30, height: 30,
  });
  assert.equal(layout[1].isHead, false);
});

// ── Hatch events (the realized-dose instrumentation) ────

test('wormHatchEvent embeds the seeded traits so the refit never re-derives them', () => {
  const seed = '2026-07-21:trial0';
  const ev = wormHatchEvent(42.7, 3, 5, seed);
  assert.equal(ev.t, 43, 'hatch time rounds to whole seconds');
  assert.equal(ev.r, 3);
  assert.equal(ev.c, 5);
  assert.equal(ev.len, wormLengthFor(seed, 3, 5));
  assert.equal(ev.life, wormLifetimeFor(seed, 3, 5));
  assert.equal(ev.pace, Math.round(wormPaceFor(seed, 3, 5) * 1000) / 1000);
  assert.equal(ev.moves, undefined, 'moves is stamped at burrow or finalize, not hatch');
});

test('burrow stamps the full budget; finalize computes exact moves for live worms', () => {
  const seed = '2026-07-21:trial0';
  const events = [wormHatchEvent(10, 3, 5, seed), wormHatchEvent(80, 7, 1, seed)];
  const wormA = hatchWorm(3, 5, seed, mulberry32(1));  // will burrow
  const wormB = hatchWorm(7, 1, seed, mulberry32(2));  // alive at game end
  wormB.movesLeft = wormB.movesLeft - 12;              // consumed 12 moves so far

  markWormBurrowed(events, wormA, 130.4);
  assert.equal(events[0].moves, events[0].life, 'a burrowed worm consumed its whole budget');
  assert.equal(events[0].tEnd, 130);

  const done = finalizeWormEvents(events, [wormB]);
  assert.equal(done[0].moves, done[0].life, 'the burrow stamp survives finalize');
  assert.equal(done[1].moves, 12, 'a live worm reports life - movesLeft, exact');
  assert.equal(done[1].tEnd, undefined, 'no burrow time for a worm alive at the end');
  // The realized dose the refit computes: Σ len × moves / 100 — always at
  // or below the scheduled wormLoad for these eggs.
  const realized = done.reduce((s, e) => s + e.len * e.moves, 0) / 100;
  const scheduled = wormLoadFor([{ r: 3, c: 5 }, { r: 7, c: 1 }], seed);
  assert.ok(realized > 0 && realized <= scheduled / WORM_PACE_MIN,
    `realized ${realized} bounded by the schedule`);
  // An event with neither stamp nor live worm counts its full budget
  // (conservative; only reachable through state loss).
  const orphan = finalizeWormEvents([wormHatchEvent(5, 0, 0, seed)], []);
  assert.equal(orphan[0].moves, orphan[0].life);
  assert.deepEqual(finalizeWormEvents(null, []), [], 'garbage in, empty out');
});

// ── Egg placement (applyGimmicks path) ──────────────────

function fixtureBoard() {
  const board = createEmptyBoard(6, 6);
  for (const [r, c] of [[0, 0], [3, 3], [5, 1], [1, 4]]) board[r][c].isMine = true;
  recalcAllAdjacency(board);
  return board;
}

function eggsOf(board) {
  const eggs = [];
  for (const row of board) for (const cell of row) if (cell.isWormEgg) eggs.push(cell);
  return eggs;
}

test('applyWorm places eggs only on plain numbered safe cells, capped at WORM_MAX_PER_BOARD', () => {
  const board = fixtureBoard();
  // L105 is mid intro block: raw intensity 3, inside the clamp.
  const applied = applyGimmicks(board, 105, ['worm'], mulberry32(11));
  const eggs = eggsOf(board);
  assert.ok(eggs.length >= 1, 'at least one egg lands');
  assert.ok(eggs.length <= WORM_MAX_PER_BOARD, 'egg count respects the clamp');
  assert.equal(eggs.length, applied.worm.length, 'applied record matches the board');
  for (const egg of eggs) {
    assert.equal(egg.isMine, false, 'eggs are safe-only');
    assert.ok(egg.adjacentMines > 0, 'eggs sit on numbered cells');
  }
});

test('eggs never stack on another gimmick\'s cell (worm runs LAST in ORDER)', () => {
  for (let seed = 0; seed < 10; seed++) {
    const board = fixtureBoard();
    applyGimmicks(board, 1, ['mystery', 'sonar', 'liar', 'worm'], mulberry32(100 + seed));
    for (const egg of eggsOf(board)) {
      assert.ok(!egg.isMystery && !egg.isSonar && !egg.isLiar && !egg.isCompass
        && !egg.isWormhole && !egg.mirrorPair && !egg.isLocked && !egg.isPressurePlate,
      `egg at (${egg.row},${egg.col}) stacked on another gimmick`);
    }
  }
});

test('clearGimmickProperties resets isWormEgg (retry loops leave no stale eggs)', () => {
  const cell = { isWormEgg: true };
  clearGimmickProperties(cell);
  assert.equal(cell.isWormEgg, false);
});

// ── The L101 capstone ladder ────────────────────────────

test('worm owns the L101-110 intro block: present on every board there', () => {
  const rng = mulberry32(17);
  for (let lv = 101; lv <= 110; lv++) {
    for (let i = 0; i < 20; i++) {
      assert.ok(getGimmicksForLevel(lv, rng).includes('worm'), `L${lv} must carry worm`);
    }
  }
});

test('L111-120 free-for-all: 1-3 introduced gimmicks, never chaos-only, guaranteed 3 at L120', () => {
  const rng = mulberry32(19);
  for (let lv = 111; lv <= 120; lv++) {
    for (let i = 0; i < 20; i++) {
      const picks = getGimmicksForLevel(lv, rng);
      assert.ok(picks.length >= 1 && picks.length <= 3, `L${lv}: ${picks.length} gimmicks`);
      assert.ok(!picks.includes('mineShift'), 'chaos-only never leaks into challenge');
    }
  }
  // progress hits 1.0 at L120: second and third gimmicks are both certain.
  for (let i = 0; i < 10; i++) {
    assert.equal(getGimmicksForLevel(120, mulberry32(300 + i)).length, 3);
  }
});

test('the capstone block keeps the sawtooth: intro dip at L101, density capped at 34%', () => {
  const d101 = getDifficultyForLevel(101);
  assert.equal(d101.rows, 11, 'intro drops the board to 11 wide');
  assert.equal(d101.cols, 11);
  for (const lv of [101, 110, 120]) {
    const d = getDifficultyForLevel(lv);
    assert.ok(d.mines <= Math.round(d.rows * d.cols * 0.34) + 1, `L${lv} density over the cap`);
  }
  assert.ok(getDifficultyForLevel(120).mines > d101.mines, 'the block ramps up toward L120');
});

// ── Segment size: the worm must read as a BODY, not a row of beads ─────────
//
// REGRESSION (2026-07-22, Christopher: "why does the worm motion look so much
// worse than the original?"): on the 6.6.6 honeycomb every segment was clamped
// to the 4.8.8 interstitial-square box — a shape that does not exist on a
// honeycomb — so segments were 0.78 of the distance to the next segment and the
// worm crawled as separated dots. Measured against the square grid, where a
// segment IS the cell rect and consecutive segments sit at 0.95 of the step.

test('wormSegmentSize keeps consecutive segments touching on every board shape', () => {
  const P = 50;

  // Square grid: null means "use each cell's own rect", which is what makes the
  // original worm continuous (cells are one grid-gap apart).
  assert.equal(wormSegmentSize(P, null), null, 'rectangular boards use the cell rect');

  // A honeycomb's six neighbours are all exactly ONE PITCH away, so the segment
  // must span a full pitch for consecutive segments to touch.
  const hex = wormSegmentSize(P, 'hex');
  const hexNeighbourStep = P;
  const hexContinuity = hex / hexNeighbourStep;
  assert.ok(hexContinuity >= 0.95,
    `hex worm must read as a body: continuity ${hexContinuity} (was 0.78 when clamped to the 4.8.8 square)`);
  assert.ok(hexContinuity <= 1.05, 'but not so large it spills out of the hexagon');

  // It is also exactly the hexagon's inscribed circle, so it fills its cell
  // without crossing an edge.
  assert.ok(Math.abs(hex - P) < 1e-9, 'hex segment == the hexagon inscribed circle (one pitch)');

  // 4.8.8 legitimately keeps the clamp — its cells really are two different
  // sizes, so an unclamped segment would pulse as the worm crawls.
  const oct = wormSegmentSize(P, '4.8.8');
  assert.ok(oct > 0 && oct < P, '4.8.8 stays clamped to the small interstitial square');
});

// REGRESSION (2026-07-27): the fix above was written as "hex gets a pitch-wide
// segment, everything else gets the 4.8.8 clamp", so when the four Laves tilings
// arrived they silently inherited a clamp shaped for an interstitial square none
// of them has. Measured at a 50px pitch: cairo 0.52 of its step, floret 0.43,
// rhombille 0.40, deltoidal 0.41 — gaps of 27 to 44px, three to four times worse
// than the honeycomb bug this section already exists for.
//
// The pin is deliberately DERIVED rather than a table of names: it walks every
// tiling the dispatcher registers, measures that tiling's own mean
// centre-to-centre step from its geometry, and requires the segment to span it.
// A seventh tiling added tomorrow is covered the day it is registered, which a
// hand-maintained list is exactly what failed to do twice.
test('REGRESSION: wormSegmentSize spans the step on EVERY registered tiling', () => {
  const P = 50;

  for (const type of TILING_TYPES) {
    const T = buildTiling(type, 6, 6);

    // Mean distance between adjacent cell centres, in pitch units, taken over
    // the real adjacency so it reflects what the worm actually crawls along.
    let sum = 0, n = 0;
    for (let i = 0; i < T.total; i++) {
      for (const j of T.adj[i]) {
        if (j <= i) continue;
        sum += Math.hypot(T.cellPos[i].cx - T.cellPos[j].cx, T.cellPos[i].cy - T.cellPos[j].cy);
        n++;
      }
    }
    const stepPx = (sum / n) * P;
    const size = wormSegmentSize(P, type);
    const continuity = size / stepPx;

    // 0.68 is the 4.8.8's own shipped ratio, which reads as a body: it is the
    // floor this lattice family has always been held to, not a fresh allowance.
    assert.ok(continuity >= 0.68,
      `${type}: segment ${size.toFixed(1)}px spans only ${continuity.toFixed(2)} of its `
      + `${stepPx.toFixed(1)}px step — the worm reads as beads`);

    // And never so wide it crosses its own cell edge.
    assert.ok(size <= P + 1e-9, `${type}: segment must stay inside the cell`);
  }
});

// ── Side-only crawl (Christopher's ruling, 2026-08-03, from the
// challenge-250 design interview: "worms shouldn't cross through corners,
// only through sides like in the classic tiling") ──────────────────────
//
// On the Laves lattices `_cellNeighbors` is corner-inclusive (the mine-count
// rule), but the worm is a physical crawler: buildWormCrawlTopology
// intersects the wireframe's side-sharing pairs with the live adjacency, so
// a Cubes rhombus offers 4 exits, not 10, and a wall-severed side stays
// uncrossable.

// A fully revealed fake tiling board over a real lattice: adjacency and
// geometry are the builder's own, cells are plain revealed zeros so every
// neighbor is walkable and only the topology constrains the walk.
function fakeTilingBoard(type, M, N, rows, cols) {
  const tiling = buildTiling(type, M, N);
  if (rows * cols !== tiling.total) throw new Error('container mismatch');
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push({ isRevealed: true, adjacentMines: 0 });
    board.push(row);
  }
  board._cellNeighbors = tiling.adj.map((l) => [...l]);
  board._cellPos = tiling.cellPos;
  board._tiling = { type, M, N };
  return { board, tiling };
}

function sidePairSet(tiling) {
  const pairs = new Set();
  for (const e of buildWireframe(tiling).edges) {
    pairs.add(`${Math.min(e.cellA, e.cellB)}:${Math.max(e.cellA, e.cellB)}`);
  }
  return pairs;
}

test('REGRESSION: worms crawl through shared SIDES only, never corners (rhombille)', () => {
  // rhombille 4x4 = 48 cells; container 6x8.
  const { board, tiling } = fakeTilingBoard('rhombille', 4, 4, 6, 8);
  const rows = 6, cols = 8;
  const sides = sidePairSet(tiling);

  // CONTROL 1 — the gate must have something to bite: this lattice's
  // adjacency really does carry corner-only links (they outnumber sides on
  // the 90-cell gate patch; plenty exist at 48 cells too).
  let cornerLinks = 0;
  tiling.adj.forEach((nbrs, i) => {
    for (const j of nbrs) if (i < j && !sides.has(`${i}:${j}`)) cornerLinks++;
  });
  assert.ok(cornerLinks >= 20, `rhombille must have corner-only links for this test to mean anything (got ${cornerLinks})`);

  const numberAt = (r, c) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return null;
    const cell = board[r] && board[r][c];
    return cell && cell.isRevealed ? (cell.adjacentMines || 0) : null;
  };

  // The crawl topology: every step the worm takes must be a side pair.
  const topo = buildWormCrawlTopology(board, rows, cols);
  assert.ok(topo, 'a tiling board yields a crawl topology');
  const rng = mulberry32(20260803);
  const worm = hatchWorm(2, 3, 'sidecrawl-test', rng);
  worm.movesLeft = 100000; // walk far beyond any budget — the pin is the path
  let moved = 0;
  for (let i = 0; i < 400; i++) {
    const before = { ...worm.segments[0] };
    if (stepWorm(worm, numberAt, rng, topo)) {
      const after = worm.segments[0];
      const a = before.r * cols + before.c;
      const b = after.r * cols + after.c;
      assert.ok(sides.has(`${Math.min(a, b)}:${Math.max(a, b)}`),
        `step ${i} crossed a non-side link: ${a} -> ${b}`);
      moved++;
    }
  }
  assert.ok(moved >= 300, `the worm must actually tour the board (moved ${moved})`);

  // CONTROL 2 — the break-test built in: the same walk on the RAW
  // corner-inclusive adjacency (the pre-ruling topology) crosses a corner
  // link almost immediately, so the pin above is not vacuously satisfied.
  const rawTopo = {
    neighborsOf: (r, c) => board._cellNeighbors[r * cols + c]
      .map((idx) => ({ r: Math.floor(idx / cols), c: idx % cols })),
    posOf: (r, c) => { const p = board._cellPos[r * cols + c]; return { x: p.cx, y: p.cy }; },
  };
  const rawRng = mulberry32(20260803);
  const rawWorm = hatchWorm(2, 3, 'sidecrawl-test', rawRng);
  rawWorm.movesLeft = 100000;
  let crossedCorner = false;
  for (let i = 0; i < 400 && !crossedCorner; i++) {
    const before = { ...rawWorm.segments[0] };
    if (stepWorm(rawWorm, numberAt, rawRng, rawTopo)) {
      const a = before.r * cols + before.c;
      const b = rawWorm.segments[0].r * cols + rawWorm.segments[0].c;
      if (!sides.has(`${Math.min(a, b)}:${Math.max(a, b)}`)) crossedCorner = true;
    }
  }
  assert.ok(crossedCorner, 'raw corner-inclusive adjacency must cross corners, or this gate tests nothing');
});

test('the side-crawl is a NO-OP on the trivalent tilings, honors walls, and skips rectangles', () => {
  // Honeycomb: every interior vertex has degree 3, so every neighbor is a
  // side neighbor — the crawl lists must equal the adjacency verbatim.
  const { board } = fakeTilingBoard('hex', 9, 7, 7, 9);
  const topo = buildWormCrawlTopology(board, 7, 9);
  for (let i = 0; i < 63; i++) {
    const r = Math.floor(i / 9), c = i % 9;
    const crawl = topo.neighborsOf(r, c).map((n) => n.r * 9 + n.c).sort((x, y) => x - y);
    assert.deepEqual(crawl, [...board._cellNeighbors[i]].sort((x, y) => x - y),
      `hex cell ${i}: side crawl must equal the adjacency on a trivalent lattice`);
  }

  // Walls: a side pair severed from the live adjacency (applyWallsTiling's
  // contract — a severed link is simply absent) must stay uncrossable even
  // though the wireframe knows the side exists.
  const { board: walled, tiling } = fakeTilingBoard('rhombille', 4, 4, 6, 8);
  const sides = sidePairSet(tiling);
  const [a, b] = [...sides][0].split(':').map(Number);
  walled._cellNeighbors[a] = walled._cellNeighbors[a].filter((x) => x !== b);
  walled._cellNeighbors[b] = walled._cellNeighbors[b].filter((x) => x !== a);
  const wTopo = buildWormCrawlTopology(walled, 6, 8);
  const aList = wTopo.neighborsOf(Math.floor(a / 8), a % 8).map((n) => n.r * 8 + n.c);
  assert.ok(!aList.includes(b), 'a wall-severed side must not be crawlable');

  // Rectangles carry no explicit topology: the builder returns null and
  // stepWorm keeps its dr/dc walk verbatim.
  assert.equal(buildWormCrawlTopology([[{ isRevealed: true }]], 1, 1), null);
});

// ── Visual-centre offsets + set pace (his petals report, 2026-08-03) ────

test('segment centres follow the VISUAL centre: asymmetric cells carry offsets, symmetric ones none', () => {
  const { board: floret } = (() => {
    const tiling = buildTiling('floret', 2, 4);
    const board = [];
    for (let r = 0; r < 6; r++) { const row = []; for (let c = 0; c < 8; c++) row.push({}); board.push(row); }
    board._cellNeighbors = tiling.adj;
    board._cellPos = tiling.cellPos;
    board._tiling = { type: 'floret', M: 2, N: 4 };
    return { board };
  })();
  const offs = wormCellCenterUnitOffsets(floret);
  assert.ok(offs && offs.length === 48);
  const maxOff = Math.max(...offs.map(o => Math.hypot(o.dx, o.dy)));
  // A floret pentagon's incircle centre sits ~0.25 pitch off its box centre.
  assert.ok(maxOff > 0.2, `floret must carry real centre offsets (max ${maxOff.toFixed(3)})`);

  const { board: hex } = (() => {
    const tiling = buildTiling('hex', 9, 7);
    const board = [];
    for (let r = 0; r < 7; r++) { const row = []; for (let c = 0; c < 9; c++) row.push({}); board.push(row); }
    board._cellNeighbors = tiling.adj;
    board._cellPos = tiling.cellPos;
    board._tiling = { type: 'hex', M: 9, N: 7 };
    return { board };
  })();
  const hexOffs = wormCellCenterUnitOffsets(hex);
  const hexMax = Math.max(...hexOffs.map(o => Math.hypot(o.dx, o.dy)));
  assert.ok(hexMax < 1e-9, `a hexagon's box centre IS its visual centre (max ${hexMax})`);

  assert.equal(wormCellCenterUnitOffsets([[{}]]), null, 'rectangles carry no descriptor and no offsets');

  // The layout applies the offset only alongside a uniform size.
  const worm = { segments: [{ r: 0, c: 0 }] };
  const rect = () => ({ left: 100, top: 100, width: 60, height: 50 });
  const plain = wormOverlayLayout([worm], rect, 40)[0];
  const shifted = wormOverlayLayout([worm], rect, 40, () => ({ dx: 7, dy: -3 }))[0];
  assert.equal(shifted.left, plain.left + 7);
  assert.equal(shifted.top, plain.top - 3);
  assert.equal(shifted.width, 40);
});

test('REGRESSION: set pace — every move of one worm ticks on the same fixed clock', () => {
  // His ruling 2026-08-03: cadence is fixed per worm (base x pace); only
  // direction stays luck. Two steps with completely different rngs must
  // produce the identical delay.
  const worm = hatchWorm(1, 1, 'set-pace-seed');
  const expected = WORM_MOVE_BASE_MS * worm.pace;
  assert.equal(worm.nextMoveMs, expected);
  stepWorm(worm, () => null, mulberry32(1));
  assert.equal(worm.nextMoveMs, expected, 'first step: same fixed delay');
  stepWorm(worm, () => null, mulberry32(999));
  assert.equal(worm.nextMoveMs, expected, 'different rng, same fixed delay — cadence carries no luck');
});
