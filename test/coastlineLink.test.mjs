// ── The ?coastline= deep link: token table, board table, labels ─────────────
//
// The link is the only place a tiling name reaches the code from outside it, and
// its parser used to be an inline if/else in main.js that no test could reach.
// That is how it acquired its silent failure: an unrecognized shape token was
// not rejected but REINTERPRETED as a modifier list, so `?coastline=cairo` built
// an ordinary 4.8.8 carrying a gimmick named "cairo" (which applyGimmicks then
// dropped) with no error anywhere. Case 1 below is that regression.
//
// The board table is pinned here too, because its numbers are not free: a size
// whose cell count is prime cannot be stored as a canonical, and a density at or
// below CONSTRUCTIVE_DENSITY_THRESHOLD puts the four Laves lattices back on
// rejection sampling, where three of them measured 0/12 to 8/12.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCoastlineParam, coastlineBoardFor, tilingLabel,
  COASTLINE_BOARDS, DEFAULT_TILING, CLASSIC_SHAPE_LABEL, tilingTypeForToken,
} from '../src/logic/coastlineLink.js';
import { buildTiling, containerIsStorable, containerFor, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { generateTilingBoard, TILING_SAFE_GIMMICKS, CONSTRUCTIVE_DENSITY_THRESHOLD } from '../src/logic/tilingGenerator.js';

// The seed a bare ?coastline= link uses (gameActions' `state.coastlineSeed ||
// 'coastline-1'`), so the generation test below builds the board the link
// actually produces rather than some other board of the same shape.
const LINK_SEED = 'coastline-1';

test('REGRESSION: every tiling name is a SHAPE token, not a modifier', () => {
  // ?coastline=cairo built a 4.8.8 with a bogus gimmick before the token table.
  for (const type of TILING_TYPES) {
    const parsed = parseCoastlineParam(type);
    assert.equal(parsed.type, type, `bare "${type}" must select that tiling`);
    assert.deepEqual(parsed.gimmicks, [], `bare "${type}" must place no modifiers`);
  }
});

test('every pre-prefix link parses exactly as it did', () => {
  // These four forms predate shape prefixes and are in existing test links.
  assert.deepEqual(parseCoastlineParam(''), { type: '4.8.8', gimmicks: [] });
  assert.deepEqual(parseCoastlineParam('1'), { type: '4.8.8', gimmicks: [] });
  assert.deepEqual(parseCoastlineParam('sonar,mirror'), { type: '4.8.8', gimmicks: ['sonar', 'mirror'] });
  assert.deepEqual(parseCoastlineParam(null), { type: '4.8.8', gimmicks: [] });

  // The hex prefix and both of its aliases.
  assert.deepEqual(parseCoastlineParam('hex'), { type: 'hex', gimmicks: [] });
  assert.deepEqual(parseCoastlineParam('6.6.6'), { type: 'hex', gimmicks: [] });
  assert.deepEqual(parseCoastlineParam('666'), { type: 'hex', gimmicks: [] });
  assert.deepEqual(parseCoastlineParam('hex:sonar,walls'), { type: 'hex', gimmicks: ['sonar', 'walls'] });
});

test('a prefix works for every tiling, and case and spacing do not matter', () => {
  assert.deepEqual(parseCoastlineParam('cairo:sonar'), { type: 'cairo', gimmicks: ['sonar'] });
  assert.deepEqual(parseCoastlineParam('floret:liar,mystery'), { type: 'floret', gimmicks: ['liar', 'mystery'] });
  assert.deepEqual(parseCoastlineParam('RHOMBILLE'), { type: 'rhombille', gimmicks: [] });
  assert.deepEqual(parseCoastlineParam(' Deltoidal : walls , worm '), { type: 'deltoidal', gimmicks: ['walls', 'worm'] });
  // A prefix plus the bare "plain board" marker is still a plain board.
  assert.deepEqual(parseCoastlineParam('cairo:1'), { type: 'cairo', gimmicks: [] });
  assert.equal(parseCoastlineParam('488:worm').type, '4.8.8');
});

test('a modifier name is never eaten as a shape', () => {
  // The token table and the modifier list share one string, so a collision
  // would make a link mean the wrong thing in whichever direction won.
  for (const g of TILING_SAFE_GIMMICKS) {
    const parsed = parseCoastlineParam(g);
    assert.equal(parsed.type, DEFAULT_TILING, `"${g}" must stay a modifier`);
    assert.deepEqual(parsed.gimmicks, [g]);
  }
  // An unknown token before a colon has no good reading, so the whole value
  // falls through to the modifier list and the default tiling — what the
  // pre-prefix parser did with the same string.
  assert.equal(parseCoastlineParam('triangular:sonar').type, DEFAULT_TILING);
});

test('the board table and the labels cover exactly TILING_TYPES', () => {
  assert.deepEqual(Object.keys(COASTLINE_BOARDS).sort(), TILING_TYPES.slice().sort(),
    'a tiling with no board row would silently generate the default shape');
  // Labels are only reachable through tilingLabel, whose fallback would hide a
  // missing entry, so check each one is distinct and names its own lattice.
  const seen = new Set();
  for (const type of TILING_TYPES) {
    const label = tilingLabel(type);
    assert.ok(label && !seen.has(label), `${type} needs its own toast label`);
    seen.add(label);
  }
  assert.equal(tilingLabel(null), tilingLabel(DEFAULT_TILING));
  assert.equal(coastlineBoardFor(null), COASTLINE_BOARDS[DEFAULT_TILING]);
});

test('the player-facing names are the ruled set, and their alias tokens resolve', () => {
  // Christopher's naming ruling (2026-08-02): a lay person should know what
  // the shapes mean — the internal identifiers stay as stored contracts, the
  // NAMES are what the eye sees. These exact strings are the ruling.
  assert.deepEqual(
    Object.fromEntries(TILING_TYPES.map((t) => [t, tilingLabel(t)])),
    {
      '4.8.8': 'Octagons',
      hex: 'Honeycomb',
      cairo: 'Paving Stones',
      floret: 'Petals',
      rhombille: '3D Cubes',
      deltoidal: 'Kites',
    },
  );
  assert.equal(CLASSIC_SHAPE_LABEL, 'Classic', 'the rectangular grid is "Classic"');
  // The lay names work as deep-link and override tokens (space-free forms).
  for (const [token, type] of [
    ['octagons', '4.8.8'], ['honeycomb', 'hex'],
    ['paving', 'cairo'], ['pavingstones', 'cairo'],
    ['petals', 'floret'],
    ['cubes', 'rhombille'], ['3dcubes', 'rhombille'],
    ['kites', 'deltoidal'],
  ]) {
    assert.equal(tilingTypeForToken(token), type, `token '${token}'`);
    assert.equal(parseCoastlineParam(`${token}:sonar`).type, type, `deep link '${token}:'`);
  }
  assert.equal(tilingTypeForToken('bogus'), null, 'an unknown token resolves to nothing, never a guess');
});

// REGRESSION (2026-07-27): `buildTiling` resolves through
// `TILING_BUILDERS[type] || buildTiling488`, so a name that is registered
// everywhere EXCEPT the builder table does not throw — it silently returns a
// 4.8.8. Every downstream layer then agrees with itself about the wrong board:
// `_tiling.type` reads '4.8.8', `computeDailyFeatures` emits that as
// `tilingType`, and R would set `shape488 = 1` forever, so the missing shape's
// own coefficient could never be fit while the 4.8.8's absorbed a second
// lattice. The link would still parse and the board would still play.
//
// Nothing caught it, because the certification gates import their builders
// DIRECTLY and the registry tests iterated TILING_TYPES without ever asking what
// came back. That is the whole assertion here: the dispatcher must return the
// tiling you asked for.
test('REGRESSION: the dispatcher returns the tiling it was asked for, never a silent 4.8.8', () => {
  for (const type of TILING_TYPES) {
    const { M, N } = coastlineBoardFor(type);
    const T = buildTiling(type, M, N);
    // '6.6.6' is a deliberate alias of 'hex' and reports the canonical name.
    const expected = type === '6.6.6' ? 'hex' : type;
    assert.equal(T.type, expected,
      `buildTiling('${type}') returned a ${T.type} — the builder table is missing an entry`);
  }

  // Control: an unregistered name IS meant to fall back, which is the contract
  // generateTilingBoard's own `type = '4.8.8'` default relies on. So the
  // assertion above is testing the registry, not the fallback.
  assert.equal(buildTiling('not-a-tiling', 5, 5).type, '4.8.8');
});

test('every board row is storable and generates a certified board', () => {
  for (const type of TILING_TYPES) {
    const { M, N, mines } = coastlineBoardFor(type);
    const T = buildTiling(type, M, N);
    const { rows, cols } = containerFor(T.total);

    // A prime cell count forces a 1 x total container, which the canonical
    // rules refuse — the only symptom would be a write that never appears.
    assert.ok(containerIsStorable(T.total),
      `${type} ${M}x${N} = ${T.total} cells -> ${rows}x${cols}, which cannot be stored`);

    // The four Laves lattices certify by CONSTRUCTION, not by sampling: below
    // the threshold rhombille measured 0/12 and floret 7/12. Nothing forces the
    // two Archimedean ones up there, and both certify by sampling in about a
    // millisecond, so they keep the densities their links shipped with.
    const density = mines / T.total;
    if (type !== '4.8.8' && type !== 'hex') {
      assert.ok(density > CONSTRUCTIVE_DENSITY_THRESHOLD,
        `${type} density ${density.toFixed(3)} would fall back to rejection sampling`);
    }

    // The real generator, on the real seed the link uses. This is the assertion
    // the numbers exist to satisfy; the two above only explain them.
    const res = generateTilingBoard({ type, M, N, mines, seed: LINK_SEED });
    assert.ok(res, `${type} ${M}x${N} with ${mines} mines produced no certified board`);
    assert.equal(res.check.solvable, true);
    assert.equal(res.check.remainingUnknowns, 0);
    assert.equal(res.tiling.type, type);
  }
});
