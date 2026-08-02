// ── Wormhole sums must never outrun the number-color tokens ────────────────
//
// The num-9..18 tokens were sized for RECTANGULAR wormhole sums (8+8, plus
// headroom). A tiling raises the ceiling: a wormhole pair sits at graph
// distance >= 3, so both endpoints can be interior cells at the lattice's
// full valence, and the displayed sum reaches 2 x maxValence — 20 on
// rhombille (valence 10), where the container-era tokens stopped at 18. A
// sum above the token range does not crash; the number silently renders in
// the theme's default revealed-cell color, unthemed. That is exactly the
// kind of gap a seventh, higher-valence lattice would reopen, so the ceiling
// here is COMPUTED from the shipped lattices rather than hard-coded: a new
// tiling that raises it fails this test until the tokens (and every theme's
// overrides) are extended.
//
// Liar can stack +1 on a wormhole endpoint, so the theoretical display is
// ceiling+1; the tokens deliberately track the pair-sum ceiling (the same
// convention the rectangular range set: 18 tokens for a 16+1 worst case).

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildTiling, TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { coastlineBoardFor } from '../src/logic/coastlineLink.js';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles');

function sumCeiling() {
  let ceiling = 0;
  for (const type of TILING_TYPES) {
    const { M, N } = coastlineBoardFor(type);
    const T = buildTiling(type, M, N);
    const maxValence = Math.max(...T.adj.map((l) => l.length));
    ceiling = Math.max(ceiling, 2 * maxValence);
  }
  return ceiling;
}

test('the shipped lattices cap the wormhole sum at 20 (rhombille, valence 10)', () => {
  // If this number moves, a new lattice raised the ceiling: extend the
  // --color-num-* tokens in global.css AND every theme override, then update
  // this pin.
  assert.equal(sumCeiling(), 20);
});

test('global.css defines tokens and .cell selectors through the ceiling', () => {
  const css = readFileSync(join(stylesDir, 'global.css'), 'utf8');
  const ceiling = sumCeiling();
  for (let n = 9; n <= ceiling; n++) {
    // Twice: the :root palette and the colorblind override block.
    const tokenCount = (css.match(new RegExp(`--color-num-${n}:`, 'g')) || []).length;
    assert.ok(tokenCount >= 2,
      `global.css defines --color-num-${n} ${tokenCount}x, expected >= 2 (:root + colorblind block)`);
    assert.ok(new RegExp(`\\.cell\\.num-${n}\\b`).test(css),
      `global.css has no .cell.num-${n} selector — the token would never apply`);
  }
});

test('every theme that overrides the 9+ range covers it through the ceiling', () => {
  // A theme opting into wormhole-sum colors must cover the whole reachable
  // range, or a rhombille sum renders unthemed in exactly the themes that
  // bothered to theme the rest.
  const themesDir = join(stylesDir, 'themes');
  const ceiling = sumCeiling();
  let themed = 0;
  for (const f of readdirSync(themesDir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(themesDir, f), 'utf8');
    if (!css.includes('--color-num-9:')) continue; // inherits global (classic, candy)
    themed++;
    for (let n = 9; n <= ceiling; n++) {
      assert.ok(css.includes(`--color-num-${n}:`),
        `${f} overrides the wormhole-sum range but stops before --color-num-${n}`);
    }
  }
  assert.ok(themed >= 20, `only ${themed} themes carry the 9+ range — the walk is not finding them`);
});
