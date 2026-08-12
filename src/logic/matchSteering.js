// Mission steering for a Challenge match's deal.
//
// His idea, and the strongest part of the mode's design: "Sneak in some of our
// equation missions into it if the games permit it (low density, high 3's for
// example or number of moves a compass saves)." A match deals 1-10 boards under
// the host's config-sheet filter; steering means a FEW of those slots prefer a
// board that also happens to advance whatever study the nightly refit is
// currently starved of.
//
// HIS CONSTRAINTS ARE THE WHOLE DESIGN, and each one is load-bearing here:
//
//  - THE HOST'S FILTER IS THE RULES and nothing may reach outside it. This
//    function takes the raw index rows and applies eligibleRows ITSELF, so a
//    steered pick comes from the same filtered set an unsteered one does and
//    there is no code path that could reach past it. A host who has unlocked
//    three shapes never draws a fourth, however starved the fourth is.
//  - ~20% OF BOARDS MAY STEER, steeredSlotCap(N) = floor(N/5). A match of four
//    or fewer boards is pure variety, by design.
//  - "IF NO DISCOVERY CAN HAPPEN, THAT'S FINE." When nothing eligible advances
//    any live mission, the deal falls through to the ordinary pick and says
//    nothing. Steering is opportunistic, never a requirement.
//  - "IT CAN'T FEEL FORCED." Steered picks are placed by a full shuffle of the
//    dealt list, so a steered board is equally likely at any position; ties
//    between equally-starved missions break at random; and each steered slot
//    takes a DIFFERENT mission, so two steered boards never pile onto one study.
//
// WHY THIS EXISTS NOW. Match boards come only from shapes the HOST has
// unlocked, and the lattices unlock late on the Climb, so matches over-sample
// Classic, Octagons and Honeycomb (the early unlocks, already the best-sampled)
// and under-sample Petals, 3D Cubes and Kites, which have almost no data. Left
// alone the mode pours rows into the coefficients that need them least, and the
// per-shape par layer is the thing matches were supposed to fix.
//
// WHAT STEERING CAN AND CANNOT SEE. The match index row is deliberately compact
// ([page, idx, shape, cells, mines, par, mods]) because one fetch answers the
// setup sheet's live counts, so a row has fields for its board's SHAPE and its
// modifier set, and no field for the feature vector; the full `features` object
// lives in the page files, which the deal reads only for boards already picked.
// So steering reaches shape-coverage and gimmick-presence missions, and it
// cannot reach feature-level ones:
//
//  - the digit shares (clueShare2/3/4/5plus) are not in the index, and they are
//    OBSERVATIONAL besides (measured on every board, never maximized, see
//    experimentDesign's OBSERVATIONAL_TARGETS), so a primary target of
//    clueShare4 correctly steers nothing;
//  - the DECORRELATION mission scores a residual of a digit share against
//    density, which needs the same missing column, so it is passed as null
//    below rather than half-implemented.
//
// Carrying the four digit shares in the index would grow it from 37 KB to
// 61 KB (+61%), measured, on a file every host fetches to open the setup sheet.
// That is his call to make, not a thing to widen quietly, so today steering
// works with what the index already holds.
//
// PURE. The mission list arrives as an argument, so every decision here is
// testable without network, DOM or module cache (the moltDay / resumeEligibility
// pattern). currentSteerMissions() is the thin wrapper that reads the loaded
// experiment file.

import { steeredSlotCap, eligibleRows, pickMatchBoards } from './matchRules.js';
import {
  resolveMissionForSlot, missionCandidateScore, getTargetGimmickName,
  getCurrentTarget, getCoverageTargets, getShapeCoverage,
} from './experimentDesign.js';

// A shape mission's synthetic target key. It exists only to give the shared
// scorer something to read; it is never stamped on a board, stored, or sent
// anywhere, unlike the daily's missionStamp.
const SHAPE_TARGET_PREFIX = 'shape:';

/**
 * Build the ordered mission list from an experiment spec.
 *
 * Gimmick missions come through resolveMissionForSlot, the single-sourced slot
 * arithmetic, exactly as selectTilingMission does: slot 0 is the primary target
 * at its fixed low weight, slots 1..N are the coverage list one-to-one. A
 * mission whose target maps to no gimmick is dropped, because the index answers
 * only which modifiers are present on a board, and `decorrelation` is passed as
 * null for the same reason (see the header).
 *
 * Shape missions come from the refit's shape_coverage list, which is emitted on
 * the SAME 1/(n+1) deficit scale, so the two kinds rank against each other with
 * no invented conversion.
 *
 * The returned list is NOT sorted; ordering happens in planMatchDeal, where the
 * random tie-break belongs.
 *
 * @param {{target: string|null, coverage: Array, shapes: Array}} spec
 * @returns {Array<{kind: string, key: string, weight: number, mission: Object}>}
 */
export function steerMissions(spec) {
  const target = spec && typeof spec.target === 'string' ? spec.target : null;
  const coverage = Array.isArray(spec && spec.coverage) ? spec.coverage : [];
  const shapes = Array.isArray(spec && spec.shapes) ? spec.shapes : [];

  const missions = [];
  const seenKeys = new Set();
  const add = (kind, key, weight, mission) => {
    if (!key || !Number.isFinite(weight) || weight <= 0) return;
    // One mission per (kind, key). With a duplicated entry, two steered slots
    // would both be spent on the same study, the double-sampling the daily's
    // no-wrap slot rule exists to prevent.
    const id = `${kind}:${key}`;
    if (seenKeys.has(id)) return;
    seenKeys.add(id);
    missions.push({ kind, key, weight, mission });
  };

  for (let slot = 0; slot <= coverage.length; slot++) {
    const mission = resolveMissionForSlot(slot, target, coverage, null);
    if (!mission || !mission.target) continue;
    const gimmick = getTargetGimmickName(mission.target);
    if (!gimmick) continue;
    add('modifier', gimmick, mission.deficitWeight, mission);
  }

  for (const entry of shapes) {
    if (!entry || typeof entry.shape !== 'string') continue;
    const weight = Number(entry.deficit_weight);
    add('shape', entry.shape, weight, {
      target: SHAPE_TARGET_PREFIX + entry.shape,
      deficitWeight: weight,
      isPrimary: false,
    });
  }

  return missions;
}

/** The mission list for right now, from the loaded experimentTarget.json. */
export function currentSteerMissions() {
  return steerMissions({
    target: getCurrentTarget(),
    coverage: getCoverageTargets(),
    shapes: getShapeCoverage(),
  });
}

/**
 * Does this row advance this mission, and by how much?
 *
 * The index answers PRESENCE, never a count, so the row's feature vector is a
 * single 1/0 indicator and the shared scorer's `min(count, COUNT_CAP) x weight`
 * collapses to the mission's own deficit weight. Routing through
 * missionCandidateScore anyway is not ceremony: it keeps the score formula
 * single-sourced (CLAUDE.md's standing rule), and the observational refusal
 * comes with it, so a digit-share target scores 0 here for the same reason it
 * scores 0 on the daily.
 */
function rowMissionScore(entry, row) {
  const present = entry.kind === 'shape'
    ? (row.shape === entry.key ? 1 : 0)
    : ((Array.isArray(row.mods) ? row.mods : []).includes(entry.key) ? 1 : 0);
  const score = missionCandidateScore(entry.mission, { [entry.mission.target]: present });
  return Number.isFinite(score) ? score : 0;
}

/** In-place Fisher-Yates over `arr` using the supplied rand. */
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Plan a match's deal: which stored boards, in what order.
 *
 * @param {Array} rows       the parsed match index (ALL rows, unfiltered)
 * @param {Object} rules     the match's sanitized rules
 * @param {Object} [opts]
 * @param {Function} [opts.rand]      unit-interval source (injected for tests).
 *   Unlike the daily's selection, nothing here needs cross-client determinism:
 *   each host deals their own match and ships the dealt entries, so the stream
 *   position carries no contract and consuming it is free.
 * @param {Array}  [opts.seenKeys]    this device's seen `page:idx` keys
 * @param {Array}  [opts.missions]    steerMissions output; [] disables steering
 * @returns {{picks: Array, cycled: boolean, eligible: number, steered: Array}}
 *   `steered` names the missions actually claimed, for logs and tests. Nothing
 *   surfaces it to the player, deliberately: if a player can tell a board was
 *   chosen for a study, the steering has failed his "it can't feel forced" bar.
 */
export function planMatchDeal(rows, rules, opts = {}) {
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const seenKeys = Array.isArray(opts.seenKeys) ? opts.seenKeys : [];
  const missions = Array.isArray(opts.missions) ? opts.missions : [];

  // The filter, applied here so no steering path can reach around it.
  const eligible = eligibleRows(Array.isArray(rows) ? rows : [], rules);
  const count = Math.max(0, Math.round(Number(rules && rules.count) || 0));

  // His cycle rule, stated once: every UNSEEN eligible board is dealt before
  // any seen one, and `cycled` says the seen list for this space should restart
  // rather than grow. Both are computed here from the full eligible set, so
  // they mean exactly what they meant before steering existed, whatever
  // steering then claims.
  const seen = new Set(seenKeys);
  const unseenCount = eligible.reduce((n, r) => n + (seen.has(r.key) ? 0 : 1), 0);
  const cycled = unseenCount < count && eligible.length - unseenCount > 0;

  const cap = Math.min(steeredSlotCap(count), count);
  if (cap === 0 || missions.length === 0 || eligible.length === 0) {
    const plain = pickMatchBoards(eligible, count, rand, seenKeys);
    return { picks: plain.picks, cycled, eligible: eligible.length, steered: [] };
  }

  // How many of this deal's slots must come from boards the player has already
  // met. A steered pick may be drawn from that budget and never from beyond it:
  // reaching into the seen remainder while unseen boards are still available
  // would re-deal a board the player has met, which is the one thing the cycle
  // rule forbids.
  let seenBudget = Math.max(0, Math.min(count, eligible.length) - unseenCount);

  // Most starved first, ties broken at RANDOM. The tie-break is not a detail:
  // on a night when several shapes sit at zero boards their weights are
  // identical, and a fixed order would send every steered slot in the world to
  // whichever one happened to sort first (the monoculture the daily's argmax
  // produced, from the other direction). Array.prototype.sort is stable, so
  // shuffling first and then sorting by weight leaves equal weights in random
  // order.
  const ranked = shuffle(missions.slice(), rand)
    .slice()
    .sort((a, b) => b.weight - a.weight);

  const claimed = [];
  const steered = [];
  const taken = new Set();
  for (const entry of ranked) {
    if (claimed.length >= cap) break;
    // Only rows still available, and only rows this mission actually advances.
    const matches = eligible.filter((r) => !taken.has(r.key) && rowMissionScore(entry, r) > 0);
    if (matches.length === 0) continue;          // nothing eligible advances it
    const fresh = matches.filter((r) => !seen.has(r.key));
    let pool = fresh;
    if (fresh.length === 0) {
      if (seenBudget === 0) continue;            // would break the cycle rule
      pool = matches;
      seenBudget--;
    }
    const row = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    taken.add(row.key);
    claimed.push(row);
    steered.push({ kind: entry.kind, key: entry.key, weight: entry.weight, boardKey: row.key });
  }

  // The rest of the match is the ordinary pick over what steering did not
  // claim. It re-derives its own unseen/seen split from the remaining rows,
  // which stays correct because no more seen boards are claimed above than the
  // deal was going to use anyway.
  const remaining = eligible.filter((r) => !taken.has(r.key));
  const fill = pickMatchBoards(remaining, count - claimed.length, rand, seenKeys);

  // Interleave by shuffling the whole dealt list. A steered board is then
  // equally likely at any position in the match, which is what keeps the
  // ~20% invisible; clustering them at the front would announce them.
  const picks = shuffle(claimed.concat(fill.picks), rand);
  return { picks, cycled, eligible: eligible.length, steered };
}
