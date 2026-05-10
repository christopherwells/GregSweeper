// ── Storage Adapter ──────────────────────────────────────
// Central localStorage wrapper with in-memory fallback.
// If localStorage is unavailable or full, all reads/writes
// silently fall back to a Map that lasts the current session.

let _storage = null; // resolved on first use
let _fallbackActive = false;
const _memoryStore = new Map();

/**
 * Test whether localStorage is available and writable.
 * Called once on first access; result is cached.
 */
function testLocalStorage() {
  try {
    const key = '__gs_storage_test__';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function getBackend() {
  if (_storage !== null) return _storage;
  if (testLocalStorage()) {
    _storage = 'local';
  } else {
    _storage = 'memory';
    _fallbackActive = true;
  }
  return _storage;
}

// ── Public API ─────────────────────────────────────────

/**
 * Read a string value (like localStorage.getItem).
 * Returns null if the key doesn't exist.
 */
export function safeGet(key) {
  try {
    if (getBackend() === 'local') {
      return localStorage.getItem(key);
    }
  } catch {
    // localStorage threw at runtime — switch to fallback
    _storage = 'memory';
    _fallbackActive = true;
  }
  return _memoryStore.get(key) ?? null;
}

/**
 * Write a string value (like localStorage.setItem).
 */
export function safeSet(key, value) {
  try {
    if (getBackend() === 'local') {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    // QuotaExceededError or SecurityError — switch to fallback
    _storage = 'memory';
    _fallbackActive = true;
    console.warn(`localStorage write failed for "${key}" — using in-memory fallback`);
  }
  _memoryStore.set(key, String(value));
}

/**
 * Remove a key (like localStorage.removeItem).
 */
export function safeRemove(key) {
  try {
    if (getBackend() === 'local') {
      localStorage.removeItem(key);
      return;
    }
  } catch {
    _storage = 'memory';
    _fallbackActive = true;
  }
  _memoryStore.delete(key);
}

/**
 * JSON helpers — mirrors the getJSON/setJSON pattern but through the adapter.
 */
export function safeGetJSON(key, fallback = null) {
  try {
    const raw = safeGet(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function safeSetJSON(key, value) {
  try {
    safeSet(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`Storage write failed for "${key}":`, err.message);
  }
}

/**
 * Returns true when localStorage is broken and we're using
 * the in-memory fallback. UI can show a toast about it.
 */
export function isStorageFailing() {
  getBackend(); // ensure test has run
  return _fallbackActive;
}

const PERSIST_RESULT_KEY = 'gregsweeper_persist_granted';

/**
 * Ask the browser to mark our origin's storage as "persistent" so the
 * Storage Pressure cleanup heuristic doesn't evict our localStorage /
 * IndexedDB / cache content the way it would for a casual visitor.
 *
 * - Chrome desktop: typically grants automatically once the user has
 *   "engaged" with the site (bookmark, install, repeat visits) — the
 *   API reliably returns true without showing a prompt in those cases.
 *   When engagement is too low it returns false silently; no permission
 *   popup the way push/notifications would. (R4 research, 2026-05-09.)
 * - iOS Safari: silently grants for any PWA added to the home screen
 *   (no permission dialog). Safari may still evict aggressively if the
 *   device is genuinely low on space, but the eviction-after-7-days
 *   storage policy doesn't apply to a persisted origin.
 * - Firefox: similar to Chrome. Older versions DID prompt; modern
 *   versions don't.
 *
 * Safe to call at boot. The result lands in localStorage so the
 * Diagnostics modal can surface it without re-running the API.
 *
 * Idempotent — calling repeatedly is harmless. We still re-call rather
 * than caching, because a previously-rejected request may succeed
 * later once the user passes engagement heuristics.
 */
export async function requestPersistentStorage() {
  if (!('storage' in navigator) || typeof navigator.storage.persist !== 'function') {
    safeSet(PERSIST_RESULT_KEY, 'unsupported');
    return false;
  }
  try {
    // If already granted, persist() returns true without re-asking.
    const granted = await navigator.storage.persist();
    safeSet(PERSIST_RESULT_KEY, granted ? 'granted' : 'denied');
    return granted;
  } catch (err) {
    safeSet(PERSIST_RESULT_KEY, 'error:' + (err && err.message ? err.message.slice(0, 50) : 'unknown'));
    return false;
  }
}

/**
 * Read the cached result of the most recent requestPersistentStorage()
 * call. Returns 'granted' / 'denied' / 'unsupported' / 'error:...' /
 * '' (never called). For diagnostics display.
 */
export function getPersistentStorageStatus() {
  return safeGet(PERSIST_RESULT_KEY) || '';
}
