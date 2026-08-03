// Daily shape rotation (Project Coastline — the reachability step).
//
// This module owns the ONE question "what shape is this date's daily?" and the
// ONE way a tiling daily board gets built, for every consumer at once: the
// nightly precompute (scripts/daily-board-pipeline.mjs), the client's
// local-generation fallback (gameActions.js), and the pre-play par resolver
// (parResolve.js). Both halves live together because the missionSlots lesson
// applies to each independently: the shape draw and the board build are
// determinism-critical, and two copies of either are two chances for the
// precompute and a fallback client to ship different boards for the same date.
//
// SHIPPED DARK. TILING_ROTATION_START is null, so resolveDailyShape returns
// null (rectangle) for every date and every path below is byte-identical to
// the pre-rotation behaviour. Turning the rotation on is a deliberate later
// one-line PR (set the start date) that carries the v1.10 bump, the What's New
// entry, and the player-facing copy — never a side effect of this module
// changing.
//
// The draw (Christopher's ruling, settled): 50% square, 50% one of the six
// tilings uniformly. Deterministic from the date string alone — no target
// file, no candidate scoring — so every client, the precompute, and the
// nightly sweep resolve the same shape for a date without fetching anything.
//
// Tiling days are SINGLE-CANDIDATE, unlike a rectangular daily's 10-way
// mission-seed contest. Two reasons, both structural: the client fallback must
// replay selection deterministically when Firebase is unreachable, and a
// contest means generating every candidate — ten rhombille generations is
// minutes of phone CPU (rhombille's certifier leans on Pass C enumeration for
// every board; worst measured single board 2.4 s). The day's mission is
// instead drawn by weight over the gimmick-bearing slots (selectTilingMission
// in experimentDesign.js — the analog of the rectangular score lottery, with
// the count term it cannot have) and force-injected onto the one seed.

import { createDailyRNG } from './seededRandom.js';
import { TILING_TYPES } from './tilingGeometry.js';
import { tilingTypeForToken } from './coastlineLink.js';
import { generateTilingBoard, TILING_SAFE_GIMMICKS } from './tilingGenerator.js';
import { drawDailyTilingConfig, tilingConfigAttempts } from './tilingBandConfigs.js';
import { getDailyGimmick } from './gimmicks.js';
import {
  candidateSeed, selectTilingMission, resolveMissionForSlot, getTargetGimmickName,
} from './experimentDesign.js';

// The first ET date whose daily participates in the shape rotation. Null means
// the rotation is OFF and every daily is rectangular — the shipped state.
//
// FLIPPING THIS IS A RELEASE, not a config tweak: the flip PR carries the
// v1.10 CURRENT_VERSION bump, its What's New entry, and the Daily-card/help
// copy, and it happens only after Christopher has playtested every shape
// (via the test-env ?dailyShape= override below). Set it to a date at least
// one day ahead of the merge so the precompute horizon and the flip agree on
// which dates rotate.
export const TILING_ROTATION_START = null;

// One rng stream per decision, each in its own namespace off the date string,
// disjoint from every existing consumer of the date seed (`:trialN` candidate
// seeds, `:missionDraw` winner lottery, `-gimmick` rolls, `:worm:` traits,
// `:tiling:` placement attempts).
const SHAPE_NAMESPACE = ':shape';

/**
 * The shape of a date's daily under the rotation: null for a rectangle
 * (always, while the rotation is off), else a TILING_TYPES entry.
 *
 * Pure and clock-free. The gate compares date STRINGS — YYYY-MM-DD compares
 * correctly as text, and every caller already holds the ET date string —
 * and anything that is not a plausible date returns null, so a practice
 * custom seed (?seed=abc) can never draw a shape even if it reaches here.
 *
 * The draw spends exactly two rng() calls on a tiling day and one on a
 * rectangle day; nothing else may consume this stream.
 *
 * @param {string} dateString YYYY-MM-DD (ET)
 * @param {string|null} rotationStart override for tests; defaults to the
 *   shipped constant
 * @returns {string|null}
 */
export function resolveDailyShape(dateString, rotationStart = TILING_ROTATION_START) {
  if (!rotationStart || typeof rotationStart !== 'string') return null;
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  if (dateString < rotationStart) return null;
  const rng = createDailyRNG(`${dateString}${SHAPE_NAMESPACE}`);
  if (rng() < 0.5) return null; // square half of the ruling
  return TILING_TYPES[Math.floor(rng() * TILING_TYPES.length)];
}

// ── Test-environment shape override (?dailyShape=) ──────────────────────
//
// The rotation ships dark, so playtesting a tiling daily (and the e2e journey
// spec) needs a way to reach the path that does not exist in production.
// main.js sets this from the ?dailyShape= URL param UNDER isTestEnvironment()
// — the same derivation-site gate as ?level= and ?coastline= — and the
// override then applies ONLY to practice-lane dailies (state.isDailyPractice),
// which record nothing. Two independent reasons that scoping is load-bearing:
//
//  - /test/ shares the origin's localStorage with production, so an overridden
//    daily that recorded would mark the REAL date completed with a board that
//    is not the canonical — blocking that day's real play and polluting
//    streak/stats (the exact class the ?level= practice gate exists for).
//  - A live daily must never diverge from its canonical; an override that
//    could touch the live lane would be a self-inflicted #114.
//
// 'rect' is accepted alongside the tiling names so a post-flip test build can
// force a rectangle day too.
let _dailyShapeOverride = null;

/**
 * @param {string|null} token raw ?dailyShape= value
 * @returns {string|null} the override that was set (normalized), or null if
 *   the token named nothing (override cleared)
 */
export function setDailyShapeOverride(token) {
  const t = String(token || '').trim().toLowerCase();
  if (t === 'rect' || t === 'classic') {
    // The rectangular grid's player-facing name is "Classic"; both spellings
    // force a square practice daily.
    _dailyShapeOverride = 'rect';
  } else {
    // Accept internal types AND the player-facing alias tokens (octagons,
    // honeycomb, paving, petals, cubes/3dcubes, kites) through the one
    // token table the ?coastline= parser uses.
    _dailyShapeOverride = tilingTypeForToken(t);
  }
  return _dailyShapeOverride;
}

export function getDailyShapeOverride() {
  return _dailyShapeOverride;
}

/**
 * The board config a tiling daily uses for a given shape ON A GIVEN DATE:
 * the banded draw from tilingBandConfigs.js (Par Bands, Phase 2). The fixed
 * COASTLINE_BOARDS configs this replaced were the reason a deltoidal daily
 * priced ~285 s against the 240 s band ceiling; the draw picks from each
 * lattice's table of generation-proven configs, weighted by closeness to
 * the date's target par at the LIVE per-shape equation. Still deterministic
 * from the date string alone — the draw replaced the "no roll to disagree
 * on" rationale with a seeded roll every consumer replays identically,
 * which is the same determinism the shape draw above already relies on.
 * (COASTLINE_BOARDS itself remains what it always was: the ?coastline=
 * practice-board config, untouched by this.)
 *
 * @param {string} type a TILING_TYPES entry
 * @param {string} dateString YYYY-MM-DD (ET)
 * @returns {import('./tilingBandConfigs.js').BandEntry|null}
 */
export function dailyTilingConfig(type, dateString) {
  return drawDailyTilingConfig(type, dateString);
}

/**
 * Build the canonical-candidate board for a tiling daily — the single entry
 * point every tiling-day producer calls.
 *
 * Mission: drawn by selectTilingMission (weight-proportional, date-seeded,
 * gimmick-bearing slots only). When no slot qualifies (observational primary
 * + empty coverage list), the day falls back to the plain dateString seed and
 * the natural gimmick lottery under the primary mission's banner — the same
 * convention the rectangular path's plain-dateString fallback uses.
 *
 * The gimmick roll is getDailyGimmick verbatim (same seed convention as a
 * rectangle day), then filtered to TILING_SAFE_GIMMICKS. That filter is
 * belt-and-suspenders: test/shapeRotation.test.mjs pins TILING_SAFE ⊇
 * DAILY_SAFE, so today it drops nothing — but if a future daily-safe gimmick
 * ships without a tiling story, the guard test fails loudly in CI while this
 * filter keeps every client deterministic (all of them drop the same entry)
 * instead of shipping a mission the tiling cannot honor.
 *
 * Config: the banded draw (tilingConfigAttempts), tried in order — the drawn
 * entry first, then the shape's designated in-band fallback entry if the
 * draw's generation exhausts on this date's seed. Both attempts are
 * deterministic, so every caller walks the identical list and lands on the
 * identical board (or the identical null).
 *
 * Returns null when every config attempt exhausts without a certified
 * board. That outcome is DETERMINISTIC (same seed, same code, same
 * result), so every caller falls back to the rectangular path in agreement —
 * the precompute and a fallback client cannot split.
 *
 * @param {string} dateString YYYY-MM-DD (ET) — also the RNG seed anchor
 * @param {string} type a TILING_TYPES entry
 * @param {{target: string, coverage_targets: Array}} spec the experiment spec
 *   (the pipeline's file read, or the client's fetch-cached getters)
 * @returns {null | {board: Array, rows: number, cols: number, totalMines: number,
 *   firstClick: number, tiling: Object, check: Object, activeGimmicks: string[],
 *   applied: Object, rngSeed: string, mission: Object}}
 */
export function buildTilingDailyBoard(dateString, type, spec) {
  const target = spec && typeof spec.target === 'string' ? spec.target : null;
  const coverage = spec && Array.isArray(spec.coverage_targets) ? spec.coverage_targets : [];

  const pick = selectTilingMission(dateString, target, coverage);
  const mission = pick ? pick.mission : resolveMissionForSlot(0, target, coverage, null);
  const rngSeed = pick ? candidateSeed(dateString, pick.slot) : dateString;

  const forcedGimmick = getTargetGimmickName(mission && mission.target);
  const rolled = getDailyGimmick(
    rngSeed, createDailyRNG, forcedGimmick, mission ? mission.singleOnly === true : false,
  );
  const gimmicks = rolled.filter((g) => {
    if (TILING_SAFE_GIMMICKS.includes(g)) return true;
    // Unreachable while the superset guard holds; loud if it ever stops.
    console.warn(`shapeRotation: dropping non-tiling-safe gimmick '${g}' from ${dateString}`);
    return false;
  });

  let result = null;
  for (const entry of tilingConfigAttempts(type, dateString)) {
    result = generateTilingBoard({
      type, M: entry.M, N: entry.N, mines: entry.mines, seed: rngSeed, gimmicks,
      forceConstructive: entry.constructive === true,
    });
    if (result) break;
  }
  if (!result) return null;

  let totalMines = 0;
  for (const row of result.board) for (const cell of row) if (cell.isMine) totalMines++;

  return { ...result, totalMines, rngSeed, mission };
}
