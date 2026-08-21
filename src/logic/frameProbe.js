// A frame-time probe, so the shape-mode lag can be measured where it happens.
//
// HIS REPORT, twice: "the lag one experiences when playing all of the shape
// game modes... an odd reveal the cells lag which doesn't happen with classic",
// and it is on his phone across devices.
//
// WHY THIS EXISTS RATHER THAN ANOTHER GUESS. Ten measured investigations on a
// desktop harness could not reproduce it, and several actively pointed the
// wrong way: at 6x CPU throttle a tiling board measured FASTER than a classic
// one (p90 51.6ms against 66.6ms), removing the seams overlay made it worse,
// and removing clip-path changed nothing. The reveal animation is genuinely
// expensive but costs MORE on classic (p90 176ms against a tiling's 135ms), so
// it cannot be what makes tilings different. Ruling those out was worth doing;
// continuing to guess from a machine that cannot see the problem is not.
//
// So this records the worst frames on the device where the lag is real, with
// enough context to name a cause: which shape, how many cells, and what the
// player had just done. It samples requestAnimationFrame deltas, which is the
// one signal that captures style, layout, paint and composite together, and
// which is exactly the part a desktop probe kept missing.
//
// Deliberately cheap: one rAF loop, a fixed-size ring, no allocation per frame
// beyond a number, and it only runs while a board is on screen.

const RING = 12;                  // worst frames kept
const JANK_MS = 50;               // a frame worth recording at all: 3 budgets
const MAX_SAMPLES = 4000;         // stop growing stats on a long session

let _worst = [];
let _frames = 0;
let _sumMs = 0;
let _running = false;
let _rafId = 0;
let _lastAt = 0;
let _context = null;

/**
 * What the player was doing, set by the caller so a slow frame can be
 * attributed rather than guessed at.
 * @param {{shape?: string, cells?: number, action?: string}} ctx
 */
export function setFrameContext(ctx) {
  _context = ctx || null;
}

/** Begin sampling. Idempotent. */
export function startFrameProbe() {
  if (_running) return;
  _running = true;
  _lastAt = 0;
  const tick = (now) => {
    if (!_running) return;
    if (_lastAt) {
      const dt = now - _lastAt;
      if (_frames < MAX_SAMPLES) { _frames++; _sumMs += dt; }
      if (dt >= JANK_MS) {
        _worst.push({
          ms: Math.round(dt),
          shape: _context?.shape || 'rect',
          cells: _context?.cells || 0,
          action: _context?.action || '',
        });
        // Keep only the worst few, so a long session cannot grow this.
        if (_worst.length > RING * 2) {
          _worst.sort((a, b) => b.ms - a.ms);
          _worst.length = RING;
        }
      }
    }
    _lastAt = now;
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

/** Stop sampling (leaving the board). */
export function stopFrameProbe() {
  _running = false;
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = 0;
}

/**
 * The report, for the diagnostics payload. Worst frames first, with the mean
 * beside them so a single spike is not mistaken for a slow board.
 */
export function frameProbeReport() {
  const worst = [..._worst].sort((a, b) => b.ms - a.ms).slice(0, RING);
  return {
    frames: _frames,
    meanMs: _frames ? Math.round((_sumMs / _frames) * 10) / 10 : 0,
    jankThresholdMs: JANK_MS,
    worst,
  };
}

/** Forget everything (a new board, or after reporting). */
export function resetFrameProbe() {
  _worst = [];
  _frames = 0;
  _sumMs = 0;
}
