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

// SETTLE WINDOWS: the quantity his report is actually about.
//
// The worst SINGLE frame is the wrong instrument for "it is taking closer to a
// full second to render" (his words, 2026-08-21). His own diagnostics showed a
// 133ms worst frame beside a 17ms mean, and those two numbers are perfectly
// consistent with a run of merely-slow frames lasting a second: no individual
// frame is remarkable, the sequence is. A ring of worst frames cannot see a
// sequence, so it reported the board as nearly fine while he watched it crawl.
//
// So each action opens a window that closes once the frames go quiet again,
// and what gets kept is how long the whole thing took to settle.
const QUIET_MS = 24;              // a frame that is not obviously struggling
const QUIET_RUN = 3;              // consecutive quiet frames that end a window
const SETTLE_CAP_MS = 4000;       // a window always closes, even if nothing does
const SETTLE_RING = 10;           // worst settles kept

let _worst = [];
let _frames = 0;
let _sumMs = 0;
let _running = false;
let _rafId = 0;
let _lastAt = 0;
let _context = null;
let _armed = false;
let _settles = [];
let _pending = null;

/** Arm the probe. Nothing samples until this is called with true. */
export function armFrameProbe(on) {
  _armed = !!on;
  if (!_armed) stopFrameProbe();
}

/**
 * What the player was doing, set by the caller so a slow frame can be
 * attributed rather than guessed at.
 * @param {{shape?: string, cells?: number, action?: string}} ctx
 */
export function setFrameContext(ctx) {
  if (!_armed) return;
  _context = ctx || null;
  // A named action opens a settle window. A re-render with no action (the
  // board being rebuilt) does not, or every window would be about the rebuild.
  if (ctx && ctx.action && ctx.action !== 'render') openSettleWindow(ctx);
}

/**
 * Start timing how long the frames take to go quiet after one action. A window
 * already open is REPLACED, not nested: if a second action lands mid-settle the
 * honest attribution is the newer one, and merging them would report a single
 * enormous settle that no tap actually produced.
 */
function openSettleWindow(ctx) {
  _pending = {
    action: ctx.action || '',
    shape: ctx.shape || 'rect',
    cells: ctx.cells || 0,
    revealed: ctx.revealed || 0,
    startedAt: 0,      // stamped by the first frame, so it is rAF's own clock
    lastBusyAt: 0,
    longMs: 0,
    worstMs: 0,
    quiet: 0,
  };
}

function closeSettleWindow() {
  const w = _pending;
  _pending = null;
  if (!w || !w.startedAt || !w.lastBusyAt) return;
  _settles.push({
    settleMs: Math.round(w.lastBusyAt - w.startedAt),
    longMs: Math.round(w.longMs),
    worstMs: Math.round(w.worstMs),
    action: w.action,
    shape: w.shape,
    cells: w.cells,
    revealed: w.revealed,
  });
  if (_settles.length > SETTLE_RING * 2) {
    _settles.sort((a, b) => b.settleMs - a.settleMs);
    _settles.length = SETTLE_RING;
  }
}

/**
 * Begin sampling. Idempotent.
 *
 * ARMING IS THE GATE (his ruling 2026-08-21: this belongs on the test branch
 * so nobody else is bothered by it). The caller passes isTestEnvironment(), and
 * until something arms it every other entry point here is inert: setContext
 * does nothing, and the report says so rather than returning empty stats that
 * would read as "no jank" on a build that never measured.
 */
export function startFrameProbe() {
  if (!_armed || _running) return;
  _running = true;
  _lastAt = 0;
  const tick = (now) => {
    if (!_running) return;
    if (_lastAt) {
      const dt = now - _lastAt;
      if (_frames < MAX_SAMPLES) { _frames++; _sumMs += dt; }
      if (_pending) {
        if (!_pending.startedAt) { _pending.startedAt = _lastAt; _pending.lastBusyAt = _lastAt; }
        if (dt > QUIET_MS) {
          _pending.longMs += dt;
          _pending.lastBusyAt = now;
          if (dt > _pending.worstMs) _pending.worstMs = dt;
          _pending.quiet = 0;
        } else if (++_pending.quiet >= QUIET_RUN) {
          closeSettleWindow();
        }
        if (_pending && now - _pending.startedAt > SETTLE_CAP_MS) closeSettleWindow();
      }
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
  // An UNARMED build says so. Returning empty stats would read as "no jank
  // measured", which is a different and misleading claim.
  if (!_armed) return { armed: false, note: 'frame probe runs on test builds only' };
  const worst = [..._worst].sort((a, b) => b.ms - a.ms).slice(0, RING);
  const settles = [..._settles].sort((a, b) => b.settleMs - a.settleMs).slice(0, SETTLE_RING);
  return {
    armed: true,
    frames: _frames,
    meanMs: _frames ? Math.round((_sumMs / _frames) * 10) / 10 : 0,
    jankThresholdMs: JANK_MS,
    worst,
    // How long one action took to stop costing frames. This is the number to
    // read against "a full second", not `worst`.
    worstSettles: settles,
    env: renderEnv(),
  };
}

/**
 * The rendering conditions, recorded because assuming them wasted a day: a
 * desktop harness measured tilings against classic six ways with theme effects
 * silently OFF the whole time (the classic theme registers none, so `fx-on` is
 * never added), and effects turned out to cost roughly 2.6x per reveal. A
 * report that cannot say whether they were on cannot be compared to one that
 * had them.
 */
function renderEnv() {
  try {
    const board = typeof document !== 'undefined' && document.getElementById('board');
    return {
      theme: (document.documentElement.dataset.theme) || 'classic',
      fxOn: !!(board && board.classList.contains('fx-on')),
      reducedMotion: !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      dpr: window.devicePixelRatio || 1,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
  } catch {
    return null;
  }
}

/** Forget everything (a new board, or after reporting). */
export function resetFrameProbe() {
  _worst = [];
  _settles = [];
  _pending = null;
  _frames = 0;
  _sumMs = 0;
}
