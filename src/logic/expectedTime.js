// Expected time for a Challenge 250 level, the display layer's pure half
// (Christopher's ruling: "expected time is DISPLAYED, handicap-adjusted",
// as a pre-level card plus a quiet in-game bar that fills as the timer
// runs; "go go go, but no real punishment").
//
// The number shown is personalPar, Greg's par for THIS drawn board scaled
// by the player's own multiplicative handicap, not a target the game
// enforces. Nothing here gates, penalizes, or records: challenge stays out
// of the par fit entirely (no submission path), so this is a pace cue and
// nothing more.
//
// Pure and node-tested so the bar's fill, its clamping, and the copy can
// be verified without a DOM: the DOM half is a few lines in headerRenderer.

/** Seconds rendered as a compact clock-ish label: 48s, 1:52, 6:40. */
export function formatExpected(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

/**
 * The pace bar's state at a moment in a run.
 *
 * `fill` is elapsed/expected CLAMPED to 1: the bar fills and then
 * stays full. That clamp IS the no-punishment rule, an overrun has
 * nothing left to show, so a slow solve never turns the bar into a
 * scolding meter, and `over` lets the caller style the full state calmly
 * rather than as a failure.
 *
 * @param {number} elapsedSec seconds played so far
 * @param {number} expectedSec personalPar for this board (0 = unknown)
 * @returns {{known: boolean, fill: number, over: boolean, remaining: number}}
 */
export function paceState(elapsedSec, expectedSec) {
  const exp = Number(expectedSec) || 0;
  if (!(exp > 0)) return { known: false, fill: 0, over: false, remaining: 0 };
  const el = Math.max(0, Number(elapsedSec) || 0);
  const ratio = el / exp;
  return {
    known: true,
    fill: Math.min(1, ratio),
    over: ratio >= 1,
    remaining: Math.max(0, exp - el),
  };
}

/**
 * The pre-level card's line. Plain, first-person-free, and deliberately
 * NOT a promise: "about" every time, because personalPar is a median
 * estimate for this player on a board nobody has played yet.
 */
export function expectedTimeLine(expectedSec) {
  if (!(Number(expectedSec) > 0)) return '';
  return `About ${formatExpected(expectedSec)}`;
}
