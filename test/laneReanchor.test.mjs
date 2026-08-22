// The lane's re-anchor pass: what it may do, and what it must never do.
//
// A past-support lane board is priced against a real certified board at the
// largest fit-legal dims that would certify, and that anchor's features are
// STORED so the nightly reprice can re-price it under each night's model. The
// reprice therefore follows the MODEL forever and the RULES never, so when
// BOARD_WIDTH_CAP went 11 -> 12 and the tap floor 28px -> 24px, larger boards
// became legal underneath every stored anchor and nothing re-attempted them.
// Measured on the shipped library: 53 anchors outgrown, covering 175 boards.
//
// Run: node --test test/laneReanchor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bandMidDensity, laneCellKey } from '../scripts/topup-marathon-lane.mjs';
import { MATCH_DENSITY_BANDS } from '../src/logic/matchRules.js';

const SRC = readFileSync(new URL('../scripts/topup-marathon-lane.mjs', import.meta.url), 'utf8');
const REANCHOR = SRC.slice(SRC.indexOf('async function reanchorPass'), SRC.indexOf('async function main'));

test('the anchor density has ONE definition, shared by both passes', () => {
  // The fill mints an anchor at a band's midpoint; the re-anchor must re-mint
  // at the SAME density or it anchors boards against a rate drawn from a
  // different mine count, which is exactly the mismatch the anchor contract
  // ("wearing this cell's modifiers at this cell's density") forbids.
  for (const band of MATCH_DENSITY_BANDS) {
    const mid = bandMidDensity(band);
    assert.ok(mid > 0 && mid < 1, `${band.key} midpoint out of range: ${mid}`);
  }
  // Ordered, and strictly inside the lane's own reachable extremes.
  const mids = MATCH_DENSITY_BANDS.map(bandMidDensity);
  for (let i = 1; i < mids.length; i++) {
    assert.ok(mids[i] > mids[i - 1], `band ${i} midpoint does not increase`);
  }
  assert.ok(mids[0] >= 0.06, 'the sparse midpoint sits above the lane floor');
  assert.ok(mids[mids.length - 1] <= 0.34, 'the dense midpoint sits below the lane cap');

  // NON-VACUITY: nobody may recompute this inline. The fill path used to, and
  // an inline copy is how the two would drift apart silently.
  const inline = SRC.match(/lo \+ \(hi - lo\) \* 0\.5/g) || [];
  assert.equal(inline.length, 1,
    'the band midpoint must be computed in exactly one place');
});

test('the re-anchor pass only ever moves an anchor UP', () => {
  // anchorFor deliberately walks DOWN the fit-legal geometries and takes the
  // first that certifies, so a re-attempt landing on the same size (or a
  // smaller one on a different seed's luck) is information, not failure.
  // Adopting a smaller anchor would worsen the very bias this fixes, on a
  // coin flip.
  assert.match(REANCHOR, /filter\(\(sp\) => sp\.cells > g\.best\)/,
    'the candidate list must be restricted to geometries larger than the best held');
  assert.match(REANCHOR, /fresh\.cells <= g\.best/,
    'a re-attempt that does not beat the current anchor must be refused');
});

test('the re-anchor pass never prices, and never restamps a page model', () => {
  // Pricing is the repricer's job and it re-prices every page unconditionally
  // on its next run. A pass that priced only the boards it touched would
  // leave a page stamped with a model fingerprint its OTHER boards were never
  // priced under, which is a quieter version of the bug being fixed.
  assert.ok(!/\bb\.par\s*=/.test(REANCHOR) && !/\.par\s*=\s*/.test(REANCHOR.replace(/anchorPar/g, '')),
    'the re-anchor pass must not write par');
  assert.ok(!/parModel\s*=/.test(REANCHOR),
    'the re-anchor pass must not restamp a page model fingerprint');
  // It must say so, or the next reader assumes the library is priced.
  assert.match(REANCHOR, /run reprice-match-library/,
    'the summary must name the step that applies the new anchors');
});

test('a board keeps its page and index: anchors are edited IN PLACE', () => {
  // page:idx is the seen-cycle key on every device. A pass that rebuilt pages
  // or compacted them would renumber survivors and reset seen records across
  // the whole player base, which is the eviction doctrine's whole point.
  assert.match(REANCHOR, /page\.boards\[idx\]\.anchorCells/,
    'edits must address the existing slot');
  // Targeted at the BOARD ARRAY specifically: the pass pushes freely to its
  // own bookkeeping (the group's rows, the projection), and a blanket ban on
  // `.push(` caught those instead of the thing that matters.
  assert.ok(!/boards\.(push|splice|shift|unshift|pop)\(/.test(REANCHOR),
    'the re-anchor pass must not add or remove board slots');
  assert.ok(!/boards\.length\s*=/.test(REANCHOR),
    'the re-anchor pass must not truncate a page');
  assert.ok(!/boards\s*=\s*/.test(REANCHOR.replace(/page\.boards\[idx\]/g, '')),
    'the re-anchor pass must not replace a page board array wholesale');
  // And it re-reads the page file rather than writing back a parsed-and-
  // reserialized copy of everything, so untouched boards keep their bytes.
  assert.match(REANCHOR, /JSON\.parse\(readFileSync\(file/,
    'the page must be re-read so untouched boards are not rewritten from memory');
});

test('the projection warns when a re-price would breach the admission ceiling', () => {
  // Found on the first real dry run: 2 boards would price past the lane's
  // 1800s ceiling, worst 2090s. Without this the pass would have reported a
  // clean run and the breach would have arrived with the next nightly.
  assert.match(REANCHOR, /MARATHON_PAR_CEILING_SECONDS/,
    'the pass must check the projected pars against the admission ceiling');
  assert.match(REANCHOR, /WARNING/, 'a breach must be loud');
});

test('the nightly runs it, and runs it BEFORE the re-price', () => {
  // A tool nobody runs fixes nothing, and running it after the re-price would
  // delay every fix by a day.
  const wf = readFileSync(new URL('../.github/workflows/refit-par-model.yml', import.meta.url), 'utf8');
  const reanchorAt = wf.indexOf('--reanchor');
  const repriceAt = wf.indexOf('node scripts/reprice-match-library.mjs');
  assert.notEqual(reanchorAt, -1, 'the nightly must run the re-anchor pass');
  assert.ok(reanchorAt < repriceAt,
    'the re-anchor must run before the re-price, or a fix waits a day');
});
