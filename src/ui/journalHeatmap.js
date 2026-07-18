// ── Journal heatmap — "where the mines went off" ──────────────────────
// The notebook's one population exhibit: a past daily board drawn as a
// grid, each square shaded by how many players detonated a mine on it.
// Every decision that could fabricate a claim lives in the pure
// src/logic/boardHeatmap.js and is node-tested there. This module only
// fetches and draws what that layer approves.
//
// Four things it will not do:
//   1. Draw a board fewer than MIN_PLAYERS_FOR_HEATMAP people have
//      solved, because a per-cell count on a thin board is one player's
//      afternoon, and painting it as a population signal would break the
//      same honesty contract the rest of the Journal runs on.
//   2. Shade a square fewer than MIN_CELL_HITS_TO_DRAW players
//      detonated. Rule 1 licenses the board; this licenses the square,
//      and they are different claims.
//   3. Draw a board the player has not finished. The map only lights
//      cells that held mines, and past dailies are replayable from the
//      Daily Archive, so an unplayed board would ship as a partial mine
//      map for a puzzle they still have ahead.
//   4. Draw anything without the canonical board to check the grid
//      against. A map that does not describe the board under it is
//      worse than no map.
//
// Rendered as a card in the in-app notebook only. The logged-out
// ?report= page has no play history to check rule 3 against.

import { el } from './journalCard.js';
import { loadRecentBoardHeatmaps, loadDailyBoard, deserializeBoard } from '../firebase/dailyBoardSync.js';
import { fetchUserDailyHistory } from '../firebase/firebaseLeaderboard.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { formatShortDate } from '../logic/journalFindings.js';
import {
  HEAT_LEVELS,
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

// `drawn` is the pure layer's approved subset: only squares that at
// least MIN_CELL_HITS_TO_DRAW distinct players detonated, with the shade
// denominator it chose. The raw payload counts never reach the DOM.
function _grid(drawn, rows, cols) {
  const grid = el('div', 'journal-heat-grid');
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.setAttribute('role', 'img');

  const cells = drawn.cells;
  const max = drawn.max;

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
      const cell = el('div', `journal-heat-cell heat-${heatLevel(count, max)}`);
      if (count > 0) cell.title = `${count} players set off a mine here.`;
      grid.appendChild(cell);
    }
  }

  grid.setAttribute('aria-label',
    `Board grid, ${rows} by ${cols}. Darker squares are cells where more players set off a mine.`);
  return grid;
}

function _legend() {
  const legend = el('div', 'journal-heat-legend');
  legend.appendChild(el('span', 'journal-heat-legend-label', 'Fewer'));
  for (let lv = 1; lv <= HEAT_LEVELS; lv++) {
    legend.appendChild(el('span', `journal-heat-swatch heat-${lv}`));
  }
  legend.appendChild(el('span', 'journal-heat-legend-label', 'More'));
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

  // Sparse, unplayed, or nothing past the per-square floor: the sentence
  // IS the exhibit. An empty grid would imply a board with no misses.
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
