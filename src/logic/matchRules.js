// The Challenge match's rule vocabulary: board-count bounds, the mission
// steering cap, the config sheet's band tables, the host-unlock derivation,
// the library index row shape, the eligibility filter, and the pick.
//
// PURE AND A LEAF on purpose. The build script (scripts/
// build-match-library.mjs) writes index rows through matchIndexRow and the
// client filters them through boardMatchesRules, so the two ends of the
// match-index.json contract live in ONE module and cannot drift (the
// mirror-pair lesson). The Firebase-facing deal I/O lives in
// src/game/matchDeal.js; the sheet UI in src/ui/matchSetup.js.
//
// "Match" is this mode's internal name everywhere in code and storage; the
// player-facing name is "Challenge" (the ladder's old word, freed by the
// rename to The Climb). The head-to-head build (async match node, codes,
// live starts) layers onto this same vocabulary.

import { LIB_SHAPE_INTROS, LIB_MOD_INTROS } from './climbLibrary.js';
import { CHALLENGE_BLOCK_SIZE } from './challenge250.js';

// His ruling: 1-10 boards per match, host-chosen.
export const MATCH_BOARD_MIN = 1;
export const MATCH_BOARD_MAX = 10;

// His steering constraints, verbatim: the host's filter is the RULES and
// nothing may reach outside it; ~20% of boards may steer; "if no discovery
// can happen, that's fine"; it "can't feel forced". At most floor(N/5)
// boards of a match may be mission-steered, so a short match is pure
// variety. The cap is the standing contract; the steering itself arrives
// with the match node (the refit's mission spec has nothing to steer while
// solo matches record nothing).
export function steeredSlotCap(boardCount) {
  return Math.floor((Number(boardCount) || 0) / 5);
}

// ── The config sheet's bands ────────────────────────────────────────────
//
// Cutoffs sized against the built match library (see the build script's
// header): its pars run ~21-435s with the mass at the easy end (medians
// near 73s), so three bands are stocked everywhere: 353/404/163 boards at
// the shipped cuts. A fourth 300s+ band measured 19 boards with
// four shapes empty, which is a label, not a choice. `max` is
// exclusive-top; the last band is open. Par here is Greg's par; the sheet
// personalizes the readout through the player's handicap ratio where one
// exists. An empty (shape x band) combo is the pool's structural truth
// (rhombille tops out near 130s, the same cap its daily rungs have), and
// the sheet's live count is what says so.
export const MATCH_TIME_BANDS = [
  { key: 'quick', label: 'Quick', max: 60 },
  { key: 'short', label: 'Standard', max: 150 },
  { key: 'long', label: 'Long', max: Infinity },
];

// Density in plain language (his design-sheet ruling: "the density numbers
// don't really mean anything to the normal player"): the sheet renders each
// band through densityPhrase, never a decimal.
export const MATCH_DENSITY_BANDS = [
  { key: 'sparse', label: 'Sparse', max: 0.16 },
  { key: 'standard', label: 'Standard', max: 0.26 },
  { key: 'dense', label: 'Packed', max: Infinity },
];

export function timeBandOf(par) {
  for (const b of MATCH_TIME_BANDS) { if (par < b.max) return b.key; }
  return MATCH_TIME_BANDS[MATCH_TIME_BANDS.length - 1].key;
}

export function densityBandOf(mines, cells) {
  const d = cells > 0 ? mines / cells : 0;
  for (const b of MATCH_DENSITY_BANDS) { if (d < b.max) return b.key; }
  return MATCH_DENSITY_BANDS[MATCH_DENSITY_BANDS.length - 1].key;
}

/** "~1 in 4", the sheet's whole density vocabulary. */
export function densityPhrase(mines, cells) {
  if (!(mines > 0) || !(cells > 0)) return '';
  return `~1 in ${Math.max(2, Math.round(cells / mines))}`;
}

// ── Host unlocks ────────────────────────────────────────────────────────
//
// His ruling: the host's unlocks build the match. "Unlocked" means the
// player has won the Climb level where the shape or modifier debuts, read
// from the LIBRARY's introduction schedule (the one the runtime deals
// under), so the sheet can never offer a lattice the Climb has not yet
// introduced. Classic is always in. maxLevelReached is cloud-synced, so
// the answer is the same on every device.
const introLevel = (block) => (Number(block) - 1) * CHALLENGE_BLOCK_SIZE + 1;

export function matchUnlocks(maxLevelReached) {
  const lvl = Number(maxLevelReached) || 0;
  const shapes = ['rect'];
  for (const [block, shape] of Object.entries(LIB_SHAPE_INTROS)) {
    if (lvl >= introLevel(block)) shapes.push(shape);
  }
  const mods = [];
  for (const [block, mod] of Object.entries(LIB_MOD_INTROS)) {
    if (lvl >= introLevel(block)) mods.push(mod);
  }
  return { shapes, mods };
}

/** The Climb level at which a shape or modifier joins the sheet. */
export function matchUnlockLevel(kind, key) {
  const table = kind === 'shape' ? LIB_SHAPE_INTROS : LIB_MOD_INTROS;
  for (const [block, k] of Object.entries(table)) {
    if (k === key) return introLevel(block);
  }
  return null;
}

// ── Rules ───────────────────────────────────────────────────────────────
//
// A match's rules: { count, shapes, mods, time, density }.
//   count    1-10 boards
//   shapes   array of shape keys a board may be (at least one)
//   mods     array of modifier keys permitted on a board: a board
//            qualifies when its own set is a SUBSET of this, so an empty
//            list means plain boards only, and plain boards qualify under
//            a permissive list too (allowed, never required)
//   time     a MATCH_TIME_BANDS key or 'any'
//   density  a MATCH_DENSITY_BANDS key or 'any'

export function defaultMatchRules(unlocks) {
  return {
    count: 3,
    shapes: unlocks.shapes.slice(),
    mods: unlocks.mods.slice(),
    time: 'any',
    density: 'any',
  };
}

/**
 * Clamp arbitrary stored/receival rules to something playable under the
 * host's CURRENT unlocks: counts bound to 1-10, shapes/mods intersected
 * with the unlocked sets (an empty shape intersection falls back to every
 * unlocked shape, since a match must have at least one shape), band keys
 * validated. Never throws; a garbage input degrades to the defaults.
 */
export function sanitizeMatchRules(raw, unlocks) {
  const def = defaultMatchRules(unlocks);
  if (!raw || typeof raw !== 'object') return def;
  // Number.isFinite, not ||: a zero is a real (out-of-range) count that
  // must clamp to 1; only a non-number falls back to the default.
  const rawCount = Number(raw.count);
  const count = Math.min(MATCH_BOARD_MAX, Math.max(MATCH_BOARD_MIN,
    Math.round(Number.isFinite(rawCount) ? rawCount : def.count)));
  const shapeSet = new Set(unlocks.shapes);
  const shapes = Array.isArray(raw.shapes)
    ? raw.shapes.filter((s) => shapeSet.has(s)) : [];
  const modSet = new Set(unlocks.mods);
  const mods = Array.isArray(raw.mods)
    ? raw.mods.filter((m) => modSet.has(m)) : def.mods;
  const timeOk = raw.time === 'any' || MATCH_TIME_BANDS.some((b) => b.key === raw.time);
  const densOk = raw.density === 'any' || MATCH_DENSITY_BANDS.some((b) => b.key === raw.density);
  return {
    count,
    shapes: shapes.length ? shapes : def.shapes,
    mods,
    time: timeOk ? raw.time : 'any',
    density: densOk ? raw.density : 'any',
  };
}

/**
 * The rules a launch should actually play under.
 *
 * A HOST's rules are re-sanitized against their current unlocks, so a stale or
 * hand-edited saved rule set can never reach outside them (his rule: the
 * host's filter is the rules).
 *
 * A JOINED match plays the stored rules VERBATIM. Re-sanitizing them against
 * the guest's unlocks would silently rewrite the match the two players agreed
 * to, which is the opposite of his ruling that the host's unlocks build the
 * match with a warning rather than the intersection of both players'. The
 * boards are dealt and frozen before anyone joins, so at that point the rules
 * are a record of how they were chosen, not a filter still being applied.
 *
 * Extracted from launchMatch because that function persists, mutates state and
 * calls newGame, so the decision inside it could not otherwise be tested.
 *
 * @param {object|null} rawRules  the sheet's working copy (host path)
 * @param {object|null} shared    the joined match's stored node, if any
 * @param {{shapes: string[], mods: string[]}} unlocks this player's unlocks
 */
export function matchRulesForLaunch(rawRules, shared, unlocks) {
  if (shared && shared.rules && typeof shared.rules === 'object') return shared.rules;
  return sanitizeMatchRules(rawRules, unlocks);
}

/**
 * Which of a joined match's rules name something this player has not met.
 *
 * His ruling: the host's unlocks build the match, WITH A WARNING naming
 * anything a guest has not met. This returns those names so the join card can
 * say them; it never filters, because filtering is the intersection he ruled
 * against.
 */
export function unmetMatchRules(rules, unlocks) {
  if (!rules || !unlocks) return { shapes: [], mods: [] };
  const shapeSet = new Set(unlocks.shapes || []);
  const modSet = new Set(unlocks.mods || []);
  return {
    shapes: (rules.shapes || []).filter((s) => !shapeSet.has(s)),
    mods: (rules.mods || []).filter((m) => !modSet.has(m)),
  };
}

// ── The index row: ONE shape, two writers ───────────────────────────────
//
// match-index.json carries a compact row per stored board so one fetch
// answers both the sheet's live counts and the deal's eligibility. The
// build script writes rows through matchIndexRow; the client reads them
// through parseMatchIndex. Position fields ride IN the row (page, idx)
// because the rows array is flat across pages, and (page:idx) doubles as
// the seen-cycle key, stable across the nightly reprice, which rewrites
// numbers in place and never moves a board between pages.

// ── The feature vector rides the index (2026-08-12, his call) ───────────
//
// Element 8 of a row is the board's FEATURE VECTOR, so mission steering can
// score a board on the same numbers the par model reads instead of on whether
// a modifier is merely present. That is what puts the feature-level targets in
// reach: a primary target like advancedLogicMoves, and the DECORRELATION
// mission, whose residual needs a digit share and its confounder.
//
// POSITIONAL, against a `featureKeys` header on the index object, because the
// key names are most of the bytes. Measured over the 920-board library: a full
// object per row is 633 KB (+1581%), the positional form is 119 KB (+217%),
// and on the wire, which is what a phone pays, gzip takes it from 7.7 KB to
// 28 KB. The header is written FROM the data rather than from a constant, so a
// new feature key needs no edit here and cannot silently fall out of the file.
//
// Values round to MATCH_INDEX_FEATURE_DP. These numbers steer a choice among
// boards; par is re-priced from the PAGE's full-precision features, so the
// rounding cannot reach a number a player sees.
export const MATCH_INDEX_FEATURE_DP = 4;

const _round = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (Number.isInteger(n)) return n;
  const f = 10 ** MATCH_INDEX_FEATURE_DP;
  return Math.round(n * f) / f;
};

/** The union of every entry's feature keys, sorted: the index's own header. */
export function matchIndexFeatureKeys(entries) {
  const keys = new Set();
  for (const e of entries || []) {
    for (const k of Object.keys((e && e.features) || {})) keys.add(k);
  }
  return [...keys].sort();
}

export function matchIndexRow(page, idx, entry, featureKeys = []) {
  const f = (entry && entry.features) || {};
  return [page, idx, entry.spec.shape, entry.spec.cells, entry.spec.mines,
    entry.par, (entry.spec.gimmicks || []).slice().sort(),
    featureKeys.map((k) => _round(f[k]))];
}

/**
 * Read the index back.
 *
 * A row WITHOUT its feature array parses fine and yields `features: {}`: an
 * index written before the vector shipped still deals boards, it just cannot
 * steer on features. Rejecting it would turn a stale cached file into an
 * unplayable Challenge, which is a far worse trade than a quiet study.
 */
export function parseMatchIndex(index) {
  if (!index || !Array.isArray(index.rows)) return null;
  const featureKeys = Array.isArray(index.featureKeys) ? index.featureKeys : [];
  const rows = [];
  for (const r of index.rows) {
    if (!Array.isArray(r) || r.length < 7) return null;
    const [page, idx, shape, cells, mines, par, mods, vec] = r;
    if (!Number.isInteger(page) || !Number.isInteger(idx)) return null;
    if (typeof shape !== 'string' || !Array.isArray(mods)) return null;
    if (!Number.isFinite(cells) || !Number.isFinite(mines) || !Number.isFinite(par)) return null;
    const features = {};
    if (Array.isArray(vec)) {
      for (let i = 0; i < featureKeys.length && i < vec.length; i++) {
        const n = Number(vec[i]);
        if (Number.isFinite(n)) features[featureKeys[i]] = n;
      }
    }
    rows.push({ page, idx, shape, cells, mines, par, mods, features, key: `${page}:${idx}` });
  }
  return rows;
}

// ── Eligibility + pick ──────────────────────────────────────────────────

export function boardMatchesRules(row, rules) {
  if (!rules.shapes.includes(row.shape)) return false;
  const allowed = new Set(rules.mods);
  for (const m of row.mods) { if (!allowed.has(m)) return false; }
  if (rules.time !== 'any' && timeBandOf(row.par) !== rules.time) return false;
  if (rules.density !== 'any' && densityBandOf(row.mines, row.cells) !== rules.density) return false;
  return true;
}

export function eligibleRows(rows, rules) {
  return rows.filter((r) => boardMatchesRules(r, rules));
}

/**
 * Pick a match's boards: uniform over the UNSEEN eligible rows first (his
 * seen-cycle rule at match scale), never the same board twice in one match,
 * cycling into the seen remainder only when the unseen supply runs out.
 * Returns fewer than `count` picks only when the eligible set itself is
 * smaller than the match. `cycled` tells the caller the seen list for these
 * rules' space should restart rather than grow.
 */
export function pickMatchBoards(rows, count, rand = Math.random, seenKeys = []) {
  const eligible = rows.slice();
  const seen = new Set(seenKeys || []);
  const unseen = eligible.filter((r) => !seen.has(r.key));
  const rest = eligible.filter((r) => seen.has(r.key));
  const picks = [];
  const drawFrom = (pool) => {
    const i = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
    return pool.splice(i, 1)[0];
  };
  while (picks.length < count && unseen.length) picks.push(drawFrom(unseen));
  const cycled = picks.length < count && rest.length > 0;
  while (picks.length < count && rest.length) picks.push(drawFrom(rest));
  return { picks, cycled };
}

/**
 * Resolve a deal's picks against the fetched page contents.
 *
 * Pure so the pairing can be tested without the fetches around it, and pure
 * BECAUSE the pairing is where a defect hid: the caller used to collect the
 * entries and then take the first `entries.length` picks for the seen list,
 * which is only right when every failure lands at the END. A page that fails
 * in the middle of a deal marked a board seen that nobody was dealt and left a
 * dealt one unmarked, quietly corrupting his cycle rule on exactly the
 * degraded path where the player can least afford a repeat.
 *
 * @param {Array} picks   the planned picks, in play order
 * @param {Map}   byPage  page number -> that page's boards array (or null)
 * @returns {{entries: Array, keys: string[], missing: Array}} entries and
 *   their seen keys in lockstep, plus the picks that resolved to nothing so
 *   the caller can report them.
 */
export function resolveMatchPicks(picks, byPage) {
  const entries = [];
  const keys = [];
  const missing = [];
  for (const pick of picks || []) {
    const boards = byPage && byPage.get ? byPage.get(pick.page) : null;
    const entry = Array.isArray(boards) ? boards[pick.idx] : null;
    if (!entry || !entry.payload || !entry.seed) {
      missing.push(pick);
      continue;
    }
    entries.push(entry);
    keys.push(pick.key);
  }
  return { entries, keys, missing };
}

// ── Match progression + totals ──────────────────────────────────────────

/** After a board is banked: another board, or the match summary? */
export function matchAdvance(match) {
  if (!match || !Array.isArray(match.entries)) return 'summary';
  return match.current + 1 < match.entries.length ? 'next' : 'summary';
}

/**
 * Match totals over the per-board results [{time, penalty}, ...]. `time`
 * is each board's penalty-inclusive final clock (what the player saw);
 * `penalty` the strike seconds inside it. Adjusted is time / k, the
 * leaderboard's own adjusted-view convention (rankAdjusted), and null for
 * an unrated player rather than a fake 1.0 pretense.
 */
export function matchTotals(results, k) {
  let raw = 0;
  let penalty = 0;
  for (const r of results || []) {
    raw += (r && Number.isFinite(r.time)) ? r.time : 0;
    penalty += (r && Number.isFinite(r.penalty)) ? r.penalty : 0;
  }
  raw = Math.round(raw * 10) / 10;
  penalty = Math.round(penalty * 10) / 10;
  const adjusted = (Number.isFinite(k) && k > 0)
    ? Math.round((raw / k) * 10) / 10
    : null;
  return { raw, penalty, adjusted };
}
