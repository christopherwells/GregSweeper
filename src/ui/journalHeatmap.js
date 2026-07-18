// ── Journal heatmap — "where the mines went off" ──────────────────────
// The notebook's one population exhibit: a past daily board drawn as a
// grid, each square shaded by how many players detonated a mine on it.
// Every decision that could fabricate a claim lives in the pure
// src/logic/boardHeatmap.js and is node-tested there. This module only
// fetches and draws what that layer approves.
//
// Three things it will not do:
//   1. Exist at all until MIN_PLAYERS_FOR_HEATMAP people have solved a
//      board. Below that there is no card, no waiting message, nothing.
//   2. Draw a board the player has not finished. The map only lights
//      cells that held mines, and past dailies are replayable from the
//      Daily Archive, so an unplayed board would ship as a partial mine
//      map for a puzzle they still have ahead.
//   3. Draw anything without the canonical board to check the grid
//      against. A map that does not describe the board under it is
//      worse than no map.
//
// Shading is a RATE (share of that board's solvers, on a fixed scale),
// never a rank against the board's own busiest square, so a board three
// people found awkward cannot render as though it were brutal.
//
// Rendered as a card in the in-app notebook only. The logged-out
// ?report= page has no play history to check rule 2 against.

import { el } from './journalCard.js';
import { loadRecentBoardHeatmaps, loadDailyBoard, deserializeBoard } from '../firebase/dailyBoardSync.js';
import { fetchUserDailyHistory } from '../firebase/firebaseLeaderboard.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { formatShortDate } from '../logic/journalFindings.js';
import {
  HEAT_LEVELS,
  heatBandLabels,
  selectHeatmapDate,
  heatmapCopy,
  heatLevel,
  parseCellKey,
} from '../logic/boardHeatmap.js';

// The player's completed board dates, or null when we cannot know them
// (signed out, offline, or a failed read). null is NOT an empty list:
// the gate treats "unknown" as "render nothing" so a fetch failure can
// never spoil a board.
async function _completedDates() {
  const uid = getUid();
  if (!uid) return null;
  const history = await fetchUserDailyHistory(uid, 400);
  if (!Array.isArray(history)) return null;
  // Keyed by BOARD date (entry.date), not the played date — the heatmap
  // is about the board, and an archive replay of it counts as solved.
  return new Set(history.map(h => h.date));
}

// `drawn` carries the squares to shade and the solver denominator they
// are shaded against, so a count never reaches the DOM without the
// share it represents.
function _grid(drawn, rows, cols) {
  const grid = el('div', 'journal-heat-grid');
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.setAttribute('role', 'img');

  const cells = drawn.cells;
  const nPlayers = drawn.nPlayers;

  // Index the sparse count map by cell so the draw stays one pass.
  const byIndex = new Map();
  for (const [key, count] of Object.entries(cells)) {
    const pos = parseCellKey(key);
    if (!pos || pos.r >= rows || pos.c >= cols) continue;
    byIndex.set(pos.r * cols + pos.c, count);
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const count = byIndex.get(r * cols + c) || 0;
      const cell = el('div', `journal-heat-cell heat-${heatLevel(count, nPlayers)}`);
      // The tooltip states the fraction outright, so the shade is always
      // convertible back into the quantity behind it.
      if (count > 0) {
        cell.title = count === 1
          ? `1 of ${nPlayers} players set off a mine here.`
          : `${count} of ${nPlayers} players set off a mine here.`;
      }
      grid.appendChild(cell);
    }
  }

  grid.setAttribute('aria-label',
    `Board grid, ${rows} by ${cols}. Darker squares are cells where a bigger share of the ${nPlayers} solvers set off a mine.`);
  return grid;
}

// A real scale bar: each swatch labeled with the share of solvers it
// stands for, so the shading reads as a measurement rather than a rank.
function _legend() {
  const legend = el('div', 'journal-heat-legend');
  legend.appendChild(el('span', 'journal-heat-legend-label', 'Share of players'));
  const labels = heatBandLabels();
  for (let lv = 1; lv <= HEAT_LEVELS; lv++) {
    const step = el('span', 'journal-heat-step');
    step.appendChild(el('span', `journal-heat-swatch heat-${lv}`));
    step.appendChild(el('span', 'journal-heat-legend-tick',
      lv <= labels.length ? `≤${labels[lv - 1]}` : `>${labels[labels.length - 1]}`));
    legend.appendChild(step);
  }
  return legend;
}

/**
 * Build the heatmap card, or null when nothing honest can be shown.
 * Never throws: the notebook renders with or without this exhibit.
 *
 * @returns {Promise<HTMLElement|null>}
 */
export async function buildHeatmapExhibit() {
  let plan = null;
  try {
    const [entries, completed] = await Promise.all([
      loadRecentBoardHeatmaps(),
      _completedDates(),
    ]);
    plan = selectHeatmapDate(entries, completed);
  } catch {
    return null;
  }
  if (!plan || plan.state === 'none') return null;

  const dateLabel = plan.date ? formatShortDate(plan.date) : '';
  const copy = heatmapCopy(plan, dateLabel);
  if (!copy) return null;

  const card = el('article', 'journal-card journal-heatmap');
  card.appendChild(el('h3', 'journal-heat-title', copy.title));
  card.appendChild(el('p', 'journal-entry', copy.body));

  // Unplayed, or a board nobody detonated: the sentence IS the exhibit.
  // An empty grid would imply misses that are not there.
  if (plan.state !== 'ready' || plan.drawn.nDrawn === 0) return card;

  // The canonical board is the authority on the grid, and it is
  // REQUIRED, not preferred: without it there is nothing to check the
  // map's self-declared shape against, and a map that does not describe
  // the board under it is worse than no map. Failing closed costs a
  // decorative card on a flaky load.
  let board = null;
  try {
    const raw = await loadDailyBoard(plan.date);
    board = raw ? deserializeBoard(raw) : null;
  } catch { /* deserializeBoard throws on a malformed payload */ }
  if (!board) return card;
  if (board.rows !== plan.payload.rows || board.cols !== plan.payload.cols) {
    console.warn('journalHeatmap: heatmap grid does not match the canonical board, not drawing');
    return card;
  }

  card.appendChild(_grid(plan.drawn, board.rows, board.cols));
  card.appendChild(_legend());
  return card;
}
