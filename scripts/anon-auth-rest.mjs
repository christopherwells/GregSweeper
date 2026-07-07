// Anonymous-auth REST helper shared by the board precompute / backfill /
// bootstrap scripts (Node-side only; the browser app authenticates through
// the Firebase SDK, never through this file).
//
// Two constraints shape it:
//
// - The web API key carries HTTP-referrer restrictions (console-applied
//   2026-07-06): a request with no Referer header is rejected outright
//   ("Requests from referer <empty> are blocked"), and Node's fetch sends
//   none. Every call here stamps the production origin as the referer so
//   the scripts keep working against the restricted key.
//
// - accounts:signUp CREATES a Firebase Auth user per run. The scripts used
//   to leave that account behind (~35 orphans/month across the nightly +
//   weekly crons — pure Auth-console clutter that made the user list
//   unreadable). deleteSelf() removes the account once the run's writes are
//   done, so script runs are Auth-neutral. Deletion is best-effort by
//   design: the board write is the mission, and a failed cleanup must never
//   fail the workflow — call it in a finally block.

const FIREBASE_API_KEY = 'AIzaSyBhiFPIUA0u021Yh7eA35N2nQOIUPVPtpo';
const KEY_REFERER = 'https://gregsweeper.com/';

export async function signInAnonymously() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: KEY_REFERER },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`anonymous sign-in failed: ${r.status} ${txt}`);
  }
  const j = await r.json();
  if (!j.idToken) throw new Error('anonymous sign-in: no idToken in response');
  return j.idToken;
}

// Delete the anonymous account the given idToken belongs to. Tolerates a
// null token (dry-run paths sign in conditionally) and never throws.
export async function deleteSelf(idToken) {
  if (!idToken) return;
  try {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${FIREBASE_API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: KEY_REFERER },
      body: JSON.stringify({ idToken }),
    });
    if (!r.ok) console.warn(`  anon-account cleanup failed (non-fatal): ${r.status} ${await r.text()}`);
    else console.log('  anon account cleaned up');
  } catch (err) {
    console.warn(`  anon-account cleanup failed (non-fatal): ${err.message}`);
  }
}
