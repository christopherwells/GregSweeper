// One-off analysis: re-anchor the Minor / Key / Critical bomb-tier
// thresholds after the 2026-06-08 coefficient pooling (PR #36).
//
// The thresholds in winLossHandler.js (2 / 8 / 16) were designed against
// the four-coefficient pricing that shipped with the mechanic (PR #32):
//   passA x 0.45 + canonicalSubset x 2.97 + genericSubset x 2.38
//     + advancedLogic x 1.38
// The pooling rework renamed the model's coefficients hours later, so
// those exact values never priced a production strike — but they ARE the
// scale the tier labels were tuned to. This script recomputes both the
// design-era value and the current pooled value for every mine on every
// canonical daily and weekly board, classifies the design-era values
// with the old thresholds, and proposes new thresholds at the matching
// quantiles of the pooled distribution.
//
// Usage: node scripts/reanchor-bomb-tiers.mjs
// Read-only (public Firebase paths). Prints a report; changes nothing.

import '../test/helpers.mjs'; // window/localStorage shims for the imports below

const { deserializeBoard } = await import('../src/firebase/dailyBoardSync.js');
const { computeBombInfoValue } = await import('../src/logic/bombInfoValue.js');

const DB = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

// Design-era coefficients: PAR_MODEL at a4525ef, the commit that shipped
// the bomb mechanic and its 2/8/16 thresholds.
const DESIGN_COEFS = {
  passAMoves: 0.45,
  canonicalSubsetMoves: 2.97,
  genericSubsetMoves: 2.38,
  advancedLogicMoves: 1.38,
};
const OLD_THRESHOLDS = { minor: 2, key: 8, critical: 16 };

function classify(v, t) {
  if (v < t.minor) return 'none';
  if (v < t.key) return 'minor';
  if (v < t.critical) return 'key';
  return 'critical';
}

function quantile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

async function fetchJson(path) {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const [dailyBoards, weeklyBoards] = await Promise.all([
  fetchJson('dailyBoard'),
  fetchJson('weeklyBoard').catch(() => ({})),
]);

const boards = [
  ...Object.entries(dailyBoards || {}).map(([k, v]) => ({ key: `daily/${k}`, raw: v })),
  ...Object.entries(weeklyBoards || {}).map(([k, v]) => ({ key: `weekly/${k}`, raw: v })),
];

console.log(`Boards fetched: ${boards.length}`);

const rowsOut = [];
let failedBoards = 0;
for (const { key, raw } of boards) {
  let parsed;
  try {
    parsed = deserializeBoard(raw);
  } catch (err) {
    failedBoards++;
    console.warn(`  skip ${key}: ${err.message}`);
    continue;
  }
  const { board, rows, cols } = parsed;
  const fr = Math.floor(rows / 2);
  const fc = Math.floor(cols / 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c].isMine) continue;
      let result;
      try {
        result = computeBombInfoValue(board, rows, cols, fr, fc, r, c);
      } catch (err) {
        console.warn(`  solver failed on ${key} mine (${r},${c}): ${err.message}`);
        continue;
      }
      const d = result.deltas;
      const designValue = Object.entries(DESIGN_COEFS)
        .reduce((sum, [k2, coef]) => sum + Math.max(0, d[k2] || 0) * coef, 0);
      rowsOut.push({ key, r, c, designValue, pooledValue: result.infoValue });
    }
  }
}

console.log(`Mines priced: ${rowsOut.length} (boards skipped: ${failedBoards})`);

const design = rowsOut.map(x => x.designValue);
const pooled = rowsOut.map(x => x.pooledValue).sort((a, b) => a - b);

// Target proportions from the design-era scale + old thresholds.
const counts = { none: 0, minor: 0, key: 0, critical: 0 };
for (const v of design) counts[classify(v, OLD_THRESHOLDS)]++;
const n = design.length;
console.log('\nDesign-era label proportions (the tuning the 2/8/16 thresholds encoded):');
for (const k of ['none', 'minor', 'key', 'critical']) {
  console.log(`  ${k.padEnd(8)} ${counts[k]} (${(100 * counts[k] / n).toFixed(1)}%)`);
}

// New thresholds at matching cumulative quantiles of the pooled scale.
const pNone = counts.none / n;
const pMinor = (counts.none + counts.minor) / n;
const pKey = (counts.none + counts.minor + counts.key) / n;
const tMinor = quantile(pooled, pNone);
const tKey = quantile(pooled, pMinor);
const tCritical = quantile(pooled, pKey);

const summary = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => quantile(s, p).toFixed(2);
  return `min ${s[0].toFixed(2)} | p25 ${q(0.25)} | p50 ${q(0.5)} | p75 ${q(0.75)} | p90 ${q(0.9)} | max ${s[s.length - 1].toFixed(2)}`;
};
console.log(`\nDesign-era values: ${summary(design)}`);
console.log(`Pooled values:     ${summary(pooled)}`);

console.log('\nQuantile-matched thresholds on the pooled scale (raw):');
console.log(`  minor ≥ ${tMinor.toFixed(2)} | key ≥ ${tKey.toFixed(2)} | critical ≥ ${tCritical.toFixed(2)}`);

// Sanity: what proportions do rounded candidates give back?
for (const cand of [
  { minor: Math.round(tMinor), key: Math.round(tKey), critical: Math.round(tCritical) },
  { minor: Math.round(tMinor * 2) / 2, key: Math.round(tKey * 2) / 2, critical: Math.round(tCritical * 2) / 2 },
]) {
  const c2 = { none: 0, minor: 0, key: 0, critical: 0 };
  for (const v of pooled) c2[classify(v, cand)]++;
  console.log(`  candidate ${JSON.stringify(cand)} → ` +
    ['none', 'minor', 'key', 'critical'].map(k => `${k} ${(100 * c2[k] / n).toFixed(1)}%`).join(' | '));
}
