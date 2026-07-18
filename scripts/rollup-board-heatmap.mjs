// Board heatmap rollup — "where the mines went off", per past daily.
//
// Sums each date's bomb hits per cell across everyone who solved that
// board (daily/{date}/* plus dailyArchive/{date}/*) and writes the map
// to boardHeatmap/{date}. `bombHitEvents[].{row,col}` is the ONLY
// per-cell signal a client submits: clickTimeline never leaves the
// device and hintEvents carry no coordinates.
//
// All aggregation decisions (one row per player, the >30%-of-mines
// probe filter, coordinate bounds) live in the pure
// src/logic/boardHeatmap.js so they are node-tested rather than trusted;
// this script is the Firebase plumbing around them.
//
// The rules make boardHeatmap/{date} unwritable by ANY client; this
// script holds the service account and so bypasses rules entirely (the
// regenerate-daily-board precedent). It is therefore free to recompute,
// which matters more than it first appears:
//
//   A date becomes eligible the moment it is strictly before today in
//   ET, and the cron runs at 11:30 ET, so a fresh date is first rolled
//   up when only a handful of people have played it. If a rolled-up
//   date were then frozen forever, its n_players would be stuck at its
//   day-after value and the MIN_PLAYERS_FOR_HEATMAP gate could never
//   open on its own. So every run RECOMPUTES the trailing
//   REFRESH_WINDOW_DAYS of dates, which is also how a date picks up
//   archive replays that land later. Older dates are skipped as
//   settled unless --refresh is passed.
//
// Usage:
//   node scripts/rollup-board-heatmap.mjs [--dry-run] [--refresh] [--date YYYY-MM-DD]

import admin from 'firebase-admin';
import { aggregateBombHits } from '../src/logic/boardHeatmap.js';

const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) {
  console.error('FIREBASE_SERVICE_ACCOUNT env not set');
  process.exit(2);
}

const dryRun = process.argv.includes('--dry-run');
const refresh = process.argv.includes('--refresh');
const dateArgIdx = process.argv.indexOf('--date');
const onlyDate = dateArgIdx >= 0 ? process.argv[dateArgIdx + 1] : null;
if (onlyDate && !/^\d{4}-\d{2}-\d{2}$/.test(onlyDate)) {
  console.error(`--date must be YYYY-MM-DD, got "${onlyDate}"`);
  process.exit(2);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(sa)),
  databaseURL: 'https://gregsweeper-66d02-default-rtdb.firebaseio.com',
});
const db = admin.database();

// How far back each run recomputes. Matches the window the client
// exhibit actually reads (HEATMAP_FETCH_LIMIT in dailyBoardSync), so
// every date a player can see stays current.
const REFRESH_WINDOW_DAYS = 45;

// The daily flips at midnight America/New_York, so "settled" is an ET
// judgement (the same anchor getLocalDateString uses in the client).
function etToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function rowsOf(bucket) {
  return Object.values(bucket || {}).filter(r => r && typeof r === 'object');
}

(async () => {
  console.log(dryRun ? '[DRY RUN] aggregating, no writes' : 'aggregating + writing');
  const today = etToday();
  const windowStart = addDays(today, -REFRESH_WINDOW_DAYS);

  const [dailySnap, archiveSnap, boardSnap, heatSnap] = await Promise.all([
    db.ref('daily').once('value'),
    db.ref('dailyArchive').once('value'),
    db.ref('dailyBoard').once('value'),
    db.ref('boardHeatmap').once('value'),
  ]);
  const daily = dailySnap.val() || {};
  const archive = archiveSnap.val() || {};
  const boards = boardSnap.val() || {};
  const existing = heatSnap.val() || {};

  // Union of every date that carries scores. `daily/` also holds the
  // `{weekStart}_weekly_first` rows, which are weekly boards and have
  // no dailyBoard entry, so the plain-date filter drops them.
  const dates = [...new Set([...Object.keys(daily), ...Object.keys(archive)])]
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter(d => d < today)
    .filter(d => !onlyDate || d === onlyDate)
    .sort();

  const updates = {};
  let written = 0;
  let skipped = 0;
  let noBoard = 0;

  for (const date of dates) {
    // Dates inside the trailing window are always recomputed so their
    // solver counts keep climbing; older ones are settled.
    if (existing[date] && !refresh && date < windowStart) { skipped++; continue; }

    const board = boards[date];
    if (!board || typeof board.rows !== 'number' || typeof board.cols !== 'number') {
      // No canonical board means no grid to bound-check against and no
      // mine count for the probe filter. Publishing an unanchored map
      // is worse than publishing none.
      noBoard++;
      continue;
    }

    const scoreRows = [
      ...rowsOf(daily[date]),
      ...rowsOf(archive[date]),
    ];
    if (scoreRows.length === 0) continue;

    const agg = aggregateBombHits(scoreRows, {
      rows: board.rows,
      cols: board.cols,
      totalMines: board.totalMines,
    });
    if (agg.nPlayers === 0) continue;

    const payload = {
      rows: board.rows,
      cols: board.cols,
      cells: agg.cells,
      totals: agg.totals,
      n_players: agg.nPlayers,
      writtenAt: admin.database.ServerValue.TIMESTAMP,
    };

    const flags = [];
    if (agg.nCheatRows > 0) flags.push(`${agg.nCheatRows} probe row(s) dropped`);
    if (agg.nOutOfBounds > 0) flags.push(`${agg.nOutOfBounds} out-of-bounds hit(s) dropped`);
    console.log(
      `  ${date}: ${agg.nPlayers} players, ${agg.totals} hits over `
      + `${Object.keys(agg.cells).length} cells${flags.length ? ` (${flags.join(', ')})` : ''}`
      + `${existing[date] ? ' [refresh]' : ''}`,
    );

    updates[`boardHeatmap/${date}`] = payload;
    written++;
  }

  if (!dryRun && written > 0) await db.ref().update(updates);
  console.log(
    `Done. dates written: ${written}, settled and skipped: ${skipped}, `
    + `no canonical board: ${noBoard}${dryRun ? ' (dry run — nothing written)' : ''}.`,
  );
  process.exit(0);
})().catch(err => {
  console.error('Rollup FAILED:', err);
  process.exit(1);
});
