// A COMPACT ON-DISK FORM for a serialized board's cells, and its inverse.
//
// WHY. serializeBoard writes one object per cell, so a 117-cell board spells
// the word "adjacentMines" 117 times and costs 2,868 bytes for what is really
// 117 small numbers. Measured over the match library: a board averages 6,638
// bytes and 84% of that is the cells array. At a 20-board buffer per corner
// the library is 114 MB of pages, and every nightly re-price rewrites all of
// them, so the same bytes land in git history again each night.
//
// WHAT THIS IS NOT. It is deliberately NOT a change to the stored format. The
// wire shape that rides Firebase canonicals, the match node (whose rules
// validate its children) and every player's save is untouched. This is an
// encoding for FILES WE BUILD: the library writer packs on the way out, the
// library reader unpacks the moment it arrives, and everything downstream sees
// exactly the array of objects it always did. Anything else would be a
// migration across three storage contracts to save disk on one of them.
//
// COLUMNAR, NOT POSITIONAL-BY-CONVENTION. A tempting packing is one character
// per cell, which is tiny and only works while the only fields are a mine flag
// and a count. Cells carry up to twenty fields across the modifiers, and a new
// one lands whenever a modifier does. So the form here is general: one column
// per field that any cell actually uses, and a field nobody uses costs
// nothing. A modifier added next month packs without an edit.
//
// Three column kinds, decided per field by how many cells carry it:
//   dense numbers  -> a plain array, used when EVERY cell has the field
//   sparse numbers -> [index, value] pairs, for a field only some cells have
//   booleans       -> a sparse INDEX list, since serializeBoard already drops
//                     `false`, so presence IS the value
//
// The dense/sparse split for numbers exists because PRESENCE is information
// here and a zero is not the same as absent. serializeBoard writes
// `adjacentMines: 0` on a mine and on every blank cell, and only drops
// booleans that are false. An earlier version of this file treated a zero as
// absent and silently rebuilt those cells without the field, which round-trips
// to a DIFFERENT board.
//
// Round-tripping is the contract, and test/boardPack.test.mjs holds it over
// the shipped library rather than over invented cells.

/** Marks a packed cells payload, so a reader can tell the two forms apart. */
export const PACK_FORMAT = 'cells-columnar-v1';

/**
 * Pack an array of serialized cell objects.
 *
 * Returns the array UNCHANGED when there is nothing to gain (no cells), so a
 * caller can pack unconditionally.
 *
 * @param {Array<Object>} cells  serializeBoard's cells array
 * @returns {Object|Array} the packed form, or the input when empty
 */
export function packCells(cells) {
  if (!Array.isArray(cells) || cells.length === 0) return cells;
  const n = cells.length;
  const pairs = new Map();  // numeric field -> [index, value] pairs
  const flags = new Map();  // boolean field -> index list
  for (let i = 0; i < n; i++) {
    const cell = cells[i] || {};
    for (const key of Object.keys(cell)) {
      const v = cell[key];
      if (v === undefined || v === null) continue;
      if (typeof v === 'boolean') {
        // serializeBoard never writes false, so a present boolean is true and
        // the index alone carries it. A literal false is dropped rather than
        // indexed, or it would come back true.
        if (v === false) continue;
        if (!flags.has(key)) flags.set(key, []);
        flags.get(key).push(i);
      } else {
        if (!pairs.has(key)) pairs.set(key, []);
        pairs.get(key).push([i, v]);
      }
    }
  }
  const num = {};    // present on EVERY cell: values only, positional
  const snum = {};   // present on some: [index, value] pairs
  for (const [key, list] of pairs) {
    if (list.length === n) num[key] = list.map(([, v]) => v);
    else snum[key] = list;
  }
  return { f: PACK_FORMAT, n, num, snum, flag: Object.fromEntries(flags) };
}

/**
 * Unpack back to the array of objects every reader downstream expects.
 *
 * TOTAL by design: anything that is not a packed payload comes back
 * unchanged, so a caller can unpack unconditionally and a library file
 * written before this shipped still reads. The alternative, throwing, would
 * turn a vintage page into a dead deal.
 *
 * @param {Object|Array} packed
 * @returns {Array<Object>}
 */
export function unpackCells(packed) {
  if (!packed || Array.isArray(packed) || packed.f !== PACK_FORMAT) return packed;
  const n = Number(packed.n) || 0;
  const cells = new Array(n);
  for (let i = 0; i < n; i++) cells[i] = {};
  for (const [key, col] of Object.entries(packed.num || {})) {
    // Dense: the field was on every cell, so every position gets it back,
    // zeros included. A mine's `adjacentMines: 0` is stored, not implied.
    for (let i = 0; i < n; i++) cells[i][key] = col[i];
  }
  for (const [key, list] of Object.entries(packed.snum || {})) {
    for (const [i, v] of list) { if (i >= 0 && i < n) cells[i][key] = v; }
  }
  for (const [key, idx] of Object.entries(packed.flag || {})) {
    for (const i of idx) { if (i >= 0 && i < n) cells[i][key] = true; }
  }
  return cells;
}

/** Pack a whole serialized payload in place of its cells. */
export function packPayload(payload) {
  if (!payload || !Array.isArray(payload.cells)) return payload;
  return { ...payload, cells: packCells(payload.cells) };
}

/** Unpack a whole serialized payload. Total, like unpackCells. */
export function unpackPayload(payload) {
  if (!payload || Array.isArray(payload.cells) || !payload.cells) return payload;
  return { ...payload, cells: unpackCells(payload.cells) };
}
