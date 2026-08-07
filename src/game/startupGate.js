// ── Startup gate + boot plumbing ──────────────────────
// Extracted from main.js (2026-07-10 split). Render nothing user-interactive
// until three preconditions hold:
//   1. The SW is up to date (or we've waited long enough — a stale
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
import { loadDailyBoard } from '../firebase/dailyBoardSync.js';
import { loadWeeklyBoard } from '../firebase/weeklyBoardSync.js';
import { pruneOldCachedBoards } from '../firebase/boardCache.js';
import {
  getUid, loadWeeklyAttempts, loadLocalWeeklyAttempts,
  replaceLocalWeeklyAttempts, pruneStaleLocalWeeklyAttempts,
} from '../firebase/firebaseProgress.js';
import { isDailyCompleted, markDailyCompleted, clearGameState, pruneOldDailyKeys } from '../storage/statsStorage.js';
import { planCompletionReconcile } from '../logic/startupReconcilePlan.js';
import { safeGet, safeSet, safeRemove } from '../storage/storageAdapter.js';
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
// index.html <head> reloads the page — the new code restarts the gate
// from scratch, so we just need to give it time to fire. If no update
// is found within timeoutMs, we proceed with the current bundle.
async function ensureLatestServiceWorker(timeoutMs = 3000) {
  if (!('serviceWorker' in navigator)) return;
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
        // controllerchange didn't fire — iOS may have already swapped
        // the controller before we attached the listener. Force a
        // single reload so the new SW takes over our page state.
        if (!sessionStorage.getItem('_gs_skip_force_reload')) {
          sessionStorage.setItem('_gs_skip_force_reload', '1');
          window.location.reload();
          return; // navigation pre-empts resolve
        }
        sessionStorage.removeItem('_gs_skip_force_reload');
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
        // Successful check (even "no update found") — reset the counter.
        if (navigator.onLine) safeSet(SW_UPDATE_FAIL_KEY, '0');
      },
      (err) => {
        // The update CHECK failed — the exact failure that left
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
// How hard the gate tries for today's canonical before letting the daily fall
// back to local generation. Linear backoff, so the worst case adds about a
// second and a half to a boot that was already failing its first read — paid
// only when the read comes back empty, never on the normal path.
const CANONICAL_RETRIES = 2;
const CANONICAL_RETRY_DELAY_MS = 500;

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
  // (offline) mode — score submission is already gated on
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
  // Same for the per-date daily par/moves/features keys — one trio per
  // played date forever would eventually trip the quota and silently
  // downgrade storage to the in-memory fallback.
  pruneOldDailyKeys();

  if (firebaseReady && !customSeed) {
    setBootStatus('Loading today\'s puzzle…');
    try {
      // Test branch: skip the Firebase weekly-attempts read too so an
      // existing master attempt doesn't get pulled in and gate test.
      // loadDailyBoard/loadWeeklyBoard are designed to throw nothing, so
      // these catches fire only on a real bug — worth a report, and the
      // null fallback keeps the gate degrading gracefully either way.
      const weeklyAttemptsP = isTestEnvironment()
        ? Promise.resolve({})
        : loadWeeklyAttempts(currentWeek).catch(err => { reportCaughtError('gate-weekly-attempts', err); return null; });
      const [dailyRaw, weeklyRaw, attempts] = await Promise.all([
        loadDailyBoard(today).catch(err => { reportCaughtError('gate-daily-board', err); return null; }),
        loadWeeklyBoard(currentWeek).catch(err => { reportCaughtError('gate-weekly-board', err); return null; }),
        weeklyAttemptsP,
      ]);
      if (dailyRaw) {
        state.canonicalDailyBoard = { date: today, raw: dailyRaw };
      } else {
        // ONE read is not enough to conclude the canonical is unavailable
        // (2026-08-07, his ask: the app should open only once it has the
        // board). Falling through to local generation is not a graceful
        // degradation for a daily — it is near-certain DIVERGENCE. The
        // canonical is precomputed up to seven days ahead against the
        // experiment target of that moment, and the nightly refit rewrites
        // that file underneath it, so a client re-deriving the day's board
        // locally is choosing from a differently-sized candidate pool and
        // lands on another trial almost every time. That is how one player
        // spent 2026-08-06 on `:trial6` while the day's board was
        // `:trial13`.
        //
        // Firebase is READY here, so this is a slow or dropped read rather
        // than an offline client — worth a short retry before accepting a
        // board nobody else is playing. A genuinely offline player still
        // gets the local fallback, which is what keeps the game playable on
        // a plane; they simply will not be ranked (the submit path refuses
        // a divergent row).
        for (let attempt = 1; attempt <= CANONICAL_RETRIES && !state.canonicalDailyBoard; attempt++) {
          setBootStatus('Fetching today\'s board…');
          await new Promise(r => setTimeout(r, CANONICAL_RETRY_DELAY_MS * attempt));
          const retryRaw = await loadDailyBoard(today)
            .catch(err => { reportCaughtError('gate-daily-board-retry', err); return null; });
          if (retryRaw) state.canonicalDailyBoard = { date: today, raw: retryRaw };
        }
      }
      if (weeklyRaw) {
        state.canonicalWeeklyBoard = { weekStart: currentWeek, raw: weeklyRaw };
      }
      // A successful Firebase read is AUTHORITATIVE for the week (a map,
      // possibly empty). Replacing — not merging over — the localStorage
      // seed is what lets an admin-side reset / cloud deletion actually
      // propagate to the player instead of being masked by a stale local
      // copy. Mirror it back to localStorage so the next boot's
      // synchronous seed agrees and a deleted day stays deleted. A null
      // result means the read could not be completed (offline / not
      // signed in / timed out) — keep the localStorage seed set above.
      if (attempts) {
        state.cachedWeeklyDayAttempts = attempts;
        if (!isTestEnvironment()) replaceLocalWeeklyAttempts(currentWeek, attempts);
      }
    } catch (err) {
      console.warn('startup gate: pre-fetch failed:', err.message);
    }
  }

  // Completion ↔ cloud reconciliation (one read, both directions).
  // "Completed today" is a per-ACCOUNT fact; the localStorage flag is
  // just this device's cache of it. Two ways they can disagree:
  //
  //  - Local flag SET, cloud row DIVERGENT (different rngSeed than the
  //    canonical): the player completed a wrong board (cold-load race,
  //    pre-canonical client). Clear the flag + cached par/moves so they
  //    can play the real canonical. Only a POSITIVELY divergent row
  //    clears — a missing row (uid mismatch, network race, offline
  //    submission) trusts the local flag; an earlier version cleared on
  //    missing-score and let raced lookups unlock replays.
  //
  //  - Local flag UNSET, cloud row MATCHING the canonical: this account
  //    already completed today's board on ANOTHER device. Adopt the
  //    completion locally (mark + drop any in-progress daily save) so
  //    the Daily card reads "Completed!" and the player can't finish
  //    the same board twice and double-submit. Adoption requires an
  //    explicit effective-seed match — a divergent row must NOT lock
  //    the player out of the canonical (that is exactly what the clear
  //    branch unlocks). The submission-level dedupe in
  //    firebaseLeaderboard backs this up for mid-session races the
  //    boot check can't see.
  //
  // Test env: skipped entirely — isDailyCompleted/markDailyCompleted
  // are no-ops there, and clearGameState would touch localStorage
  // shared with the production origin.
  if (firebaseReady && !customSeed && !isTestEnvironment()) {
    const canonicalSeed = state.canonicalDailyBoard?.raw?.rngSeed || null;
    if (canonicalSeed) {
      setBootStatus('Verifying today\'s play…');
      const myUid = await waitForUid(3000);
      if (myUid) {
        try {
          const snap = await firebase.database().ref(`daily/${today}`).once('value');
          const rows = snap.val();
          const { action } = planCompletionReconcile({
            rows, uid: myUid, dateString: today, canonicalSeed,
            localCompleted: isDailyCompleted(today),
          });
          if (action === 'clearLocal') {
            // Confirmed divergent — clear the completion flag plus the
            // cached par/moves so newGame recomputes them against the
            // canonical layout. Don't touch streak fields; replaying
            // maintains the streak via lastDailyDate === today.
            safeRemove('minesweeper_daily_completed_date');
            safeRemove('minesweeper_daily_par_' + today);
            safeRemove('minesweeper_daily_moves_' + today);
          } else if (action === 'adoptCompletion') {
            // Completed on another device — adopt. Any in-progress local
            // attempt is moot; first completion wins.
            markDailyCompleted(today);
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
// initAnonymousAuth is fire-and-forget from init() — there is no promise
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
async function _waitForFirebaseInit(timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (typeof firebase !== 'undefined' && firebase.apps?.length) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
