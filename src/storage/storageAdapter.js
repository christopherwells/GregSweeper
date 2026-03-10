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
