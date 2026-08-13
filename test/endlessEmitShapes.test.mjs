// The endless emitter's per-shape allowance (scripts/search-endless-specs.mjs).
//
// REGRESSION, 2026-08-13. emitPool slices the pool's price range into `slices`
// bands and lets each shape take `maxPerShape / slices` per band. That is fair
// only if every shape has material in every band. A shape whose whole range
// lands inside ONE band could never reach its allowance, and rhombille is
// exactly that shape: it runs 2.2 to 3.29 s/cell against an endless pool
// spanning past 20, so all of it sits in the first of eight slices and it took
// 2 entries where hex and floret took 16.
//
// That is what emptied rhombille out of the endless pool, and what the pool's
// own "carries all SEVEN shapes" contract then refused. The fix is a second
// pass that tops up only the shapes which finished under their global
// allowance, so a spread shape is untouched and a concentrated one is not
// punished for being concentrated.
//
// This runs the real emitter over the real cache, because the bug was in the
// interaction between the slicing and the cache's actual price distribution:
// a synthetic fixture with evenly-spread shapes cannot express it at all.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEARCH = new URL('../scripts/search-endless-specs.mjs', import.meta.url);
const CACHE = new URL('../scripts/data/spec-search-cache.json', import.meta.url);

function emitEndless() {
  const out = execFileSync(process.execPath, [fileURLToPath(SEARCH), '--emit', 'endless'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const shapes = {};
  for (const line of out.split('\n')) {
    if (!line.trimStart().startsWith('E(')) continue;
    const tiling = line.match(/T\('([a-z0-9.]+)'/);
    const shape = tiling ? tiling[1] : (/R\(/.test(line) ? 'rect' : null);
    if (shape) shapes[shape] = (shapes[shape] || 0) + 1;
  }
  return shapes;
}

test('REGRESSION: a price-concentrated shape reaches its endless allowance', { timeout: 120_000 }, () => {
  if (!existsSync(CACHE)) return;   // the cache is a build artifact, not a fixture
  const shapes = emitEndless();
  const total = Object.values(shapes).reduce((a, b) => a + b, 0);
  assert.ok(total > 40, `only ${total} endless entries emitted: the cache or the emitter moved`);

  // Rhombille is the shape whose whole range sits in one slice. Before the
  // top-up it took 2; the allowance is 16.
  assert.ok((shapes.rhombille || 0) >= 8,
    `rhombille holds ${shapes.rhombille || 0} endless entries; the per-slice quota is starving it again`);

  // Non-vacuity: a SPREAD shape must still be near the same allowance, or the
  // assertion above would pass on an emitter that simply stopped slicing.
  assert.ok((shapes.hex || 0) >= 8, `hex holds ${shapes.hex || 0}, so the comparison means nothing`);

  // The contract the pool's own test enforces downstream: every tiling present.
  for (const shape of ['4.8.8', 'hex', 'cairo', 'floret', 'rhombille', 'deltoidal']) {
    assert.ok(shapes[shape] > 0, `${shape} is absent from the emitted endless pool`);
  }
});

test('the emitter still respects the per-shape cap it was given', { timeout: 120_000 }, () => {
  if (!existsSync(CACHE)) return;
  const shapes = emitEndless();
  // maxPerShape is 16 in runEmit's endless call. The top-up may fill up to it
  // and must never exceed it, or a concentrated shape would swamp the pool.
  const cap = Number(readFileSync(new URL('../scripts/search-endless-specs.mjs', import.meta.url), 'utf8')
    .match(/maxPerShape:\s*(\d+)/)[1]);
  assert.equal(cap, 16, 'the cap moved; this test reads it from the source');
  for (const [shape, n] of Object.entries(shapes)) {
    assert.ok(n <= cap, `${shape} holds ${n}, past the ${cap} cap`);
  }
});
