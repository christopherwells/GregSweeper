// Rebuild test/fixtures/canonical-sweep.json, the committed snapshot behind
// the nightly sweep's fixture mode (verify-canonical-boards.mjs --fixture).
//
//   node scripts/build-sweep-fixture.mjs
//
// WHAT THE SNAPSHOT MUST CARRY, and why each piece is there. The smoke exists
// because the sweep's ORCHESTRATION crashed twice in production on key
// families its loops had never seen (#260's weekly-first rows; the first
// match_ row, 2026-08-13/14), so the snapshot deliberately holds every family
// `daily/` can contain, plus one key from a family nobody has invented yet:
//
//   - one FUTURE dailyBoard with its dailyMeta (and crux when one exists),
//     fetched verbatim so the real signature and the real feature vector are
//     verified offline;
//   - the current week's weeklyBoard, swept as the live week;
//   - one post-era daily score bucket with real rows, plus one PLANTED
//     divergent row (rngSeed 'planted-divergent-seed'), so the smoke proves
//     detection rather than only completion;
//   - one match_ bucket (skipped by rule), one {weekStart}_weekly_first
//     bucket, one zz9_unknown_family bucket (the NEXT incident, planted now);
//   - one past week's weekly/ rows with its weeklyBoard rngSeed for the
//     weekly half of the divergence scan.
//
// The fixture's clock is frozen INSIDE the file (`today` = the day before the
// snapshotted future board), so the dataset stays "future" forever and the
// smoke can never age into sweeping nothing.
//
// Player names are scrubbed to 'Anonymous' (the production scrubber's own
// value, so the shape stays producible); rows are otherwise verbatim, because
// a fixture carrying a field the producer cannot emit describes a database
// that cannot exist, and tests against it prove nothing (the expiresAt
// lesson, match-guest-join).
//
// WHEN THE SMOKE REDDENS ON A DELIBERATE CHANGE (a feature definition moved,
// a solver change un-certifies the frozen board), the remedy is to re-run
// this builder in the same PR, which is the fixture equivalent of the
// nightly's regenerate remediation. New feature keys need no rebuild: the
// frozen meta's writtenAt predates the bumped FEATURES_EPOCH, so absent new
// keys read as pipeline vintage, exactly as production metas do.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getLocalDateString, getWeekStart } from '../src/logic/seededRandom.js';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const OUT_URL = new URL('../test/fixtures/canonical-sweep.json', import.meta.url);

async function get(path) {
  const r = await fetch(`${DB_BASE}/${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** First `cap` rows, names scrubbed to the production scrubber's own value. */
function scrubRows(rows, cap) {
  return Object.fromEntries(Object.entries(rows || {}).slice(0, cap)
    .map(([k, r]) => [k, r && typeof r === 'object' && 'name' in r ? { ...r, name: 'Anonymous' } : r]));
}

async function main() {
  const today = getLocalDateString();
  const thisWeek = getWeekStart();

  const boardKeys = Object.keys(await get('dailyBoard.json?shallow=true') || {}).sort();
  const future = boardKeys.find((d) => d > today);
  if (!future) throw new Error('no future canonical exists to snapshot; run after the precompute');

  const [futureBoard, futureMeta, futureCrux] = await Promise.all([
    get(`dailyBoard/${future}.json`),
    get(`dailyMeta/${future}.json`),
    get(`cruxes/${future}.json`),
  ]);
  const liveWeekBoard = await get(`weeklyBoard/${thisWeek}.json`);
  if (!futureBoard || !liveWeekBoard) throw new Error('future daily or live weekly canonical missing');

  const dailyKeys = Object.keys(await get('daily.json?shallow=true') || {});
  const pastDates = dailyKeys
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k < today && k >= '2026-04-27').sort();
  const scoreDate = pastDates[pastDates.length - 1];
  const matchKey = dailyKeys.find((k) => k.startsWith('match_'));
  const weeklyFirstKey = dailyKeys.filter((k) => /_weekly_first$/.test(k)).sort().pop();
  if (!scoreDate || !matchKey || !weeklyFirstKey) {
    throw new Error(`a daily/ key family is missing (date ${scoreDate}, match ${matchKey}, weeklyFirst ${weeklyFirstKey}); `
      + 'the snapshot must carry all three or the smoke stops covering one');
  }

  const [scoreRowsRaw, matchRows, weeklyFirstRows, scoreSeed] = await Promise.all([
    get(`daily/${scoreDate}.json`),
    get(`daily/${matchKey}.json`),
    get(`daily/${weeklyFirstKey}.json`),
    get(`dailyBoard/${scoreDate}/rngSeed.json`),
  ]);
  if (typeof scoreSeed !== 'string') throw new Error(`dailyBoard/${scoreDate} has no rngSeed to compare against`);
  const scoreRows = scrubRows(scoreRowsRaw, 3);
  const firstRow = Object.values(scoreRows)[0];
  if (!firstRow) throw new Error(`daily/${scoreDate} has no rows to plant a divergent copy of`);
  scoreRows.plantedDivergent = { ...firstRow, name: 'Anonymous', rngSeed: 'planted-divergent-seed' };

  const weeklyFirstWeek = weeklyFirstKey.replace(/_weekly_first$/, '');
  const weeklyWeeks = Object.keys(await get('weekly.json?shallow=true') || {})
    .filter((w) => w >= '2026-05-04' && w < thisWeek).sort();
  const pastWeek = weeklyWeeks[weeklyWeeks.length - 1];
  const [weeklyRows, pastWeekSeed, weeklyFirstSeed] = await Promise.all([
    pastWeek ? get(`weekly/${pastWeek}.json`) : null,
    pastWeek ? get(`weeklyBoard/${pastWeek}/rngSeed.json`) : null,
    get(`weeklyBoard/${weeklyFirstWeek}/rngSeed.json`),
  ]);

  const db = {
    dailyBoard: {
      [future]: futureBoard,
      [scoreDate]: { rngSeed: scoreSeed },
    },
    dailyMeta: { [future]: futureMeta },
    weeklyBoard: {
      [thisWeek]: liveWeekBoard,
      ...(weeklyFirstSeed ? { [weeklyFirstWeek]: { rngSeed: weeklyFirstSeed } } : {}),
      ...(pastWeek && pastWeekSeed ? { [pastWeek]: { rngSeed: pastWeekSeed } } : {}),
    },
    daily: {
      [scoreDate]: scoreRows,
      [matchKey]: scrubRows(matchRows, 2),
      [weeklyFirstKey]: scrubRows(weeklyFirstRows, 2),
      // The family nobody has invented yet. The last two families each
      // crashed the scan on arrival; this key exists so surviving an unknown
      // one is pinned before the third arrives.
      zz9_unknown_family: { r1: { time: 42, name: 'Anonymous' } },
    },
    ...(futureCrux ? { cruxes: { [future]: futureCrux } } : {}),
    ...(pastWeek && weeklyRows ? { weekly: { [pastWeek]: scrubRows(weeklyRows, 2) } } : {}),
  };

  const fixture = {
    builtAt: new Date().toISOString(),
    note: 'Frozen production snapshot for verify-canonical-boards.mjs --fixture. '
      + 'Rebuild with scripts/build-sweep-fixture.mjs; the clock below is part of the data.',
    today: dayBefore(future),
    thisWeek,
    db,
  };
  mkdirSync(new URL('../test/fixtures/', import.meta.url), { recursive: true });
  writeFileSync(OUT_URL, JSON.stringify(fixture, null, 1));
  const kb = Math.round(JSON.stringify(fixture).length / 1024);
  console.log(`wrote ${fileURLToPath(OUT_URL)} (${kb} KB)`);
  console.log(`  future daily ${future} (crux: ${futureCrux ? 'yes' : 'ABSENT — crux soundness not covered'}), live week ${thisWeek}`);
  console.log(`  score bucket ${scoreDate} (+1 planted divergent), match ${matchKey}, weekly-first ${weeklyFirstKey}`
    + `${pastWeek ? `, weekly ${pastWeek}` : ', weekly rows ABSENT'}`);
}

main().catch((err) => { console.error('build-sweep-fixture failed:', err.message); process.exit(1); });
