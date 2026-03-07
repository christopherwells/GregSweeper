/**
 * Firebase Online Daily Leaderboard
 * Uses Firebase Realtime Database (compat SDK loaded via CDN in index.html).
 * Falls back to localStorage when offline or Firebase unavailable.
 */

let firebaseReady = false;
let db = null;

/**
 * Initialize Firebase. Call once on app startup.
 * Config should be replaced with user's own Firebase project config.
 */
export function initFirebase() {
  try {
    // Check if Firebase SDK is available (loaded via CDN)
    if (typeof firebase === 'undefined' || !firebase.initializeApp) {
      console.log('Firebase SDK not loaded — leaderboard will be local-only');
      return;
    }

    // Firebase project configuration
    // Replace with your own Firebase project config from console.firebase.google.com
    const firebaseConfig = {
      apiKey: "AIzaSyCmYnIGt8EfOXnOPxWKCsBz5CU2Fg4wRrE",
      authDomain: "gregsweeper.firebaseapp.com",
      databaseURL: "https://gregsweeper-default-rtdb.firebaseio.com",
      projectId: "gregsweeper",
      storageBucket: "gregsweeper.firebasestorage.app",
      messagingSenderId: "574027498253",
      appId: "1:574027498253:web:5d2b2b4a0f8b4e5c6d7e8f"
    };

    // Only initialize if not already done
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.database();
    firebaseReady = true;
    console.log('Firebase leaderboard initialized');
  } catch (err) {
    console.warn('Firebase init failed — using local leaderboard:', err.message);
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
    return true;
  } catch (err) {
    console.warn('Firebase submit failed:', err.message);
    return false;
  }
}

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
