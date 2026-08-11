// ── Board heatmap, the pure layer ────────────────────────────────────
// "Where the mines went off": how often each cell of a past daily board
// was detonated, summed across everyone who solved it. Two jobs live
// here, both pure so both are node-testable:
//
//   1. AGGREGATION (`aggregateBombHits`), the rollup script's whole
//      decision layer. `bombHitEvents[].{row,col}` on the score rows is
//      the ONLY per-cell signal a client ever submits (clickTimeline is
//      local-only and hintEvents carry no coordinates), so this is the
//      one place the population map can come from.
//   2. THE HONESTY GATE (`selectHeatmapDate` / `heatmapCopy`), with a
//      small player base a per-cell count of 1 is one person's bad
//      afternoon, not a population signal. Painting it as one would
//      break the same no-fabrication rule the rest of the Journal runs
//      on, so the map stays closed until MIN_PLAYERS_FOR_HEATMAP people
//      have solved the same board, and says so plainly meanwhile.
//
// A third rule the gate enforces: the map is a partial MINE MAP by
// construction (a cell only registers a hit if a mine was on it), and
// past dailies are replayable through the Daily Archive. So a board is
// only ever drawn for a player who has already completed it.

import { isBombHitCheat } from './difficulty.js';
import { countWord } from './journalProse.js';

// How many distinct solvers a board needs before the exhibit exists at
// all. Below this NOTHING renders: no map, no waiting copy, no card.
// The feature stays invisible until the audience can actually support a
// population claim (Christopher, 2026-07-18).
export const MIN_PLAYERS_FOR_HEATMAP = 30;

// Shading is a RATE, not a rank: a square's level comes from the share
// of that board's solvers who detonated it, on a fixed scale. Scaling
// against the board's own busiest square instead would rank rather than
// measure, so a board where three people had a bad moment and nobody
// else did would light up as though it were brutal. On this scale one
// hit among thirty solvers reads as the 3% it is, which is why a single
// hit is safe to draw (Christopher's correction, 2026-07-18).
//
// Upper edge of each band as a fraction of solvers; the last level is
// everything above the final edge.
export const HEAT_BANDS = [0.05, 0.10, 0.20];
export const HEAT_LEVELS = HEAT_BANDS.length + 1;

export function cellKey(r, c) {
  return `${r}_${c}`;
}

// "3_7" → {r: 3, c: 7}; anything else → null. Firebase keys forbid
// "." "$" "#" "[" "]" "/", so the underscore join is key-safe.
export function parseCellKey(key) {
  const m = /^(\d{1,2})_(\d{1,2})$/.exec(String(key));
  return m ? { r: Number(m[1]), c: Number(m[2]) } : null;
}

function _eventList(raw) {
  // Firebase hands back an array for dense numeric keys and an object
  // otherwise, and an old client may have written neither.
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

/**
 * One row per player. A uid can hold both a day-of row and an archive
 * replay of the same date; counting both would let one person's two
 * sittings read as two people struggling. Day-of wins (it is the real
 * attempt at the real board), then the earliest timestamp.
 */
function _onePerPlayer(scoreRows) {
  const best = new Map();
  for (const row of scoreRows) {
    if (!row || typeof row.uid !== 'string' || !row.uid) continue;
    const prev = best.get(row.uid);
    if (!prev) { best.set(row.uid, row); continue; }
    const prevArchive = prev.archivePlay === true;
    const rowArchive = row.archivePlay === true;
    if (prevArchive !== rowArchive) {
      if (prevArchive) best.set(row.uid, row);
      continue;
    }
    const prevT = typeof prev.timestamp === 'number' ? prev.timestamp : Infinity;
    const rowT = typeof row.timestamp === 'number' ? row.timestamp : Infinity;
    if (rowT < prevT) best.set(row.uid, row);
  }
  return [...best.values()];
}

/**
 * Sum bomb hits per cell over one date's score rows.
 *
 * @param {Array<object>} scoreRows daily/{date}/* and dailyArchive/{date}/* rows
 * @param {{rows?: number, cols?: number, totalMines?: number}} board the
 *   canonical board's shape, used to bound-check coordinates and to drop
 *   brute-force probe runs (the same >30%-of-mines rule the submit gate
 *   applies, so a historical probe row can't dominate the map).
 * @returns {{cells: Record<string, number>, totals: number, nPlayers: number,
 *   nCheatRows: number, nOutOfBounds: number}}
 */
export function aggregateBombHits(scoreRows, board = {}) {
  const cells = {};
  let totals = 0;
  let nCheatRows = 0;
  let nOutOfBounds = 0;
  const rowsMax = typeof board.rows === 'number' ? board.rows : null;
  const colsMax = typeof board.cols === 'number' ? board.cols : null;

  const players = _onePerPlayer(Array.isArray(scoreRows) ? scoreRows : []);
  let nPlayers = 0;
  for (const row of players) {
    const events = _eventList(row.bombHitEvents);
    // A probe run's hits describe the layout, not where the board is
    // hard. Someone who detonates a third of the mines is messing
    // around, not playing, so they leave the map AND the denominator
    // (Christopher, 2026-07-18). `bombHits` is the submitted count;
    // fall back to the event count for rows that predate the field.
    const hitCount = typeof row.bombHits === 'number' ? row.bombHits : events.length;
    if (isBombHitCheat(hitCount, board.totalMines)) { nCheatRows++; continue; }
    nPlayers++;

    for (const ev of events) {
      if (!ev || !Number.isInteger(ev.row) || !Number.isInteger(ev.col)) continue;
      if (ev.row < 0 || ev.col < 0) { nOutOfBounds++; continue; }
      if ((rowsMax !== null && ev.row >= rowsMax) || (colsMax !== null && ev.col >= colsMax)) {
        nOutOfBounds++;
        continue;
      }
      const key = cellKey(ev.row, ev.col);
      cells[key] = (cells[key] || 0) + 1;
      totals++;
    }
  }

  return { cells, totals, nPlayers, nCheatRows, nOutOfBounds };
}

/**
 * Shade bucket for one square: 0 when untouched, else 1..HEAT_LEVELS by
 * the SHARE of the board's solvers who detonated it. Fixed scale, so
 * the same shade means the same thing on every board.
 *
 * @param {number} count hits on this square (= distinct players, since a
 *   struck mine stays revealed and cannot be hit twice by one player)
 * @param {number} nPlayers solvers of the board (the denominator)
 */
export function heatLevel(count, nPlayers) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(nPlayers) || nPlayers <= 0) return 0;
  const share = count / nPlayers;
  for (let i = 0; i < HEAT_BANDS.length; i++) {
    if (share <= HEAT_BANDS[i]) return i + 1;
  }
  return HEAT_LEVELS;
}

export function maxCellCount(cells) {
  let max = 0;
  for (const v of Object.values(cells || {})) if (typeof v === 'number' && v > max) max = v;
  return max;
}

// The band edges as player-facing percentages, for the legend's scale
// bar. The legend states the real numbers rather than "fewer / more",
// a shade nobody can convert back into a quantity is decoration.
export function heatBandLabels() {
  return HEAT_BANDS.map(edge => `${Math.round(edge * 100)}%`);
}

/**
 * The squares worth drawing: every square anyone detonated, keyed with
 * its count, plus the solver denominator to shade against. There is no
 * per-square minimum, because the fixed rate scale already renders a
 * lone hit as the small share it is.
 *
 * @returns {{cells: Record<string, number>, nPlayers: number, nDrawn: number}}
 */
export function drawableCells(cells, nPlayers) {
  const kept = {};
  let nDrawn = 0;
  for (const [key, count] of Object.entries(cells || {})) {
    // Number.isFinite, not typeof: NaN is a number and fails every
    // comparison, so a bare `<= 0` test would let it through.
    if (!Number.isFinite(count) || count <= 0) continue;
    kept[key] = count;
    nDrawn++;
  }
  return { cells: kept, nPlayers: Number(nPlayers) || 0, nDrawn };
}

/**
 * Pick which board the notebook exhibit should draw.
 *
 * @param {Array<{date: string, payload: object}>} entries rolled-up dates, any order
 * @param {Array<string>|Set<string>|null} completedDates board dates this
 *   player has finished. `null` means "not known" (logged out, or the
 *   history fetch failed), which resolves to 'none': without it we
 *   cannot promise the map won't spoil a board they still have to play.
 * @returns {{state: 'ready'|'unplayed'|'sparse'|'none', date: string|null,
 *   payload: object|null, bestPlayers: number}}
 */
export function selectHeatmapDate(entries, completedDates) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter(e => e && typeof e.date === 'string' && e.payload)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (list.length === 0 || completedDates == null) {
    return { state: 'none', date: null, payload: null, bestPlayers: 0 };
  }

  let bestPlayers = 0;
  for (const e of list) {
    const n = Number(e.payload.n_players);
    if (Number.isFinite(n) && n > bestPlayers) bestPlayers = n;
  }

  // No board has the audience yet, so the exhibit does not exist. Not a
  // waiting message, not an empty frame: nothing. A card whose only
  // content is an apology is worse than no card.
  const qualified = list.filter(e => Number(e.payload.n_players) >= MIN_PLAYERS_FOR_HEATMAP);
  if (qualified.length === 0) {
    return { state: 'none', date: null, payload: null, bestPlayers };
  }

  const done = completedDates instanceof Set ? completedDates : new Set(completedDates);
  const played = qualified.find(e => done.has(e.date));
  if (played) {
    return {
      state: 'ready',
      date: played.date,
      payload: played.payload,
      bestPlayers,
      // Counts and their denominator travel together, so no caller can
      // shade a square without the share it represents.
      drawn: drawableCells(played.payload.cells, played.payload.n_players),
    };
  }
  // The payload is WITHHELD, not merely hidden: the caller cannot paint
  // a mine map it was never handed, so a rendering bug cannot leak one.
  return { state: 'unplayed', date: qualified[0].date, payload: null, bestPlayers };
}

/**
 * Greg's copy for a plan. Plain first person, complete sentences, no
 * dashes, counts spoken as words. Returns null when nothing should
 * render at all.
 */
export function heatmapCopy(plan, dateLabel = '') {
  if (!plan || plan.state === 'none') return null;

  if (plan.state === 'unplayed') {
    return {
      title: 'Where the mines went off',
      body: `Enough people have solved the ${dateLabel} board for me to map it. You have not played it, so I am keeping the map closed. Play it from Past dailies and I will show you where the mines went off.`,
    };
  }

  const n = Number(plan.payload?.n_players) || 0;
  const totals = Number(plan.payload?.totals) || 0;
  const opener = `I have logged ${countWord(n)} solvers on the ${dateLabel} board`;
  // Counts render as words below twenty-one and as digits above, so no
  // sentence here opens on the count.
  if (totals === 0) {
    return {
      title: 'Where the mines went off',
      body: `${opener} and not one of them set off a mine. Some boards read clean the whole way through.`,
    };
  }
  return {
    title: 'Where the mines went off',
    body: `${opener}. The darker a square, the bigger the share of them who set off a mine on it.`,
  };
}
