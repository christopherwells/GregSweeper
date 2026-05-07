// Shared Firebase-readiness gate. Both dailyBoardSync and weeklyBoardSync
// (and the startup gate in main.js) need to wait for the CDN-loaded
// firebase SDK to actually initialize before calling db.ref(). Without
// this, a cold-load race lets reads silently no-op and writes silently
// fail, which is exactly what produced the canonical-board divergence
// incident on 2026-05-06.

export const FIREBASE_READY_TIMEOUT_MS = 8000;

function _firebaseDb() {
  if (typeof firebase === 'undefined' || !firebase.apps?.length) return null;
  try { return firebase.database(); } catch { return null; }
}

export async function waitForFirebaseReady(timeoutMs = FIREBASE_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = _firebaseDb();
    if (db) return db;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Firebase did not initialize within ${timeoutMs}ms`);
}
