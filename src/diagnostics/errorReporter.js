// Remote error reporting — captures uncaught errors and unhandled promise
// rejections, writes them to Firebase under errors/{uid}/{timestamp}.
//
// Why: with two active users on opposite platforms (Christopher on
// Windows desktop, Kate on iOS PWA), regressions surface as written bug
// reports days later. A captured stack trace beats "the daily was weird
// yesterday" by a wide margin. Writes are owner-readable only — the
// project owner reads via Firebase Console.
//
// Rate-limited so an error in a tight loop can't flood Firebase. Drops
// the cap silently after 10 events per session; the user never sees
// reporter activity.

import { getUid } from '../firebase/firebaseProgress.js';

const MAX_ERRORS_PER_SESSION = 10;
const MAX_BUFFER = 20;
const BUFFER_FLUSH_INTERVAL_MS = 1000;
const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 8000;
const MAX_URL_LEN = 500;
const MAX_UA_LEN = 500;

let _initialized = false;
let _sessionWriteCount = 0;
let _buffer = [];
let _codeVersion = 'unknown';
let _intervalId = null;
// Monotonic timestamp for the path key. Date.now() can collide if two
// errors fire in the same millisecond (a single throw inside a tight
// retry loop would do it); the second write would silently overwrite
// the first because the rule allows updates on existing keys. Bumping
// past _lastTs guarantees within-session uniqueness without needing
// an underscore-bearing key (which the numeric-only path regex would
// reject).
let _lastTs = 0;

function _safeStr(v, max) {
  try {
    const s = typeof v === 'string' ? v : String(v);
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return '';
  }
}

function _isStandalone() {
  try {
    return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

function _nextTs() {
  let ts = Date.now();
  if (ts <= _lastTs) ts = _lastTs + 1;
  _lastTs = ts;
  return ts;
}

function _writeOne(payload) {
  // Defensive: never let the reporter throw and bubble back into the
  // page. Every step is wrapped.
  try {
    const uid = getUid();
    if (!uid) return false;
    if (typeof firebase === 'undefined' || !firebase.database) return false;
    const ts = _nextTs();
    const data = {
      message: _safeStr(payload.message, MAX_MESSAGE_LEN),
      stack: _safeStr(payload.stack || '', MAX_STACK_LEN),
      url: _safeStr(location.href, MAX_URL_LEN),
      codeVersion: _safeStr(_codeVersion, 32),
      userAgent: _safeStr(navigator.userAgent || '', MAX_UA_LEN),
      isStandalone: _isStandalone(),
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    };
    firebase.database().ref(`errors/${uid}/${ts}`).set(data).catch(() => {});
    _sessionWriteCount++;
    return true;
  } catch {
    return false;
  }
}

function _flushBuffer() {
  if (_buffer.length === 0) return;
  const remaining = [];
  for (const ev of _buffer) {
    if (_sessionWriteCount >= MAX_ERRORS_PER_SESSION) break;
    const ok = _writeOne(ev);
    if (!ok) {
      // Couldn't write yet (e.g. uid still resolving). Keep for next tick.
      remaining.push(ev);
    }
  }
  _buffer = remaining;
}

function _enqueue(payload) {
  if (_sessionWriteCount >= MAX_ERRORS_PER_SESSION) return;
  if (_writeOne(payload)) return;
  // Auth not ready yet — buffer for the periodic flush. Cap the buffer
  // so a flood during initialization can't grow unbounded.
  if (_buffer.length < MAX_BUFFER) _buffer.push(payload);
  // Restart the periodic flush if it had cleared after a previous drain.
  // Without this, an error that arrives AFTER auth resolves but BEFORE
  // the next periodic tick (and after the interval was cleared on
  // empty-buffer) would sit in the buffer forever. _initialized stays
  // true; we just re-arm the timer.
  if (_initialized && _intervalId === null && _buffer.length > 0) {
    _intervalId = setInterval(() => {
      if (_sessionWriteCount >= MAX_ERRORS_PER_SESSION || _buffer.length === 0) {
        clearInterval(_intervalId);
        _intervalId = null;
        return;
      }
      _flushBuffer();
    }, BUFFER_FLUSH_INTERVAL_MS);
  }
}

/**
 * Attach window-level error listeners. Safe to call multiple times —
 * subsequent calls are no-ops. Pass the current cache version so written
 * errors carry the build that produced them.
 *
 * @param {object} [opts]
 * @param {string} [opts.codeVersion]
 */
export function initErrorReporter(opts) {
  if (_initialized) return;
  _initialized = true;
  if (opts && opts.codeVersion) _codeVersion = opts.codeVersion;

  window.addEventListener('error', (ev) => {
    _enqueue({
      message: ev && ev.message ? ev.message : 'unknown error',
      stack: ev && ev.error && ev.error.stack ? ev.error.stack : '',
    });
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev ? ev.reason : null;
    let message = 'unhandled rejection';
    let stack = '';
    if (reason) {
      if (typeof reason === 'string') message = reason;
      else if (reason.message) message = reason.message;
      else { try { message = JSON.stringify(reason); } catch {} }
      if (reason.stack) stack = reason.stack;
    }
    _enqueue({ message, stack });
  });

  // Periodic flush handles the auth-not-yet-ready case. Cleared once
  // the cap is hit OR the buffer has fully drained — without the empty-
  // buffer clear, a single buffered boot-time error would leave the
  // interval ticking every second for the entire session even after
  // its work is done.
  _intervalId = setInterval(() => {
    if (_sessionWriteCount >= MAX_ERRORS_PER_SESSION) {
      clearInterval(_intervalId);
      _intervalId = null;
      return;
    }
    if (_buffer.length === 0) {
      clearInterval(_intervalId);
      _intervalId = null;
      return;
    }
    _flushBuffer();
  }, BUFFER_FLUSH_INTERVAL_MS);
}

/**
 * Manually update the codeVersion after init (e.g. once the SW reports
 * its CACHE_NAME). Lets late-arriving errors carry the right build.
 */
export function setErrorReporterCodeVersion(v) {
  if (typeof v === 'string' && v) _codeVersion = v;
}

/**
 * Test-only helper — fire a synthetic error through the reporter so a
 * Firebase round-trip can be verified manually. Exposed on window when
 * `?debug=1` is enabled.
 */
export function reportTestError(label) {
  _enqueue({
    message: 'TEST: ' + (label || 'manual error report'),
    stack: new Error('TEST').stack || '',
  });
}
