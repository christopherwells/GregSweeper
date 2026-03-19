import { safeGet, safeSet, safeRemove, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
/**
 * Firebase Online Daily Leaderboard
 * Uses Firebase Realtime Database (compat SDK loaded via CDN in index.html).
 * Falls back to localStorage when offline or Firebase unavailable.
 */

let firebaseReady = false;
let db = null;

// Client-side rate limiting: track last submission timestamp
let _lastSubmitTime = 0;
const SUBMIT_COOLDOWN_MS = 30000; // 30 seconds between submissions

// Score validation bounds
const MIN_VALID_TIME = 5;    // seconds — anything faster is impossible
const MAX_VALID_TIME = 3600; // seconds — 1 hour cap

/**
 * Initialize Firebase. Call once on app startup.
 * Config should be replaced with user's own Firebase project config.
 */
export async function initFirebase() {
  try {
    // Check if Firebase SDK is available (loaded via CDN)
    if (typeof firebase === 'undefined' || !firebase.initializeApp) {
      console.log('Firebase SDK not loaded — leaderboard will be local-only');
      return;
    }

    // Firebase project configuration
    // Replace with your own Firebase project config from console.firebase.google.com
    const firebaseConfig = {
      apiKey: "AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo",
      authDomain: "gregsweeper-66d02.firebaseapp.com",
      databaseURL: "https://gregsweeper-66d02-default-rtdb.firebaseio.com",
      projectId: "gregsweeper-66d02",
      storageBucket: "gregsweeper-66d02.firebasestorage.app",
      messagingSenderId: "381276018616",
      appId: "1:381276018616:web:28a79187190dcf9caba14d"
    };

    // Only initialize if not already done
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.database();

    // Test connectivity with a quick read
    try {
      await Promise.race([
        db.ref('.info/connected').once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connection timeout')), 5000)),
      ]);
    } catch (connErr) {
      console.warn('Firebase connected but database may be unreachable:', connErr.message);
      // Still mark as ready — individual operations have their own timeouts
    }

    firebaseReady = true;
    console.log('Firebase leaderboard initialized');
  } catch (err) {
    console.warn('Firebase init failed — using local leaderboard:', err.message);
    if (err.message?.includes('permission')) {
      console.warn('Hint: Check Firebase Realtime Database Security Rules in the Firebase Console.');
      console.warn('For testing, set rules to: { ".read": true, ".write": true }');
    }
    firebaseReady = false;
  }
}

/**
 * Check if Firebase is connected and available.
 */
export function isFirebaseOnline() {
  return firebaseReady && db !== null;
}

/**
 * Submit a score to the online daily leaderboard.
 * @param {string} dateString YYYY-MM-DD format
 * @param {string} name Player name (max 20 chars)
 * @param {number} time Completion time in seconds
 * @param {number} bombHits Number of bomb hits (daily mode strikes)
 * @returns {Promise<boolean>} true if submitted successfully
 */
export async function submitOnlineScore(dateString, name, time, bombHits = 0) {
  if (!isFirebaseOnline()) return false;

  // Client-side rate limiting: reject submissions too close together
  const now = Date.now();
  if (now - _lastSubmitTime < SUBMIT_COOLDOWN_MS) {
    console.warn('Score submission rate-limited — please wait before submitting again');
    return false;
  }

  // Basic score validation: reject impossible or unreasonable times
  if (typeof time !== 'number' || time < MIN_VALID_TIME || time > MAX_VALID_TIME) {
    console.warn(`Score rejected — time ${time}s is outside valid range (${MIN_VALID_TIME}–${MAX_VALID_TIME}s)`);
    return false;
  }

  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;

    const ref = db.ref(`daily/${dateString}`);
    await ref.push({
      name: sanitizedName,
      time,
      bombHits,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    });

    _lastSubmitTime = now;
    return true;
  } catch (err) {
    console.warn('Firebase submit failed:', err.message);
    return false;
  }
}

// NOTE: Client-side validation is not sufficient for security.
// Firebase Security Rules should be configured to enforce:
//   - Time range validation (5–3600 seconds)
//   - Rate limiting per user/IP
//   - Name length and content sanitization
//   - Date string format validation
// See: https://firebase.google.com/docs/database/security

/**
 * Fetch the online daily leaderboard for a given date.
 * @param {string} dateString YYYY-MM-DD format
 * @returns {Promise<Array<{name: string, time: number, bombHits: number}>>} sorted entries
 */
export async function fetchOnlineLeaderboard(dateString) {
  if (!isFirebaseOnline()) return null;

  try {
    const ref = db.ref(`daily/${dateString}`);
    // Race against a 5-second timeout to avoid hanging on bad config
    const snapshot = await Promise.race([
      ref.orderByChild('time').limitToFirst(50).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);

    if (!snapshot.exists()) return [];

    const entries = [];
    snapshot.forEach((child) => {
      const val = child.val();
      entries.push({
        name: val.name || 'Anonymous',
        time: val.time || 0,
        bombHits: val.bombHits || 0,
      });
    });

    // Already sorted by time from Firebase query, but ensure it
    entries.sort((a, b) => a.time - b.time);
    return entries;
  } catch (err) {
    console.warn('Firebase fetch failed:', err.message);
    return null; // null signals to fall back to local
  }
}

// ── Room Code Helpers ──────────────────────────────────

const ROOM_CODE_RE = /^[A-Za-z0-9]{4,8}$/;

function validateRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_RE.test(code);
}

/**
 * Check if a room with the given code exists.
 * @param {string} code 4-8 alphanumeric room code
 * @returns {Promise<boolean>}
 */
export async function checkRoomExists(code) {
  if (!isFirebaseOnline() || !validateRoomCode(code)) return false;
  try {
    const snap = await Promise.race([
      db.ref(`rooms/${code.toUpperCase()}/name`).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return snap.exists();
  } catch (err) {
    console.warn('checkRoomExists failed:', err.message);
    return false;
  }
}

/**
 * Create a new room.
 * @param {string} code 4-8 alphanumeric room code
 * @param {string} roomName Display name for the room
 * @param {string} creatorName Name of the person creating the room
 * @returns {Promise<boolean>} true if created successfully
 */
export async function createRoom(code, roomName, creatorName) {
  if (!isFirebaseOnline()) return false;
  if (!validateRoomCode(code)) {
    console.warn('Invalid room code — must be 4-8 alphanumeric characters');
    return false;
  }

  const upperCode = code.toUpperCase();
  const sanitizedName = String(roomName).slice(0, 30).trim();
  const sanitizedCreator = String(creatorName).slice(0, 20).trim();
  if (!sanitizedName || !sanitizedCreator) return false;

  try {
    // Check if room already exists
    const exists = await checkRoomExists(upperCode);
    if (exists) {
      console.warn('Room already exists:', upperCode);
      return false;
    }

    await db.ref(`rooms/${upperCode}`).set({
      name: sanitizedName,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      createdBy: sanitizedCreator,
    });

    // Add creator as first member
    await db.ref(`rooms/${upperCode}/members/${sanitizedCreator}`).set({
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    });

    return true;
  } catch (err) {
    console.warn('createRoom failed:', err.message);
    return false;
  }
}

/**
 * Join an existing room.
 * @param {string} code Room code
 * @param {string} playerName Player's display name
 * @returns {Promise<boolean>} true if joined successfully
 */
export async function joinRoom(code, playerName) {
  if (!isFirebaseOnline()) return false;
  if (!validateRoomCode(code)) return false;

  const upperCode = code.toUpperCase();
  const sanitizedName = String(playerName).slice(0, 20).trim();
  if (!sanitizedName) return false;

  try {
    const exists = await checkRoomExists(upperCode);
    if (!exists) {
      console.warn('Room does not exist:', upperCode);
      return false;
    }

    await db.ref(`rooms/${upperCode}/members/${sanitizedName}`).set({
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    return true;
  } catch (err) {
    console.warn('joinRoom failed:', err.message);
    return false;
  }
}

/**
 * Leave a room (remove member).
 * @param {string} code Room code
 * @param {string} playerName Player's display name
 * @returns {Promise<boolean>}
 */
export async function leaveRoom(code, playerName) {
  if (!isFirebaseOnline()) return false;
  if (!validateRoomCode(code)) return false;

  const upperCode = code.toUpperCase();
  const sanitizedName = String(playerName).slice(0, 20).trim();
  if (!sanitizedName) return false;

  try {
    await db.ref(`rooms/${upperCode}/members/${sanitizedName}`).remove();
    return true;
  } catch (err) {
    console.warn('leaveRoom failed:', err.message);
    return false;
  }
}

/**
 * Submit a score to a room's daily leaderboard.
 * @param {string} code Room code
 * @param {string} dateString YYYY-MM-DD
 * @param {string} name Player name
 * @param {number} time Completion time in seconds
 * @param {number} bombHits Number of bomb hits
 * @returns {Promise<boolean>}
 */
export async function submitRoomScore(code, dateString, name, time, bombHits = 0) {
  if (!isFirebaseOnline()) return false;
  if (!validateRoomCode(code)) return false;

  if (typeof time !== 'number' || time < MIN_VALID_TIME || time > MAX_VALID_TIME) {
    console.warn(`Room score rejected — time ${time}s outside valid range`);
    return false;
  }

  const upperCode = code.toUpperCase();
  const sanitizedName = String(name).slice(0, 20).trim();
  if (!sanitizedName) return false;

  try {
    const ref = db.ref(`rooms/${upperCode}/scores/${dateString}`);
    await ref.push({
      name: sanitizedName,
      time,
      bombHits,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    });
    return true;
  } catch (err) {
    console.warn('submitRoomScore failed:', err.message);
    return false;
  }
}

/**
 * Fetch today's room leaderboard.
 * @param {string} code Room code
 * @param {string} dateString YYYY-MM-DD
 * @returns {Promise<Array|null>} sorted entries or null on failure
 */
export async function fetchRoomLeaderboard(code, dateString) {
  if (!isFirebaseOnline()) return null;
  if (!validateRoomCode(code)) return null;

  const upperCode = code.toUpperCase();

  try {
    const ref = db.ref(`rooms/${upperCode}/scores/${dateString}`);
    const snapshot = await Promise.race([
      ref.orderByChild('time').limitToFirst(50).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);

    if (!snapshot.exists()) return [];

    const entries = [];
    snapshot.forEach((child) => {
      const val = child.val();
      entries.push({
        name: val.name || 'Anonymous',
        time: val.time || 0,
        bombHits: val.bombHits || 0,
      });
    });

    entries.sort((a, b) => a.time - b.time);
    return entries;
  } catch (err) {
    console.warn('fetchRoomLeaderboard failed:', err.message);
    return null;
  }
}

/**
 * Fetch past N days of room results.
 * @param {string} code Room code
 * @param {number} days Number of past days to fetch (default 7)
 * @returns {Promise<Object|null>} { 'YYYY-MM-DD': [...entries] } or null
 */
export async function fetchRoomHistory(code, days = 7) {
  if (!isFirebaseOnline()) return null;
  if (!validateRoomCode(code)) return null;

  const upperCode = code.toUpperCase();
  const history = {};

  try {
    for (let i = 1; i <= days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

      const ref = db.ref(`rooms/${upperCode}/scores/${ds}`);
      const snapshot = await Promise.race([
        ref.orderByChild('time').limitToFirst(50).once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);

      if (snapshot.exists()) {
        const entries = [];
        snapshot.forEach((child) => {
          const val = child.val();
          entries.push({
            name: val.name || 'Anonymous',
            time: val.time || 0,
            bombHits: val.bombHits || 0,
          });
        });
        entries.sort((a, b) => a.time - b.time);
        history[ds] = entries;
      }
    }

    return history;
  } catch (err) {
    console.warn('fetchRoomHistory failed:', err.message);
    return null;
  }
}

/**
 * Get room members list.
 * @param {string} code Room code
 * @returns {Promise<string[]|null>} array of member names or null
 */
export async function getRoomMembers(code) {
  if (!isFirebaseOnline()) return null;
  if (!validateRoomCode(code)) return null;

  const upperCode = code.toUpperCase();

  try {
    const snap = await Promise.race([
      db.ref(`rooms/${upperCode}/members`).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);

    if (!snap.exists()) return [];

    return Object.keys(snap.val());
  } catch (err) {
    console.warn('getRoomMembers failed:', err.message);
    return null;
  }
}

/**
 * Get room info (name, createdBy).
 * @param {string} code Room code
 * @returns {Promise<{name: string, createdBy: string}|null>}
 */
export async function getRoomInfo(code) {
  if (!isFirebaseOnline()) return null;
  if (!validateRoomCode(code)) return null;

  const upperCode = code.toUpperCase();

  try {
    const snap = await Promise.race([
      db.ref(`rooms/${upperCode}`).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);

    if (!snap.exists()) return null;

    const val = snap.val();
    return {
      name: val.name || 'Unnamed Room',
      createdBy: val.createdBy || 'Unknown',
    };
  } catch (err) {
    console.warn('getRoomInfo failed:', err.message);
    return null;
  }
}

// ── Room localStorage Helpers ──────────────────────────

const ROOM_STORAGE_KEY = 'minesweeper_room';

/**
 * Save room info to localStorage.
 * @param {string} code Room code
 * @param {string} playerName Player's display name in the room
 */
export function saveRoomInfo(code, playerName) {
  try {
    safeSetJSON(ROOM_STORAGE_KEY, {
      code: code.toUpperCase(),
      playerName: String(playerName).slice(0, 20).trim(),
    });
  } catch (e) {
    console.warn('saveRoomInfo failed:', e.message);
  }
}

/**
 * Load room info from localStorage.
 * @returns {{code: string, playerName: string}|null}
 */
export function loadRoomInfo() {
  try {
    const raw = safeGet(ROOM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.code && parsed.playerName) return parsed;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Clear room info from localStorage.
 */
export function clearRoomInfo() {
  try {
    safeRemove(ROOM_STORAGE_KEY);
  } catch (e) {
    // ignore
  }
}
