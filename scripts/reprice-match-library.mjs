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
import { matchIndexRow, matchIndexFeatureKeys, timeBandOf } from '../src/logic/matchRules.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';

const OUT_DIR = new URL('./data/match-library/', import.meta.url);
const INDEX_FILE = new URL('match-index.json', OUT_DIR);

function main() {
  const dry = process.argv.includes('--dry-run');
  const pageNames = readdirSync(OUT_DIR)
    .filter((f) => /^match-\d{3}\.json$/.test(f))
    .sort();
  if (pageNames.length === 0) {
    console.error('reprice-match-library: no pages found, nothing to do');
    process.exit(1);
  }

  const fp = modelFingerprint();
  const rows = [];
  const counts = [];
  let boards = 0;
  let bandMoves = 0;
  let maxShift = 0;
  let featureless = 0;

  // Two passes, because the index's feature header is the UNION over every
  // board and the rows encode against it positionally: a row written before
  // the last page is read would be keyed to a header that then grew.
  const loaded = pageNames.map((name, p) => {
    const url = new URL(name, OUT_DIR);
    const page = JSON.parse(readFileSync(url, 'utf8'));
    for (const b of page.boards) {
      boards++;
      if (b.features) {
        let par = 0;
        try { par = predictPar(b.features); } catch { par = 0; }
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
    counts.push(page.boards.length);
    page.parModel = fp;
    if (!dry) writeFileSync(url, JSON.stringify(page));
    return { p, page };
  });

  const featureKeys = matchIndexFeatureKeys(loaded.flatMap(({ page }) => page.boards));
  for (const { p, page } of loaded) {
    page.boards.forEach((b, i) => rows.push(matchIndexRow(p, i, b, featureKeys)));
  }

  const index = {
    parModel: fp,
    boards,
    pages: pageNames.length,
    counts,
    featureKeys,
    rows,
  };
  if (!dry) writeFileSync(INDEX_FILE, JSON.stringify(index));

  console.log(`reprice-match-library: ${boards} boards over ${pageNames.length} pages`
    + ` under model ${fp}; ${bandMoves} changed time band,`
    + ` largest par shift ${maxShift.toFixed(1)}s`
    + (featureless ? `, ${featureless} kept their stored par (no usable features)` : '')
    + (dry ? ' (dry run: nothing written)' : ''));
}

main();
