// ── Startup gate + boot plumbing ──────────────────────
// Extracted from main.js (2026-07-10 split). Render nothing user-interactive
// until three preconditions hold:
//   1. The SW is up to date (or we've waited long enough, a stale
//      cache on a steady-state load is benign).
//   2. The Firebase SDK is initialized so loadDailyBoard can succeed.
//   3. For non-practice loads, today's canonical board is in memory.
//
// Without this gate, a cold-load race lets `loadDailyBoard` return
// null silently, gameActions falls through to local generation, the
// stale `experimentTarget.json` cache picks a different `:trialN`
// winner from whatever wrote the canonical, and the player ends up
// on a divergent board. This is exactly the failure that put Kate on
// trial3 while Chris was on trial5 on 2026-05-06.

import { state } from '../state/gameState.js';
import { isTestEnvironment } from '../firebase/env.js';
import { getLocalDateString, getWeekStart } from '../logic/seededRandom.js';
import { loadDailyBoardResult } from '../firebase/dailyBoardSync.js';
import { loadWeeklyBoardResult } from '../firebase/weeklyBoardSync.js';
import {
  shouldRetryCanonical, canonicalRetryDelay,
  CANONICAL_RETRIES, CANONICAL_UNREAD,
} from '../logic/canonicalRetry.js';
import { pruneOldCachedBoards } from '../firebase/boardCache.js';
import {
  getUid, loadWeeklyAttempts, loadLocalWeeklyAttempts,
  replaceLocalWeeklyAttempts, pruneStaleLocalWeeklyAttempts,
} from '../firebase/firebaseProgress.js';
import {
  isDailyCompleted, markDailyCompleted, clearGameState, pruneOldDailyKeys,
  getDailyCompletionRecord, unlockDailyReplay,
} from '../storage/statsStorage.js';
import { planCompletionReconcile } from '../logic/startupReconcilePlan.js';
import { safeGet, safeSet } from '../storage/storageAdapter.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// ── Boot overlay helpers ──────────────────────────────
function setBootStatus(text) {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = text;
}

export function hideBootOverlay() {
  const el = document.getElementById('boot-overlay');
  if (el) el.remove();
}

// ── Service-worker update gate ────────────────────────
// Kick off an update check and wait briefly for any new SW to install
// and activate. If activation fires, the controllerchange handler in
// index.html <head> reloads the page, the new code restarts the gate
// from scratch, so we just need to give it time to fire. If no update
// is found within timeoutMs, we proceed with the current bundle.
async function ensureLatestServiceWorker(timeoutMs = 3000) {
  if (!('serviceWorker' in navigator)) return;
  // A known-offline boot cannot fetch an update, so waiting the full budget
  // for one buys nothing and costs the player three seconds of "Connecting…"
  // (2026-08-07, measured as part of his airplane-mode report). Trusted only
  // in the negative direction: false means there is definitely no network.
  // reg.update() below is still CALLED on a true-but-wrong reading; this only
  // skips the WAIT, so a stale onLine can never suppress a real update.
  if (navigator.onLine === false) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.getRegistration();
  } catch { return; }
  if (!reg) return;

  // R3 (iOS standalone PWAs): updatefound rarely fires here because
  // iOS often updates the SW BEFORE launching the page, leaving it in
  // `waiting` state when our code runs. controllerchange may not fire
  // either if the activation already happened pre-launch. So handle
  // an existing `waiting` worker explicitly: postMessage skipWaiting
  // (the SW listens via the existing message handler), wait briefly
  // for controllerchange, then force a reload as a fallback for the
  // case where activation completed silently before we could observe.
  if (reg.waiting && navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        // controllerchange didn't fire, iOS may have already swapped
        // the controller before we attached the listener. Force a
        // single reload so the new SW takes over our page state.
        //
        // Everything here is inside try/catch because a throw in a setTimeout
        // callback does NOT reject the enclosing promise, it escapes as an
        // uncaught error and `resolve` is never called, stranding the
        // boot overlay forever. sessionStorage is the live hazard: it throws on
        // write in a storage-restricted context (Safari private browsing, a
        // locked-down PWA container), which is exactly where the iOS path this
        // block exists for is taken.
        try {
          if (!sessionStorage.getItem('_gs_skip_force_reload')) {
            sessionStorage.setItem('_gs_skip_force_reload', '1');
            window.location.reload();
            return; // navigation pre-empts resolve
          }
          sessionStorage.removeItem('_gs_skip_force_reload');
        } catch { /* no session storage, fall through and boot */ }
        resolve();
      }, 2000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
        resolve(); // controllerchange handler in <head> reloads us
      }, { once: true });
      reg.waiting.postMessage({ type: 'skipWaiting' });
    });
  }

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'activated') {
          clearTimeout(timer);
          // Don't resolve; controllerchange will reload us. If the
          // reload doesn't fire within 500ms (unusual), fall through
          // so the gate can proceed.
          setTimeout(resolve, 500);
        }
      });
    });
    // Two-callback form (NOT .catch().then(), which would run the reset
    // right after the failure handler and zero the counter it just bumped).
    reg.update().then(
      () => {
        // Successful check (even "no update found"), reset the counter.
        if (navigator.onLine) safeSet(SW_UPDATE_FAIL_KEY, '0');
      },
      (err) => {
        // The update CHECK failed, the exact failure that left
        // Sebastien's device silently stuck on a 6-day-old bundle.
        // Offline checks fail legitimately (no report); an ONLINE
        // failure means updates aren't reaching this device, so count
        // consecutive failures durably and, at three in a row, tell the
        // player how to self-rescue.
        if (!navigator.onLine) return;
        reportCaughtError('sw-update-check', err);
        const fails = (parseInt(safeGet(SW_UPDATE_FAIL_KEY)) || 0) + 1;
        safeSet(SW_UPDATE_FAIL_KEY, String(fails));
        if (fails >= 3) {
          import('../ui/toastManager.js').then(m => m.showToast(
            'Game updates aren\'t reaching this device. Try closing every tab of the game and reopening it.', 6000, 'uiWarning'));
        }
      }
    );
  });
}
const SW_UPDATE_FAIL_KEY = 'minesweeper_sw_update_fail_count';

// ── The gate ──────────────────────────────────────────
/**
 * Re-read one canonical after a first result with no board, with linear
 * backoff. Returns the board, or null once the budget is spent.
 *
 * WHICH failures are worth retrying is the whole point, and getting it wrong
 * cost real boot time (issue #255). A null used to mean four things at once,
 * the date is empty, the payload failed its trust gate, the read timed out,
 * Firebase never came ready, so the loop spent its budget on the two cases
 * that provably cannot improve: an empty date returns empty again, and a
 * tampered payload returns the same bytes. The loaders now report a reason and
 * `shouldRetryCanonical` acts on it, so only a genuine unread read is retried.
 *
 * The budget is wall-clock and is checked BEFORE each attempt, never raced
 * against one in flight, truncating a read that was about to land would
 * defeat the retry's purpose. With the loaders' 5s fetch timeout that bounds
 * this at ~5.5s; the attempt-count version it replaced allowed 11.5s while its
 * comment claimed "about a second and a half".
 */
async function retryCanonicalRead(label, loadResult, firstReason) {
  const startedAt = Date.now();
  let reason = firstReason;
  for (let attempt = 1; attempt <= CANONICAL_RETRIES; attempt++) {
    if (!shouldRetryCanonical({
      reason, attempt, elapsedMs: Date.now() - startedAt, online: navigator.onLine !== false,
    })) return null;
    await new Promise(r => setTimeout(r, canonicalRetryDelay(attempt)));
    const res = await loadResult().catch(err => {
      reportCaughtError(`${label}-retry`, err);
      return { board: null, reason: CANONICAL_UNREAD };
    });
    if (res && res.board) return res.board;
    reason = (res && res.reason) || CANONICAL_UNREAD;
  }
  return null;
}
// Budget for the completion-reconcile read. Matches the fetch timeout the
// board syncs use; the gate has already spent its Firebase-ready wait by the
// time this runs, so the only thing left to bound is the read itself.
const RECONCILE_READ_TIMEOUT_MS = 5000;
// One-time migration marker for completions recorded before the board seed was
// stored beside them. See the vintageUnlock argument in startupReconcilePlan.
const VINTAGE_UNLOCK_KEY = 'minesweeper_daily_vintage_unlock_done';

export async function runStartupGate() {
  // Step 1 of the visible boot sequence ('Loading…' is the HTML
  // default before this runs): the SW-update + Firebase waits below
  // are where a slow connection actually spends its time.
  setBootStatus('Connecting…');

  // SW update wait + Firebase ready wait run in PARALLEL. Both have
  // their own time budgets (3s SW, 8s Firebase) and neither depends on
  // the other; the prior sequential version could spend up to 11s in
  // the gate before any fetch started. With Promise.all the gate
  // takes at most max(3, 8) = 8s for the two waits, then daily +
  // weekly + attempts fetch in parallel below.
  //
  // initFirebase() was kicked off before this gate runs (fire-and-
  // forget in init()), so the Firebase-ready wait is just polling for
  // completion. If neither comes back in time we proceed in degraded
  // (offline) mode, score submission is already gated on
  // isFirebaseOnline() so a fully-local play stays out of the
  // canonical leaderboard.
  const [, firebaseReady] = await Promise.all([
    ensureLatestServiceWorker(3000),
    _waitForFirebaseInit(8000),
  ]);
  state.firebaseReady = firebaseReady;

  // Pre-fetch today's canonical board + this week's weekly canonical +
  // weekly attempts ALL in parallel. None depend on each other; they
  // share the Firebase connection. Skip for ?seed= practice runs since
  // those intentionally bypass the canonical bucket.
  const urlParams = new URLSearchParams(window.location.search);
  const customSeed = urlParams.get('seed');
  const today = getLocalDateString();
  const currentWeek = getWeekStart();

  // Seed the weekly-attempt cache from localStorage SYNCHRONOUSLY. This
  // closes the boot-time race where Firebase's anon-auth + fetch hadn't
  // settled before the title screen rendered, letting the player tap
  // Weekly and bypass the one-per-day gate. Firebase data merges over
  // this once it arrives. Also prune stale entries from previous weeks.
  // Test branch: start with no cached weekly attempts so the player
  // can replay the weekly indefinitely. Don't touch localStorage (it's
  // shared with master via the same github.io origin and we'd nuke
  // production's stored attempts).
  state.cachedWeeklyDayAttempts = isTestEnvironment() ? {} : loadLocalWeeklyAttempts(currentWeek);
  state.cachedWeeklyAttemptsWeek = currentWeek;
  if (!isTestEnvironment()) pruneStaleLocalWeeklyAttempts(currentWeek);
  // Trim the offline board cache to its rolling window (yesterday..+7
  // dailies, prev/current/next weekly) so it can't grow unbounded.
  pruneOldCachedBoards(today, currentWeek);
  // Same for the per-date daily par/moves/features keys, one trio per
  // played date forever would eventually trip the quota and silently
  // downgrade storage to the in-memory fallback.
  pruneOldDailyKeys();

  if (firebaseReady && !customSeed) {
    setBootStatus('Loading today\'s puzzle…');
    try {
      // Test branch: skip the Firebase weekly-attempts read too so an
      // existing master attempt doesn't get pulled in and gate test.
      // loadDailyBoard/loadWeeklyBoard are designed to throw nothing, so
      // these catches fire only on a real bug, worth a report, and the
      // null fallback keeps the gate degrading gracefully either way.
      const weeklyAttemptsP = isTestEnvironment()
        ? Promise.resolve({})
        : loadWeeklyAttempts(currentWeek).catch(err => { reportCaughtError('gate-weekly-attempts', err); return null; });
      // The *Result loaders carry WHY a read produced no board, which is what
      // decides whether retrying it can help at all (issue #255).
      const failed = (label) => (err) => {
        reportCaughtError(label, err);
        return { board: null, reason: CANONICAL_UNREAD };
      };
      let [dailyRes, weeklyRes, attempts] = await Promise.all([
        loadDailyBoardResult(today).catch(failed('gate-daily-board')),
        loadWeeklyBoardResult(currentWeek).catch(failed('gate-weekly-board')),
        weeklyAttemptsP,
      ]);
      let dailyRaw = dailyRes.board;
      let weeklyRaw = weeklyRes.board;
      if (!dailyRaw || !weeklyRaw) {
        // ONE read is not enough to conclude the canonical is unavailable
        // (2026-08-07, his ask: the app should open only once it has the
        // board). Falling through to local generation is not a graceful
        // degradation for a daily, it is near-certain DIVERGENCE. The
        // canonical is precomputed up to seven days ahead against the
        // experiment target of that moment, and the nightly refit rewrites
        // that file underneath it, so a client re-deriving the day's board
        // locally is choosing from a differently-sized candidate pool and
        // lands on another trial almost every time. That is how one player
        // spent 2026-08-06 on `:trial6` while the day's board was
        // `:trial13`.
        //
        // Firebase is READY here, so this is a slow or dropped read rather
        // than an offline client, worth a short retry before accepting a
        // board nobody else is playing. A genuinely offline player still
        // gets the local fallback, which is what keeps the game playable on
        // a plane; they will not be ranked (the submit path refuses
        // a divergent row).
        //
        // Only an UNREAD result is retried (issue #255). The loaders report
        // why they came back empty, and two of the reasons cannot improve on a
        // second look: a date the server says is EMPTY answers the same way
        // next time, and an UNTRUSTED payload returns the same bytes. Both
        // used to consume the whole budget and buy nothing.
        // navigator.onLine is the discriminator, and it has to be checked
        // HERE rather than relying on firebaseReady: the SDK loads from a CDN
        // the service worker deliberately does not cache, so on a warm HTTP
        // cache it can initialize perfectly well with no network behind it.
        // Without this, an offline boot pays the full retry budget, and each
        // retry re-enters loadDailyBoard's own 8s waitForFirebaseReady, so it
        // is seconds, not milliseconds. Measured: an offline boot already sits
        // ~19.5s on the overlay, which is the whole of "the PWA stops working
        // in airplane mode". Retrying is for a slow network, never for none.
        //
        // THE WEEKLY IS RETRIED ON THE SAME TERMS, and its blast radius is
        // wider than the daily's. A weekly miss does not merely give one player
        // the wrong board: the local-generation fallback WRITES what it built
        // to the write-once weeklyBoard node, so the first client to miss the
        // read establishes the week for everyone who comes after. It is also a
        // scarcer thing to spend, since a week has one board and seven
        // attempts at it.
        //
        // The two run CONCURRENTLY rather than one after the other. Serial
        // retries would double the worst-case boot on exactly the slow network
        // that triggers them, and the offline work that took the overlay from
        // 19.5s to 4.9s is not worth giving back for a loop that spends most of
        // its time waiting.
        setBootStatus('Fetching today\'s board…');
        const [dailyRetry, weeklyRetry] = await Promise.all([
          dailyRaw ? null
            : retryCanonicalRead('gate-daily-board', () => loadDailyBoardResult(today), dailyRes.reason),
          weeklyRaw ? null
            : retryCanonicalRead('gate-weekly-board', () => loadWeeklyBoardResult(currentWeek), weeklyRes.reason),
        ]);
        if (dailyRetry) dailyRaw = dailyRetry;
        if (weeklyRetry) weeklyRaw = weeklyRetry;
      }
      if (dailyRaw) state.canonicalDailyBoard = { date: today, raw: dailyRaw };
      if (weeklyRaw) state.canonicalWeeklyBoard = { weekStart: currentWeek, raw: weeklyRaw };
      // A successful Firebase read is AUTHORITATIVE for the week (a map,
      // possibly empty). Replacing, not merging over, the localStorage
      // seed is what lets an admin-side reset / cloud deletion actually
      // propagate to the player instead of being masked by a stale local
      // copy. Mirror it back to localStorage so the next boot's
      // synchronous seed agrees and a deleted day stays deleted. A null
      // result means the read could not be completed (offline / not
      // signed in / timed out), keep the localStorage seed set above.
      if (attempts) {
        state.cachedWeeklyDayAttempts = attempts;
        if (!isTestEnvironment()) replaceLocalWeeklyAttempts(currentWeek, attempts);
      }
    } catch (err) {
      console.warn('startup gate: pre-fetch failed:', err.message);
    }
  }

  // Completion ↔ cloud reconciliation (one read, both directions).
  // The lock asks "has this ACCOUNT finished TODAY'S BOARD", not "did it play
  // a daily today", which is the separate, coarser fact the streak keeps. Those
  // two came apart the moment a divergent board could count for the streak
  // while its score was refused. Two ways local and cloud disagree:
  //
  //  - Local flag SET, but the day's real board is unplayed: the player
  //    completed a WRONG board (cold-load race, pre-canonical client, a stale
  //    experiment target). Unlock so they can play the real one. Three
  //    signals, cheapest first, the board seed this device recorded, then a
  //    positively-divergent cloud row, then the one-time vintage unlock for
  //    completions predating the seed record. A missing row on its own never
  //    clears (uid mismatch, network race, offline submission all produce
  //    one); an earlier version cleared on missing-score and let raced lookups
  //    unlock replays. The decision tree is pure and node-tested in
  //    startupReconcilePlan.js.
  //
  //  - Local flag UNSET, cloud row MATCHING the canonical: this account
  //    already completed today's board on ANOTHER device. Adopt the
  //    completion locally (mark + drop any in-progress daily save) so
  //    the Daily card reads "Completed!" and the player can't finish
  //    the same board twice and double-submit. Adoption requires an
  //    explicit effective-seed match, a divergent row must NOT lock
  //    the player out of the canonical (that is exactly what the clear
  //    branch unlocks). The submission-level dedupe in
  //    firebaseLeaderboard backs this up for mid-session races the
  //    boot check can't see.
  //
  // Test env: skipped entirely, isDailyCompleted/markDailyCompleted/
  // unlockDailyReplay are no-ops there, and clearGameState would touch
  // localStorage shared with the production origin.
  if (firebaseReady && !customSeed && !isTestEnvironment()) {
    const canonicalSeed = state.canonicalDailyBoard?.raw?.rngSeed || null;
    if (canonicalSeed) {
      setBootStatus('Verifying today\'s play…');
      const myUid = await waitForUid(3000);
      if (myUid) {
        try {
          // TIMEOUT-RACED like every other Firebase read on the boot path.
          // Realtime DB's once('value') does not time out on its own: on a
          // half-open socket (a phone waking from sleep, a captive portal, a
          // dropped wifi handover) it never settles. This one await was
          // the only unbounded read left between the boot overlay going up and
          // hideBootOverlay() at the end of init, and init's .catch safety net
          // cannot help, it catches a THROW, and a hang is not one. The
          // symptom is the app sitting on the loading screen forever.
          const snap = await Promise.race([
            firebase.database().ref(`daily/${today}`).once('value'),
            new Promise((_, reject) => setTimeout(
              () => reject(new Error('timeout')), RECONCILE_READ_TIMEOUT_MS)),
          ]);
          const rows = snap.val();
          const record = getDailyCompletionRecord();
          const localCompleted = isDailyCompleted(today);
          // Spend the one-time vintage unlock only where it can apply: a
          // completion recorded for TODAY with no board seed against it. The
          // marker is consumed either way, so this can never fire twice.
          const vintageUnlock = localCompleted && record.date === today && !record.seed
            && safeGet(VINTAGE_UNLOCK_KEY) !== '1';
          if (vintageUnlock) safeSet(VINTAGE_UNLOCK_KEY, '1');
          const { action } = planCompletionReconcile({
            rows, uid: myUid, dateString: today, canonicalSeed,
            localCompleted,
            localSeed: record.date === today ? record.seed : null,
            vintageUnlock,
          });
          if (action === 'clearLocal') {
            // This account has not finished the day's real board. Unlock the
            // replay and drop the cached par/moves so newGame recomputes them
            // against the canonical layout. Streak fields are untouched: the
            // divergent play still counted the day, which is the whole point of
            // the split (his constraint, "I don't want people losing their
            // streak, but I also don't want bad data").
            //
            // unlockDailyReplay, not a bare remove: the cloud's lastDailyDate
            // still says "played today", so applyCloudProgress would re-lock
            // the card on the next write under users/{uid}, and the progress
            // listener applies every one of those. The sticky marker is what
            // makes the unlock survive to the moment the player taps Daily.
            // (unlockDailyReplay also drops the cached par / moves / features
            // for the date, they describe the wrong board.)
            unlockDailyReplay(today);
          } else if (action === 'adoptCompletion') {
            // Completed on another device, adopt, recording the board it was
            // on so a later boot can tell it was the canonical. This is also
            // what re-locks a player the vintage unlock touched but who had
            // genuinely played the real board.
            markDailyCompleted(today, canonicalSeed);
            clearGameState('daily');
          }
        } catch (err) {
          console.warn('startup gate: completion verification failed:', err.message);
        }
      }
    }
  }
}

// Wait for anonymous auth to resolve the uid, or return whatever getUid()
// says at the deadline (null when auth never settled). Polls because
// initAnonymousAuth is fire-and-forget from init(), there is no promise
// to await directly. Anonymous auth typically completes in <500 ms, but a
// cold reload (e.g. right after a service-worker auto-reload from a new
// deploy) can race consumers like the gate's reconcile step or the Stats
// modal's owner check. (Consolidates main.js's two former near-identical
// pollers into one.)
export async function waitForUid(timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const uid = getUid();
    if (uid) return uid;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return getUid();
}

// Wait for `firebase.initializeApp()` to have run. initFirebase() was
// kicked off before runStartupGate; this just polls for completion.
// Returns true on Firebase ready, false on timeout (offline mode).
// A known-offline boot gives up on Firebase early instead of serving the
// player eight seconds of "Connecting…" for a connection that cannot happen
// (2026-08-07, his airplane-mode report). Measured, an offline boot sat 19.5s
// on the overlay; gating the canonical retries took it to 8.0s and this takes
// the rest.
//
// navigator.onLine is only trusted in the NEGATIVE direction, false means
// there is definitely no network, while true promises nothing. So it is used
// solely to shorten the wait, never to skip a wait that might have succeeded.
// The connection is still attempted, because the SDK can initialize from a
// warm HTTP cache and a stale onLine reading should not cost the player their
// cloud sync; it just is not waited on for as long.
const OFFLINE_FIREBASE_WAIT_MS = 1200;

async function _waitForFirebaseInit(timeoutMs = 8000) {
  const budget = navigator.onLine === false
    ? Math.min(timeoutMs, OFFLINE_FIREBASE_WAIT_MS)
    : timeoutMs;
  const startedAt = Date.now();
  while (Date.now() - startedAt < budget) {
    if (typeof firebase !== 'undefined' && firebase.apps?.length) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
