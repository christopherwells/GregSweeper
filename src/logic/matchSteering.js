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
// WHAT STEERING SEES. Every index row carries its board's FEATURE VECTOR (his
// call, 2026-08-12), so a mission scores on the same numbers the par model
// reads. Three kinds of mission are therefore reachable, and the scorer is the
// daily's own in all three cases:
//
//  - COVERAGE and PRIMARY targets score on the real count, so a board with
//    four compass cells outranks one with a single cell rather than tying it;
//  - the DECORRELATION mission works, because the residual it scores needs a
//    digit share AND its confounder, and the vector carries both. This is the
//    one place a digit share may be aimed at: as a LEVEL they are
//    observational, measured on every board and never maximized, and
//    missionCandidateScore keeps refusing them on that basis;
//  - SHAPE coverage, which has no feature key and rides a synthetic one below.
//
// The vector is positional against the index's `featureKeys` header, which is
// what keeps it affordable: 119 KB raw and 28 KB gzipped against 7.7 KB
// before, where an object per row would have been 633 KB. See matchRules.js.
//
// PURE. The mission list arrives as an argument, so every decision here is
// testable without network, DOM or module cache (the moltDay / resumeEligibility
// pattern). currentSteerMissions() is the thin wrapper that reads the loaded
// experiment file.

import { steeredSlotCap, eligibleRows, pickMatchBoards } from './matchRules.js';
import {
  resolveMissionForSlot, missionCandidateScore,
  getCurrentTarget, getCoverageTargets, getShapeCoverage, getDecorrelationMission,
} from './experimentDesign.js';

// A shape mission's synthetic target key. It exists only to give the shared
// scorer something to read; it is never stamped on a board, stored, or sent
// anywhere, unlike the daily's missionStamp.
const SHAPE_TARGET_PREFIX = 'shape:';

// Two boards count as equally good for a mission within this much. Feature
// counts tie exactly, but a decorrelation residual is a float and two boards
// the same distance off the line should share the draw rather than have the
// last bit of arithmetic pick between them.
const SCORE_EPS = 1e-9;

/**
 * Build the ordered mission list from an experiment spec.
 *
 * Feature missions come through resolveMissionForSlot, the single-sourced slot
 * arithmetic, exactly as selectTilingMission does: slot 0 is the primary target
 * at its fixed low weight, slots 1..N are the coverage list one-to-one, and the
 * slot past them is the decorrelation mission on the nights the refit ships
 * one. No mission is filtered out by kind: the index carries the whole feature
 * vector, so a mission the boards cannot advance scores 0 and claims nothing,
 * which reaches the same outcome by a shorter route.
 *
 * Shape missions come from the refit's shape_coverage list, which is emitted on
 * the SAME 1/(n+1) deficit scale, so the two kinds rank against each other with
 * no invented conversion.
 *
 * The returned list is NOT sorted; ordering happens in planMatchDeal, where the
 * random tie-break belongs.
 *
 * @param {{target: string|null, coverage: Array, shapes: Array,
 *          decorrelation: Object|null}} spec
 * @returns {Array<{kind: string, key: string, weight: number, mission: Object}>}
 */
export function steerMissions(spec) {
  const target = spec && typeof spec.target === 'string' ? spec.target : null;
  const coverage = Array.isArray(spec && spec.coverage) ? spec.coverage : [];
  const shapes = Array.isArray(spec && spec.shapes) ? spec.shapes : [];
  const decorrelation = (spec && spec.decorrelation) || null;

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

  // One past the coverage list is the decorrelation slot: resolveMissionForSlot
  // returns that mission for every slot beyond the list, so one extra step
  // reaches it and the dedupe keeps it to one claim.
  for (let slot = 0; slot <= coverage.length + 1; slot++) {
    const mission = resolveMissionForSlot(slot, target, coverage, decorrelation);
    if (!mission || !mission.target) continue;
    // A decorrelation mission is keyed apart from a plain one on the same
    // feature: they are different studies (the residual against a confounder,
    // versus the level), and one must not dedupe the other away.
    const kind = mission.type === 'decorrelation' ? 'decorrelation' : 'feature';
    add(kind, mission.target, mission.deficitWeight, mission);
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
    decorrelation: getDecorrelationMission(),
  });
}

/**
 * Does this row advance this mission, and by how much?
 *
 * The board's own feature vector goes straight into missionCandidateScore, the
 * daily's scorer, so the formula stays single-sourced (CLAUDE.md's standing
 * rule) and everything it decides comes along: the count cap, the residual
 * arithmetic on a decorrelation mission, and the refusal to maximize an
 * observational target.
 *
 * A SHAPE mission has no feature key, so it rides a synthetic one whose value
 * is the 1/0 indicator "is this board that lattice". The same cap-and-weight
 * arithmetic then applies to it unchanged.
 */
function rowMissionScore(entry, row) {
  const features = (row && row.features) || {};
  const score = entry.kind === 'shape'
    ? missionCandidateScore(entry.mission, { [entry.mission.target]: row.shape === entry.key ? 1 : 0 })
    : missionCandidateScore(entry.mission, features);
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
    const matches = [];
    for (const r of eligible) {
      if (taken.has(r.key)) continue;
      const score = rowMissionScore(entry, r);
      if (score > 0) matches.push({ row: r, score });
    }
    if (matches.length === 0) continue;          // nothing eligible advances it
    const fresh = matches.filter((m) => !seen.has(m.row.key));
    let pool = fresh;
    if (fresh.length === 0) {
      if (seenBudget === 0) continue;            // would break the cycle rule
      pool = matches;
      seenBudget--;
    }
    // The BEST board for this mission, not any board that scores at all. This
    // is what carrying the feature vector buys: a board with four compass
    // cells advances the compass study further than one with a single cell,
    // and under the old presence-only index the two were indistinguishable.
    // Ties break at random, and the seen-cycle is what stops the same strong
    // board being dealt to the same player over and over.
    let best = pool[0].score;
    for (const m of pool) { if (m.score > best) best = m.score; }
    const top = pool.filter((m) => m.score >= best - SCORE_EPS);
    const row = top[Math.min(top.length - 1, Math.floor(rand() * top.length))].row;
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
