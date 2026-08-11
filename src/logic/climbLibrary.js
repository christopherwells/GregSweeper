// The Climb library's shared vocabulary: which levels the pre-generated
// library covers, where to fetch a level's file, the introduction schedule
// the library was BUILT to, and the bin-pick rule.
//
// This is a LEAF on purpose (imports one constant): the build, reprice and
// top-up scripts need the same schedule the runtime deals under, and the
// scripts cannot be imported by the browser (they pull node:fs), so the
// tables are defined here and scripts/build-climb-library.mjs re-exports
// them.
//
// THE SCHEDULE IS THE LIBRARY'S, not the drawn braid's. The two differ by a
// three-cycle (his ruling 2026-08-10, "Swap sonar forward": sonar 13 -> 6,
// hex 6 -> 7, locked 7 -> 13), and from the day the runtime deals from the
// library, every player-facing debut surface (checkpoint labels, first
// encounter cards, e2e venues) follows THESE tables. The braid keeps its own
// derived tables for the drawn fallback path.

import { CHALLENGE_BLOCK_SIZE } from './challenge250.js';

// The library covers the drawn ladder's span: the L1-25 openers stay
// authored (teaching is the one job a draw cannot do, and a library bin
// cannot either), and the endless zone waits for its own pre-generation.
export const CLIMB_LIBRARY_FROM = 26;
export const CLIMB_LIBRARY_TO = 250;

export const LIB_SHAPE_INTROS = {
  7: 'hex', 8: '4.8.8', 10: 'cairo', 12: 'rhombille', 14: 'floret', 16: 'deltoidal',
};
export const LIB_MOD_INTROS = {
  2: 'walls', 3: 'liar', 4: 'mystery', 6: 'sonar', 9: 'wormhole',
  11: 'mirror', 13: 'locked', 15: 'compass', 17: 'worm',
};

export function levelHasLibrary(level) {
  return level >= CLIMB_LIBRARY_FROM && level <= CLIMB_LIBRARY_TO;
}

// RELATIVE on purpose: the app serves at / in production and /test/ on the
// test branch, and a root-anchored path would cross the two.
export function levelFileUrl(level) {
  return `scripts/data/climb-library/level-${String(level).padStart(3, '0')}.json`;
}

/**
 * What a level may take in, derived from its number and its file's own
 * `intro` field. The ONE copy of the schedule-legality rule: the build, the
 * top-up, the reprice re-binner and the runtime all place or accept boards
 * through this, so none of them can disagree about where a shape or
 * modifier is allowed.
 */
export function intakeRules(level, intro) {
  const block = Math.floor((level - 1) / CHALLENGE_BLOCK_SIZE) + 1;
  const shapesIn = new Set(['rect']);
  for (const [b, sh] of Object.entries(LIB_SHAPE_INTROS)) {
    if (Number(b) <= block) shapesIn.add(sh);
  }
  const modsIn = new Set();
  for (const [b, g] of Object.entries(LIB_MOD_INTROS)) {
    if (Number(b) <= block) modsIn.add(g);
  }
  const isModIntro = intro != null && Object.values(LIB_MOD_INTROS).includes(intro);
  return {
    block,
    shapesIn,
    modsIn,
    // A shape-debut level is single-shape by ruling; a modifier-debut level
    // takes any introduced shape but every stack must carry the debut mod.
    shapeDebut: intro != null && !isModIntro ? intro : null,
    requiredMod: isModIntro ? intro : null,
  };
}

/** May this board belong at this level? Window is the caller's business. */
export function boardAllowedAtLevel(board, rules) {
  const { shape, gimmicks } = board.spec;
  if (rules.shapeDebut && shape !== rules.shapeDebut) return false;
  if (!rules.shapesIn.has(shape)) return false;
  if (rules.requiredMod && !(gimmicks || []).includes(rules.requiredMod)) return false;
  return (gimmicks || []).every((g) => rules.modsIn.has(g));
}

/**
 * His seen-cycle rule, verbatim: "One of them is chosen and marked as seen.
 * If all 10 end up being seen, then it goes back to 1." Pick randomly among
 * the unseen boards; when every board in the bin has been seen, the cycle
 * resets and the whole bin is fresh again. Returns the pick plus whether
 * the cycle reset, so the caller knows to restart the seen list rather
 * than append to it.
 */
export function pickFromBin(boards, seenSeeds, rand = Math.random) {
  if (!Array.isArray(boards) || boards.length === 0) return { pick: null, cycled: false };
  const seen = new Set(seenSeeds || []);
  let pool = boards.filter((b) => !seen.has(b.seed));
  const cycled = pool.length === 0;
  if (cycled) pool = boards;
  const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return { pick, cycled };
}
