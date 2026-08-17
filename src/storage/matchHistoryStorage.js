// This device's solo Challenge runs, persisted.
//
// The one storage home for the records src/logic/matchHistory.js shapes: a
// single JSON list under one key, newest first, capped by the logic layer's
// own SOLO_HISTORY_CAP. Reads and writes go through storageAdapter so private
// browsing degrades to the in-memory map the way every other store does, and
// a corrupt list reads as empty rather than throwing inside a win handler.

import { safeGetJSON, safeSetJSON } from './storageAdapter.js';
import { soloRunRecord, appendSoloRun } from '../logic/matchHistory.js';

const SOLO_RUNS_KEY = 'minesweeper_match_solo_runs';

/** Stored solo runs, newest first. Always an array. */
export function loadSoloRuns() {
  const list = safeGetJSON(SOLO_RUNS_KEY, []);
  return Array.isArray(list) ? list.filter((r) => r && Array.isArray(r.boards)) : [];
}

/**
 * Record a finished solo run. Returns true when the record was written; for
 * a run with nothing to record (no cleared board) nothing is written and the
 * answer is false.
 */
export function recordSoloRun(match, finishedAt = Date.now()) {
  const record = soloRunRecord(match, finishedAt);
  if (!record) return false;
  safeSetJSON(SOLO_RUNS_KEY, appendSoloRun(loadSoloRuns(), record));
  return true;
}
