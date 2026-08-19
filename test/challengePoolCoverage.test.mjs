// CHALLENGE_POOL is the coverage half of the pool: what the configurable
// Challenge mode draws from on top of the ladder's own two.
//
// The gap it closes was measured, not guessed. The ladder pool is balanced for
// a difficulty ramp — emitPool walks the ppc range in slices and spends each on
// a round-robin over (shape x modifier set) — and that leaves the corners a
// PLAYER can select nearly empty: a brand-new player can pick Classic with no
// modifiers, and the ladder pool held SIX such boards, three of them short.
// The search cache had 603 all along; nothing had ever selected for them.
//
// These tests pin the properties that make the pool usable rather than its
// exact contents, which move with every re-emit. Generation, certification and
// price are proven separately by scripts/validate-challenge-pool.mjs, which
// times real board builds and so cannot live in CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LADDER_POOL, ENDLESS_POOL, CHALLENGE_POOL } from '../src/logic/challengePool.js';
import { specFace, PAR_CEILING_SECONDS } from '../src/logic/challengeRules.js';
import { boardFitsPhone, MIN_TAP_MAJORITY } from '../src/logic/boardFit.js';
import { containerIsStorable } from '../src/logic/tilingGeometry.js';

const parOf = (e) => e.ppc * e.cells;

// Deduped by face. LADDER_POOL and ENDLESS_POOL legitimately OVERLAP — the
// endless pool is a separately-emitted slice of the same space, and a spec can
// be legal on the ladder and above the endless floor at once — so a union that
// simply concatenates them counts those boards twice.
const UNION = (() => {
  const byFace = new Map();
  for (const e of [...LADDER_POOL, ...ENDLESS_POOL, ...CHALLENGE_POOL]) {
    if (!byFace.has(specFace(e))) byFace.set(specFace(e), e);
  }
  return [...byFace.values()];
})();

test('the coverage pool is disjoint from the other two', () => {
  // It is emitted as their COMPLEMENT, topping up buckets they leave thin. An
  // entry that appears in two of them is a board drawn twice as often as its
  // neighbours for no stated reason, and it is also payload for nothing.
  const held = new Set([...LADDER_POOL, ...ENDLESS_POOL].map((e) => specFace(e)));
  const dupes = CHALLENGE_POOL.filter((e) => held.has(specFace(e))).map((e) => specFace(e));
  assert.deepEqual(dupes, [], 'coverage entries already shipped by the ladder or endless pools');

  // And it holds no duplicates of its own.
  const faces = CHALLENGE_POOL.map((e) => specFace(e));
  assert.equal(new Set(faces).size, faces.length, 'the coverage pool repeats a face');
});

test('every coverage entry is a legal, storable, phone-sized board', () => {
  for (const e of CHALLENGE_POOL) {
    const label = `${e.shape} ${e.cells}c ${e.mines}m`;
    assert.ok(e.cells > 0 && e.mines > 0 && e.mines < e.cells, `${label}: mine count must leave safe cells`);
    assert.ok(e.ppc > 0 && Number.isFinite(e.ppc), `${label}: needs a real price`);
    assert.ok(parOf(e) <= PAR_CEILING_SECONDS, `${label}: par ${parOf(e).toFixed(0)}s over the ceiling`);
    if (e.shape === 'rect') {
      assert.ok(e.rows * e.cols === e.cells, `${label}: rect cells must equal rows x cols`);
    } else {
      // The phone cap is his ruling, and the search cache OUTLIVES rule
      // changes — legality is re-checked on the way out, never assumed from
      // the fact that something was once measured.
      assert.ok(boardFitsPhone(e.shape, e.M, e.N), `${label}: wider than a phone can hold`);
      assert.ok(containerIsStorable(e.cells), `${label}: cell count has no storable container`);
    }
  }
});

test('the beginner corner is actually playable', () => {
  // A player who has just started the Climb has Classic unlocked and no
  // modifiers. That filter reaching three boards is what made this pool
  // necessary; these floors are set well under what the emit produces so a
  // re-emit does not have to hit a number exactly, but far above the six the
  // ladder pool alone offered.
  const classicPlain = UNION.filter((e) => e.shape === 'rect' && e.gimmicks.length === 0);
  assert.ok(classicPlain.length >= 20,
    `Classic with no modifiers must reach a real set of boards, got ${classicPlain.length}`);
  assert.ok(classicPlain.filter((e) => parOf(e) <= 60).length >= 10,
    'a beginner asking for SHORT classic boards must not see the same three');
  assert.ok(classicPlain.filter((e) => parOf(e) > 60 && parOf(e) <= 180).length >= 8,
    'nor should the medium band collapse to one');

  // A 10-board match is the longest he allows, so no legitimate filter may
  // ever be forced to repeat a spec inside a single match.
  assert.ok(classicPlain.filter((e) => parOf(e) <= 60).length >= 10,
    'the tightest legitimate filter must fill a 10-board match without repeating');
});

test('no shape or modifier count is starved in the union', () => {
  // His representation ruling is about the whole pool, and it applies here
  // more than anywhere: a player picking one shape is picking their entire
  // match from that slice.
  const byShape = new Map();
  for (const e of UNION) byShape.set(e.shape, (byShape.get(e.shape) || 0) + 1);
  for (const [shape, n] of byShape) {
    assert.ok(n >= 90, `${shape} holds only ${n} entries; a shape-locked match would repeat`);
  }
  const byArity = new Map();
  for (const e of UNION) byArity.set(e.gimmicks.length, (byArity.get(e.gimmicks.length) || 0) + 1);
  for (const arity of [0, 1, 2, 3]) {
    assert.ok((byArity.get(arity) || 0) >= 150,
      `${arity}-modifier boards hold only ${byArity.get(arity) || 0}; the ladder pool's own skew was 56 plain against 171 triples`);
  }
});

test('the pool file keeps its regeneration markers', () => {
  // The block is machine-written. Losing a marker turns the next re-emit into
  // a hand edit, which is how a generated table starts drifting from its
  // generator.
  const src = readFileSync(new URL('../src/logic/challengePool.js', import.meta.url), 'utf8');
  assert.match(src, /\/\/ CHALLENGE:START/, 'start marker');
  assert.match(src, /\/\/ CHALLENGE:END/, 'end marker');
  assert.match(src, /--emit challenge/, 'the marker names the command that regenerates it');
  assert.ok(src.indexOf('// CHALLENGE:START') < src.indexOf('// CHALLENGE:END'), 'markers in order');
});

test('MIN_TAP_MAJORITY is still the phone rule these entries were judged by', () => {
  // A guard on the guard: if the tap floor moves, every tiling entry above was
  // admitted under the old one and the pool wants re-emitting.
  //
  // The floor moved 28 -> 24 on 2026-08-19 (his pressing-surface ruling: the
  // pitch is the verified inscribed-circle diameter, so the floor now equals
  // the press itself). The re-emit this pin demands is deliberately NOT in
  // the same change: the drawn-pool re-search arc was mid-flight in its own
  // session that night (the M1 window repair, branch
  // cwells/drawn-pool-research-m1), and its emit under a post-merge pull
  // satisfies this pin's demand under the new floor with proven candidates
  // rather than a mechanical re-emit racing it. Widening admits and never
  // evicts, so every currently shipped entry stays legal in the interim.
  assert.equal(MIN_TAP_MAJORITY, 24,
    'his 24px floor moved — re-run `--emit challenge` and the pool validator');
});
