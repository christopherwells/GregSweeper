// The library's on-disk cell packing: it must round-trip EXACTLY, because the
// board that comes back out is the one a player is dealt and re-certified
// against its stored numbers. A packing that lost a field would not fail
// loudly; it would deal a board whose numbers no longer describe its mines,
// and certifyStoredBoard's ground-truth audit would reject it at install.
//
// Driven over the SHIPPED library rather than invented cells, because the
// fields that actually occur are decided by the modifiers, and a hand-written
// fixture would only ever exercise the ones I thought of.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { packCells, unpackCells, packPayload, unpackPayload, PACK_FORMAT } from '../src/logic/boardPack.js';
import { OUT_DIR } from '../scripts/build-match-library.mjs';
import { matchPageNames } from '../scripts/match-index-files.mjs';

const pageNames = matchPageNames(OUT_DIR);
const pages = pageNames.map((f) => JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8')));
const boards = pages.flatMap((p) => p.boards).filter((b) => b && !b.evicted);

test('every board in the library round-trips through the packing byte for byte', () => {
  assert.ok(boards.length > 500, `${boards.length} boards is too few to be the real library`);
  let packedBytes = 0;
  let plainBytes = 0;
  let fieldsSeen = new Set();
  for (const b of boards) {
    const cells = b.payload.cells;
    // Vintage pages may already be packed; this test is about the transform.
    const plain = Array.isArray(cells) ? cells : unpackCells(cells);
    const packed = packCells(plain);
    assert.deepEqual(unpackCells(packed), plain,
      `board ${b.seed} does not survive the round trip`);
    plainBytes += Buffer.byteLength(JSON.stringify(plain));
    packedBytes += Buffer.byteLength(JSON.stringify(packed));
    for (const c of plain) for (const k of Object.keys(c)) fieldsSeen.add(k);
  }
  // Non-vacuity: a library of blank cells would round-trip trivially.
  assert.ok(fieldsSeen.size >= 3,
    `only ${[...fieldsSeen]} occur; this sweep is not exercising real cells`);
  // MEASURED at 3.8x over the shipped library. The floor is 3x rather than the
  // measurement, so ordinary drift in what boards contain does not redden this,
  // but a packing that stopped working (a 1.1x, say) still fails loudly. The
  // first version of this line guessed 4x before anything had been measured
  // and failed on a packing that was working correctly.
  assert.ok(packedBytes * 3 < plainBytes,
    `packing saved too little to be worth a format: ${plainBytes} -> ${packedBytes}`);
});

test('a payload round-trips whole, and both directions are TOTAL', () => {
  // The shipped library is packed, so the PLAIN form is recovered first and
  // the transform is exercised from there. Written this way deliberately: the
  // test has to pass whether or not the files on disk have been packed yet,
  // or it becomes an assertion about when the repricer last ran.
  const plain = unpackPayload(boards[0].payload);
  assert.ok(Array.isArray(plain.cells), 'the plain form is an array of cells');
  const packed = packPayload(plain);
  assert.equal(packed.cells.f, PACK_FORMAT, 'a packed payload names its format');
  assert.deepEqual(unpackPayload(packed), plain);
  // Idempotent both ways, which is what lets the repricer pack unconditionally
  // on a directory where some pages are already packed.
  assert.deepEqual(packPayload(packed), packed, 'packing an packed payload changes nothing');
  assert.deepEqual(unpackPayload(plain), plain, 'unpacking a plain payload changes nothing');
  assert.equal(unpackCells(undefined), undefined);
  assert.equal(unpackPayload(null), null);
  assert.deepEqual(unpackCells([]), []);
});

test('a false boolean never survives, because serializeBoard never writes one', () => {
  // The sparse index list encodes presence, so a literal `false` would come
  // back as `true` if it were ever indexed. It must be dropped on the way in.
  const packed = packCells([{ isMine: false, adjacentMines: 2 }, { isMine: true }]);
  assert.deepEqual(unpackCells(packed), [{ adjacentMines: 2 }, { isMine: true }]);
});

test('REGRESSION: a stored zero SURVIVES, because presence is information', () => {
  // serializeBoard drops only false booleans; it writes `adjacentMines: 0` on
  // a mine and on every blank cell. The first version of this packer treated a
  // zero as absent and rebuilt those cells without the field, which round-trips
  // to a different board. Caught by the sweep above on the very first board.
  const packed = packCells([{ adjacentMines: 0 }, { adjacentMines: 3 }]);
  assert.deepEqual(unpackCells(packed), [{ adjacentMines: 0 }, { adjacentMines: 3 }]);
  // And a field only SOME cells carry keeps its absence, rather than coming
  // back as a zero on every cell that never had it.
  const sparse = packCells([{ adjacentMines: 1 }, { adjacentMines: 1, sonarCount: 0 }]);
  assert.deepEqual(unpackCells(sparse), [{ adjacentMines: 1 }, { adjacentMines: 1, sonarCount: 0 }]);
});
