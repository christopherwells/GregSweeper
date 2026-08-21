// Re-derive a banked match result's strike penalties from the board itself.
//
// WHY THIS EXISTS (his report, 2026-08-19). He and Kate hit two Classic marathon
// boards in a live five-board run and were charged strike penalties in the
// thousands of par-seconds: computeBombInfoValue priced each strike as a par DIFFERENCE,
// and under the log model a difference like that includes the board's
// whole multiplicative baseline, which past a shape's fit ceiling is the raw
// extrapolation the marathon lane exists to avoid. The pricing itself is
// fixed at the source now, but the results ALREADY BANKED on a device keep
// the inflated numbers, and both destinations refuse them:
//
//   - the match node validates `time` and `penalty` at <= 3600, so the whole
//     `results/{index}` write was refused and the standings never got the
//     board (worse than wrong: Firebase returns sparse indices as an OBJECT,
//     so a player missing boards 0-1 reads as having played NOTHING);
//   - matchFitRows refuses a row outside [5, 3600]s, so the board never
//     reaches the model either.
//
// Fifty minutes of real play on the first marathon-scale boards anyone has
// ever played is exactly the data the fit is starved of, so it is recovered
// rather than written off. Everything needed is on the device: the dealt
// entry stores the board payload, the result stores each strike's cell and
// the sane anchored par, and the wall clock is exactly `time - penalty`
// because preciseTime is penalty-inclusive by construction (timerManager).
//
// RE-DERIVED, NEVER ADJUSTED. The repair replays each strike through the
// same solver on the same board in the same order and rebuilds the penalty
// from the fixed pricing; it does not scale, cap, or estimate the stored
// number. On a board whose pricing was already honest the recomputation
// reproduces the stored total and the repair reports nothing, so this is
// safe to run over every result unconditionally and needs no marker for
// "was this written by the broken build". Measured cost: one solver run is
// ~6ms on a 660-cell board, and a strike costs two.

import { deserializeBoard } from '../firebase/dailyBoardSync.js';
import { computeBombInfoValue, repriceStoredStrike } from '../logic/bombInfoValue.js';
import { BOMB_PENALTY_BASE, BOMB_PENALTY_RAMP } from '../logic/difficulty.js';

/** A stored total and a recomputed one agree inside the game's own 0.1s. */
const SAME_PENALTY_EPS = 0.05;

// What BOTH destinations refuse: the match node validates time and penalty at
// <= 3600, and matchFitRows refuses the same range. A stored row inside it is
// one the game accepted and both consumers will take, so nothing is owed.
const DESTINATION_MAX_SECONDS = 3600;

/**
 * Re-derive one result's penalties from its board.
 *
 * @param {object} entry  the dealt match entry (payload + features)
 * @param {object} res    the banked result (time, penalty, par, bombHitEvents)
 * @returns {object|null} a corrected copy, or null when nothing changed and
 *   when the inputs cannot support an exact answer (a missing payload, an
 *   unusable par, a solver refusal). Null means FILE WHAT YOU HAVE: this
 *   module never returns a guess.
 */
export function repairMatchResult(entry, res) {
  if (!entry || !res) return null;
  const events = Array.isArray(res.bombHitEvents) ? res.bombHitEvents : [];
  if (events.length === 0) return null;
  // The sane baseline the move share is priced against. On a match board
  // this is the installed par, which the deal already keeps ANCHORED for a
  // provisional board, so it is the honest number even where predictPar is
  // not. Without it there is nothing to price against and no repair to make.
  const par = Number(res.par) || 0;
  if (!(par > 0)) return null;

  let d = null;
  try { d = deserializeBoard(entry.payload); } catch { return null; }
  if (!d || !Array.isArray(d.board) || !Number.isInteger(d.cols) || d.cols <= 0) return null;
  const opener = Number.isInteger(d.firstClick) ? d.firstClick : -1;
  if (opener < 0) return null;
  const fr = Math.floor(opener / d.cols);
  const fc = opener % d.cols;

  // ── The stored counts are the RIGHT basis, when they exist ─────────
  //
  // Each event since 2026-08-20 carries patternBefore/searchBefore/
  // patternAfter/searchAfter, recorded for exactly this job:
  // repriceStoredStrike turns them into today's seconds with no board state
  // and no solver run. They are a measurement of the BOARD, so neither a
  // model change nor a change of information basis can invalidate them.
  //
  // Why this matters (issue #410). The live handler prices a strike from the
  // PLAYER'S board; this module was written on 2026-08-19 when from-scratch
  // was the shipped rule, and when 8606f216b changed that the next day the
  // repair was given `{ liveState: false }` to keep it working on stored
  // payloads. That pinned it to the OLD rule while the live path moved on,
  // and its premise, that recomputation is a no-op on an honest result,
  // silently stopped holding: the opener basis is systematically the LARGER
  // number, so the repair began rewriting ordinary honest boards upward by
  // tens of seconds and feeding that to the standings and the par fit.
  const counted = events.map((e) => repriceStoredStrike(e, entry.features || null, par));
  const everyEventCounted = counted.every((v) => v !== null);

  if (everyEventCounted) {
    const rebuiltFromCounts = [];
    let countedTotal = 0;
    for (let i = 0; i < events.length; i++) {
      const rampedBase = BOMB_PENALTY_BASE * (1 + BOMB_PENALTY_RAMP * i);
      const penalty = Math.round((counted[i] + rampedBase) * 10) / 10;
      rebuiltFromCounts.push({ ...events[i], penalty, infoValue: Math.round(counted[i] * 10) / 10 });
      countedTotal += penalty;
    }
    countedTotal = Math.round(countedTotal * 10) / 10;
    const storedNow = Number(res.penalty) || 0;
    if (Math.abs(countedTotal - storedNow) < SAME_PENALTY_EPS) return null;
    const wallNow = Math.round(((Number(res.time) || 0) - storedNow) * 10) / 10;
    return {
      ...res,
      time: Math.round((wallNow + countedTotal) * 10) / 10,
      penalty: countedTotal,
      bombHitEvents: rebuiltFromCounts,
    };
  }

  // ── The legacy cohort: events with no counts ───────────────────────
  //
  // These predate 2026-08-20 and are the rows this module was actually
  // written for. The only answer available is the opener basis, which is NOT
  // the rule they were charged under, so it is applied ONLY where the stored
  // number is already one the destinations refuse. An honest row is never
  // touched by a rule that cannot reproduce it.
  const storedSoFar = Number(res.penalty) || 0;
  const storedTime = Number(res.time) || 0;
  const destinationsRefuse = storedSoFar < 0 || storedSoFar > DESTINATION_MAX_SECONDS
    || storedTime < 0 || storedTime > DESTINATION_MAX_SECONDS;
  if (!destinationsRefuse) return null;

  const prior = [];
  const rebuilt = [];
  let total = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || !Number.isInteger(e.row) || !Number.isInteger(e.col)) return null;
    let infoValue = 0;
    try {
      const r = computeBombInfoValue(
        d.board, d.rows, d.cols, fr, fc, e.row, e.col,
        prior.slice(), entry.features || null, par,
        // A stored payload is not a played board: nothing on it is
        // revealed, so the live-state reading would price every strike
        // against an untouched board and overstate it. The recovery asks
        // the opener question, which is the rule those boards were played
        // under, and says so rather than pretending otherwise.
        { liveState: false },
      );
      infoValue = r.infoValue;
    } catch {
      // A solver refusal means no exact answer for this board; the caller
      // keeps the stored row rather than filing a number nobody derived.
      return null;
    }
    // The n-th strike's base, the live handler's own formula: events are in
    // strike order, so the k-th (0-based) is strike k+1.
    const rampedBase = BOMB_PENALTY_BASE * (1 + BOMB_PENALTY_RAMP * i);
    const penalty = Math.round((infoValue + rampedBase) * 10) / 10;
    rebuilt.push({ ...e, penalty, infoValue: Math.round(infoValue * 10) / 10 });
    total += penalty;
    prior.push({ row: e.row, col: e.col });
  }
  total = Math.round(total * 10) / 10;

  const storedTotal = Number(res.penalty) || 0;
  if (Math.abs(total - storedTotal) < SAME_PENALTY_EPS) return null;

  // The wall clock is exact: preciseTime is wall + penalty by construction,
  // and the stored penalty is the same sum the events carry.
  const wall = Math.round(((Number(res.time) || 0) - storedTotal) * 10) / 10;
  return {
    ...res,
    time: Math.round((wall + total) * 10) / 10,
    penalty: total,
    bombHitEvents: rebuilt,
  };
}

/**
 * Re-derive every banked result of a match IN PLACE, returning the indices
 * that changed so the caller can re-post them.
 *
 * @param {object} match `state.match`
 * @returns {number[]} indices whose stored result was replaced
 */
export function repairMatchResults(match) {
  if (!match || !Array.isArray(match.results) || !Array.isArray(match.entries)) return [];
  const fixed = [];
  for (let i = 0; i < match.results.length; i++) {
    const repaired = repairMatchResult(match.entries[i], match.results[i]);
    if (repaired) {
      match.results[i] = repaired;
      fixed.push(i);
    }
  }
  return fixed;
}
