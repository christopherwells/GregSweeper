// Local cache of canonical daily/weekly boards for offline play.
//
// Canonical boards are write-once and immutable once published, so a
// board we've already fetched can be served from localStorage forever
// without re-hitting Firebase. That's exactly what makes a daily/weekly
// playable on bad service or fully offline: the startup gate + a
// background prefetch pull a week of boards while online, and the
// read-through in dailyBoardSync/weeklyBoardSync serves them locally
// afterward.
//
// This module is intentionally dependency-light (only storageAdapter) so
// the board-sync modules can import it without a circular dependency —
// the prefetch helpers that DO need loadDailyBoard/loadWeeklyBoard live
// in those modules, not here.

import { safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';

const DAILY_PREFIX = 'minesweeper_board_daily_';
const WEEKLY_PREFIX = 'minesweeper_board_weekly_';

// How many ET days of dailies to keep/prefetch (today + the next 6).
export const PREFETCH_DAILY_DAYS = 7;

// Pure calendar arithmetic on a 'YYYY-MM-DD' string. Anchored at noon UTC
// so a day-add never lands on a DST seam or rolls the date the wrong way;
// ET dates are just calendar days, so this matches getLocalDateString's
// sequence without needing the timezone here.
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// A cached payload is only trustworthy if it has the structural fields the
// deserializer requires. A malformed/partial entry returns null so the
// caller falls through to Firebase rather than feeding garbage to
// deserializeBoard (which would throw).
function _isValidBoard(raw) {
  return raw && typeof raw === 'object'
    && Number.isInteger(raw.rows) && Number.isInteger(raw.cols)
    && Array.isArray(raw.cells) && raw.cells.length === raw.rows * raw.cols;
}

export function getCachedDailyBoard(date) {
  if (typeof date !== 'string' || !date) return null;
  const raw = safeGetJSON(DAILY_PREFIX + date, null);
  return _isValidBoard(raw) ? raw : null;
}

export function cacheDailyBoard(date, raw) {
  if (typeof date !== 'string' || !date || !_isValidBoard(raw)) return;
  try { safeSetJSON(DAILY_PREFIX + date, raw); } catch { /* quota / private — best-effort */ }
}

export function getCachedWeeklyBoard(weekStart) {
  if (typeof weekStart !== 'string' || !weekStart) return null;
  const raw = safeGetJSON(WEEKLY_PREFIX + weekStart, null);
  return _isValidBoard(raw) ? raw : null;
}

export function cacheWeeklyBoard(weekStart, raw) {
  if (typeof weekStart !== 'string' || !weekStart || !_isValidBoard(raw)) return;
  try { safeSetJSON(WEEKLY_PREFIX + weekStart, raw); } catch { /* best-effort */ }
}

// Drop cached boards outside the rolling window so localStorage doesn't
// grow without bound. Keep yesterday → +7 for dailies (yesterday is a
// grace slot for a play in progress across the midnight ET flip) and
// previous/current/next week for weeklies. Called once at startup.
export function pruneOldCachedBoards(today, currentWeek) {
  try {
    const keepDaily = new Set();
    for (let i = -1; i <= PREFETCH_DAILY_DAYS; i++) keepDaily.add(addDays(today, i));
    const keepWeekly = new Set([addDays(currentWeek, -7), currentWeek, addDays(currentWeek, 7)]);
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(DAILY_PREFIX) && !keepDaily.has(k.slice(DAILY_PREFIX.length))) {
        toRemove.push(k);
      } else if (k.startsWith(WEEKLY_PREFIX) && !keepWeekly.has(k.slice(WEEKLY_PREFIX.length))) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch { /* best-effort */ }
}
