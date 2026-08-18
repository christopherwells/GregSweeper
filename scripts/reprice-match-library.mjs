// Re-price the match library under the model of the day.
//
// The nightly refit moves PAR_MODEL (and the per-shape deviations), and the
// match library's stored pars, the numbers the config sheet's time bands
// filter on, must move with it or the sheet's "Quick" quietly drifts into
// selling two-minute boards (the reprice-climb-library lesson, and
// test/matchLibrary.test.mjs is the alarm that reddens when this step was
// skipped). Every board stored its FEATURE VECTOR at generation, features
// are model-independent where par is not, so repricing is one predictPar
// per board, seconds for the whole library.
//
// UNLIKE the climb reprice, nothing moves: the match library has no level
// windows, band membership is computed at filter time from par, and the
// (page:idx) position is the seen-cycle key on every player's device, so
// pages rewrite their numbers IN PLACE and a board never changes address.
//
// Usage: node scripts/reprice-match-library.mjs [--dry-run]

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { packPayload } from '../src/logic/boardPack.js';
import { timeBandOf } from '../src/logic/matchRules.js';
import { marathonProvisionalPar } from '../src/logic/marathonFit.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { OUT_DIR, writeMatchIndexFiles, matchPageNames } from './match-index-files.mjs';

function main() {
  const dry = process.argv.includes('--dry-run');
  const pageNames = matchPageNames();
  if (pageNames.length === 0) {
    console.error('reprice-match-library: no pages found, nothing to do');
    process.exit(1);
  }

  const fp = modelFingerprint();
  let boards = 0;
  let bandMoves = 0;
  let maxShift = 0;
  let featureless = 0;
  let packed = 0;
  let tombstones = 0;

  // Two passes, because the index's feature header is the UNION over every
  // board and the rows encode against it positionally: a row written before
  // the last page is read would be keyed to a header that then grew.
  const loaded = pageNames.map((name, p) => {
    const url = new URL(name, OUT_DIR);
    const page = JSON.parse(readFileSync(url, 'utf8'));
    for (const b of page.boards) {
      // A tombstone holds a slot, carries no payload and no price; there is
      // nothing to re-price and it must not count as featureless.
      if (b && b.evicted) { tombstones++; continue; }
      boards++;
      // PACK ON THE WAY PAST. This pass already rewrites every page, so it is
      // where the columnar cell form (boardPack.js) gets applied and where a
      // page written before it shipped heals itself. Total in both directions,
      // so a page already packed is left as it is.
      if (b.payload && Array.isArray(b.payload.cells)) {
        b.payload = packPayload(b.payload);
        packed++;
      }
      if (b.features) {
        let par = 0;
        // A lane board takes raw predictPar UNLESS it is out of the model's
        // support, which is exactly the boards that stored an anchor. The
        // proportion half of the lane (a 6x20, a 25x3) is an ordinary cell
        // count in an extraordinary shape and re-prices like anything else;
        // only past a shape's fit ceiling does the model extrapolate badly
        // (probed 2026-08-17: hex collapses, cairo explodes), and there the
        // stored ANCHOR (a real fit-ceiling board's features, in support) is
        // re-priced under tonight's model and extended linearly, so lane
        // pars keep moving with the refit like everything else.
        try {
          if (b.oversized === true && b.anchorFeatures && b.anchorCells) {
            par = marathonProvisionalPar({
              cells: b.spec.cells,
              anchorPar: predictPar(b.anchorFeatures),
              anchorCells: b.anchorCells,
            });
          } else {
            par = predictPar(b.features);
          }
        } catch { par = 0; }
        if (par > 0) {
          par = Math.round(par * 10) / 10;
          const shift = Math.abs(par - b.par);
          if (shift > maxShift) maxShift = shift;
          if (timeBandOf(par) !== timeBandOf(b.par)) bandMoves++;
          b.par = par;
        } else {
          featureless++;
        }
      } else {
        featureless++;
      }
    }
    page.parModel = fp;
    if (!dry) writeFileSync(url, JSON.stringify(page));
    return { p, page };
  });

  // Rebuilt from the pages just rewritten, so the index can never describe a
  // board the pages no longer hold. In place, as ever: a board keeps its
  // page and its position, because `page:idx` is the seen-cycle key on every
  // device and moving one silently resets a player's no-repeat record.
  const written = writeMatchIndexFiles(loaded.map(({ page }) => page.boards), fp, { dry });

  console.log(`reprice-match-library: ${boards} boards over ${pageNames.length} pages`
    + ` in ${Object.keys(written.shards).length} shards, ${written.corners} corners,`
    + ` under model ${fp}; ${bandMoves} changed time band,`
    + ` largest par shift ${maxShift.toFixed(1)}s`
    + (packed ? `, ${packed} packed` : '')
    + (featureless ? `, ${featureless} kept their stored par (no usable features)` : '')
    + (tombstones ? `, ${tombstones} tombstone(s) skipped` : '')
    + (dry ? ' (dry run: nothing written)' : ''));
}

main();
