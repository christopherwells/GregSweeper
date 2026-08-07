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

// Where each modifier and shape debuts, by BLOCK (the checkpoint selector
// labels its rows from these; the venues themselves are pinned
// independently in test/challenge250.test.mjs against the levels table).
export const MOD_INTRO_BLOCKS = Object.freeze({
  2: 'walls', 3: 'liar', 4: 'mystery', 7: 'locked', 10: 'wormhole',
  13: 'mirror', 16: 'sonar', 19: 'compass', 22: 'worm',
});
export const SHAPE_INTRO_BLOCKS = Object.freeze({
  6: 'hex', 9: '4.8.8', 12: 'rhombille', 15: 'cairo', 21: 'floret', 38: 'deltoidal',
});

// The tier ladder (s/cell). Geometric ×~1.18 steps with the larger final
// step to the ruled summit.
export const TIER_PPC = {
  1: 0.55, 2: 0.65, 3: 0.75, 4: 0.90, 5: 1.05, 6: 1.25,
  7: 1.50, 8: 1.80, 9: 2.15, 10: 2.55, 11: 2.90, 12: 3.60,
};

// Accept band around a block's authored par-per-cell target, multiplicative.
// At T12 this reproduces prove-t12-specs' [3.35, 4.0] summit band.
export const PPC_BAND_LO = 0.93;
export const PPC_BAND_HI = 1.11;

// The absolute par ceiling and the 2-second generation cap
// (validator-enforced; the cap is as-measured, no margin — his ruling).
export const PAR_CEILING_SECONDS = 480;
// The endless zone lifts the ceiling to TEN minutes (his ruling
// 2026-08-04, answering the map's one open flag: "in the endless zone it
// can go to 10 minutes"). The tier is unbounded above 3.6 s/cell there
// and the 2-second generation cap still stands. Recorded here so the
// endless build reads one constant rather than re-deriving the ruling.
export const ENDLESS_PAR_CEILING_SECONDS = 600;

// PER-SHAPE ceiling (his ruling 2026-08-04, after the four-shape pool came
// back without a square board in it): a shape that needs more room to reach
// the summit rate gets it. Classic takes +2 minutes, and Paving Stones takes
// the same because it has the identical problem.
//
// Why those two and only those two. The summit rate and the ceiling are two
// separate rulings, and for a gently-priced shape they intersect in a sliver:
// Classic and Paving Stones need ~150 cells to reach 3.6 s/cell at all, and
// 150 cells at that rate IS ten minutes, so every board of theirs that clears
// the rate measures 557-601s against a 600s ceiling. Twelve minutes gives
// them the headroom admission needs.
//
// 3D Cubes is NOT on this list, and raising its ceiling would not help: its
// qualifying boards already price 222-464s, comfortably under. Its blocker is
// generation time (2.1-9.8s against the 2-second cap), which is a different
// ruling and is not moved here.
export const ENDLESS_PAR_CEILING_BY_SHAPE = Object.freeze({
  rect: 720,
  cairo: 720,
  // Petals sits just under the standard ceiling the same way, one step
  // milder: its 72-cell boards price 7.6-7.9 s/cell at ~550s and were the
  // pool's whole top end until the headroom rule cut them. His ruling
  // 2026-08-04: +1 minute, not +2, because it needs less.
  floret: 660,
});

/** The endless par ceiling that applies to a shape. */
export function endlessParCeiling(shape) {
  return ENDLESS_PAR_CEILING_BY_SHAPE[shape] || ENDLESS_PAR_CEILING_SECONDS;
}
export const GEN_CAP_MS = 2000;

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
const T = (shape, M, N, cells, mines, gimmicks = [], opts = {}) =>
  ({ shape, M, N, cells, mines, gimmicks, ...opts });

// Intensity dials, in old-ladder units (see header). INTRO_RAMP[g] gives a
// gentle 1,1,2,2,3 intensity ramp across a mod-intro block's five levels.
const INTRO_RAMP = {
  walls: [11, 12, 13, 14, 16],
  liar: [21, 22, 23, 24, 26],
  mystery: [31, 32, 33, 34, 36],
  locked: [41, 42, 43, 44, 46],
  wormhole: [51, 52, 53, 54, 56],
  mirror: [61, 62, 63, 64, 66],
  sonar: [81, 82, 82, 83, 84],
  compass: [91, 92, 93, 94, 96],
  worm: [101, 102, 103, 104, 106],
};
const GL_GENTLE = 45;   // post-intro intensity ~1 for every type
const GL_MEDIUM = 80;   // ~2 for most types
const GL_HIGH = 115;    // ~3 (the old ladder's deep end; the proven Paving dial)

// ── The 50-block map ───────────────────────────────────────────────────
// Levels are authored per block (5 each). `tier` is the map's plateau
// label; `ppc` is the numeric target the specs aim at — TIER_PPC[tier]
// everywhere except the six SHAPE-INTRO dips, where it is the shape's
// gentlest proven config (the quantified dip: the map's parenthesized
// tiers are narrative, the floor configs are the spec). `ppc: null` on
// the opener blocks: they validate on the deduction floor instead.
const BLOCKS = [
  // ── Opener, L1-25, all Classic ──
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
    levels: [
      R(9, 9, 15, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[0] }),
      R(9, 9, 15, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[1] }),
      R(9, 9, 16, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[2] }),
      R(9, 9, 16, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[3] }),
      R(9, 9, 17, ['mystery'], { gimmickLevel: INTRO_RAMP.mystery[4] }),
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

  // ── The braid, L26-250 ──
  {
    block: 6, tier: 2, ppc: 0.55, shape: 'hex', dip: true,
    beat: 'SHAPE INTRO: Honeycomb. Plain hexes; L30 tease: walls.',
    levels: [
      T('hex', 7, 7, 49, 9), T('hex', 7, 7, 49, 9), T('hex', 7, 7, 49, 9),
      T('hex', 7, 7, 49, 9),
      T('hex', 7, 7, 49, 9, ['walls'], { gimmickLevel: GL_GENTLE }),
    ],
  },
  {
    block: 7, tier: 3, ppc: 0.75, shape: 'hex',
    beat: 'MOD INTRO: Locked (shape-neutral → most recent shape).',
    levels: [
      T('hex', 9, 7, 63, 14, ['locked'], { gimmickLevel: INTRO_RAMP.locked[0] }),
      T('hex', 9, 7, 63, 14, ['locked'], { gimmickLevel: INTRO_RAMP.locked[1] }),
      T('hex', 9, 7, 63, 14, ['locked'], { gimmickLevel: INTRO_RAMP.locked[2] }),
      T('hex', 9, 7, 63, 14, ['locked'], { gimmickLevel: INTRO_RAMP.locked[3] }),
      T('hex', 9, 7, 63, 14, ['locked'], { gimmickLevel: INTRO_RAMP.locked[4] }),
    ],
  },
  {
    block: 8, tier: 3, ppc: 0.75, shape: 'rect',
    beat: 'Remix: walls+liar and walls+mystery pairs at tier.',
    levels: [
      R(11, 11, 26, ['walls', 'liar'], { gimmickLevel: 47, wallSegments: 2 }),
      R(11, 11, 26, ['walls', 'mystery'], { gimmickLevel: 47, wallSegments: 2 }),
      R(11, 11, 27, ['walls', 'liar'], { gimmickLevel: 47, wallSegments: 2 }),
      R(11, 11, 26, ['walls', 'mystery'], { gimmickLevel: 47, wallSegments: 2 }),
      R(11, 11, 27, ['walls', 'liar'], { gimmickLevel: 47, wallSegments: 2 }),
    ],
  },
  {
    block: 9, tier: 3, ppc: 0.58, shape: '4.8.8', dip: true,
    beat: 'SHAPE INTRO: Octagons. Plain; L45 tease: mystery.',
    levels: [
      T('4.8.8', 5, 6, 50, 7), T('4.8.8', 5, 6, 50, 7), T('4.8.8', 5, 6, 50, 7),
      T('4.8.8', 5, 6, 50, 7),
      T('4.8.8', 5, 6, 50, 7, ['mystery'], { gimmickLevel: GL_GENTLE }),
    ],
  },
  {
    block: 10, tier: 4, ppc: 0.90, shape: '4.8.8',
    beat: 'MOD INTRO: Wormhole (mechanism venue: asymmetric pairs on the two cell sizes).',
    levels: [
      T('4.8.8', 6, 7, 72, 15, ['wormhole'], { gimmickLevel: INTRO_RAMP.wormhole[0] }),
      T('4.8.8', 6, 7, 72, 15, ['wormhole'], { gimmickLevel: INTRO_RAMP.wormhole[1] }),
      T('4.8.8', 6, 7, 72, 15, ['wormhole'], { gimmickLevel: INTRO_RAMP.wormhole[2] }),
      T('4.8.8', 6, 7, 72, 15, ['wormhole'], { gimmickLevel: INTRO_RAMP.wormhole[3] }),
      T('4.8.8', 6, 7, 72, 15, ['wormhole'], { gimmickLevel: INTRO_RAMP.wormhole[4] }),
    ],
  },
  {
    block: 11, tier: 4, ppc: 0.90, shape: 'hex',
    beat: 'Remix: locked+walls; first same-shape return.',
    levels: [
      T('hex', 9, 9, 81, 19, ['locked', 'walls'], { gimmickLevel: 75 }),
      T('hex', 9, 9, 81, 19, ['locked', 'walls'], { gimmickLevel: 75 }),
      T('hex', 9, 9, 81, 19, ['locked', 'walls'], { gimmickLevel: 75 }),
      T('hex', 9, 9, 81, 19, ['locked', 'walls'], { gimmickLevel: 75 }),
      T('hex', 9, 9, 81, 19, ['locked', 'walls'], { gimmickLevel: 75 }),
    ],
  },
  {
    block: 12, tier: 4, ppc: 0.98, shape: 'rhombille', dip: true,
    beat: 'SHAPE INTRO: 3D Cubes (floor ~0.98 lands the dip at T5-ish par on 48 cells). L60 tease: liar.',
    levels: [
      T('rhombille', 4, 4, 48, 11), T('rhombille', 4, 4, 48, 11),
      T('rhombille', 4, 4, 48, 11), T('rhombille', 4, 4, 48, 11),
      T('rhombille', 4, 4, 48, 11, ['liar'], { gimmickLevel: GL_GENTLE }),
    ],
  },
  {
    block: 13, tier: 5, ppc: 1.05, shape: 'rhombille',
    beat: 'MOD INTRO: Mirror (shape-neutral → most recent shape).',
    levels: [
      T('rhombille', 4, 5, 60, 14, ['mirror'], { gimmickLevel: INTRO_RAMP.mirror[0] }),
      T('rhombille', 4, 5, 60, 14, ['mirror'], { gimmickLevel: INTRO_RAMP.mirror[1] }),
      T('rhombille', 4, 5, 60, 14, ['mirror'], { gimmickLevel: INTRO_RAMP.mirror[2] }),
      T('rhombille', 4, 5, 60, 14, ['mirror'], { gimmickLevel: INTRO_RAMP.mirror[3] }),
      T('rhombille', 4, 5, 60, 14, ['mirror'], { gimmickLevel: INTRO_RAMP.mirror[4] }),
    ],
  },
  {
    block: 14, tier: 5, ppc: 1.05, shape: 'rect',
    beat: 'Remix: liar+locked, mystery+mirror.',
    levels: [
      R(11, 11, 31, ['liar', 'locked'], { gimmickLevel: 55 }),
      R(11, 11, 31, ['mystery', 'mirror'], { gimmickLevel: 55 }),
      R(11, 11, 31, ['liar', 'locked'], { gimmickLevel: 55 }),
      R(11, 11, 31, ['mystery', 'mirror'], { gimmickLevel: 55 }),
      R(11, 11, 31, ['liar', 'locked'], { gimmickLevel: 55 }),
    ],
  },
  {
    block: 15, tier: 5, ppc: 1.00, shape: 'cairo', dip: true,
    beat: 'SHAPE INTRO: Paving Stones. Plain pentagons; L75 tease: locked.',
    levels: [
      T('cairo', 5, 6, 49, 12), T('cairo', 5, 6, 49, 12), T('cairo', 5, 6, 49, 12),
      T('cairo', 5, 6, 49, 12),
      T('cairo', 5, 6, 49, 12, ['locked'], { gimmickLevel: 55 }),
    ],
  },
  {
    block: 16, tier: 6, ppc: 1.25, shape: 'cairo',
    beat: 'MOD INTRO: Sonar (mechanism venue: the valence-7 depth-2 ball).',
    levels: [
      // Five DISTINCT boards, one lesson — the block-3 pattern (his ruling,
      // 2026-08-07: a training block may hold shape and modifier, but "they
      // MUST not be the same board"). The 66-cell size these all shared is
      // gone for a second reason: cairo has 66 cells only at 4x10 or 10x4,
      // and both render 2.5:1.
      //
      // Variety here is the MINE COUNT rather than the size, because 60 is
      // cairo's only tier-6 size once sonar is on it: 49 cells price 1.15
      // against a 1.16 band floor, and 84 cells price 1.50-1.72 against a
      // 1.39 ceiling. Same lever block 3 uses.
      T('cairo', 6, 6, 60, 7, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[0], constructive: true }),
      T('cairo', 6, 6, 60, 10, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[1], constructive: true }),
      T('cairo', 6, 6, 60, 13, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[2], constructive: true }),
      T('cairo', 6, 6, 60, 16, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[3] }),
      T('cairo', 6, 6, 60, 19, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[4] }),
    ],
  },
  {
    block: 17, tier: 6, ppc: 1.25, shape: '4.8.8',
    beat: 'Remix: wormhole+locked.',
    levels: [
      T('4.8.8', 8, 7, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 8, 7, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 8, 7, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 8, 7, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 8, 7, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
    ],
  },
  {
    block: 18, tier: 6, ppc: 1.25, shape: 'rhombille',
    beat: 'Remix: mirror+walls, density up (Cubes’ lever).',
    levels: [
      T('rhombille', 4, 5, 60, 16, ['mirror', 'walls'], { gimmickLevel: 70 }),
      T('rhombille', 4, 5, 60, 16, ['mirror', 'walls'], { gimmickLevel: 70 }),
      T('rhombille', 4, 5, 60, 16, ['mirror', 'walls'], { gimmickLevel: 70 }),
      T('rhombille', 4, 5, 60, 16, ['mirror', 'walls'], { gimmickLevel: 70 }),
      T('rhombille', 4, 5, 60, 16, ['mirror', 'walls'], { gimmickLevel: 70 }),
    ],
  },
  {
    block: 19, tier: 7, ppc: 1.50, shape: '4.8.8',
    beat: 'MOD INTRO: Compass (8-way family; the diagonal ray reads as steps along the octagon/square staircase).',
    levels: [
      T('4.8.8', 8, 7, 98, 24, ['compass'], { gimmickLevel: INTRO_RAMP.compass[0] }),
      T('4.8.8', 8, 7, 98, 24, ['compass'], { gimmickLevel: INTRO_RAMP.compass[1] }),
      T('4.8.8', 8, 7, 98, 23, ['compass'], { gimmickLevel: INTRO_RAMP.compass[2] }),
      T('4.8.8', 8, 7, 98, 23, ['compass'], { gimmickLevel: INTRO_RAMP.compass[3] }),
      T('4.8.8', 8, 7, 98, 23, ['compass'], { gimmickLevel: INTRO_RAMP.compass[4] }),
    ],
  },
  {
    block: 20, tier: 7, ppc: 1.50, shape: 'rect',
    beat: 'Remix: sonar+compass join the home-turf pool. Milestone L100.',
    levels: [
      R(12, 12, 40, ['sonar', 'liar'], { gimmickLevel: 95 }),
      R(12, 12, 40, ['compass', 'walls'], { gimmickLevel: 110, wallSegments: 3 }),
      R(12, 12, 39, ['sonar', 'mystery'], { gimmickLevel: 95 }),
      R(12, 12, 40, ['compass', 'liar'], { gimmickLevel: 105 }),
      R(12, 12, 38, ['sonar', 'compass'], { gimmickLevel: 105 }),
    ],
  },
  {
    block: 21, tier: 7, ppc: 1.14, shape: 'floret', dip: true,
    beat: 'SHAPE INTRO: Petals (floor ~1.14). Plain pinwheels; L105 tease: walls.',
    levels: [
      T('floret', 2, 3, 36, 6, [], { constructive: true }),
      T('floret', 2, 3, 36, 6, [], { constructive: true }),
      T('floret', 2, 3, 36, 6, [], { constructive: true }),
      T('floret', 2, 3, 36, 6, [], { constructive: true }),
      T('floret', 2, 3, 36, 6, ['walls'], { gimmickLevel: GL_GENTLE, constructive: true }),
    ],
  },
  {
    block: 22, tier: 8, ppc: 1.80, shape: 'hex',
    beat: 'MOD INTRO: Worm (mechanism venue: the purest six-exit crawl, side-only per the shipped ruling).',
    levels: [
      T('hex', 9, 9, 81, 26, ['worm'], { gimmickLevel: INTRO_RAMP.worm[0] }),
      T('hex', 9, 9, 81, 26, ['worm'], { gimmickLevel: INTRO_RAMP.worm[1] }),
      T('hex', 9, 9, 81, 26, ['worm'], { gimmickLevel: INTRO_RAMP.worm[2] }),
      T('hex', 9, 9, 81, 26, ['worm'], { gimmickLevel: INTRO_RAMP.worm[3] }),
      T('hex', 9, 9, 81, 26, ['worm'], { gimmickLevel: INTRO_RAMP.worm[4] }),
    ],
  },
  {
    block: 23, tier: 8, ppc: 1.80, shape: 'cairo',
    beat: 'Remix: sonar+liar on the 84-cell board (Paving’s size lever).',
    levels: [
      T('cairo', 7, 7, 84, 20, ['sonar', 'liar'], { gimmickLevel: 110 }),
      T('cairo', 7, 7, 84, 20, ['sonar', 'liar'], { gimmickLevel: 110 }),
      T('cairo', 7, 7, 84, 20, ['sonar', 'liar'], { gimmickLevel: 110 }),
      T('cairo', 7, 7, 84, 20, ['sonar', 'liar'], { gimmickLevel: 110 }),
      T('cairo', 7, 7, 84, 20, ['sonar', 'liar'], { gimmickLevel: 110 }),
    ],
  },
  {
    block: 24, tier: 8, ppc: 1.80, shape: 'floret',
    beat: 'Remix: walls+mystery on the rosettes.',
    levels: [
      T('floret', 2, 4, 48, 13, ['walls', 'mystery'], { gimmickLevel: 70 }),
      T('floret', 2, 4, 48, 13, ['walls', 'mystery'], { gimmickLevel: 70 }),
      T('floret', 2, 4, 48, 13, ['walls', 'mystery'], { gimmickLevel: 70 }),
      T('floret', 2, 4, 48, 13, ['walls', 'mystery'], { gimmickLevel: 70 }),
      T('floret', 2, 4, 48, 13, ['walls', 'mystery'], { gimmickLevel: 70 }),
    ],
  },
  {
    block: 25, tier: 8, ppc: 1.80, shape: 'rhombille',
    beat: 'REPRISE: Wormhole (sum ceiling 20; the two-token extreme).',
    levels: [
      T('rhombille', 4, 5, 60, 19, ['wormhole'], { gimmickLevel: 110 }),
      T('rhombille', 4, 5, 60, 19, ['wormhole'], { gimmickLevel: 110 }),
      T('rhombille', 4, 5, 60, 19, ['wormhole'], { gimmickLevel: 110 }),
      T('rhombille', 4, 5, 60, 19, ['wormhole'], { gimmickLevel: 110 }),
      T('rhombille', 4, 5, 60, 19, ['wormhole'], { gimmickLevel: 110 }),
    ],
  },
  {
    block: 26, tier: 9, ppc: 2.15, shape: 'rect',
    beat: 'Remix: 2-stacks on a dense 11×11.',
    levels: [
      R(11, 11, 44, ['mystery', 'liar'], { gimmickLevel: GL_MEDIUM }),
      R(11, 11, 44, ['walls', 'locked'], { gimmickLevel: GL_MEDIUM, wallSegments: 3 }),
      R(11, 11, 44, ['liar', 'mirror'], { gimmickLevel: GL_MEDIUM }),
      R(11, 11, 44, ['mystery', 'locked'], { gimmickLevel: GL_MEDIUM }),
      R(11, 11, 44, ['walls', 'liar'], { gimmickLevel: GL_MEDIUM, wallSegments: 3 }),
    ],
  },
  {
    block: 27, tier: 9, ppc: 2.15, shape: 'hex',
    beat: 'Remix: worm+walls (the crawl in corridors).',
    levels: [
      T('hex', 9, 9, 81, 27, ['worm', 'walls'], { gimmickLevel: 108 }),
      T('hex', 9, 9, 81, 27, ['worm', 'walls'], { gimmickLevel: 108 }),
      T('hex', 9, 9, 81, 27, ['worm', 'walls'], { gimmickLevel: 108 }),
      T('hex', 9, 9, 81, 27, ['worm', 'walls'], { gimmickLevel: 108 }),
      T('hex', 9, 9, 81, 27, ['worm', 'walls'], { gimmickLevel: 108 }),
    ],
  },
  {
    block: 28, tier: 9, ppc: 2.15, shape: 'rhombille',
    beat: 'REPRISE: Sonar (valence-10 ball, ~31 cells; structural relief on the no-subset lattice).',
    levels: [
      T('rhombille', 4, 5, 60, 19, ['sonar'], { gimmickLevel: 100 }),
      T('rhombille', 4, 5, 60, 19, ['sonar'], { gimmickLevel: 100 }),
      T('rhombille', 4, 5, 60, 19, ['sonar'], { gimmickLevel: 100 }),
      T('rhombille', 4, 5, 60, 19, ['sonar'], { gimmickLevel: 100 }),
      T('rhombille', 4, 5, 60, 19, ['sonar'], { gimmickLevel: 100 }),
    ],
  },
  {
    block: 29, tier: 9, ppc: 2.15, shape: '4.8.8',
    beat: 'Remix: compass+mirror.',
    levels: [
      T('4.8.8', 8, 7, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
    ],
  },
  {
    block: 30, tier: 9, ppc: 2.15, shape: 'rhombille',
    beat: 'Remix: mirror+locked, density up. Milestone L150. (Beat text said 0.28; T9 needs ~0.31 — flagged.)',
    levels: [
      T('rhombille', 6, 4, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 6, 4, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 6, 4, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 6, 4, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 6, 4, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
    ],
  },
  {
    block: 31, tier: 10, ppc: 2.55, shape: 'hex',
    beat: 'REPRISE: Compass 60° (the six-axis family on the lattice that defined it).',
    levels: [
      T('hex', 11, 10, 110, 33, ['compass'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 33, ['compass'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 33, ['compass'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 33, ['compass'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 33, ['compass'], { gimmickLevel: GL_HIGH }),
    ],
  },
  {
    block: 32, tier: 10, ppc: 2.55, shape: 'floret',
    beat: 'Remix: sonar+liar on the pinwheel.',
    levels: [
      T('floret', 3, 4, 72, 19, ['sonar', 'liar'], { gimmickLevel: 100 }),
      T('floret', 3, 4, 72, 19, ['sonar', 'liar'], { gimmickLevel: 100 }),
      T('floret', 3, 4, 72, 19, ['sonar', 'liar'], { gimmickLevel: 100 }),
      T('floret', 3, 4, 72, 19, ['sonar', 'liar'], { gimmickLevel: 100 }),
      T('floret', 3, 4, 72, 19, ['sonar', 'liar'], { gimmickLevel: 100 }),
    ],
  },
  {
    block: 33, tier: 10, ppc: 2.55, shape: 'rect',
    beat: 'Remix: 2-stacks, dense 12×12. (Beat text said toward 0.30; T10 needs 0.34 — flagged.)',
    levels: [
      R(12, 12, 49, ['locked', 'liar'], { gimmickLevel: 90 }),
      R(12, 12, 49, ['mystery', 'mirror'], { gimmickLevel: 90 }),
      R(12, 12, 49, ['walls', 'locked'], { gimmickLevel: 90, wallSegments: 4 }),
      R(12, 12, 49, ['liar', 'mirror'], { gimmickLevel: 90 }),
      R(12, 12, 49, ['locked', 'liar'], { gimmickLevel: 90 }),
    ],
  },
  {
    block: 34, tier: 10, ppc: 2.55, shape: 'floret',
    beat: 'REPRISE: Worm (the rotated-pinwheel crawl; heavy realized load).',
    levels: [
      T('floret', 3, 4, 72, 20, ['worm'], { gimmickLevel: 118 }),
      T('floret', 3, 4, 72, 20, ['worm'], { gimmickLevel: 118 }),
      T('floret', 3, 4, 72, 20, ['worm'], { gimmickLevel: 118 }),
      T('floret', 3, 4, 72, 20, ['worm'], { gimmickLevel: 118 }),
      T('floret', 3, 4, 72, 20, ['worm'], { gimmickLevel: 118 }),
    ],
  },
  {
    block: 35, tier: 10, ppc: 2.55, shape: 'cairo',
    beat: 'Remix: compass+locked on the big board.',
    levels: [
      T('cairo', 8, 8, 112, 27, ['compass', 'locked'], { gimmickLevel: 100 }),
      T('cairo', 8, 8, 112, 27, ['compass', 'locked'], { gimmickLevel: 100 }),
      T('cairo', 8, 8, 112, 27, ['compass', 'locked'], { gimmickLevel: 100 }),
      T('cairo', 8, 8, 112, 27, ['compass', 'locked'], { gimmickLevel: 100 }),
      T('cairo', 8, 8, 112, 27, ['compass', 'locked'], { gimmickLevel: 100 }),
    ],
  },
  {
    block: 36, tier: 11, ppc: 2.90, shape: 'hex',
    beat: 'Remix: density push past 0.28, 2-stacks.',
    levels: [
      T('hex', 11, 10, 110, 35, ['mystery', 'liar'], { gimmickLevel: 85 }),
      T('hex', 11, 10, 110, 35, ['mystery', 'walls'], { gimmickLevel: 85 }),
      T('hex', 11, 10, 110, 35, ['liar', 'walls'], { gimmickLevel: 85 }),
      T('hex', 11, 10, 110, 35, ['mystery', 'liar'], { gimmickLevel: 85 }),
      T('hex', 11, 10, 110, 35, ['mystery', 'walls'], { gimmickLevel: 85 }),
    ],
  },
  {
    block: 37, tier: 11, ppc: 2.90, shape: 'floret',
    beat: 'REPRISE: Compass 30° (the due-north family; Kites arrives next block, so Petals hosts).',
    levels: [
      T('floret', 3, 4, 72, 21, ['compass'], { gimmickLevel: GL_HIGH }),
      T('floret', 3, 4, 72, 21, ['compass'], { gimmickLevel: GL_HIGH }),
      T('floret', 3, 4, 72, 21, ['compass'], { gimmickLevel: GL_HIGH }),
      T('floret', 3, 4, 72, 21, ['compass'], { gimmickLevel: GL_HIGH }),
      T('floret', 3, 4, 72, 21, ['compass'], { gimmickLevel: GL_HIGH }),
    ],
  },
  {
    block: 38, tier: 9, ppc: 1.75, shape: 'deltoidal', dip: true,
    beat: 'SHAPE INTRO: Kites, the one late intro with a real dip. Plain kites at the 36-cell floor; L190 tease: mystery.',
    levels: [
      T('deltoidal', 2, 3, 36, 6, [], { constructive: true }),
      T('deltoidal', 2, 3, 36, 6, [], { constructive: true }),
      T('deltoidal', 2, 3, 36, 6, [], { constructive: true }),
      T('deltoidal', 2, 3, 36, 6, [], { constructive: true }),
      T('deltoidal', 2, 3, 36, 6, ['mystery'], { gimmickLevel: GL_GENTLE, constructive: true }),
    ],
  },
  {
    block: 39, tier: 11, ppc: 2.90, shape: 'deltoidal',
    beat: 'Consolidation: density-boosted (Kites’ lever), one modifier.',
    levels: [
      T('deltoidal', 2, 3, 36, 10, ['mystery'], { gimmickLevel: 70 }),
      T('deltoidal', 2, 3, 36, 10, ['liar'], { gimmickLevel: 70 }),
      T('deltoidal', 2, 3, 36, 10, ['mystery'], { gimmickLevel: 70 }),
      T('deltoidal', 2, 3, 36, 10, ['liar'], { gimmickLevel: 70 }),
      T('deltoidal', 2, 3, 36, 10, ['walls'], { gimmickLevel: 70 }),
    ],
  },
  {
    block: 40, tier: 11, ppc: 2.90, shape: 'rect',
    beat: '3-STACK DEBUT on home turf. Milestone L200.',
    levels: [
      R(11, 11, 48, ['walls', 'liar', 'locked'], { gimmickLevel: 90, wallSegments: 3 }),
      R(11, 11, 49, ['mystery', 'mirror', 'liar'], { gimmickLevel: 90 }),
      R(11, 11, 49, ['locked', 'mystery', 'mirror'], { gimmickLevel: 90 }),
      R(11, 11, 49, ['walls', 'liar', 'mystery'], { gimmickLevel: 90, wallSegments: 3 }),
      R(11, 11, 50, ['liar', 'mirror', 'walls'], { gimmickLevel: 90, wallSegments: 3 }),
    ],
  },
  {
    block: 41, tier: 11, ppc: 2.90, shape: 'rhombille',
    beat: '3-stacks: sonar+mirror+walls.',
    levels: [
      T('rhombille', 5, 5, 75, 23, ['sonar', 'mirror', 'walls'], { gimmickLevel: 120 }),
      T('rhombille', 5, 5, 75, 23, ['sonar', 'mirror', 'walls'], { gimmickLevel: 120 }),
      T('rhombille', 5, 5, 75, 23, ['sonar', 'mirror', 'walls'], { gimmickLevel: 120 }),
      T('rhombille', 5, 5, 75, 23, ['sonar', 'mirror', 'walls'], { gimmickLevel: 120 }),
      T('rhombille', 5, 5, 75, 23, ['sonar', 'mirror', 'walls'], { gimmickLevel: 120 }),
    ],
  },
  {
    block: 42, tier: 12, ppc: 3.60, shape: '4.8.8',
    beat: '3-stacks: wormhole+compass+locked.',
    levels: [
      T('4.8.8', 8, 7, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
    ],
  },
  {
    block: 43, tier: 12, ppc: 3.60, shape: 'cairo',
    beat: '3-stacks on the size lever: the proven 112-cell heavy-stack. (Beat text said 84c; the proven T12 spec is 112c — flagged.)',
    levels: [
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
    ],
  },
  {
    block: 44, tier: 12, ppc: 3.60, shape: 'deltoidal',
    beat: '2-stacks with mines up; its 3-stack waits for the gauntlet.',
    levels: [
      T('deltoidal', 2, 3, 36, 12, ['mystery', 'liar'], { gimmickLevel: 75 }),
      T('deltoidal', 2, 3, 36, 12, ['walls', 'mystery'], { gimmickLevel: 75 }),
      T('deltoidal', 2, 3, 36, 12, ['liar', 'walls'], { gimmickLevel: 75 }),
      T('deltoidal', 2, 3, 36, 12, ['mystery', 'liar'], { gimmickLevel: 75 }),
      T('deltoidal', 2, 3, 36, 12, ['walls', 'mystery'], { gimmickLevel: 75 }),
    ],
  },
  {
    block: 45, tier: 12, ppc: 3.60, shape: 'hex',
    beat: '3-stacks: worm+compass+walls at the density frontier.',
    levels: [
      T('hex', 11, 10, 110, 36, ['worm', 'compass', 'walls'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 36, ['worm', 'compass', 'walls'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 36, ['worm', 'compass', 'walls'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 36, ['worm', 'compass', 'walls'], { gimmickLevel: GL_HIGH }),
      T('hex', 11, 10, 110, 36, ['worm', 'compass', 'walls'], { gimmickLevel: GL_HIGH }),
    ],
  },
  {
    // The ceiling picks the size: at 3.60 s/cell the 8-minute cap tops out
    // ~133 cells, so Classic's summit lives on 11×11 (the map's own note;
    // 12×12 would target 518s). The stack composition is a MEASURED cost
    // decision (14-seed probes per family): constructive-mystery solves on
    // a 0.42-density classic carry 3-4s per-seed tails and sonar-strict
    // strip-solves 3.6-10.8s — both blow the 2-second cap — while
    // walls+locked+liar at 51 mines runs 0.75s worst across every seed
    // family probed and prices 3.50, dead in the summit band. One spec,
    // five levels: every attempt draws a fresh layout anyway (the ladder's
    // whole premise), so the block's variety is layout, not dials.
    block: 46, tier: 12, ppc: 3.60, shape: 'rect',
    beat: '3-stacks at the boosted-Classic ceiling (11-wide, dense + heavy stacks).',
    levels: [
      R(11, 11, 51, ['walls', 'locked', 'liar'], { gimmickLevel: GL_HIGH, wallSegments: 3 }),
      R(11, 11, 51, ['walls', 'locked', 'liar'], { gimmickLevel: GL_HIGH, wallSegments: 3 }),
      R(11, 11, 51, ['walls', 'locked', 'liar'], { gimmickLevel: GL_HIGH, wallSegments: 3 }),
      R(11, 11, 51, ['walls', 'locked', 'liar'], { gimmickLevel: GL_HIGH, wallSegments: 3 }),
      R(11, 11, 51, ['walls', 'locked', 'liar'], { gimmickLevel: GL_HIGH, wallSegments: 3 }),
    ],
  },
  {
    block: 47, tier: 12, ppc: 3.60, shape: 'mixed',
    beat: 'Pre-finale remix: 3-stacks drawn across all learned shapes.',
    levels: [
      T('hex', 11, 10, 110, 35, ['compass', 'walls', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 8, 7, 98, 32, ['locked', 'sonar', 'walls'], { gimmickLevel: 80 }),
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
      T('floret', 3, 4, 72, 22, ['locked', 'liar', 'walls'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 4, 5, 60, 23, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 }),
    ],
  },
  {
    block: 48, tier: 12, ppc: 3.60, shape: 'gauntlet',
    beat: 'FINALE I: Classic → Honeycomb → Octagons → Paving Stones → 3D Cubes.',
    levels: [
      R(11, 11, 54),
      T('hex', 11, 10, 110, 37),
      T('4.8.8', 8, 7, 98, 33),
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
      T('rhombille', 4, 5, 60, 23, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 }),
    ],
  },
  {
    block: 49, tier: 12, ppc: 3.60, shape: 'gauntlet',
    beat: 'FINALE II: Petals → Kites → Classic → 3D Cubes → Paving Stones.',
    levels: [
      T('floret', 3, 4, 72, 24),
      T('deltoidal', 2, 3, 36, 12),
      R(11, 11, 54),
      T('rhombille', 4, 5, 60, 23, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 }),
      T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 }),
    ],
  },
  {
    block: 50, tier: 12, ppc: 3.60, shape: 'gauntlet',
    beat: 'FINALE III: the seven-shape summit; L250 = Kites, 3-stacked, the crown.',
    levels: [
      T('hex', 11, 10, 110, 37),
      T('4.8.8', 8, 7, 98, 33),
      R(11, 11, 54),
      T('floret', 3, 4, 72, 24),
      T('deltoidal', 2, 3, 36, 10, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 }),
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
// ONE SELF-IMPOSED MARGIN: pool admission requires worst-measured generation
// under ENDLESS_GEN_BUDGET_MS (1500), not the full 2000ms cap. The cap is his
// ruling and is unchanged; the margin is judgement, because an endless board
// is drawn fresh on every attempt AND every death-retry, so a spec sitting at
// 1990ms on the validator's machine is one that intermittently stalls on a
// phone. It costs the top of the range: deltoidal reaches 9.73 s/cell at
// ~1990ms, and the shipped ceiling is 8.22 instead.
export const ENDLESS_START_LEVEL = CHALLENGE_MAX_LEVEL + 1;   // 251

// Pool-admission generation budget (see above), as a fraction of whatever cap
// applies to the shape. NOT the cap itself: the authored ladder keeps
// GEN_CAP_MS unchanged.
export const ENDLESS_GEN_HEADROOM = 0.75;
export const ENDLESS_GEN_BUDGET_MS = GEN_CAP_MS * ENDLESS_GEN_HEADROOM;   // 1500

// PER-SHAPE generation cap in the endless zone (his ruling 2026-08-04):
// 3D Cubes gets 3.5 seconds. It is the one shape whose exclusion was never
// about the par ceiling — its qualifying boards price 222-464s, comfortably
// under — but about time: its certifier has no Pass B and leans on Pass C
// enumeration for every board, so it measured 2.1-9.8s against the 2-second
// cap. Raising ITS cap is what lets it into the zone; raising its ceiling
// would have done nothing.
// Per-shape ADMISSION FLOOR, where a lattice cannot reach the pool floor on a
// board a phone can hold. His ruling, 2026-08-07: every tiling must be
// available in the endless zone, and "without sufficient data, I think it's
// fine to put the top 10 percentile of most difficult paving stones."
//
// Measured after the phone cap's proportion rule: cairo's largest
// well-proportioned patch is 112 cells, and across its legal sizes x
// densities x the endless stacks its hardest board is ppc 3.52 — it clears
// the 3.5 floor, but only just, and only on one stack. Admitting its top
// decile (ppc >= 2.54 over 96 viable boards) is what gives it a real presence
// instead of a single entry.
//
// The reasoning behind accepting a softer floor is his too: these rates are
// provisional. Every shape looks dear while nobody knows its tricks, and the
// par model is fit on play that is still learning them — Classic priced far
// harder early on than it does now. When cairo's per-cell rate rises on real
// data, this entry should shrink toward the shared floor and eventually go.
export const ENDLESS_PPC_FLOOR_BY_SHAPE = Object.freeze({
  cairo: 2.5,
});

/** The admission floor a shape is held to. */
export function endlessPpcFloor(shape) {
  return ENDLESS_PPC_FLOOR_BY_SHAPE[shape] ?? ENDLESS_PPC_FLOOR;
}

export const ENDLESS_GEN_CAP_BY_SHAPE = Object.freeze({
  rhombille: 3500,
  // Cairo joined this table on 2026-08-06, on the same reasoning rhombille is
  // here for and on Christopher's ruling that the budget "can be 3 [seconds]
  // if it means we get diversity". The phone cap took cairo's endless boards
  // from 9x9 to 13x7, its largest legal patch, and 162 cells only price under
  // the 720s ceiling at a density where the certifier has to work: measured
  // 1929ms and 2487ms for the two entries that ship. Held to 3000 rather than
  // rhombille's 3500 because those two have real headroom at 3000 and the
  // entry that did not (mystery, 4722ms) was dropped instead of accommodated.
  // Endless generation happens behind a level card, never under a click.
  cairo: 3000,
});

/** The endless generation cap that applies to a shape. */
export function endlessGenCap(shape) {
  return ENDLESS_GEN_CAP_BY_SHAPE[shape] || GEN_CAP_MS;
}

/** The admission budget for a shape: its cap, less the standing headroom. */
export function endlessGenBudget(shape) {
  return endlessGenCap(shape) * ENDLESS_GEN_HEADROOM;
}

// Difficulty escalation per endless BLOCK (5 levels), multiplicative on
// par-per-cell from the T12 summit. Tuned to the pool's actual span rather
// than picked round: the pool reaches 1.8x the summit, and at 1.035 that
// takes about 17 blocks, so the climb runs roughly 85 levels past the crown
// before the hardest material starts cycling. That cycling is what
// "unbounded above 3.6" means in practice once a PROVEN pool runs out of
// ceiling — the alternative is promising a difficulty nobody has generated.
// Re-check this whenever the pool's top moves: it fell from 7.9 to 6.6 when
// par headroom became an admission rule, and a growth rate left at 1.05
// would then have reached the top in 12 blocks instead of 17.
export const ENDLESS_PPC_GROWTH = 1.035;

// The pool's ADMISSION floor, distinct from the summit the escalation aims
// at. His ruling 2026-08-04: drop it to 3.5 so more boards fit.
//
// The two numbers do different jobs and it matters that they can differ. The
// escalation still STARTS at the T12 summit (3.6), so the zone opens exactly
// where the authored ladder ended; the floor only says which boards may sit
// in the pool the draw chooses from. Lowering it widens the material near the
// bottom — the shapes pinned there by their own gentle pricing, Classic and
// Paving Stones especially — without making the first endless block easier
// than the crown that precedes it.
export const ENDLESS_PPC_FLOOR = 3.5;

// How many of the nearest-priced specs the per-level draw chooses among. Wide
// enough that a block of five is not one board five times, narrow enough that
// every draw stays near its target.
const ENDLESS_CANDIDATES = 10;

// How far from the block's target the draw may reach to find a shape the
// block has not used yet, as a ratio on par-per-cell. Variety is his ruling
// ("mixed board lengths") and the pool is NOT uniform across difficulty:
// only floret and deltoidal reach past about 6 s/cell, so a window ranked on
// price alone collapses to two shapes at the top of the climb. This is the
// deliberate trade — a somewhat cheaper board over a fifth repeat of the same
// lattice — and it is bounded so a block at 8 s/cell can never reach down to
// the summit for the sake of a new shape.
export const ENDLESS_VARIETY_MAX_RATIO = 1.9;

/** @param {number} ppc measured median par-per-cell over the search's seeds */
const E = (ppc, spec) => Object.freeze({ ...spec, ppc, gimmicks: Object.freeze(spec.gimmicks || []) });

// Measured medians from scripts/search-endless-specs.mjs, re-measured over a
// wide seed sample by scripts/harden-endless-pool.mjs. Re-run both after any
// refit that moves a shape's equation materially: these prices are what the
// escalation targets, and the validator re-times them either way.
//
// AN ENTRY NEEDS HEADROOM, not merely a passing measurement. Price and
// generation time both vary by seed sample, so a spec measured AT a boundary
// lands either side of it depending on which seeds ran, and the validator
// then fails intermittently on a pool nobody changed. Two entries were cut
// for exactly that: a 12x13 rect priced 605s against the 600s ceiling and a
// cairo priced 601s, both of which had passed their own search. Rect and
// cairo are structurally pinned against that ceiling (they need ~150 cells to
// reach the summit rate at all, and 150 x 4 s/cell IS ten minutes), which is
// why each keeps only the few entries that clear it with room.
//
// CAIRO MOVED UP THE CLIMB on 2026-08-06 rather than leaving it. Its six
// entries were all 9x9, which the phone cap refuses (12.29 pitch units wide
// against a cap of 11.21) and which — being square in (M, N) — the transpose
// that rescued every other violation does nothing for. Its largest legal patch
// is 13x7 at 162 cells, and that size only works in a narrow slot: below ~74
// mines it prices past the 720s ceiling, and above ~75 the generation cost
// climbs steeply (3856ms at 75 mines with walls). At exactly 74 it lands at
// 699-713s and 1447-1688ms, so three entries ship there. The 136-cell
// alternative is cheap to generate but tops out at ppc 3.38 against the 3.5
// floor at every density tried, so it is not an option.
//
// The consequence is that cairo now enters at ppc ~4.3 instead of ~3.6: it is
// no longer part of the climb's opening rungs, which rect 3.66, hex 3.67 and
// 4.8.8 3.78 still cover. Re-run scripts/search-endless-specs.mjs if a future
// refit reprices cairo enough to reopen a cheaper rung.
export const ENDLESS_SPECS = Object.freeze([
  // Paving Stones, restored 2026-08-07 under ENDLESS_PPC_FLOOR_BY_SHAPE. Its
  // top decile begins at ppc 2.54, but the pool's margin rule (an entry AT a
  // floor reads under it on a smaller sample) wants clearance, so the two
  // boards sitting on 2.5 are left out and these four carry the shape.
  E(2.62, T('cairo', 8, 8, 112, 27, ['mirror', 'liar', 'walls'], { gimmickLevel: 120 })),
  E(2.78, T('cairo', 8, 8, 112, 27, ['locked', 'liar'], { gimmickLevel: 120 })),
  E(3.29, T('cairo', 9, 7, 110, 26, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 })),
  E(3.52, T('cairo', 8, 8, 112, 27, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 })),
  E(3.66, R(12, 12, 58, ['locked', 'liar'], { gimmickLevel: 100 })),
  E(3.67, T('hex', 9, 8, 72, 31, ['worm', 'walls'], { gimmickLevel: 120 })),
  E(3.69, T('hex', 11, 10, 110, 37, ['worm', 'walls'], { gimmickLevel: 120 })),
  E(3.78, T('4.8.8', 6, 7, 72, 29, ['wormhole', 'locked'], { gimmickLevel: 120 })),
  E(3.87, T('deltoidal', 2, 3, 36, 10, ['sonar', 'walls'], { gimmickLevel: 120 })),
  E(3.89, T('rhombille', 4, 5, 60, 22, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 })),
  E(3.90, T('hex', 9, 8, 72, 31, ['compass', 'walls'], { gimmickLevel: 120 })),
  E(3.93, T('4.8.8', 8, 7, 98, 33, ['wormhole', 'locked'], { gimmickLevel: 120 })),
  E(3.98, T('hex', 9, 8, 72, 31, ['compass', 'walls'], { gimmickLevel: 100 })),
  E(3.99, T('hex', 11, 10, 110, 37, ['compass', 'walls'], { gimmickLevel: 100 })),
  E(4.08, T('hex', 9, 8, 72, 31, ['worm', 'compass', 'walls'], { gimmickLevel: 120 })),
  E(4.10, T('floret', 3, 4, 72, 22, ['sonar', 'liar'], { gimmickLevel: 120 })),
  E(4.10, T('floret', 3, 3, 54, 22, ['walls'], { gimmickLevel: 100 })),
  E(4.14, T('hex', 11, 10, 110, 37, ['worm', 'compass', 'walls'], { gimmickLevel: 100 })),
  E(4.16, T('deltoidal', 2, 3, 36, 12, ['sonar', 'walls'], { gimmickLevel: 100 })),
  E(4.22, T('deltoidal', 3, 3, 54, 15, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 })),
  E(4.25, T('4.8.8', 6, 7, 72, 29, ['wormhole', 'compass', 'locked'], { gimmickLevel: 120 })),
  E(4.34, T('4.8.8', 6, 7, 72, 31, ['locked'], { gimmickLevel: 100 })),
  E(4.36, T('deltoidal', 3, 3, 54, 16, ['mystery', 'locked'], { gimmickLevel: 100 })),
  E(4.55, T('4.8.8', 6, 7, 72, 31, ['locked'], { gimmickLevel: 120 })),
  E(4.66, T('floret', 3, 3, 54, 22, ['sonar', 'liar', 'walls'], { gimmickLevel: 100 })),
  E(4.73, T('deltoidal', 3, 3, 54, 17)),
  E(4.89, T('4.8.8', 8, 7, 98, 36, ['locked'], { gimmickLevel: 100 })),
  E(4.99, T('4.8.8', 6, 7, 72, 31, ['compass', 'locked'], { gimmickLevel: 100 })),
  E(5.17, T('floret', 3, 3, 54, 23, ['sonar', 'liar', 'walls'], { gimmickLevel: 100 })),
  E(5.32, T('floret', 3, 4, 72, 27, ['liar', 'walls'], { gimmickLevel: 120 })),
  E(5.34, T('deltoidal', 2, 3, 36, 12, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 })),
  E(5.35, T('deltoidal', 3, 3, 54, 16, ['sonar', 'walls'], { gimmickLevel: 120 })),
  E(5.66, T('deltoidal', 2, 3, 36, 14, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 })),
  E(5.88, T('floret', 3, 3, 54, 23, ['sonar', 'liar'], { gimmickLevel: 120 })),
  E(6.14, T('deltoidal', 2, 3, 36, 13, ['locked', 'sonar', 'walls'], { gimmickLevel: 120 })),
  E(6.50, T('floret', 3, 4, 72, 29, ['liar', 'walls'], { gimmickLevel: 100 })),
  E(6.76, T('floret', 3, 4, 72, 29, ['sonar', 'liar'], { gimmickLevel: 100 })),
  E(7.39, T('floret', 3, 4, 72, 31)),
  E(7.77, T('floret', 3, 4, 72, 31, ['liar', 'walls'], { gimmickLevel: 100 })),
]);

const ENDLESS_MAX_PPC = ENDLESS_SPECS.reduce((m, e) => Math.max(m, e.ppc), 0);

/** Endless block index (0-based) for a level past the crown. */
function endlessBlockIndex(level) {
  return Math.floor((level - ENDLESS_START_LEVEL) / CHALLENGE_BLOCK_SIZE);
}

/**
 * The par-per-cell an endless block aims at: the T12 summit compounded by
 * ENDLESS_PPC_GROWTH per block, clamped to what the proven pool actually
 * holds. Clamping rather than extrapolating is the point — past the pool's
 * ceiling the ladder stops climbing rather than promising a difficulty nobody
 * has generated.
 * @param {number} level
 */
export function endlessTargetPpc(level) {
  const e = Math.max(0, endlessBlockIndex(level));
  return Math.min(TIER_PPC[12] * (ENDLESS_PPC_GROWTH ** e), ENDLESS_MAX_PPC);
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

// One block of five is resolved together, because "mixed board lengths" is a
// property of the BLOCK rather than of a level: each level prefers a shape
// none of its earlier siblings used, falling back to the whole candidate
// window when nothing new is left. Memoised per block, since a block gets
// resolved on every level lookup inside it.
const _endlessBlockMemo = new Map();

function endlessBlock(blockStart) {
  const cached = _endlessBlockMemo.get(blockStart);
  if (cached) return cached;

  const target = endlessTargetPpc(blockStart);
  // Nearest by LOG distance, so "twice as hard" reads the same either side.
  const byDistance = ENDLESS_SPECS
    .map((e) => ({ e, d: Math.abs(Math.log(e.ppc / target)) }))
    .sort((a, b) => a.d - b.d || a.e.ppc - b.e.ppc);
  const ranked = byDistance.slice(0, ENDLESS_CANDIDATES).map((r) => r.e);
  // The wider window the variety rule may reach into, bounded by ratio.
  const varietyWindow = byDistance
    .filter((r) => r.d <= Math.log(ENDLESS_VARIETY_MAX_RATIO))
    .map((r) => r.e);

  const usedShapes = new Set();
  const out = [];
  for (let i = 0; i < CHALLENGE_BLOCK_SIZE; i++) {
    const level = blockStart + i;
    // A shape this block has not used yet, preferring the close window and
    // reaching into the bounded one only when the close window is exhausted.
    const freshNear = ranked.filter((e) => !usedShapes.has(e.shape));
    const freshWide = varietyWindow.filter((e) => !usedShapes.has(e.shape));
    const from = freshNear.length ? freshNear : (freshWide.length ? freshWide : ranked);
    const pick = from[hashLevel(level, 'endless') % from.length];
    usedShapes.add(pick.shape);
    out.push(Object.freeze({
      level,
      block: Math.floor((level - 1) / CHALLENGE_BLOCK_SIZE) + 1,
      tier: 12,
      endless: true,
      targetPpc: target,
      ppc: pick.ppc,
      dip: false,
      shape: pick.shape,
      rows: pick.rows, cols: pick.cols, M: pick.M, N: pick.N,
      cells: pick.cells, mines: pick.mines,
      gimmicks: pick.gimmicks,
      gimmickLevel: pick.gimmickLevel,
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

// ── Expansion + accessors ──────────────────────────────────────────────

// Opener blocks validate on the deduction floor, not the ppc band; stamp
// the per-draw floor onto their specs here rather than per level above.
for (const b of BLOCKS) {
  if (b.ppc === null) {
    for (const spec of b.levels) spec.minDeductions = OPENER_MIN_DEDUCTIONS;
  }
}

const LEVEL_SPECS = [];
for (const b of BLOCKS) {
  for (let i = 0; i < b.levels.length; i++) {
    const level = (b.block - 1) * CHALLENGE_BLOCK_SIZE + i + 1;
    const spec = {
      level,
      block: b.block,
      tier: b.tier,
      ppc: b.ppc,
      dip: b.dip === true,
      ...b.levels[i],
      gimmicks: (b.levels[i].gimmicks || []).slice(),
    };
    Object.freeze(spec.gimmicks);
    LEVEL_SPECS.push(Object.freeze(spec));
  }
}
Object.freeze(LEVEL_SPECS);

export const CHALLENGE_BLOCKS = BLOCKS.map((b) => Object.freeze({
  block: b.block, tier: b.tier, ppc: b.ppc, shape: b.shape,
  beat: b.beat, dip: b.dip === true,
}));
Object.freeze(CHALLENGE_BLOCKS);

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

/**
 * Stable dedupe key: two levels sharing a fingerprint draw from the same
 * board distribution, so the validator proves each distinct spec once.
 */
export function specFingerprint(spec) {
  const dims = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.M}x${spec.N}`;
  const opts = [
    spec.gimmickLevel ? `gl${spec.gimmickLevel}` : '',
    spec.wallSegments ? `w${spec.wallSegments}` : '',
    spec.constructive ? 'con' : '',
    spec.minDeductions ? `d${spec.minDeductions}` : '',
    spec.maxDeductions ? `D${spec.maxDeductions}` : '',
  ].filter(Boolean).join(',');
  return `${spec.shape}:${dims}:m${spec.mines}:[${spec.gimmicks.join('+')}]${opts ? ':' + opts : ''}`;
}
