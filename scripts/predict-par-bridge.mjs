// A one-job bridge for the R analysis documents: price feature rows through
// the client's OWN predictPar (the one definition, per-shape dispatch
// included), so an R-side screen or comparison can never disagree with the
// shipped model about what a board is worth.
//
//   node predict-par-bridge.mjs <rows.json> <out.json>
//
// rows.json: an array of feature objects. `tilingType` of "rect" (or absent)
// prices through PAR_MODEL; any other value dispatches to its shape block
// exactly as the client does. Output: a JSON array of predicted pars in
// seconds, same order.

import { readFileSync, writeFileSync } from 'node:fs';
import { predictPar, modelFor } from '../src/logic/dailyFeatures.js';

const [rowsPath, outPath] = process.argv.slice(2);
if (!rowsPath || !outPath) {
  console.error('usage: node predict-par-bridge.mjs <rows.json> <out.json>');
  process.exit(1);
}
const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
const pars = rows.map((r) => {
  const f = { ...r };
  if (f.tilingType === 'rect') delete f.tilingType;
  return predictPar(f);
});
writeFileSync(outPath, JSON.stringify(pars));
console.error(`priced ${pars.length} row(s) under the shipped model`);
