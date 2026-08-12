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

// ── The index row: ONE shape, two writers ───────────────────────────────
//
// match-index.json carries a compact row per stored board so one fetch
// answers both the sheet's live counts and the deal's eligibility. The
// build script writes rows through matchIndexRow; the client reads them
// through parseMatchIndex. Position fields ride IN the row (page, idx)
// because the rows array is flat across pages, and (page:idx) doubles as
// the seen-cycle key, stable across the nightly reprice, which rewrites
// numbers in place and never moves a board between pages.

export function matchIndexRow(page, idx, entry) {
  return [page, idx, entry.spec.shape, entry.spec.cells, entry.spec.mines,
    entry.par, (entry.spec.gimmicks || []).slice().sort()];
}

export function parseMatchIndex(index) {
  if (!index || !Array.isArray(index.rows)) return null;
  const rows = [];
  for (const r of index.rows) {
    if (!Array.isArray(r) || r.length < 7) return null;
    const [page, idx, shape, cells, mines, par, mods] = r;
    if (!Number.isInteger(page) || !Number.isInteger(idx)) return null;
    if (typeof shape !== 'string' || !Array.isArray(mods)) return null;
    if (!Number.isFinite(cells) || !Number.isFinite(mines) || !Number.isFinite(par)) return null;
    rows.push({ page, idx, shape, cells, mines, par, mods, key: `${page}:${idx}` });
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
