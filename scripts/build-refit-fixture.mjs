// Rebuild test/fixtures/refit-db/, the frozen database behind the refit's
// smoke mode (REFIT_SMOKE=1 REFIT_DB_URL=test/fixtures/refit-db).
//
//   node scripts/build-refit-fixture.mjs
//
// A FILTERED PRODUCTION SAMPLE, deliberately not a synthesis: the database
// right now holds every regime that has crashed the nightly this week, so a
// window of the real thing carries them all with no invented shapes (the
// fixture-invention lesson: a fixture the producer cannot emit describes a
// database that cannot exist).
//
//   - match_ rows under daily/ and dailyMeta/ (the 2026-08-13/14 sweep crash
//     class, and the family the fit gates at MATCH_FIT_THRESHOLD);
//   - COVERAGE SATURATION: every gimmick over 20 unique fit dates, which
//     emptied coverage_targets for the first time on 2026-08-14 and crashed
//     the sort. Counts are date-count-based, so the regime cannot age out of
//     a frozen sample;
//   - ONE-ROW SHAPES (rhombille re-priced 62% on a single row, 2026-08-13):
//     whatever the window holds per lattice stays that thin forever;
//   - {weekStart}_weekly_first rows (the #260 class).
//
// timed.json is capped BELOW its 20-row threshold and dailyBoard carries
// only 3 boards (digit frame < 30 rows), so the smoke runs ONE brms fit:
// those secondary fits are gated machinery the smoke exercises to their
// skip messages, and compiling three Stan models per PR buys nothing more.
//
// Names are scrubbed to 'Anonymous' (the production scrubber's own value);
// uids stay verbatim, because the fit's (1|uid) grouping is the machinery
// under test and the uids are already world-readable.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getLocalDateString } from '../src/logic/seededRandom.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const OUT_DIR = new URL('../test/fixtures/refit-db/', import.meta.url);
const WINDOW_DAYS = 110;
const TIMED_CAP = 5;        // below TIMED_FIT_THRESHOLD (20): fit stays skipped
const ARCHIVE_BUCKETS = 6;  // a taste of the family; the pooling gate stays shut
const BOARD_DATES = 3;      // digit frame < MIN_SCORES_TO_FIT (30): fit skipped

async function get(path) {
  const r = await fetch(`${DB_BASE}/${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

function daysAgo(n, today) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const isDate = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k);

function scrubBucket(rows) {
  if (!rows || typeof rows !== 'object') return rows;
  return Object.fromEntries(Object.entries(rows)
    .map(([k, r]) => [k, r && typeof r === 'object' && 'name' in r ? { ...r, name: 'Anonymous' } : r]));
}

function writeJson(name, obj) {
  writeFileSync(new URL(name, OUT_DIR), JSON.stringify(obj));
  const kb = Math.round(JSON.stringify(obj).length / 1024);
  console.log(`  ${name}: ${Object.keys(obj).length} bucket(s), ${kb} KB`);
}

async function main() {
  const today = getLocalDateString();
  const floor = daysAgo(WINDOW_DAYS, today);
  console.log(`sampling production ${floor}..${today} into ${fileURLToPath(OUT_DIR)}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const [metaAll, dailyAll, timedAll, archiveAll] = await Promise.all([
    get('dailyMeta.json'), get('daily.json'), get('timed.json'), get('dailyArchive.json'),
  ]);

  const keep = (k) => (isDate(k) ? k >= floor && k <= today
    : k.startsWith('match_') || /_weekly_first$/.test(k));
  const pick = (all) => Object.fromEntries(Object.entries(all || {})
    .filter(([k]) => keep(k)).map(([k, v]) => [k, isDate(k) || !v ? v : v]));

  const meta = Object.fromEntries(Object.entries(metaAll || {}).filter(([k]) => keep(k)));
  const daily = Object.fromEntries(Object.entries(pick(dailyAll))
    .map(([k, rows]) => [k, scrubBucket(rows)]));
  const timed = Object.fromEntries(Object.entries(timedAll || {}).slice(0, TIMED_CAP)
    .map(([k, r]) => [k, r && typeof r === 'object' && 'name' in r ? { ...r, name: 'Anonymous' } : r]));
  const archive = Object.fromEntries(Object.entries(archiveAll || {})
    .filter(([k]) => isDate(k)).slice(-ARCHIVE_BUCKETS)
    .map(([k, rows]) => [k, scrubBucket(rows)]));

  const metaDates = Object.keys(meta).filter(isDate).sort();
  const boardDates = metaDates.slice(-BOARD_DATES);
  const boards = {};
  for (const d of boardDates) {
    const b = await get(`dailyBoard/${d}.json`);
    if (b) boards[d] = b;
  }

  const nMatch = Object.keys(daily).filter((k) => k.startsWith('match_')).length;
  const nWeekly = Object.keys(daily).filter((k) => /_weekly_first$/.test(k)).length;
  const nRows = Object.values(daily).reduce((a, b) => a + Object.keys(b || {}).length, 0);
  if (nMatch === 0 || nWeekly === 0) {
    throw new Error(`a daily/ key family is missing from the sample (match ${nMatch}, weekly_first ${nWeekly}); `
      + 'the smoke would stop covering it');
  }

  // THE COVERAGE THROTTLE MUST HAVE WORK, verified rather than hoped. The
  // headline incident (2026-08-14) was coverage_targets emptying for the
  // first time, but full saturation turned out to be a TRANSIENT data state:
  // measured 2026-08-15 over the whole canonical era, wormLoad sits at 18
  // nonzero fit dates, under the 20 line, so no frozen sample can promise
  // the empty list. The split, then: this fixture guarantees the throttle
  // path itself runs hot (several gimmicks saturated at real counts), and
  // the empty-sort guard is pinned by SOURCE SCAN in
  // test/refitEmptyCoverageGuard.test.mjs, because a text pin does not age
  // with the data. The feature list mirrors the R script's GIMMICK_FEATURES;
  // drift fails LOUD on the next rebuild, the safe direction.
  const GIMMICK_FEATURES = [
    'mysteryCellCount', 'liarCellCount', 'lockedCellCount',
    'wallEdgeCount', 'wormholePairCount', 'mirrorPairCount',
    'sonarCellCount', 'compassCellCount', 'wormLoad',
  ];
  const scored = new Set(Object.keys(daily).filter((k) => Object.keys(daily[k] || {}).length > 0));
  const nonzeroDates = (f) => Object.entries(meta)
    .filter(([k, m]) => scored.has(k) && Number(m?.features?.[f]) > 0).length;
  const saturated = GIMMICK_FEATURES.filter((f) => nonzeroDates(f) >= 20);
  if (saturated.length < 5) {
    throw new Error(`only ${saturated.length} gimmick(s) reach the 20-date saturation line in this sample, `
      + 'so the coverage throttle would barely run. Widen WINDOW_DAYS.');
  }
  console.log(`  coverage saturation in sample: ${saturated.length}/9 gimmicks at 20+ nonzero dates`
    + ` (${GIMMICK_FEATURES.map((f) => `${f.replace(/CellCount|PairCount|EdgeCount|Load/, '')}=${nonzeroDates(f)}`).join(', ')})`);

  writeJson('dailyMeta.json', meta);
  writeJson('daily.json', daily);
  writeJson('timed.json', timed);
  writeJson('dailyArchive.json', archive);
  writeJson('dailyBoard.json', boards);
  console.log(`  (${nRows} score rows over ${metaDates.length} dates + ${nMatch} match + ${nWeekly} weekly-first buckets)`);
}

main().catch((err) => { console.error('build-refit-fixture failed:', err.message); process.exit(1); });
