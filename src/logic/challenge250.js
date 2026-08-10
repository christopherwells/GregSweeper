// Challenge 250 — the authored 50-block ladder (Christopher's design,
// 2026-08-03; the design authority is CHALLENGE_250_MAP.md at repo root).
//
// A level is a PAR RATING, not a fixed puzzle: its spec is {par-per-cell
// tier, shape, modifier set}, and every attempt draws a FRESH certified
// no-guess layout of the spec with the marked Start-here opener (no
// memorize-through). This module is the PURE spec table — it imports
// nothing, so UI surfaces and tests can read the ladder without touching
// the solver. The builder that turns a spec into a certified board lives
// in challenge250Builder.js; the offline proof that every authored spec
// generates inside the rulings lives in
// scripts/validate-challenge250-specs.mjs.
//
// The rulings the table implements (all his, 2026-08-03):
//   - Tier ladder T1 0.55 → T12 3.60 s/cell (numeric anchors adopted; the
//     summit moved 3.25 → 3.60 in his same-day second-pass ruling).
//   - Absolute par ceiling 8 minutes; difficulty is par-per-cell, never
//     raw par — no giant boards just to inflate time.
//   - THE 2-SECOND GENERATION CAP: no spec ships whose measured worst-case
//     generation exceeds 2s in the validator's own run (as measured, no
//     margin; jitter to under 3s on other runs is fine).
//   - Modifiers must be LOAD-BEARING on ladder boards: the strict filter,
//     no relax-to-ship (unlike the daily's budgeted escape).
//   - Opener blocks (1-5) are sized by the deduction-count floor (3-5 real
//     deductions; the floor is the per-draw gate, killing one-click
//     cascade levels) rather than by par-per-cell, which is only the
//     honest difficulty axis from ~48 cells up.
//   - Pressure plates retire from the ladder (Chaos-only); mineShift stays
//     Chaos-only.
//   - Blocks 51+ are the ENDLESS ZONE: unbounded above 3.6 s/cell, par
//     ceiling lifted to TEN minutes (his 2026-08-04 ruling), 2-second
//     generation cap unchanged. Built as a PROVEN POOL plus a
//     deterministic per-level draw (see ENDLESS_SPECS below) rather than
//     as more authored blocks, because a level number has no upper bound
//     and every ladder spec has to be proven before it ships.
//
// GIMMICK LEVEL UNITS: spec.gimmickLevel is measured in OLD-LADDER levels
// (11..120) because getIntensity's ramp is anchored on the old ladder's
// intro positions and its 120 cap — the same knob PR #224 threaded into
// generateTilingBoard, and the unit the proven Paving T12 spec (level 115)
// was measured in. It is an INTENSITY DIAL, not a ladder position; the
// C250 level number never feeds getIntensity.
//
// Three beat-text reconciliations (tier column wins over beat prose where
// the map disagrees with its own measured tables; flagged for Christopher
// in the build PR):
//   - Block 30 ("mirror+locked at 0.28"): Cubes 72c at 0.28 prices 1.56
//     plain — no stack reaches the T9 band from there. Authored at 0.306
//     (22 mines), which lands the band with the beat's own pairing.
//   - Block 33 ("12×12 toward 0.30"): 0.30 prices 1.93 — under the T10
//     band even stacked. Authored at 0.34 (49 mines), the sweep's rung.
//   - Block 43 ("84-cell + locked+sonar+walls"): the map's own proven-spec
//     table routes Paving's T12 through the 112-cell rung (3.41); 84c
//     stacked reaches only ~1.9. Authored at 112c, the proven spec.

import { LADDER_POOL, ENDLESS_POOL } from './challengePool.js';
import {
  PAR_CEILING_SECONDS, GEN_CAP_MS, GEN_CAP_PEAK_MS, GEN_SLOW_DRAW_RATE,
  ENDLESS_PAR_CEILING_SECONDS, ENDLESS_PAR_CEILING_BY_SHAPE, endlessParCeiling,
  ENDLESS_GEN_CAP_BY_SHAPE, endlessGenCap,
  ENDLESS_GEN_HEADROOM, ENDLESS_GEN_BUDGET_MS, endlessGenBudget,
  ENDLESS_PPC_FLOOR, ENDLESS_PPC_FLOOR_BY_SHAPE, endlessPpcFloor,
  specFace, specFingerprint,
} from './challengeRules.js';

// The rulings live in challengeRules.js (a leaf the pool-building tools can
// import without assembling the ladder); re-exported here so every existing
// reader of challenge250.js is unchanged.
export {
  PAR_CEILING_SECONDS, GEN_CAP_MS, GEN_CAP_PEAK_MS, GEN_SLOW_DRAW_RATE,
  ENDLESS_PAR_CEILING_SECONDS, ENDLESS_PAR_CEILING_BY_SHAPE, endlessParCeiling,
  ENDLESS_GEN_CAP_BY_SHAPE, endlessGenCap,
  ENDLESS_GEN_HEADROOM, ENDLESS_GEN_BUDGET_MS, endlessGenBudget,
  ENDLESS_PPC_FLOOR, ENDLESS_PPC_FLOOR_BY_SHAPE, endlessPpcFloor,
  specFace, specFingerprint,
};

export const CHALLENGE_MAX_LEVEL = 250;
export const CHALLENGE_BLOCK_SIZE = 5;
export const CHALLENGE_BLOCK_COUNT = 50;

// THE PROGRESSION EPOCH. Challenge 250 resets EVERYONE to L1 (his ruling:
// no memento of the old 120 climb), and the epoch marker is what keeps a
// stale device's pre-reset progress from resurrecting through the cloud
// max-merge (the moltDay date-anchored-snapshot lesson): maxCheckpoint and
// the power-up inventory are adopted from the cloud ONLY when the cloud
// snapshot carries THIS epoch. Pre-reset cloud writes have no epoch field
// at all, so they can never win; a stale device still running old code
// keeps writing epoch-less snapshots, which every current device ignores
// until that device updates and resets itself. Bump this number only for
// a future ladder-wide progression reset.
export const CHALLENGE_250_EPOCH = 1;

// Power-up earns per challenge win, by LEVEL BAND (his ruling
// 2026-08-04, after playing to L8 and earning nothing: "I should be
// earning 1 powerup at lvl 1-100, 2 200-250, and 3 above 250"). This
// REPLACED a tier-scaled expectation (tier/6 per win) that made the
// openers a near-dead zone — at T1 it paid out about one power-up every
// six wins, so eight levels of honest play could easily produce zero,
// which is exactly what happened. A flat guaranteed award per win is
// both more generous and more legible.
//
// The bands as stated leave 101-199 unnamed; read as three contiguous
// bands over a 250-level ladder plus endless, the only self-consistent
// reading is 1-100 / 101-250 / 251+, which is what ships.
export const POWERUP_BAND_1_MAX = 100;
export const POWERUP_BAND_2_MAX = CHALLENGE_MAX_LEVEL; // 250

export function powerUpAwardCount(level) {
  const lv = Math.max(1, Math.round(level || 1));
  if (lv <= POWERUP_BAND_1_MAX) return 1;
  if (lv <= POWERUP_BAND_2_MAX) return 2;
  return 3;
}

// A bonus lifeline on top of the banded award (his ruling: "an extra
// lifeline should be given at a 33% chance"). Restores the pre-C250
// lifeline roll, which the tier-scaled experiment had folded away, at
// his rate rather than the old 30%.
export const LIFELINE_BONUS_CHANCE = 0.33;

// The tier ladder (s/cell). Geometric ×~1.18 steps with the larger final
// step to the ruled summit.
export const TIER_PPC = {
  1: 0.55, 2: 0.65, 3: 0.75, 4: 0.90, 5: 1.05, 6: 1.25,
  7: 1.50, 8: 1.80, 9: 2.15, 10: 2.55, 11: 2.90, 12: 3.60,
};

// The validator's acceptance band around a level's stored price,
// multiplicative — and it is SYMMETRIC, unlike the [0.93, 1.11] it replaced.
//
// That asymmetry was right for the authored table and is wrong here. There, a
// spec was hand-tuned to hit a TIER TARGET and being a little hard was
// preferable to being a little easy, so the band leaned that way. Now the
// band sits around the spec's OWN measured price, and the only thing it can
// be testing is whether that stored price still describes the spec — for
// which a lean in either direction is just a bias in when it fires. Measured,
// it fired exactly that way: four levels failed a re-validation and every one
// of them failed LOW, none high.
//
// The width is set from the measurement's own precision rather than picked.
// Re-measuring the whole shipped pool at ten seeds and again at sixteen moved
// 2 of 495 and then 8 of 494 specs by more than 5%, so sample-to-sample
// movement past 5% runs under 2% of specs and past 12% is rarer still, while
// the drift this check exists to catch — a refit moving a shape's equation —
// moves prices by tens of percent. A band tighter than the noise is not a
// stricter test, it is a test of the seed sample.
export const PPC_BAND = 0.12;
export const PPC_BAND_LO = 1 - PPC_BAND;
export const PPC_BAND_HI = 1 + PPC_BAND;

// Opener blocks: every draw must need at least this many deductions past
// the opener click (check.totalClicks - 1). The 3-5 range in the map is
// the SIZING guidance; 3 is the per-draw floor that kills one-click
// cascades. The validator reports the median so sizing stays honest.
export const OPENER_MIN_DEDUCTIONS = 3;

// ── Spec constructors (internal shorthand) ─────────────────────────────
// A rect spec: rows×cols container, mines, authored gimmicks at an
// explicit intensity dial. A tiling spec: lattice dims M×N (per-tiling
// meaning), pinned cell count (verified against buildTiling in tests so
// the leaf module never imports geometry).
const R = (rows, cols, mines, gimmicks = [], opts = {}) =>
  ({ shape: 'rect', rows, cols, cells: rows * cols, mines, gimmicks, ...opts });

// Intensity dials, in old-ladder units (see header). INTRO_RAMP[g] gives a
// gentle 1,1,2,2,3 intensity ramp across a mod-intro block's five levels.
// Only the three OPENER modifiers keep a hand-written ramp; every later
// introduction is drawn from the pool, which carries its own measured dial.
const INTRO_RAMP = {
  walls: [11, 12, 13, 14, 16],
  liar: [21, 22, 23, 24, 26],
  mystery: [31, 32, 33, 34, 36],
};
const GL_GENTLE = 45;   // post-intro intensity ~1 for every type

// ── The 50-block map ───────────────────────────────────────────────────
// Levels are authored per block (5 each). `tier` is the map's plateau
// label; `ppc` is the numeric target the specs aim at — TIER_PPC[tier]
// everywhere except the six SHAPE-INTRO dips, where it is the shape's
// gentlest proven config (the quantified dip: the map's parenthesized
// tiers are narrative, the floor configs are the spec). `ppc: null` on
// the opener blocks: they validate on the deduction floor instead.
const OPENER_BLOCKS = [
  // ── Opener, L1-25, all Classic. AUTHORED, not drawn. ──
  // L1-10 RAMP (his ruling 2026-08-04, after playing it: "I want the
  // first 10 levels to be significantly easier. Perhaps a ramp up to 10
  // instead of a plateau. When I meant lvl 1 is a few clicks, I meant
  // just a few clicks"). The first authoring read the map's
  // 3-to-5-deductions line as a FLOOR and sized boards at 7x7-8x8, which
  // measured 15-39 deductions — a floor cannot make a board small, only
  // stop it being trivial. So these ten levels are sized DOWN to the
  // deduction count itself, and `maxDeductions` is the new dial: L1-2
  // cap at 5 real deductions, and the cap loosens by roughly two per
  // level until the ordinary floor-only regime resumes at L11.
  {
    block: 1, tier: 1, ppc: null, shape: 'rect',
    beat: 'First clicks. 5×5 growing to 6×6, a handful of deductions each.',
    levels: [
      R(5, 5, 3, [], { maxDeductions: 5 }),
      R(5, 5, 4, [], { maxDeductions: 5 }),
      R(6, 6, 5, [], { maxDeductions: 7 }),
      R(6, 6, 6, [], { maxDeductions: 9 }),
      R(6, 6, 7, [], { maxDeductions: 11 }),
    ],
  },
  {
    block: 2, tier: 1, ppc: null, shape: 'rect',
    beat: 'MOD INTRO: Walls. Still small; the wall as topology, not decoration.',
    levels: [
      R(6, 6, 6, ['walls'], { gimmickLevel: 11, wallSegments: 1, maxDeductions: 11 }),
      R(7, 7, 8, ['walls'], { gimmickLevel: 12, wallSegments: 1, maxDeductions: 13 }),
      R(7, 7, 9, ['walls'], { gimmickLevel: 13, wallSegments: 2, maxDeductions: 15 }),
      R(7, 7, 10, ['walls'], { gimmickLevel: 14, wallSegments: 2, maxDeductions: 17 }),
      R(8, 8, 12, ['walls'], { gimmickLevel: 16, wallSegments: 3, maxDeductions: 20 }),
    ],
  },
  {
    // The ramp keeps climbing THROUGH the liar intro (his 2026-08-04
    // follow-up: "the ramp is fine, but maybe smooth out the 10 to 15 a
    // little"). L10 lands at ~16 deductions and this block used to open
    // at ~24 on a 9x9 — a step big enough to read as a wall right where
    // a new modifier arrives. It now opens on the 8x8 the player just
    // finished and grows into the 9x9 across the block.
    block: 3, tier: 2, ppc: null, shape: 'rect',
    beat: 'MOD INTRO: Liar. The pink cell; ±1 as a disjunction.',
    levels: [
      R(8, 8, 11, ['liar'], { gimmickLevel: INTRO_RAMP.liar[0], maxDeductions: 22 }),
      R(8, 8, 12, ['liar'], { gimmickLevel: INTRO_RAMP.liar[1], maxDeductions: 24 }),
      R(9, 9, 14, ['liar'], { gimmickLevel: INTRO_RAMP.liar[2], maxDeductions: 27 }),
      R(9, 9, 15, ['liar'], { gimmickLevel: INTRO_RAMP.liar[3], maxDeductions: 30 }),
      R(9, 9, 16, ['liar'], { gimmickLevel: INTRO_RAMP.liar[4] }),
    ],
  },
  {
    block: 4, tier: 2, ppc: null, shape: 'rect',
    beat: 'MOD INTRO: Mystery. Information delayed; solving around a hole.',
    // Five DISTINCT boards, one lesson. The mine count is the lever, because
    // the block deliberately holds shape and modifier — his ruling is that a
    // training block MAY do that, but "they MUST not be the same board". This
    // block used to repeat 15 and 16 mines back to back, which reads as one
    // board twice however the intensity dial is set: a dial is not something
    // a player can see, which is exactly why uniqueness is judged on
    // specFace. Caught by that test, not by eye.
    levels: [
      R(9, 9, 14, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[0] }),
      R(9, 9, 15, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[1] }),
      R(9, 9, 16, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[2] }),
      R(9, 9, 17, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[3] }),
      R(9, 9, 18, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[4] }),
    ],
  },
  {
    block: 5, tier: 3, ppc: null, shape: 'rect',
    beat: 'Opener capstone: first 2-stacks of walls/liar/mystery. Checkpoint L25 = the door to the shapes.',
    levels: [
      R(9, 9, 16, ['walls', 'liar'], { gimmickLevel: GL_GENTLE, wallSegments: 2 }),
      R(9, 9, 16, ['walls', 'mystery'], { gimmickLevel: GL_GENTLE, wallSegments: 2 }),
      R(9, 9, 17, ['liar', 'mystery'], { gimmickLevel: GL_GENTLE }),
      R(10, 10, 20, ['walls', 'liar'], { gimmickLevel: GL_GENTLE, wallSegments: 2 }),
      R(10, 10, 21, ['liar', 'mystery'], { gimmickLevel: GL_GENTLE }),
    ],
  },

];

// ── The endless zone (blocks 51+) ───────────────────────────────
//
// His ruling (2026-08-03/04): past L250 the ladder is endless and UNBOUNDED
// ABOVE T12 — any certified spec at or above 3.6 s/cell, mixed board
// lengths, checkpoints every 5 banked forever, max level as the brag stat.
// The par ceiling lifts to ten minutes; the 2-second generation cap stands.
//
// WHY A POOL AND NOT A GENERATOR. Every spec on this ladder is offline-proven
// before it ships: certified, strictly load-bearing, inside the generation
// cap, inside the par ceiling. A level number has no upper bound, so an
// authored table cannot reach it — but neither can a free-parameter
// generator, which at level 1,000 would hand the player a (shape, size,
// density, stack) combination nobody has ever generated. So the zone is a
// POOL of proven specs plus a deterministic draw, the same architecture as
// TILING_BAND_CONFIGS and for the same reason.
//
// The pool comes from scripts/search-endless-specs.mjs, which sweeps
// candidate specs per shape and keeps only those where every draw over K
// seeds certifies. What ships is a log-spaced selection across each shape's
// own reachable range, so all seven shapes appear and the ladder always has
// a near neighbour at its current difficulty.
//
export const ENDLESS_START_LEVEL = CHALLENGE_MAX_LEVEL + 1;   // 251

// The endless pool now comes from the SAME search the ladder draws on
// (challengePool.js), sliced at the endless admission floor and each shape's
// own par ceiling. It used to be a hand-pasted table, which is why it drifted
// out of date twice: a refit re-prices every entry, and the wall sight-line
// fix (#269) left two entries over their generation cap with no way to remove
// them by hand — the rhombille one was the pool's entire rhombille
// representation, so dropping it would have deleted a shape. Regenerating
// both tables together is the answer to both.
export const ENDLESS_SPECS = ENDLESS_POOL;

/** Endless block index (0-based) for a level past the crown. */
function endlessBlockIndex(level) {
  return Math.floor((level - ENDLESS_START_LEVEL) / CHALLENGE_BLOCK_SIZE);
}

/**
 * THE ENDLESS ZONE DOES NOT SCALE (his ruling, 2026-08-07): "endless shouldn't
 * need to scale. its just supposed to be hard boards and variety and some can
 * be terribly hard."
 *
 * It used to compound the T12 summit by ENDLESS_PPC_GROWTH per block and clamp
 * to the pool's ceiling, which had two bad consequences and no good one. The
 * climb ran out around L336 and after that every block drew from the same
 * handful of hardest specs, so the zone got LESS varied exactly as it got
 * longer: measured over L500-750, 250 levels drew **15 distinct specs** and the
 * worst repeated **50 times**. That is the same complaint he raised at L65-70
 * ("I've played the same board 3 times"), at sixteen times the severity.
 *
 * And the climb was never the point. Past the crown the ladder has already
 * asked everything a difficulty curve can ask; what a player wants at L500 is
 * a different PROBLEM, not a bigger one. So every proven spec is drawable at
 * every level, the range of the pool IS the range of the zone, and a terribly
 * hard board is an occasional spike rather than the permanent state.
 *
 * Kept as an export because the validator and the endless report both read it
 * to describe the zone's reach; it now answers with the pool's own span.
 * @returns {{lo: number, hi: number}}
 */
export function endlessPpcRange() {
  const ppcs = ENDLESS_SPECS.map((e) => e.ppc);
  return { lo: Math.min(...ppcs), hi: Math.max(...ppcs) };
}

// FNV-1a, so the draw is deterministic from the level alone without this leaf
// module importing a PRNG. Determinism matters here for a specific reason: the
// BOARD varies per attempt (challengeBoardSeed carries per-draw entropy, so
// nothing can be memorised), but the SPEC must not, or "max level" stops being
// comparable between players and stops being the brag stat it is meant to be.
function hashLevel(level, salt) {
  let h = 0x811c9dc5;
  const str = `${level}:${salt}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// THE DRAW IS A DECK, not a hash pick per level.
//
// Hash-picking from the whole pool at every level is uniform only in
// expectation, and over a pool this size the variance is exactly the
// complaint it exists to answer: measured on the pool as it stands, 400
// levels left 5 specs never dealt at all while one came up 14 times against
// a fair share of 4. That is his L65-70 report again, in the zone whose
// entire remaining job is variety.
//
// So the pool is dealt like a deck: a seeded shuffle, walked in order, every
// entry appearing exactly once per cycle before any appears twice. Coverage
// and fair share are then properties of the structure rather than things to
// hope for and test after the fact.
//
// The shuffle is REPAIRED so that no group of five consecutive cards shares a
// shape while an unused one is still reachable — "mixed board lengths" is a
// property of the BLOCK. A repair is a swap, so it is still a permutation and
// the exact-coverage property survives it.
const _endlessDeck = (() => {
  // DEALT from per-shape queues, not shuffled-then-repaired. Repairing a flat
  // shuffle in place works at the head and starves the tail: the early
  // windows pull the scarce shapes forward, and with one shape holding a
  // third of the pool a late block came back three-shaped (measured at L326:
  // floret, deltoidal, cairo, floret, floret). Dealing makes the spread a
  // property of construction.
  const byShape = new Map();
  ENDLESS_SPECS.forEach((e, i) => {
    if (!byShape.has(e.shape)) byShape.set(e.shape, []);
    byShape.get(e.shape).push(i);
  });
  // Fisher-Yates within each shape, driven by the same FNV-1a the level draw
  // uses, so the deck is identical for every player without this leaf
  // importing a PRNG.
  for (const [shape, list] of byShape) {
    for (let i = list.length - 1; i > 0; i--) {
      const k = hashLevel(i, `deck:${shape}`) % (i + 1);
      [list[i], list[k]] = [list[k], list[i]];
    }
  }

  // PROPORTIONAL FAIR SCHEDULING, the classic one: each shape's next card is
  // "due" at (dealt + 0.5) / total of the way through the deck, and the
  // earliest-due shape is dealt next. That spaces every shape EVENLY across
  // the whole deck by construction, which is the property the window needs
  // and the one greedy rules kept failing to give.
  //
  // Two greedy rules were tried and both left a bad tail. "Most cards
  // remaining first" plus a never-twice-in-a-block exclusion cannot be
  // satisfied at all here — floret holds about a third of the endless pool
  // against rhombille's two entries — so floret's surplus went undealt until
  // the end and the deck finished on a run of florets. Ranking by recency
  // instead spread the doubling but still ran the scarce shapes out early,
  // leaving the last twenty cards drawn from two or three shapes. Measured
  // both times as a two-shape block at L346.
  const totals = new Map([...byShape].map(([sh, l]) => [sh, l.length]));
  const dealtCount = new Map([...byShape.keys()].map((sh) => [sh, 0]));
  const out = [];
  while (out.length < ENDLESS_SPECS.length) {
    let best = null, bestDue = Infinity;
    for (const [shape, list] of byShape) {
      if (!list.length) continue;
      const due = (dealtCount.get(shape) + 0.5) / totals.get(shape);
      if (due < bestDue || (due === bestDue && shape < best)) { bestDue = due; best = shape; }
    }
    out.push(byShape.get(best).shift());
    dealtCount.set(best, dealtCount.get(best) + 1);
  }

  // PAD TO A WHOLE NUMBER OF BLOCKS. The draw index is the level's distance
  // past the crown modulo the deck length, so unless that length divides the
  // block size the windows drift by two cards on every wrap and the shape
  // spread the dealing just guaranteed is lost from the second cycle on
  // (measured: a block down to two shapes within 200 blocks). The padding
  // cards are ordinary deals, chosen from the shapes the seam has not just
  // used and taking each shape's OLDEST card, so a handful of entries come
  // up twice per cycle rather than once — invisible against the fair-share
  // bar, where a two-shape block is not.
  const dealt = new Map();
  out.forEach((i, pos) => { const sh = ENDLESS_SPECS[i].shape; if (!dealt.has(sh)) dealt.set(sh, []); dealt.get(sh).push(pos); });
  while (out.length % CHALLENGE_BLOCK_SIZE !== 0) {
    // The pad sits at the SEAM, so it must avoid both the deck's tail and its
    // head — the wrap puts them in one window.
    const near = [
      ...out.slice(-(CHALLENGE_BLOCK_SIZE - 1)),
      ...out.slice(0, CHALLENGE_BLOCK_SIZE - 1),
    ].map((i) => ENDLESS_SPECS[i].shape);
    const shape = [...dealt.keys()].sort((x, y) =>
      near.filter((r) => r === x).length - near.filter((r) => r === y).length || (x < y ? -1 : 1))[0];
    out.push(out[dealt.get(shape).shift()]);
  }
  return out;
})();

// Memoised per block, since a block is resolved on every level lookup in it.
const _endlessBlockMemo = new Map();

function endlessBlock(blockStart) {
  const cached = _endlessBlockMemo.get(blockStart);
  if (cached) return cached;

  const out = [];
  for (let i = 0; i < CHALLENGE_BLOCK_SIZE; i++) {
    const level = blockStart + i;
    // The deck position is the level's own distance past the crown, so the
    // SPEC is fixed per level (max level stays comparable between players)
    // while the BOARD still varies per attempt.
    const draw = level - ENDLESS_START_LEVEL;
    const pick = ENDLESS_SPECS[_endlessDeck[((draw % _endlessDeck.length) + _endlessDeck.length) % _endlessDeck.length]];
    out.push(Object.freeze({
      level,
      block: Math.floor((level - 1) / CHALLENGE_BLOCK_SIZE) + 1,
      tier: 12,
      endless: true,
      ppc: pick.ppc,
      dip: false,
      shape: pick.shape,
      rows: pick.rows, cols: pick.cols, M: pick.M, N: pick.N,
      cells: pick.cells, mines: pick.mines,
      gimmicks: pick.gimmicks,
      gimmickLevel: pick.gimmickLevel,
      wallSegments: pick.wallSegments,
      constructive: pick.constructive,
    }));
  }
  const frozen = Object.freeze(out);
  _endlessBlockMemo.set(blockStart, frozen);
  return frozen;
}

/**
 * The spec for a level past the crown. Deterministic from the level alone.
 * @param {number} level >= ENDLESS_START_LEVEL
 */
export function endlessSpecForLevel(level) {
  const lv = Math.max(ENDLESS_START_LEVEL, Math.round(level));
  const blockStart = Math.floor((lv - 1) / CHALLENGE_BLOCK_SIZE) * CHALLENGE_BLOCK_SIZE + 1;
  return endlessBlock(blockStart)[lv - blockStart];
}

// ── THE EMERGENT BRAID, L26-250 ────────────────────────────────────────
//
// His design, 2026-08-08: past the opener the ladder is "a slow difficulty
// ramp" over "a decently wide but every increased width" band, with
// introductions that EMERGE from the material rather than being scheduled —
// "when enough boards can contain the gimmick, it should be introduced",
// "when enough boards can be a different shape, the shape should be
// introduced", and "once a board or gimmick is introduced, it gets played 5
// times, then any gimmick/shape can be brought in".
//
// So blocks 6-50 are no longer authored. Each block asks the pool what it can
// carry at that difficulty; a pending shape or modifier debuts on the first
// block that can give it a full five distinct boards, holds that block, and
// afterwards joins the general draw. Where each thing lands is DERIVED and
// moves when the pool or the par model moves — MOD_INTRO_BLOCKS and
// SHAPE_INTRO_BLOCKS are outputs now, not inputs.
//
// AND NOTHING EVER REPEATS. Uniqueness is judged on specFace — the shape,
// dimensions, mine count and modifier set a player can actually tell apart —
// never on specFingerprint, which separates dials nobody can see. The
// authored table this replaces carried 109 distinct boards across 250 levels
// and repeated its worst spec eight times, which is what he hit at L65-70.

export const BRAID_START_LEVEL = 26;
export const BRAID_START_BLOCK = 6;

// The ramp: par-per-cell from the opener's exit to the ruled T12 summit,
// geometric so every block is the same step up rather than a flattening one.
export const BRAID_PPC_START = 0.55;
export const BRAID_PPC_END = TIER_PPC[12];

// The band, a multiplicative half-width on the target that WIDENS with the
// climb. Both ends are judgement inside his ruling, and the reasoning for
// starting this wide is worth keeping: the old authored band was ±9/11%,
// tighter than the par model's own accuracy, and its only real property was
// that adjacent tiers did not overlap. That is the wrong thing to protect —
// the ramp lives in the band's CENTRE, nobody can feel a 10% par difference,
// and overlapping bands still climb monotonically on average.
export const BRAID_BAND_START = 0.18;
export const BRAID_BAND_END = 0.45;

// A debut runs exactly one block, so the lesson starts ON a checkpoint (death
// returns you to where the new thing was introduced, not into the middle of
// it) and the checkpoint selector has a block to label.
const INTRO_MIN_CANDIDATES = CHALLENGE_BLOCK_SIZE;

// How far a DEBUT check may widen the block's band looking for its five
// boards. The same ladder the per-level pick walks, truncated: an
// introduction reaching further than the boards around it would land the new
// thing at a difficulty the rest of the block does not share.
const DEBUT_STRETCH = [1, 1.35, 1.8];

// What the opener already teaches. The braid never re-introduces these.
const OPENER_SHAPES = ['rect'];
const OPENER_MODS = ['walls', 'liar', 'mystery'];

// What is left to introduce. This order breaks TIES ONLY — when two things
// first become viable in the same block. Which block each lands on comes from
// the pool.
const BRAID_SHAPES = ['hex', '4.8.8', 'cairo', 'rhombille', 'floret', 'deltoidal'];
const BRAID_MODS = ['locked', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];

/** Where the ramp is aiming at a level. */
export function braidTargetPpc(level) {
  const span = CHALLENGE_MAX_LEVEL - BRAID_START_LEVEL;
  const t = Math.min(1, Math.max(0, (level - BRAID_START_LEVEL) / span));
  return BRAID_PPC_START * Math.pow(BRAID_PPC_END / BRAID_PPC_START, t);
}

/** The widening band at a level, as [lo, hi] on par-per-cell. */
export function braidBand(level) {
  const span = CHALLENGE_MAX_LEVEL - BRAID_START_LEVEL;
  const t = Math.min(1, Math.max(0, (level - BRAID_START_LEVEL) / span));
  const half = BRAID_BAND_START + t * (BRAID_BAND_END - BRAID_BAND_START);
  const target = braidTargetPpc(level);
  return [target * (1 - half), target * (1 + half)];
}

/** Nearest authored tier to a measured rate — a display label, not a gate. */
function tierForPpc(ppc) {
  let best = 1, bestD = Infinity;
  for (const t of Object.keys(TIER_PPC)) {
    const d = Math.abs(Math.log(ppc / TIER_PPC[t]));
    if (d < bestD) { bestD = d; best = Number(t); }
  }
  return best;
}

// hashLevel (defined with the endless draw above) is shared: both draws need
// the same property, that the SPEC is fixed per level while the BOARD is not.

/**
 * Variety penalty for putting `entry` at `level`, given the run of levels
 * before it. Lower is better; the draw picks among the best-scoring
 * candidates, so this shapes the feel without collapsing the ladder onto one
 * board per difficulty.
 */
function varietyPenalty(entry, recent) {
  let p = 0;
  for (let k = 0; k < recent.length; k++) {
    const prev = recent[recent.length - 1 - k];
    if (!prev) continue;
    const decay = recent.length - k;
    if (k < 3 && prev.shape === entry.shape) p += 6 * decay;
    if (k < 5 && prev.gimmicks.join('+') === entry.gimmicks.join('+')) p += 4 * decay;
    if (k < 2) for (const g of entry.gimmicks) if (prev.gimmicks.includes(g)) p += decay;
  }
  return p;
}

/**
 * THE ASSIGNMENT. Runs once at module load over 225 levels — cheap, and it
 * has to be sequential, because "nothing repeats" and "a thing joins the
 * general draw after its debut" are both history-dependent.
 */
function assignBraid(pool, openerFaces) {
  const used = new Set(openerFaces);
  const shapesIn = new Set(OPENER_SHAPES);
  const modsIn = new Set(OPENER_MODS);
  const pendingShapes = BRAID_SHAPES.slice();
  const pendingMods = BRAID_MODS.slice();
  const modIntro = {};
  const shapeIntro = {};
  const out = [];
  const recent = [];

  // Only boards whose shape AND every modifier have already been introduced.
  const known = (e) => shapesIn.has(e.shape) && e.gimmicks.every((g) => modsIn.has(g));

  const pickOne = (level, eligible) => {
    // Widen out from the level's own band until something is available.
    // Widening is the honest failure mode: a pool thin at some difficulty
    // gives a board off-target rather than a repeat or a hole.
    const band = braidBand(level);
    for (const stretch of [1, 1.35, 1.8, 2.5, Infinity]) {
      const l = stretch === Infinity ? 0 : band[0] / stretch;
      const h = stretch === Infinity ? Infinity : band[1] * stretch;
      const cands = eligible.filter((e) => !used.has(e.face) && e.ppc >= l && e.ppc <= h);
      if (!cands.length) continue;
      let bestP = Infinity;
      for (const c of cands) { const p = varietyPenalty(c, recent); if (p < bestP) bestP = p; }
      const best = cands.filter((c) => varietyPenalty(c, recent) === bestP);
      return best[hashLevel(level, 'braid') % best.length];
    }
    return null;
  };

  for (let block = BRAID_START_BLOCK; block <= CHALLENGE_BLOCK_COUNT; block++) {
    const first = (block - 1) * CHALLENGE_BLOCK_SIZE + 1;
    const last = first + CHALLENGE_BLOCK_SIZE - 1;
    // How many unused boards matching a filter this block could reach, over
    // the SAME widening ladder the per-level pick uses. Judging a debut on
    // the strict band while picks are allowed to widen is what starved the
    // first cut: introductions stalled, the introduced pool ran dry, and the
    // assignment threw at L56.
    const reach = (filterFn) => {
      for (const stretch of DEBUT_STRETCH) {
        const l = braidBand(first)[0] / stretch;
        const h = braidBand(last)[1] * stretch;
        const c = pool.filter((e) => !used.has(e.face) && e.ppc >= l && e.ppc <= h && filterFn(e));
        if (c.length >= INTRO_MIN_CANDIDATES) return c;
      }
      return null;
    };
    const shapeCands = (shape) => reach((e) => e.shape === shape && e.gimmicks.every((g) => modsIn.has(g)));
    const modCands = (mod) => reach((e) => e.gimmicks.indexOf(mod) >= 0 && shapesIn.has(e.shape)
      && e.gimmicks.every((g) => g === mod || modsIn.has(g)));

    // Which KIND goes next alternates by how many of each has debuted, so
    // shapes and modifiers interleave instead of the six shapes arriving in
    // one run and the six modifiers in another. Within a kind the order is
    // the declared one, which breaks ties only.
    const shapesDone = BRAID_SHAPES.length - pendingShapes.length;
    const modsDone = BRAID_MODS.length - pendingMods.length;
    const kinds = shapesDone <= modsDone ? ['shape', 'mod'] : ['mod', 'shape'];

    let debut = null;
    let eligible = null;
    for (const kind of kinds) {
      const pending = kind === 'shape' ? pendingShapes : pendingMods;
      const cands = kind === 'shape' ? shapeCands : modCands;
      for (const key of pending) {
        const c = cands(key);
        if (c) { debut = { kind, key }; eligible = c; break; }
      }
      if (debut) break;
    }

    if (!debut) {
      eligible = pool.filter(known);
      // NOTHING NEW WAS VIABLE, and the introduced material cannot fill the
      // block either. That is precisely the signal to introduce something:
      // the alternative is repeating a board, which is the one thing the
      // ladder may not do. Take whichever pending thing the pool can supply
      // best, at any price under this block's own ceiling.
      const avail = eligible.filter((e) => !used.has(e.face));
      if (avail.length < CHALLENGE_BLOCK_SIZE) {
        const ceil = braidBand(last)[1] * DEBUT_STRETCH[DEBUT_STRETCH.length - 1];
        let bestN = 0;
        for (const kind of kinds) {
          const pending = kind === 'shape' ? pendingShapes : pendingMods;
          for (const key of pending) {
            const c = pool.filter((e) => !used.has(e.face) && e.ppc <= ceil && (kind === 'shape'
              ? e.shape === key && e.gimmicks.every((g) => modsIn.has(g))
              : e.gimmicks.indexOf(key) >= 0 && shapesIn.has(e.shape)
                && e.gimmicks.every((g) => g === key || modsIn.has(g))));
            if (c.length > bestN) { bestN = c.length; debut = { kind, key }; eligible = c; }
          }
        }
      }
    }

    for (let i = 0; i < CHALLENGE_BLOCK_SIZE; i++) {
      const level = first + i;
      // Last resort: any introduced board, nearest in price. Reached only if
      // the introduced pool is exhausted, which the test treats as a hard
      // failure rather than something to live with.
      const pick = pickOne(level, eligible) || pickOne(level, pool.filter(known));
      if (!pick) throw new Error('challenge ladder: pool exhausted at L' + level);
      used.add(pick.face);
      recent.push(pick);
      if (recent.length > 8) recent.shift();
      out.push(Object.freeze({
        level, block,
        tier: tierForPpc(pick.ppc),
        ppc: pick.ppc,
        dip: false,
        intro: debut ? debut.key : null,
        shape: pick.shape,
        rows: pick.rows, cols: pick.cols, M: pick.M, N: pick.N,
        cells: pick.cells, mines: pick.mines,
        gimmicks: pick.gimmicks,
        gimmickLevel: pick.gimmickLevel,
        wallSegments: pick.wallSegments,
        constructive: pick.constructive,
      }));
    }

    if (debut) {
      if (debut.kind === 'shape') {
        shapesIn.add(debut.key);
        pendingShapes.splice(pendingShapes.indexOf(debut.key), 1);
        shapeIntro[block] = debut.key;
      } else {
        modsIn.add(debut.key);
        pendingMods.splice(pendingMods.indexOf(debut.key), 1);
        modIntro[block] = debut.key;
      }
    }
  }
  return { levels: out, modIntro, shapeIntro, pendingShapes, pendingMods };
}

// ── Expansion + accessors ──────────────────────────────────────────────

// Opener blocks validate on the deduction floor, not the ppc band; stamp
// the per-draw floor onto their specs here rather than per level above.
for (const b of OPENER_BLOCKS) {
  if (b.ppc === null) {
    for (const spec of b.levels) spec.minDeductions = OPENER_MIN_DEDUCTIONS;
  }
}

const LEVEL_SPECS = [];
for (const b of OPENER_BLOCKS) {
  for (let i = 0; i < b.levels.length; i++) {
    const level = (b.block - 1) * CHALLENGE_BLOCK_SIZE + i + 1;
    const spec = {
      level, block: b.block, tier: b.tier, ppc: b.ppc, dip: b.dip === true,
      ...b.levels[i],
      gimmicks: (b.levels[i].gimmicks || []).slice(),
    };
    Object.freeze(spec.gimmicks);
    LEVEL_SPECS.push(Object.freeze(spec));
  }
}

const _braid = assignBraid(
  LADDER_POOL.map((e) => Object.freeze({ ...e, face: specFace(e) })),
  LEVEL_SPECS.map((s) => specFace(s)),
);
for (const spec of _braid.levels) LEVEL_SPECS.push(spec);
Object.freeze(LEVEL_SPECS);

/**
 * Where each modifier and shape debuts, by BLOCK. DERIVED from the pool (see
 * assignBraid) except for the three the opener teaches by hand. The
 * checkpoint selector labels its rows from these.
 */
export const MOD_INTRO_BLOCKS = Object.freeze(
  Object.assign({ 2: 'walls', 3: 'liar', 4: 'mystery' }, _braid.modIntro));
export const SHAPE_INTRO_BLOCKS = Object.freeze(Object.assign({}, _braid.shapeIntro));

/**
 * Anything the pool could never carry a debut for. EMPTY is the contract and
 * the test asserts it: a shape or modifier stranded here never appears on the
 * ladder at all, which is a pool problem to fix by searching wider, never
 * something to route around in the assignment.
 */
export const UNINTRODUCED = Object.freeze({
  shapes: Object.freeze(_braid.pendingShapes.slice()),
  gimmicks: Object.freeze(_braid.pendingMods.slice()),
});

export const CHALLENGE_BLOCKS = Object.freeze(
  Array.from({ length: CHALLENGE_BLOCK_COUNT }, (_, i) => {
    const block = i + 1;
    const authored = OPENER_BLOCKS.find((b) => b.block === block);
    if (authored) {
      return Object.freeze({
        block, tier: authored.tier, ppc: authored.ppc, shape: authored.shape,
        beat: authored.beat, dip: authored.dip === true,
      });
    }
    const levels = LEVEL_SPECS.filter((s) => s.block === block);
    const shapes = [...new Set(levels.map((s) => s.shape))];
    const intro = levels[0].intro;
    const target = braidTargetPpc(levels[0].level);
    return Object.freeze({
      block,
      tier: tierForPpc(target),
      ppc: Number(target.toFixed(2)),
      shape: shapes.length === 1 ? shapes[0] : 'mixed',
      beat: intro ? ('Introducing ' + intro + '.')
        : ('Drawn from the pool around ' + target.toFixed(2) + ' s/cell.'),
      dip: false,
    });
  }),
);

/**
 * The spec for a ladder level: the authored table through L250, then the
 * endless pool's draw. Levels below 1 clamp to 1; there is no upper clamp,
 * because the endless zone IS the upper end and it is unbounded by ruling.
 * @param {number} level
 * @returns {object} frozen spec: {level, block, tier, ppc, dip, shape,
 *   rows?, cols?, M?, N?, cells, mines, gimmicks, gimmickLevel?,
 *   wallSegments?, constructive?, minDeductions?, endless?, targetPpc?}
 */
export function challengeSpecForLevel(level) {
  const lv = Math.max(Math.round(level || 1), 1);
  if (lv > CHALLENGE_MAX_LEVEL) return endlessSpecForLevel(lv);
  return LEVEL_SPECS[lv - 1];
}

/**
 * First level of the block (= checkpoint = survival unit) containing a level.
 * Unbounded above: checkpoints keep landing every 5 and bank forever (his
 * ruling), which is also why users/{uid}/challenge250.maxCheckpoint carries
 * no upper bound in the rules.
 */
export function blockStartLevel(level) {
  const lv = Math.max(Math.round(level || 1), 1);
  return Math.floor((lv - 1) / CHALLENGE_BLOCK_SIZE) * CHALLENGE_BLOCK_SIZE + 1;
}

/**
 * The ppc acceptance band for a non-opener spec: [lo, hi] around the
 * block's authored target. Opener specs (ppc null) return null — they
 * validate on the deduction floor.
 */
export function ppcBandFor(spec) {
  if (spec.ppc == null) return null;
  return [spec.ppc * PPC_BAND_LO, spec.ppc * PPC_BAND_HI];
}
