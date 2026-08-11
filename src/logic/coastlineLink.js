// The ?coastline= deep link: what a tiling name means (Project Coastline).
//
// This link is the ONLY place a tiling name arrives from OUTSIDE the code, so
// the three decisions that name drives live here together and are node-tested:
// which tiling to build, which modifiers to place on it, and what to call the
// shape in the toast.
//
// It used to be an inline if/else in main.js, which is how the parser acquired
// its silent failure: an unrecognized shape token was not rejected, it was
// reinterpreted as a MODIFIER LIST. So `?coastline=cairo` generated an ordinary
// 4.8.8 carrying a gimmick named "cairo", which applyGimmicks then dropped from
// its ORDER filter, with no error anywhere. With two tilings that was a typo you
// would notice; with six it is a link you would believe.
//
// Pure module: no DOM, no state, no clock. main.js hands it the raw query value
// and gameActions.js reads the board table.

import { TILING_TYPES } from './tilingGeometry.js';

// The shape a link with no prefix means. Every ?coastline= link written before
// prefixes existed omits one, so this is a compatibility anchor, not a taste
// call: it must stay the 4.8.8.
export const DEFAULT_TILING = '4.8.8';

// Query token -> tiling type. Every canonical name is its own token, DERIVED
// from TILING_TYPES rather than listed again, so a seventh tiling is reachable
// by name the day its builder lands (the label and the board below are real
// per-tiling decisions and stay hand-written, with the test asserting each
// covers the whole list). The rest are aliases: the lattice shorthands plus
// the PLAYER-FACING names (space-free forms, a URL token can't carry a
// space), so a link can say what a player would say. Tokens are matched
// lowercased, and none collides with a modifier name, which is what lets one
// string carry either.
const TILING_TOKENS = {
  ...Object.fromEntries(TILING_TYPES.map(t => [t, t])),
  '488': '4.8.8',
  '6.6.6': 'hex',
  '666': 'hex',
  octagons: '4.8.8',
  honeycomb: 'hex',
  paving: 'cairo',
  pavingstones: 'cairo',
  petals: 'floret',
  cubes: 'rhombille',
  '3dcubes': 'rhombille',
  kites: 'deltoidal',
};

// The PLAYER-FACING name of each shape (Christopher's ruling, 2026-08-02: a
// lay person should know what they mean, "4.8.8" and "deltoidal" are
// internal identifiers, not names). The name is what the eye sees: the
// octagon-and-square bathroom floor, a honeycomb, Cairo's street paving,
// pentagon petals in six-flower rosettes, the tumbling-blocks illusion of
// stacked 3D cubes, plain kites. The rectangular grid is "Classic" wherever
// a shape name is needed beside these. Internal type strings NEVER change
// with the display names, they are stored contracts (canonical
// `tiling.type`, `features.tilingType`, PAR_MODEL_SHAPES keys, lab rows,
// seed strings), and renaming them would be the wallEdges-format
// silent-breakage class.
const TILING_LABELS = {
  '4.8.8': 'Octagons',
  hex: 'Honeycomb',
  cairo: 'Paving Stones',
  floret: 'Petals',
  rhombille: '3D Cubes',
  deltoidal: 'Kites',
};

// The Classic (rectangular) grid's display name, exported so every surface
// that names shapes beside the tilings says the same word.
export const CLASSIC_SHAPE_LABEL = 'Classic';

/**
 * Resolve a raw shape token (deep-link value, test override) to an internal
 * tiling type, honoring the player-facing aliases above. Returns null for
 * anything unrecognized, callers must treat that as "not a tiling", never
 * guess.
 *
 * @param {string|null} token
 * @returns {string|null} a TILING_TYPES entry, or null
 */
export function tilingTypeForToken(token) {
  return TILING_TOKENS[String(token || '').trim().toLowerCase()] || null;
}

/**
 * The practice board each tiling generates: lattice dimensions and mine count.
 *
 * Two constraints fix these, and both were measured rather than guessed.
 *
 * SIZE has to make a container the canonical rules can store. The container is
 * an arbitrary exact factorization, so a prime cell count forces 1 x total and
 * is refused (containerIsStorable). Cell counts are 4.8.8 `2MN-M-N+1`, hex `MN`,
 * cairo `2MN-M-N`, floret `6MN`, rhombille `3MN`, deltoidal `6MN`; the sizes
 * below land on 72, 84 and 63 cells, containers 8x9, 7x12 and 7x9.
 *
 * DENSITY has to put the four Laves lattices on the CONSTRUCTIVE placer, which
 * `generateTilingBoard` switches to above CONSTRUCTIVE_DENSITY_THRESHOLD (0.22),
 * and that is a viability question rather than a taste one. Below the threshold
 * generation falls back to rejection sampling, and over 12 seeds each the
 * sampling path certified 12/12 for cairo but only 7/12 for floret at density
 * 0.208, 8/12 for deltoidal at 0.181, and 0/12 for rhombille at 0.211. Those
 * failures are not even cheap, since a failing run pays 600 attempts before
 * returning null. So all four sit at 0.250, where every one of them generates.
 * The shipped two keep the densities their links already ship with (0.153 and
 * 0.206), and a sampling 4.8.8 certifies in about a millisecond.
 *
 * Generation cost at these numbers, measured over 30 seeds x 10 modifier
 * configurations per tiling (1800 boards, 0 failures), worst single board:
 * 4.8.8 21 ms, hex 21 ms, cairo 178 ms, floret 982 ms, deltoidal 2094 ms,
 * rhombille 2371 ms. The spread is real and it is the lattice, not the size:
 * rhombille's Pass B is structurally dead (its clue sets almost never contain
 * one another), so its certifier leans on Pass C enumeration for every board.
 * That is also why rhombille takes 72 cells rather than the 90 its frozen gate
 * fixture uses: the same sweep at M=5, N=6 (90 cells, density 0.244) measured
 * 13.7 s worst case, six times the cost for 25% more cells. Cost is paid behind
 * the boot overlay during init, once per load, on a test-gated practice surface.
 */
// Dimensions are held to boardFit's phone cap by test/boardFit.test.mjs.
// 3D Cubes and Kites were transposed there (2026-08-06) at an identical cell
// count: both were laid out landscape, which on a portrait phone is what
// crushes the pitch.
export const COASTLINE_BOARDS = {
  '4.8.8': { M: 6, N: 7, mines: 11 },      // 72 cells (42 octagons + 30 squares)
  hex: { M: 9, N: 7, mines: 13 },          // 63 hexagons
  cairo: { M: 7, N: 7, mines: 21 },        // 84 pentagons
  floret: { M: 3, N: 4, mines: 18 },       // 72 pentagons (12 pinwheels of 6)
  rhombille: { M: 6, N: 4, mines: 18 },    // 72 rhombi (24 hexagons of 3)
  deltoidal: { M: 4, N: 3, mines: 18 },    // 72 kites
};

/**
 * Parse the raw `?coastline=` value into the tiling to build and the modifiers
 * to place on it.
 *
 * Accepted forms, all case-insensitive:
 *   ""  / "1"                  plain board, default tiling
 *   "sonar,mirror"             default tiling with those modifiers
 *   "hex" / "cairo"            plain board on that tiling
 *   "hex:sonar,walls"          that tiling with those modifiers
 *
 * A token that is not a tiling name stays in the modifier list, which is what
 * keeps every pre-prefix link working verbatim. An unknown token BEFORE a colon
 * is the one case with no good reading: it is not a tiling and it cannot be a
 * modifier list either, so the whole value is treated as modifiers and the
 * caller gets the default tiling, the same thing the pre-prefix parser did.
 *
 * @param {string|null} raw the query value, may be null/empty
 * @returns {{type: string, gimmicks: string[]}} type is always in TILING_TYPES
 */
export function parseCoastlineParam(raw) {
  const value = String(raw || '');
  let type = DEFAULT_TILING;
  let modPart = value;

  const colon = value.indexOf(':');
  if (colon >= 0) {
    const named = TILING_TOKENS[value.slice(0, colon).trim().toLowerCase()];
    if (named) {
      type = named;
      modPart = value.slice(colon + 1);
    }
  } else {
    const named = TILING_TOKENS[value.trim().toLowerCase()];
    if (named) {
      type = named;
      modPart = '';
    }
  }

  // "1" is the bare "give me a plain board" form, not a modifier.
  const gimmicks = modPart.split(',').map(s => s.trim()).filter(s => s && s !== '1');
  return { type, gimmicks };
}

/**
 * The board dimensions for a tiling type. Falls back to the default tiling,
 * which is reachable only through `state.coastlineType` being unset. The
 * parser above never emits a type outside TILING_TYPES, and every entry of
 * TILING_TYPES has a row here (asserted in test/coastlineLink.test.mjs).
 *
 * @param {string|null} type
 * @returns {{M:number, N:number, mines:number}}
 */
export function coastlineBoardFor(type) {
  return COASTLINE_BOARDS[type] || COASTLINE_BOARDS[DEFAULT_TILING];
}

/**
 * Plain-language name of a tiling, for the practice toast.
 *
 * @param {string|null} type
 * @returns {string}
 */
export function tilingLabel(type) {
  return TILING_LABELS[type] || TILING_LABELS[DEFAULT_TILING];
}
