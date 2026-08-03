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
//   - Blocks 51+ are the endless zone (unbounded above 3.6 s/cell). NOT
//     BUILT YET — the 8-minute-ceiling-in-endless flag is open with
//     Christopher; until the endless zone lands, levels past 250 clamp to
//     the L250 crown spec exactly as the old ladder clamped past 120.
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

// Tier-scaled power-up earns (his build note: inventories wipe at the L1
// reset, all six power-ups stay, earns become tier-scaled so early-tier
// farming is pointless — the checkpoint selector survives on that
// property). Expected awards per win = tier/6: about one power-up every
// six wins at T1, one per win at T6, and two per win at T12 — the summit
// keeps the old flat rate, the openers earn almost nothing. The fraction
// is a Bernoulli roll so awards stay whole numbers.
export function powerUpAwardCount(tier, rng = Math.random) {
  const expected = Math.max(0, (tier || 1) / 6);
  const base = Math.floor(expected);
  return base + (rng() < expected - base ? 1 : 0);
}

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

// The 8-minute absolute par ceiling and the 2-second generation cap
// (validator-enforced; the cap is as-measured, no margin — his ruling).
export const PAR_CEILING_SECONDS = 480;
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
  {
    block: 1, tier: 1, ppc: null, shape: 'rect',
    beat: 'Counting fundamentals. 7×7 to 8×8, every board 3-5 real deductions.',
    levels: [R(7, 7, 8), R(7, 7, 9), R(8, 8, 10), R(8, 8, 11), R(8, 8, 12)],
  },
  {
    block: 2, tier: 1, ppc: null, shape: 'rect',
    beat: 'MOD INTRO: Walls. Small boards; the wall as topology, not decoration.',
    levels: [
      R(8, 8, 10, ['walls'], { gimmickLevel: 11, wallSegments: 1 }),
      R(8, 8, 10, ['walls'], { gimmickLevel: 12, wallSegments: 1 }),
      R(8, 8, 11, ['walls'], { gimmickLevel: 13, wallSegments: 2 }),
      R(8, 8, 11, ['walls'], { gimmickLevel: 14, wallSegments: 2 }),
      R(8, 8, 12, ['walls'], { gimmickLevel: 16, wallSegments: 3 }),
    ],
  },
  {
    block: 3, tier: 2, ppc: null, shape: 'rect',
    beat: 'MOD INTRO: Liar. The pink cell; ±1 as a disjunction.',
    levels: [
      R(9, 9, 14, ['liar'], { gimmickLevel: INTRO_RAMP.liar[0] }),
      R(9, 9, 14, ['liar'], { gimmickLevel: INTRO_RAMP.liar[1] }),
      R(9, 9, 15, ['liar'], { gimmickLevel: INTRO_RAMP.liar[2] }),
      R(9, 9, 15, ['liar'], { gimmickLevel: INTRO_RAMP.liar[3] }),
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
      T('cairo', 4, 10, 66, 16, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[0] }),
      T('cairo', 4, 10, 66, 16, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[1] }),
      T('cairo', 4, 10, 66, 16, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[2] }),
      T('cairo', 4, 10, 66, 16, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[3] }),
      T('cairo', 4, 10, 66, 16, ['sonar'], { gimmickLevel: INTRO_RAMP.sonar[4] }),
    ],
  },
  {
    block: 17, tier: 6, ppc: 1.25, shape: '4.8.8',
    beat: 'Remix: wormhole+locked.',
    levels: [
      T('4.8.8', 7, 8, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 7, 8, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 7, 8, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 7, 8, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
      T('4.8.8', 7, 8, 98, 22, ['wormhole', 'locked'], { gimmickLevel: 75 }),
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
      T('4.8.8', 7, 8, 98, 24, ['compass'], { gimmickLevel: INTRO_RAMP.compass[0] }),
      T('4.8.8', 7, 8, 98, 24, ['compass'], { gimmickLevel: INTRO_RAMP.compass[1] }),
      T('4.8.8', 7, 8, 98, 23, ['compass'], { gimmickLevel: INTRO_RAMP.compass[2] }),
      T('4.8.8', 7, 8, 98, 23, ['compass'], { gimmickLevel: INTRO_RAMP.compass[3] }),
      T('4.8.8', 7, 8, 98, 23, ['compass'], { gimmickLevel: INTRO_RAMP.compass[4] }),
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
      T('4.8.8', 7, 8, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 27, ['compass', 'mirror'], { gimmickLevel: GL_HIGH }),
    ],
  },
  {
    block: 30, tier: 9, ppc: 2.15, shape: 'rhombille',
    beat: 'Remix: mirror+locked, density up. Milestone L150. (Beat text said 0.28; T9 needs ~0.31 — flagged.)',
    levels: [
      T('rhombille', 4, 6, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 4, 6, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 4, 6, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 4, 6, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
      T('rhombille', 4, 6, 72, 22, ['mirror', 'locked'], { gimmickLevel: GL_HIGH }),
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
      T('rhombille', 4, 6, 72, 24, ['sonar', 'mirror', 'walls'], { gimmickLevel: 110 }),
      T('rhombille', 4, 6, 72, 24, ['sonar', 'mirror', 'walls'], { gimmickLevel: 110 }),
      T('rhombille', 4, 6, 72, 24, ['sonar', 'mirror', 'walls'], { gimmickLevel: 110 }),
      T('rhombille', 4, 6, 72, 24, ['sonar', 'mirror', 'walls'], { gimmickLevel: 110 }),
      T('rhombille', 4, 6, 72, 24, ['sonar', 'mirror', 'walls'], { gimmickLevel: 110 }),
    ],
  },
  {
    block: 42, tier: 12, ppc: 3.60, shape: '4.8.8',
    beat: '3-stacks: wormhole+compass+locked.',
    levels: [
      T('4.8.8', 7, 8, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
      T('4.8.8', 7, 8, 98, 31, ['wormhole', 'compass', 'locked'], { gimmickLevel: GL_HIGH }),
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
      T('4.8.8', 7, 8, 98, 31, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 }),
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
      T('4.8.8', 7, 8, 98, 33),
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
      T('4.8.8', 7, 8, 98, 33),
      R(11, 11, 54),
      T('floret', 3, 4, 72, 24),
      T('deltoidal', 2, 3, 36, 10, ['locked', 'sonar', 'walls'], { gimmickLevel: 100 }),
    ],
  },
];

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
 * The authored spec for a ladder level. Levels below 1 clamp to 1; levels
 * past CHALLENGE_MAX_LEVEL clamp to the L250 crown until the endless zone
 * lands (the old ladder's clamp-past-MAX_LEVEL behavior, deliberately).
 * @param {number} level
 * @returns {object} frozen spec: {level, block, tier, ppc, dip, shape,
 *   rows?, cols?, M?, N?, cells, mines, gimmicks, gimmickLevel?,
 *   wallSegments?, constructive?, minDeductions?}
 */
export function challengeSpecForLevel(level) {
  const lv = Math.min(Math.max(Math.round(level || 1), 1), CHALLENGE_MAX_LEVEL);
  return LEVEL_SPECS[lv - 1];
}

/** First level of the block (= checkpoint = survival unit) containing a level. */
export function blockStartLevel(level) {
  const lv = Math.min(Math.max(Math.round(level || 1), 1), CHALLENGE_MAX_LEVEL);
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
  ].filter(Boolean).join(',');
  return `${spec.shape}:${dims}:m${spec.mines}:[${spec.gimmicks.join('+')}]${opts ? ':' + opts : ''}`;
}
