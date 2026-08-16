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
// HIS CUTOFFS, 2026-08-15: Quick is under two minutes, Standard two to four,
// Long past four. They replace 60/150, which he called wrong on sight once the
// distribution was in front of him ("I didn't realize we were so off").
//
// The old numbers sold a two-and-a-half minute board as "Standard" and put
// everything past that in one bucket. Measured over 17,434 boards, the move
// re-sorts the library to 13,679 Quick / 3,327 Standard / 428 Long: heavily
// front-loaded, which is honest about what the library actually holds rather
// than about what its labels used to claim.
//
// A BOARD'S BAND IS ITS PAR, ABSOLUTELY, not relative to its shape. Relative
// per-shape boundaries were the standing proposal, because sparse boards price
// long and dense ones price quick, so some shape-by-band cells looked
// unreachable. Probed at each shape's largest phone-legal size with modifier
// stacks, every one of the seven clears 240s, including 3D Cubes, whose
// apparent ceiling of 208s was an artifact of never having been searched above
// 75 cells when 135 are legal. So absolute bands are FILLABLE and the relative
// design is not needed. What the probe does not establish is where each ceiling
// really sits: those predictions run far outside the data the par model was fit
// on, and no board over ~144 cells has ever been played.
export const MATCH_TIME_BANDS = [
  { key: 'quick', label: 'Quick', max: 120 },
  { key: 'short', label: 'Standard', max: 240 },
  { key: 'long', label: 'Long', max: Infinity },
];

/**
 * The longest board the match library will ADMIT (his ruling: "limit to 600
 * seconds for now").
 *
 * An admission rule for generation, deliberately not a membership bound: the
 * endless library learned that lesson already, where a shape's ceiling is
 * honored when a board is built and a later re-price is never allowed to evict
 * over it. Non-binding today, since no stored match board reaches 600s and
 * only seven pass 480s, so this is a gate on what the top-up may keep.
 *
 * A MARATHON set above this is his idea and explicitly deferred.
 */
export const MATCH_PAR_CEILING_SECONDS = 600;

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

// Difficulty in seconds of thinking per cell (his ruling 2026-08-16, labels
// his). par/cells is the ladder's own currency, so the cutoffs anchor to the
// Climb's ramp rather than to this library's happenstance: Gentle is the
// early-Climb pace, Mean is its upper blocks. Measured at adoption the
// library split roughly 25/48/27 across the three. Deliberately NOT part of
// the corner key: shards and seen-cycles stay untouched, rows filter on
// their own stored par and cells, and only the summary carries a per-corner
// split so the sheet's count stays exact.
export const MATCH_DIFFICULTY_BANDS = [
  { key: 'gentle', label: 'Gentle', max: 1.0 },
  { key: 'standard', label: 'Standard', max: 2.0 },
  { key: 'mean', label: 'Mean', max: Infinity },
];

export function difficultyBandOf(par, cells) {
  const ppc = cells > 0 ? par / cells : 0;
  for (const b of MATCH_DIFFICULTY_BANDS) { if (ppc < b.max) return b.key; }
  return MATCH_DIFFICULTY_BANDS[MATCH_DIFFICULTY_BANDS.length - 1].key;
}

/**
 * Whether a list of totals needs its tenths (his ruling 2026-08-16: "cut the
 * tenth of a second unless it actually matters"). It matters exactly when
 * two totals sit inside one second of each other, where the whole-second
 * form would show a tie that is not one.
 */
export function needsTenths(totals) {
  const t = (totals || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  for (let i = 1; i < t.length; i++) { if (t[i] - t[i - 1] < 1) return true; }
  return false;
}

/**
 * A total as a clock: m:ss past a minute, plain seconds under it, tenths
 * only when the caller says they matter. Never negative, never NaN text.
 */
export function fmtClock(sec, withTenths = false) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  // Round FIRST at the precision being shown, so 59.96 becomes 60 before
  // the minute split and carries to 1:00 instead of printing 60s or 1:60.
  const v = withTenths ? Math.round(sec * 10) / 10 : Math.round(sec);
  if (v >= 60) {
    const m = Math.floor(v / 60);
    const rem = withTenths ? Math.round((v - m * 60) * 10) / 10 : v - m * 60;
    const s = withTenths ? rem.toFixed(1) : String(rem);
    const [whole, tenth] = s.split('.');
    return `${m}:${whole.padStart(2, '0')}${tenth ? `.${tenth}` : ''}`;
  }
  return withTenths ? `${v.toFixed(1)}s` : `${v}s`;
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
    difficulty: 'any',
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
  const diffOk = raw.difficulty === undefined || raw.difficulty === 'any'
    || MATCH_DIFFICULTY_BANDS.some((b) => b.key === raw.difficulty);
  return {
    count,
    shapes: shapes.length ? shapes : def.shapes,
    mods,
    time: timeOk ? raw.time : 'any',
    density: densOk ? raw.density : 'any',
    difficulty: diffOk && raw.difficulty ? raw.difficulty : 'any',
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

// The one class of feature the index does NOT carry. Contribution keys are
// measured on every library board and ride the PAGE, which is where a dealt
// entry (and therefore its fit row) takes its features from, so excluding them
// here costs the study nothing. They are kept out of the STEERING vector for
// the reason they were kept out of `target_candidates`: a contribution effect
// must never be FORCE-INJECTABLE. His ruling made that structural rather than
// conventional, "candidate vectors lack the keys, so a mission targeting one
// could never win a day", and a header derived blindly from the boards would
// quietly hand the keys back on the first build that measured them. The size
// argument agrees with the ruling: over the 2,759-board library they add 56 KB
// (+16%) to the shards a deal fetches, to steer on what nothing may steer on.
//
// Stated as the SUFFIX CONVENTION rather than as a copy of
// CONTRIBUTION_FEATURE_KEYS. That constant is defined in boardSolver.js, so
// importing it here would mean loading the whole solver into this leaf, and
// into the setup sheet along with it.
// test/matchRules.test.mjs pins the two against each other in BOTH directions,
// so neither a new measured type nor an innocent key ending in "Required" can
// drift the sets apart unnoticed.
const CONTRIBUTION_KEY_RE = /(?:Required|ClicksSaved)$/;

/** The union of every entry's feature keys, sorted: the index's own header. */
export function matchIndexFeatureKeys(entries) {
  const keys = new Set();
  for (const e of entries || []) {
    for (const k of Object.keys((e && e.features) || {})) {
      if (!CONTRIBUTION_KEY_RE.test(k)) keys.add(k);
    }
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

// ── The SPLIT index: one summary, one shard per shape ───────────────────
//
// THE INDEX WAS THE THING THAT DID NOT SCALE. Every client fetched
// match-index.json WHOLE to open the setup sheet (for the live counts) and
// again at deal time, against one row per stored board: 349 KB / 71 KB
// gzipped at 2,759 boards. His depth target is ~100 boards per (shape x
// modifier x length x mines), which is 819,000 boards and a 21 MB gzipped
// index. The PAGES were already sharded by shape and fetched on demand, so
// the index was the only monolith left and the only thing standing between
// the library and real depth.
//
// It splits along the two questions clients actually ask, which have very
// different sizes:
//
//   THE SHEET asks "how many boards fit these rules", and only ever needs a
//   COUNT. A count per corner is bounded by the library's VARIETY (shape x
//   modifier set x time band x density band), not by its depth: 347 corners
//   at 2,759 boards, and still 347 at 819,000, because adding boards to a
//   corner moves a number rather than adding a row. That is the whole reason
//   this is the fix rather than a smaller row format.
//
//   THE DEAL asks for the eligible rows themselves, and only for the shapes
//   in the host's filter. So the rows go into one shard per shape and a deal
//   fetches only what its rules can reach.
//
// The corner key is derived from boardMatchesRules' own decisions, so the
// summed count and the filtered length cannot disagree; test/matchLibrary
// asserts that equality over the shipped library, which is what keeps this a
// single definition rather than a parallel one.

// ONE FILE PER CORNER (his ruling 2026-08-14). The index was sharded by SHAPE,
// which meant a player who picked Classic, Quick, Sparse and no modifiers
// downloaded the metadata for every Classic board in the library to be dealt
// ten. Measured over 13,986 rows: 89 KB gzipped for one shape, 374 KB for all
// seven, whatever the rest of the selection said.
//
// Sharding on all four axes the filter tests makes the download follow the
// CHOICE. That same selection now costs 0.7 KB, and the worst case anyone can
// construct (every shape, every band, three modifiers) costs 77 KB, still five
// times cheaper than today's best case. His framing: a player who picks "any"
// is signing up for the wider download, and that is honest pricing rather than
// everybody paying the maximum.
//
// The trade is REQUEST COUNT, not bytes: that worst case is 156 small files.
// They are tiny and multiplexed, and the summary tells the client which
// corners exist so it never asks for one that does not. If round trips ever
// bite on a slow connection, the fix is grouping the modifier axis back up,
// not abandoning the split.
export const MATCH_SHARD_PREFIX = 'mx';

/**
 * Filename for one corner's index shard, relative to the library directory.
 *
 * Takes the corner's four parts in the same order matchCornerKey emits them,
 * so a caller cannot accidentally transpose two of them. `mods` is the sorted
 * '+'-joined set, or empty for a plain board.
 */
export function matchShardFile(shape, time, density, mods, prefix = MATCH_SHARD_PREFIX) {
  return `${prefix}-${shape}-${time}-${density}-${mods || 'none'}.json`;
}

/** The shard file a row belongs in, straight from its own corner. */
export function matchShardFileForRow(row) {
  const [shape, mods, time, density] = matchCornerKey(row);
  return matchShardFile(shape, time, density, mods);
}

// ── THE HARVEST: the Climb library as a second shelf ────────────────────
//
// His ruling 2026-08-16, "Do this first": the Climb's boards become
// dealable for Challenge. They are certified, priced by the same nightly
// refit, and concentrated exactly where this library is thinnest
// (measured at build: 833 corners with no match board, 3,825 boards, 96%
// carrying two or more modifiers, two-thirds long or short).
//
// HIS INVIOLABLE, verbatim: "The climb times do finish DO NOT TRANSFER!"
// Nothing crosses between the modes in either direction. Two structural
// rules carry that here. Harvest rows key their seen-cycle as `c:<seed>`
// inside the MATCH seen list, never any Climb store, and by SEED because
// the nightly re-bin renumbers Climb files, so a file+index key would rot
// where a seed key cannot. And a harvest pick resolves by locator PLUS
// seed (resolveMatchPicks), so a re-binned file can never hand the deal a
// different board than the index promised; the mismatch reads as missing
// and the deal degrades honestly.
export const CLIMB_SHARD_PREFIX = 'cmx';

/** One harvest index row: the Climb file stem and index locate the board,
 * the seed IS its identity, and the corner and feature fields are exactly
 * what matchIndexRow carries so eligibility and steering read both shelves
 * with one set of eyes. */
export function climbIndexRow(file, idx, entry, featureKeys = []) {
  const f = (entry && entry.features) || {};
  return [file, idx, entry.spec.shape, entry.spec.cells, entry.spec.mines,
    entry.par, (entry.spec.gimmicks || []).slice().sort(), entry.seed,
    featureKeys.map((k) => _round(f[k]))];
}

/** Read a harvest shard back. Same contract as parseMatchIndex: null on a
 * malformed file, `features: {}` on a row without its vector. */
export function parseClimbMatchIndex(index) {
  if (!index || !Array.isArray(index.rows)) return null;
  const featureKeys = Array.isArray(index.featureKeys) ? index.featureKeys : [];
  const rows = [];
  for (const r of index.rows) {
    if (!Array.isArray(r) || r.length < 8) return null;
    const [file, idx, shape, cells, mines, par, mods, seed, vec] = r;
    if (typeof file !== 'string' || !Number.isInteger(idx)) return null;
    if (typeof shape !== 'string' || !Array.isArray(mods)) return null;
    if (typeof seed !== 'string' || !seed) return null;
    if (!Number.isFinite(cells) || !Number.isFinite(mines) || !Number.isFinite(par)) return null;
    const features = {};
    if (Array.isArray(vec)) {
      for (let i = 0; i < featureKeys.length && i < vec.length; i++) {
        const n = Number(vec[i]);
        if (Number.isFinite(n)) features[featureKeys[i]] = n;
      }
    }
    rows.push({ page: file, idx, seed, shape, cells, mines, par, mods, features, key: `c:${seed}` });
  }
  return rows;
}

/**
 * Every subset of the player's chosen modifiers, as sorted '+'-joined keys.
 *
 * The modifier filter is a SUBSET test: someone who ticks walls and liar may
 * be dealt a plain board, a walls board, a liar board or a walls+liar board.
 * So the files they need are the subsets of their selection, and that is what
 * makes the request count grow with how much they ticked.
 */
export function modSubsetKeys(mods) {
  const list = [...new Set(mods || [])].sort();
  let out = [[]];
  for (const m of list) out = [...out, ...out.map((s) => [...s, m])];
  return out.map((s) => s.slice().sort().join('+') || '');
}

/**
 * Exactly the shard files a rules object needs, and no others.
 *
 * `corners` is the summary's corner list, which is what keeps this from
 * requesting files that were never written: an empty corner has no file, and
 * asking for one would spend a round trip to learn nothing. Pass null to get
 * the full cross product instead, which a client without a summary must.
 */
export function matchShardFilesFor(rules, corners, prefix = MATCH_SHARD_PREFIX) {
  const shapes = rules && rules.shapes && rules.shapes.length ? rules.shapes : [];
  const times = rules && rules.time && rules.time !== 'any'
    ? [rules.time] : MATCH_TIME_BANDS.map((b) => b.key);
  const dens = rules && rules.density && rules.density !== 'any'
    ? [rules.density] : MATCH_DENSITY_BANDS.map((b) => b.key);
  const modKeys = modSubsetKeys(rules && rules.mods);
  // parseMatchSummary hands `mods` back as an ARRAY, so it is re-joined here
  // rather than compared as a string. Comparing the array directly matches
  // nothing and would silently request the full cross product.
  const live = corners
    ? new Set(corners.map((c) => [c.shape, (c.mods || []).slice().sort().join('+'),
      c.time, c.density].join('|')))
    : null;
  const out = [];
  for (const s of shapes) {
    for (const t of times) {
      for (const d of dens) {
        for (const m of modKeys) {
          if (live && !live.has([s, m, t, d].join('|'))) continue;
          out.push(matchShardFile(s, t, d, m, prefix));
        }
      }
    }
  }
  return out;
}

/** The corner a row falls in: exactly the four things boardMatchesRules tests. */
export function matchCornerKey(row) {
  return [row.shape, (row.mods || []).slice().sort().join('+'),
    timeBandOf(row.par), densityBandOf(row.mines, row.cells)];
}

/**
 * The summary's `corners` payload: one [shape, mods, time, density, n] tuple
 * per occupied corner, sorted so the file is stable across rebuilds (a
 * reordered file is a diff nobody can read and a cache nobody can reuse).
 */
export function buildMatchCorners(rows) {
  const n = new Map();
  const diffIdx = new Map(MATCH_DIFFICULTY_BANDS.map((b, i) => [b.key, i]));
  for (const r of rows || []) {
    const k = JSON.stringify(matchCornerKey(r));
    const rec = n.get(k) || { count: 0, diff: MATCH_DIFFICULTY_BANDS.map(() => 0) };
    rec.count += 1;
    // The corner KEY deliberately excludes difficulty (shards and seen-cycles
    // must not move); the summary carries a per-corner split instead so the
    // sheet's count under a difficulty chip stays exact.
    rec.diff[diffIdx.get(difficultyBandOf(r.par, r.cells))] += 1;
    n.set(k, rec);
  }
  return [...n.entries()]
    .map(([k, rec]) => [...JSON.parse(k), rec.count, rec.diff])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0)
      || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
}

/**
 * Read a summary file back. Null when it is missing or malformed, so a caller
 * can fall back rather than render a count it did not measure.
 */
export function parseMatchSummary(summary) {
  if (!summary || !Array.isArray(summary.corners)) return null;
  const corners = [];
  for (const c of summary.corners) {
    if (!Array.isArray(c) || c.length < 5) return null;
    const [shape, mods, time, density, count, diff] = c;
    if (typeof shape !== 'string' || typeof mods !== 'string') return null;
    if (typeof time !== 'string' || typeof density !== 'string') return null;
    if (!Number.isFinite(count) || count < 0) return null;
    // The difficulty split is OPTIONAL: a summary cached before it shipped
    // still parses and still deals; a difficulty-filtered count then falls
    // back to the whole corner, overstating gracefully rather than refusing.
    const diffOk = Array.isArray(diff)
      && diff.length === MATCH_DIFFICULTY_BANDS.length
      && diff.every((x) => Number.isFinite(x) && x >= 0);
    corners.push({
      shape, mods: mods ? mods.split('+') : [], time, density, count,
      diff: diffOk ? diff.slice() : null,
    });
  }
  return corners;
}

/**
 * How many stored boards a rule set can reach, from the summary alone.
 *
 * MUST equal `eligibleRows(rows, rules).length`. The modifier test is the
 * reason this is a sum rather than a lookup: a board is eligible when its
 * modifiers are a SUBSET of the allowed ones, so a corner's boards count
 * toward every rule set that is a superset of that corner's own set, and
 * there is no single corner to read.
 */
export function countEligibleCorners(corners, rules) {
  const shapes = new Set(rules.shapes || []);
  const allowed = new Set(rules.mods || []);
  const wantDiff = rules.difficulty && rules.difficulty !== 'any'
    ? MATCH_DIFFICULTY_BANDS.findIndex((b) => b.key === rules.difficulty)
    : -1;
  let n = 0;
  for (const c of corners || []) {
    if (!shapes.has(c.shape)) continue;
    if (c.mods.some((m) => !allowed.has(m))) continue;
    if (rules.time !== 'any' && c.time !== rules.time) continue;
    if (rules.density !== 'any' && c.density !== rules.density) continue;
    n += wantDiff >= 0 && c.diff ? c.diff[wantDiff] : c.count;
  }
  return n;
}

// ── Eligibility + pick ──────────────────────────────────────────────────

export function boardMatchesRules(row, rules) {
  if (!rules.shapes.includes(row.shape)) return false;
  const allowed = new Set(rules.mods);
  for (const m of row.mods) { if (!allowed.has(m)) return false; }
  if (rules.time !== 'any' && timeBandOf(row.par) !== rules.time) return false;
  if (rules.density !== 'any' && densityBandOf(row.mines, row.cells) !== rules.density) return false;
  // `difficulty` may be absent on rules stored before it shipped; absent
  // means 'any', the way an unknown state reads as pending elsewhere.
  if (rules.difficulty && rules.difficulty !== 'any'
    && difficultyBandOf(row.par, row.cells) !== rules.difficulty) return false;
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
    // The harvest's stale-locator guard: a harvest pick carries the seed the
    // index promised, and the nightly re-bin moves Climb boards between
    // files, so an index cached across a re-bin can point at somebody else's
    // slot. A seed mismatch is a missing board, never a silent substitute.
    if (!entry || !entry.payload || !entry.seed
      || (pick.seed && entry.seed !== pick.seed)) {
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
