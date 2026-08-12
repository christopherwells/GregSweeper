import { safeGet, safeSet, safeRemove, safeGetJSON, safeSetJSON } from '../storage/storageAdapter.js';
import { isTestEnvironment } from './env.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import { planScoreSubmission, canonicalSeedPath } from '../logic/submitGate.js';
import { isBombHitCheat } from '../logic/difficulty.js';
import { attributePlayedDate } from '../logic/archiveEligibility.js';
import { etDateStringOfMs } from '../logic/seededRandom.js';
/**
 * Firebase Online Daily Leaderboard
 * Uses Firebase Realtime Database (compat SDK loaded via CDN in index.html).
 * Falls back to localStorage when offline or Firebase unavailable.
 */

let firebaseReady = false;
let db = null;

// playerNames/{uid} → name join cache. Every leaderboard resolves each row's
// DISPLAY name by uid (resolveDisplayName), so a name change in Settings shows
// on every past record instantly, the row's own stored name is only a
// fallback for rows with no uid (join-at-read; see the Settings/name-gate
// publishPlayerName writers). Cached briefly so rapid leaderboard tab-switches
// don't re-read the whole node each time.
let _playerNamesCache = null;
let _playerNamesCacheAt = 0;
const PLAYER_NAMES_TTL_MS = 60000;

// Client-side rate limiting: one clock PER submission path. A single shared
// clock let a timed (Quick Play) win suppress a daily/weekly_first submission
// landing within the cooldown window (issue #89), the paths look independent
// to the player, so one must never burn the other's clock.
//
// EVERY path must appear in this literal. `_submitCooldownOk` reads
// `_lastSubmitByKind[kind] || 0`, so an unregistered kind is not rate-limited
// at all. It is always permitted, and a reader of the call site cannot tell
// that from a limit that is working.
const _lastSubmitByKind = { daily: 0, archive: 0, timed: 0, match: 0 };
const SUBMIT_COOLDOWN_MS = 30000; // 30 seconds between submissions per path

// Exported for the #89 regression pin: the per-path clocks are independent.
export function _submitCooldownOk(kind, now = Date.now()) {
  return now - (_lastSubmitByKind[kind] || 0) >= SUBMIT_COOLDOWN_MS;
}
export function _stampSubmitCooldown(kind, now = Date.now()) {
  _lastSubmitByKind[kind] = now;
}

// Pure identity re-stamp for queued submissions (issue #132), exported for
// tests. The uid frozen at enqueue time is replaced with the uid the device
// is signed in as at FLUSH time, after an account-link switch the old uid
// fails the `uid === auth.uid` write rule forever, so identity must resolve
// at flush, not at enqueue.
export function restampPendingEntry(entry, uid) {
  return { ...entry, extras: { ...(entry.extras || {}), uid } };
}
export function restampPendingWeeklyEntry(entry, uid) {
  return { ...entry, uid };
}

// Firebase App Check (abuse protection). The site key is public by design
// (like the VAPID key in firebasePush.js); it pairs with the App Check
// registration in the Firebase console (App Check → register the web app
// with a reCAPTCHA provider) and paste the site key here. Empty string =
// App Check off, activation no-ops. APP_CHECK_PROVIDER must match the
// console registration: 'v3' (classic reCAPTCHA v3 key) or 'enterprise'
// (reCAPTCHA Enterprise key).
//
// Why this exists: the Firebase config above ships to every browser, so a
// rehosted copy of the site works against this database from any origin
// (anonymous auth is not gated by authorized domains). App Check tokens
// attest that traffic comes from the real app. Activation only ATTACHES
// tokens, nothing is rejected until enforcement is turned on in the
// console, and enforcement must wait until stale service-worker clients
// (which lack this code) have cycled onto a build that includes it.
const APP_CHECK_SITE_KEY = '6Lc6jUctAAAAACH5c0o-uBd5P88EBebd3mKUyeXU';
const APP_CHECK_PROVIDER = 'enterprise';

// Score validation bounds
const MIN_VALID_TIME = 5;    // seconds, anything faster is impossible
const MAX_VALID_TIME = 3600; // seconds, 1 hour cap

// Retry queue for failed submissions. When a submit fails (offline,
// auth-race, transient Firebase error, or post-rules-deploy rejection on
// a stale client), queue the payload to localStorage. Flushed from
// initFirebase() on every successful boot.
const PENDING_KEY = 'minesweeper_pending_daily_submissions';
const PENDING_WEEKLY_KEY = 'minesweeper_pending_weekly_submissions';
const PENDING_MAX_ENTRIES = 10;                   // Drop oldest beyond this
// 14 days / 6 attempts (was 7 / 3). flushPending* only runs while online,
// so attempts increment only on real online tries, but on persistently
// bad service a player can burn several boots before reconnecting. The
// wider window is what lets a score queued on flaky service still recover
// when the player finally gets signal days later, instead of aging out.
const PENDING_MAX_AGE_MS = 14 * 24 * 3600 * 1000; // 14 days, older entries are stale
const PENDING_MAX_ATTEMPTS = 6;                   // Give up after N flushes per entry

function _queueFailedSubmission(dateString, name, time, bombHits, extras) {
  try {
    const pending = safeGetJSON(PENDING_KEY) || [];
    pending.push({
      dateString,
      name,
      time,
      bombHits,
      extras: extras || {},
      queuedAt: Date.now(),
      attempts: 0,
    });
    while (pending.length > PENDING_MAX_ENTRIES) pending.shift();
    safeSetJSON(PENDING_KEY, pending);
  } catch (err) {
    console.warn('Could not queue pending submission:', err.message);
  }
}

/**
 * Initialize Firebase. Call once on app startup.
 * Config should be replaced with user's own Firebase project config.
 */
export async function initFirebase() {
  try {
    // Check if Firebase SDK is available (loaded via CDN)
    if (typeof firebase === 'undefined' || !firebase.initializeApp) {
      console.log('Firebase SDK not loaded, leaderboard will be local-only');
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

    activateAppCheck();

    db = firebase.database();

    // Test connectivity with a quick read
    try {
      await Promise.race([
        db.ref('.info/connected').once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connection timeout')), 5000)),
      ]);
    } catch (connErr) {
      console.warn('Firebase connected but database may be unreachable:', connErr.message);
      // Still mark as ready, individual operations have their own timeouts
    }

    firebaseReady = true;
    console.log('Firebase leaderboard initialized');
    // Catch up on any queued failed submissions from prior offline / auth-race sessions
    flushPendingSubmissions().catch(err => reportCaughtError('flush-pending-daily', err));
    flushPendingWeeklySubmissions().catch(err => reportCaughtError('flush-pending-weekly', err));
  } catch (err) {
    console.warn('Firebase init failed, using local leaderboard:', err.message);
    if (err.message?.includes('permission')) {
      console.warn('Hint: Check Firebase Realtime Database Security Rules in the Firebase Console.');
      console.warn('For testing, set rules to: { ".read": true, ".write": true }');
    }
    firebaseReady = false;
  }
}

/**
 * Activate Firebase App Check (see APP_CHECK_SITE_KEY above). Called from
 * initFirebase() right after initializeApp, before any database handle is
 * created, so every subsequent request carries a token. Skipped on the
 * test build and local dev: neither is on the reCAPTCHA key's domain
 * allowlist, and their traffic must not count against the production
 * verified/unverified metrics that gate the enforcement decision.
 * (When enforcement ships, local dev switches to the App Check debug
 * provider with a debug token, not needed in monitor mode.)
 */
function activateAppCheck() {
  if (!APP_CHECK_SITE_KEY) return;
  if (isTestEnvironment()) return;
  if (typeof location !== 'undefined' &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  if (typeof firebase.appCheck !== 'function') return; // CDN script didn't load
  try {
    const provider = APP_CHECK_PROVIDER === 'enterprise'
      ? new firebase.appCheck.ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY)
      : APP_CHECK_SITE_KEY; // string key = reCAPTCHA v3 provider (compat shorthand)
    firebase.appCheck().activate(provider, /* isTokenAutoRefreshEnabled */ true);
  } catch (err) {
    // Activation failure must never take down the leaderboard init,
    // in monitor mode an unattested client still works.
    reportCaughtError('app-check-activate', err);
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
 *
 * Board features for the date are uploaded separately to `dailyMeta/{date}`
 * (write-once), because every player on a given date gets the same board and
 * denormalising features into every per-player score push would waste space
 * and complicate the R join for the offline refit.
 *
 * @param {string} dateString YYYY-MM-DD format
 * @param {string} name Player name (max 20 chars)
 * @param {number} time Completion time in seconds
 * @param {number} bombHits Number of bomb hits (daily mode strikes)
 * @param {Object} [extras]
 * @param {string} [extras.uid] Stable anonymous uid for per-user analysis
 * @param {number} [extras.par] Predicted par at play time (for R diagnostics)
 * @param {Object} [extras.features] Board feature vector for dailyMeta upsert
 * @returns {Promise<boolean>} true if submitted successfully
 */
/**
 * Internal: push the score to Firebase. No rate limiting. Returns true
 * on success, false on any validation/network/auth failure. Shared by
 * submitOnlineScore (with rate limit + queueing) and flushPendingSubmissions
 * (bypasses rate limit because queue entries are legitimate prior attempts,
 * not user spam).
 */
async function _doSubmitOnlineScore(dateString, name, time, bombHits, extras) {
  if (!isFirebaseOnline()) return false;

  if (typeof time !== 'number' || time < MIN_VALID_TIME || time > MAX_VALID_TIME) {
    console.warn(`Score rejected: time ${time}s is outside valid range (${MIN_VALID_TIME}-${MAX_VALID_TIME}s)`);
    return false;
  }

  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;

    const payload = {
      name: sanitizedName,
      time,
      bombHits,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    };
    if (extras.uid) payload.uid = String(extras.uid);
    if (typeof extras.par === 'number') payload.par = extras.par;
    // Per-hit event log: [{ t, row, col, penalty?, infoValue? }, ...].
    // - v1.5.9+ plays carry { t, row, col }.
    // - v1.5.149+ plays (new info-value bomb mechanic) additionally
    //   carry `penalty` and `infoValue`. The R refit treats events
    //   without a `penalty` field as the legacy +10s/re-fog cohort.
    // Denormalised `totalBombPenalty` is the sum of per-hit penalties on
    // the row, so the R-side `clean_time = time - totalBombPenalty`
    // subtraction is a single column read instead of an unnest.
    if (Array.isArray(extras.bombHitEvents) && extras.bombHitEvents.length > 0) {
      payload.bombHitEvents = extras.bombHitEvents;
      let totalPenalty = 0;
      for (const e of extras.bombHitEvents) {
        if (e && typeof e.penalty === 'number') totalPenalty += e.penalty;
      }
      if (totalPenalty > 0) {
        payload.totalBombPenalty = Math.round(totalPenalty * 10) / 10;
      }
    }
    // Lens invocations: [{ t, kind }] with kind 'flag-warning' | 'region'.
    // Worm hatch log: [{ t, r, c, len, life, pace, moves, tEnd? }], one
    // per hatched egg, traits embedded (the refit never reimplements the
    // seeded RNG), `moves` = exact realized move count. The refit fits on
    // the REALIZED worm dose (Σ len × moves / 100), because the scheduled
    // wormLoad overstates what a fast or late-hatching run experienced.
    // Only attached when worms hatched, so worm-free rows are unchanged.
    if (Array.isArray(extras.wormEvents) && extras.wormEvents.length > 0) {
      payload.wormEvents = extras.wormEvents;
    }
    // Effective RNG seed used for this daily's generation. Equal to the
    // dateString on non-experiment days, a `:trialN` variant on
    // adaptive-experiment days (see experimentDesign.js). Stored so
    // the R refit can reproduce the exact board offline if it ever
    // needs to recompute features or solver move-type counts.
    if (typeof extras.rngSeed === 'string' && extras.rngSeed !== dateString) {
      payload.rngSeed = extras.rngSeed;
    }

    // Two questions stand between this run and a leaderboard row, and the
    // answers are in the pure logic/submitGate.js so they can be TESTED rather
    // than grepped (the guard shipped 2026-08-07 with 22 source-scan assertions
    // and no execution of its own logic):
    //
    //   DEDUPE, one row per (player, board). Matching is per BOARD, not per
    //   uid (scoreRowMatch.js), so a practice (?seed=) row can never block the
    //   real daily and a player with a divergent historical row can still land
    //   their canonical replay.
    //
    //   DIVERGENCE, a score set on a board that was not the day's canonical
    //   never reaches the leaderboard. Their client missed the canonical and
    //   generated locally, which the precompute horizon makes near-certain
    //   rather than unlucky: the board is written up to seven days ahead and
    //   the nightly refit rewrites the experiment target underneath it, so a
    //   client re-deriving picks from a differently-sized candidate pool. One
    //   player's 2026-08-06 row sat on `:trial6` against a `:trial13`
    //   canonical. The DAY still counts, the caller writes dailyHistory
    //   regardless, which is what streaks read; only the leaderboard, which
    //   compares people on one board, refuses it.
    //
    // Both reads feed ONE pure decision (logic/submitGate.js). Each is
    // independently try/caught so an outage on either surfaces as `null`,
    // "unavailable", never "mismatch", and the gate falls open. That is the
    // property that matters: dropping real scores whenever Firebase hiccups
    // would be far worse than the bad row either guard prevents.
    const playedSeed = typeof extras.rngSeed === 'string' ? extras.rngSeed : dateString;
    let existingRows = null;
    if (extras.uid) {
      try {
        existingRows = (await db.ref(`daily/${dateString}`).once('value')).val();
      } catch { /* read failed, nothing blocks the push */ }
    }
    // A null path means this bucket has no canonical to diverge from (a match
    // board; see canonicalSeedPath). Skip the read rather than making one whose
    // answer is null by construction and could only ever no-op the check.
    let canonicalSeed = null;
    const seedPath = canonicalSeedPath(dateString);
    if (seedPath) {
      try {
        canonicalSeed = (await db.ref(seedPath).once('value')).val();
      } catch { /* read failed, proceed with the push */ }
    }

    const { verdict } = planScoreSubmission({
      rows: existingRows, uid: extras.uid || null,
      bucketKey: dateString, playedSeed, canonicalSeed,
    });
    if (verdict !== 'proceed') return verdict;

    const ref = db.ref(`daily/${dateString}`);
    await ref.push(payload);

    // Fire-and-forget meta upload. Don't block the score submission if the
    // meta write fails or is rejected (e.g. write-once rule when another
    // client already uploaded it for today).
    if (extras.features && typeof extras.features === 'object') {
      // PERMISSION_DENIED is the EXPECTED write-once rejection when another
      // client already wrote today's meta, only unexpected failures report.
      upsertDailyMeta(dateString, extras.features).catch(err => {
        const msg = String((err && err.code) || (err && err.message) || '');
        if (!/permission[ _]?denied/i.test(msg)) reportCaughtError('daily-meta-upsert', err);
      });
    }

    return true;
  } catch (err) {
    console.warn('Firebase submit failed:', err.message);
    return false;
  }
}

export async function submitOnlineScore(dateString, name, time, bombHits = 0, extras = {}) {
  // Test branch: never write to the production leaderboard. Reads
  // (fetchOnlineLeaderboard) still work so the modal still shows
  // current standings, but no test score lands in the bucket.
  if (isTestEnvironment()) return false;
  // Anti-cheat: a run that found most of the board's mines by stepping on them
  // was probing the layout, not playing (see isBombHitCheat for the two arms
  // and why a bare fraction was not enough), never leaderboard it, and never
  // queue it for retry. Returns 'cheat' (not false) so the wrapper's
  // failure-queue path is skipped. The caller still records the DAY.
  // Daily/weekly_first only; gimmick-free
  // modes pass totalMines too but bombHits is 0, so this never trips.
  if (isBombHitCheat(bombHits, extras.totalMines)) return 'cheat';
  // Offline / Firebase not ready, queue and retry on next successful boot
  if (!isFirebaseOnline()) {
    _queueFailedSubmission(dateString, name, time, bombHits, extras);
    return false;
  }

  // Client-side rate limiting. Within-cooldown is usually spam, but a REAL
  // first submission can land here too, so QUEUE it instead of dropping
  // (issue #89: a cooldown hit used to discard the score permanently). The
  // flush dedupes per (uid, board), so a spam retry resolves 'duplicate'
  // instead of double-rowing.
  const now = Date.now();
  if (!_submitCooldownOk('daily', now)) {
    console.warn('Score submission rate-limited, queued for retry');
    _queueFailedSubmission(dateString, name, time, bombHits, extras);
    return false;
  }

  // Three-way outcome: true (pushed), false (failed, queued for retry),
  // 'duplicate' (this account already has a row for this exact board,
  // definitive, not queued, no cooldown burned).
  const ok = await _doSubmitOnlineScore(dateString, name, time, bombHits, extras);
  if (ok === true) {
    _stampSubmitCooldown('daily', now);
  } else if (ok === false) {
    // Push failed mid-flight (transient network, auth race, or post-deploy
    // rule rejection on a stale client). Queue for retry.
    _queueFailedSubmission(dateString, name, time, bombHits, extras);
  }
  return ok;
}

/**
 * Build the `dailyArchive/{date}` row payload. Extracted from
 * submitArchiveScore so the data contract (the exact fields the dailyArchive
 * rules require and allow) is unit-testable without a live Firebase: a dropped
 * `archivePlay` or a stray field would otherwise only surface as a silent
 * rules rejection on a real write. `timestamp` is passed in (the caller
 * supplies firebase.database.ServerValue.TIMESTAMP) so this stays pure.
 * Assumes `name` is already non-empty.
 *
 * @param {string} date YYYY-MM-DD of the replayed board
 * @param {string} name sanitized player name
 * @param {number} time completion seconds
 * @param {number} bombHits strike count
 * @param {Object} extras { uid, par, cruxViewed, bombHitEvents, rngSeed }
 * @param {*} timestamp the server timestamp sentinel
 * @returns {Object} the payload to push
 */
export function buildArchivePayload(date, name, time, bombHits, extras = {}, timestamp) {
  const payload = {
    name: String(name).slice(0, 20).trim(),
    time,
    bombHits,
    archivePlay: true,
    timestamp,
  };
  if (extras.uid) payload.uid = String(extras.uid);
  if (typeof extras.par === 'number') payload.par = extras.par;
  // Set by PR 4's `?crux=` route (localStorage flag). The refit drops archive
  // rows for a date whose crux the player saw (previewing changes the time).
  if (extras.cruxViewed === true) payload.cruxViewed = true;
  if (Array.isArray(extras.bombHitEvents) && extras.bombHitEvents.length > 0) {
    payload.bombHitEvents = extras.bombHitEvents;
    let totalPenalty = 0;
    for (const e of extras.bombHitEvents) {
      if (e && typeof e.penalty === 'number') totalPenalty += e.penalty;
    }
    if (totalPenalty > 0) payload.totalBombPenalty = Math.round(totalPenalty * 10) / 10;
  }
  if (Array.isArray(extras.wormEvents) && extras.wormEvents.length > 0) {
    payload.wormEvents = extras.wormEvents;
  }
  // Archive boards are PAST dates, so the effective seed routinely differs
  // from `date` (the daily flips `:trialN` on experiment days). Store it only
  // when it differs so the refit can reproduce the exact board.
  if (typeof extras.rngSeed === 'string' && extras.rngSeed !== date) {
    payload.rngSeed = extras.rngSeed;
  }
  return payload;
}

/**
 * Submit an archive replay of a PAST daily to `dailyArchive/{date}/{pushId}`.
 *
 * Separate from `daily/` by design: the live day-of leaderboard never shows
 * replay rows (an old cached client reading `daily/` never sees them),
 * so the leaderboard stays day-of by construction. These rows feed the
 * par-model fit as nuisance-corrected data: the R refit binds them with an
 * `archive = 1` marker and an `archivePlay` fixed effect that absorbs any
 * systematic late-play offset and never ships in PAR_MODEL.
 *
 * First-completion dedup is the CALLER's job (it submits only when the player
 * has no dailyHistory row for the date yet), so this is a plain push with no
 * per-board read. Fire-and-forget like submitTimedScore: a lost archive row
 * is statistically replaceable, so there is no retry queue.
 *
 * @param {string} date YYYY-MM-DD (ET) of the replayed board
 * @param {string} name player name (max 20 chars)
 * @param {number} time completion time in seconds
 * @param {number} bombHits strike count
 * @param {Object} extras { uid, par, features, bombHitEvents, rngSeed, cruxViewed }
 * @returns {Promise<boolean>}
 */
export async function submitArchiveScore(date, name, time, bombHits = 0, extras = {}) {
  if (isTestEnvironment()) return false;
  // Anti-cheat: same probing guard as the live daily, a mine-popping run
  // never feeds the par fit either (dailyArchive rows are nuisance-corrected
  // fit data).
  if (isBombHitCheat(bombHits, extras.totalMines)) return false;
  if (!isFirebaseOnline()) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (typeof time !== 'number' || time < MIN_VALID_TIME || time > MAX_VALID_TIME) return false;

  const now = Date.now();
  if (!_submitCooldownOk('archive', now)) return false;

  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;

    const payload = buildArchivePayload(date, sanitizedName, time, bombHits, extras,
      firebase.database.ServerValue.TIMESTAMP);

    await db.ref(`dailyArchive/${date}`).push(payload);
    _stampSubmitCooldown('archive', now);

    // Ensure the date's feature meta exists so the archive row can join the
    // fit. Archive dates were canonical, so meta usually already exists
    // (write-once makes this a no-op); only a gap gets filled.
    if (extras.features && typeof extras.features === 'object') {
      upsertDailyMeta(date, extras.features).catch(err => {
        const msg = String((err && err.code) || (err && err.message) || '');
        if (!/permission[ _]?denied/i.test(msg)) reportCaughtError('archive-meta-upsert', err);
      });
    }

    return true;
  } catch (err) {
    console.warn('Archive score submission failed:', err && err.message);
    return false;
  }
}

/**
 * Submit a finished Challenge match's boards as par-fit rows.
 *
 * One row per cleared board, into the SAME `daily/*` + `dailyMeta/*` tables
 * the refit reads, keyed `match_<hash>` off the board's own seed
 * (logic/matchCodes.matchRowKey). The weekly's first attempt already lands in
 * those tables under its own suffix; this is that pattern with a key that
 * identifies a BOARD instead of a date, which is what lets the same library
 * board pool rows across matches and hosts.
 *
 * BATCHED, and the batch is the reason this is not a loop over
 * submitOnlineScore. A ten-board match produces ten rows at one moment, and
 * the 30-second per-path cooldown would queue nine of them for a later boot.
 * The cooldown's job is to stop a player spamming one submission path, so the
 * MATCH is the right unit: one check and one stamp for the whole run, with
 * each row pushed through the un-rate-limited core the retry flush uses.
 *
 * Fire-and-forget per row: a failed push queues for the next boot through the
 * same pending queue every daily row uses, and the flush restamps the uid.
 *
 * @param {Array<object>} rows from logic/matchStandings.matchFitRows
 * @param {string} name  the player's leaderboard name
 * @param {string} uid
 * @returns {Promise<{submitted: number, refused: number}>}
 */
export async function submitMatchFitRows(rows, name, uid) {
  const out = { submitted: 0, refused: 0 };
  if (isTestEnvironment()) return out;
  if (!Array.isArray(rows) || rows.length === 0) return out;
  const sanitizedName = String(name || '').slice(0, 20).trim();
  if (!sanitizedName || !uid) return out;

  const now = Date.now();
  if (!_submitCooldownOk('match', now)) return out;
  _stampSubmitCooldown('match', now);

  for (const row of rows) {
    // The daily's own probing guard, per board: match strikes ride the daily
    // frame, so a run that found most of a board's mines by stepping on them
    // is refused here for the same reason it is there. The board still counts
    // for the player and the match; only the fit row is refused.
    if (isBombHitCheat(row.bombHits, row.totalMines)) { out.refused++; continue; }
    const extras = {
      uid,
      par: row.par,
      features: row.features,
      bombHitEvents: row.bombHitEvents,
      wormEvents: row.wormEvents,
      totalMines: row.totalMines,
      // A match board's seed IS its bucket key's source, so a row never needs
      // an rngSeed to say which board it was: the key already does.
    };
    if (!isFirebaseOnline()) {
      _queueFailedSubmission(row.key, sanitizedName, row.time, row.bombHits, extras);
      continue;
    }
    const ok = await _doSubmitOnlineScore(row.key, sanitizedName, row.time, row.bombHits, extras);
    if (ok === true) out.submitted++;
    else if (ok === false) _queueFailedSubmission(row.key, sanitizedName, row.time, row.bombHits, extras);
  }
  return out;
}

/**
 * Submit a timed-mode run to `timed/{pushId}`. Unlike daily, every timed
 * board is unique, so the feature vector rides the row itself (there is
 * no per-date meta bucket to join against). These rows are fit-data
 * first, leaderboard later: the R refit starts using them via a
 * modeTimed effect once >= 20 rows exist (same threshold pattern as new
 * feature coefficients). Fire-and-forget, no retry queue; timed runs
 * are frequent and a lost row is statistically replaceable.
 *
 * @param {string} name Player name
 * @param {number} time Completion time in seconds
 * @param {number} level Difficulty tab (1-4: Beginner..Extreme)
 * @param {Object} extras { uid, par, features }
 * @returns {Promise<boolean>}
 */
export async function submitTimedScore(name, time, level, extras = {}) {
  if (isTestEnvironment()) return false;
  if (!isFirebaseOnline()) return false;
  if (typeof time !== 'number' || time < MIN_VALID_TIME || time > MAX_VALID_TIME) return false;

  const now = Date.now();
  if (!_submitCooldownOk('timed', now)) return false;

  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;
    const payload = {
      name: sanitizedName,
      time,
      level: typeof level === 'number' ? level : 0,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    };
    if (extras.uid) payload.uid = String(extras.uid);
    if (typeof extras.par === 'number' && extras.par > 0) payload.par = extras.par;
    if (extras.features && typeof extras.features === 'object') {
      payload.features = extras.features;
    }
    await db.ref('timed').push(payload);
    _stampSubmitCooldown('timed', now);
    return true;
  } catch (err) {
    console.warn('Timed score submission failed:', err && err.message);
    return false;
  }
}

/**
 * Resubmit any queued failed score writes. Called by initFirebase() on every
 * successful boot. Bypasses SUBMIT_COOLDOWN_MS, queue entries are legitimate
 * prior submissions, not user spam. Drops entries older than PENDING_MAX_AGE_MS
 * or that have hit PENDING_MAX_ATTEMPTS.
 */
export async function flushPendingSubmissions() {
  // Never write prod scores from a test session, the pending queue lives in
  // localStorage, shared across the master/test github.io origin, so a score
  // queued on master must not flush while the test build is open.
  if (isTestEnvironment()) return;
  if (!isFirebaseOnline()) return;
  let pending;
  try {
    pending = safeGetJSON(PENDING_KEY);
  } catch (err) {
    console.warn('Could not read pending submissions:', err.message);
    return;
  }
  if (!Array.isArray(pending) || pending.length === 0) return;

  // Issue #132: identity resolves at FLUSH time, not enqueue time. The queue
  // used to carry the uid frozen when the submit failed; an account-link
  // switch then made every retry fail the `uid === auth.uid` rule until the
  // entry aged out. The queued score belongs to whoever is signed in on this
  // device NOW. No uid yet (auth still settling) → leave the queue untouched
  // for a later flush instead of burning attempts on writes the rules reject.
  let currentUid = null;
  try {
    const { getUid } = await import('./firebaseProgress.js');
    currentUid = getUid();
  } catch { /* progress module unavailable, treat as auth-not-settled */ }
  if (!currentUid) return;

  const stillPending = [];
  const now = Date.now();
  let flushed = 0;
  for (const raw of pending) {
    if (now - raw.queuedAt > PENDING_MAX_AGE_MS) continue;
    if (raw.attempts >= PENDING_MAX_ATTEMPTS) continue;
    raw.attempts++;
    const entry = restampPendingEntry(raw, currentUid);
    const ok = await _doSubmitOnlineScore(
      entry.dateString,
      entry.name,
      entry.time,
      entry.bombHits,
      entry.extras || {}
    );
    // 'duplicate' resolves the entry too: the score is already on the
    // board (the original push landed, or another device submitted
    // while this one was offline), retrying would only re-read.
    if (ok) flushed++;
    else stillPending.push(entry);
  }
  try {
    safeSetJSON(PENDING_KEY, stillPending);
  } catch (err) {
    console.warn('Could not save pending submissions:', err.message);
  }
  if (flushed > 0) {
    console.log(`Re-submitted ${flushed} pending daily score(s) after reconnect.`);
  }
}

/**
 * Submit the player's weekly result to `weekly/{weekStart}/{uid}`.
 * Writes per-day data via `update` and bestTime via a transaction, so
 * each day's entry is additive and never clobbers prior days even if
 * the pre-fetch of existing data failed.
 *
 * Caller passes only today's {day: time} entry and a local bestTime
 * candidate. The transaction ensures server-side bestTime only decreases.
 *
 * @param {string} weekStart 'YYYY-MM-DD' Monday in ET
 * @param {string} uid stable anonymous uid
 * @param {string} name player name (max 20 chars)
 * @param {number} bestTime local best-time candidate (seconds)
 * @param {Object<number, number>} dayTimes today's entry, e.g. {2: 50.1}
 * @returns {Promise<boolean>}
 */
export async function submitWeeklyScore(weekStart, uid, name, bestTime, dayTimes, extras = {}) {
  // Test branch: don't write to the production weekly leaderboard.
  if (isTestEnvironment()) return false;
  // Anti-cheat: if THIS attempt found most of the board's mines by stepping on
  // them, skip recording it, the day-time writes are additive, so
  // skipping leaves prior honest days on the row untouched while the probing
  // attempt never lands.
  if (isBombHitCheat(extras.attemptBombHits, extras.totalMines)) return false;
  if (!weekStart || !uid) return false;
  if (typeof bestTime !== 'number' || bestTime < MIN_VALID_TIME || bestTime > MAX_VALID_TIME) {
    console.warn(`Weekly bestTime ${bestTime}s outside valid range`);
    return false;
  }
  // Offline, durably queue and retry on the next online boot (mirrors the
  // daily path). Previously a flaky connection here dropped the weekly
  // score permanently with no retry, which is how Kate's weekly attempts
  // could vanish on bad service.
  if (!isFirebaseOnline()) {
    _queueFailedWeeklySubmission(weekStart, uid, name, bestTime, dayTimes, extras);
    return false;
  }
  const ok = await _doSubmitWeeklyScore(weekStart, uid, name, bestTime, dayTimes, extras);
  // 'divergent' is a RESOLVED outcome, never queued for retry: the board was
  // wrong and will still be wrong on the next flush, so queuing it would retry
  // forever. Only a falsy result (a real write failure) goes back in the queue.
  if (!ok) _queueFailedWeeklySubmission(weekStart, uid, name, bestTime, dayTimes, extras);
  return ok;
}

async function _doSubmitWeeklyScore(weekStart, uid, name, bestTime, dayTimes, extras = {}) {
  try {
    const sanitizedName = String(name).slice(0, 20).trim();
    if (!sanitizedName) return false;

    const safeDayTimes = {};
    if (dayTimes && typeof dayTimes === 'object') {
      for (const [k, v] of Object.entries(dayTimes)) {
        const day = Number(k);
        if (Number.isInteger(day) && day >= 0 && day <= 6
            && typeof v === 'number' && v >= MIN_VALID_TIME && v <= MAX_VALID_TIME) {
          safeDayTimes[day] = v;
        }
      }
    }

    const safeDayBombHits = {};
    if (extras.dayBombHits && typeof extras.dayBombHits === 'object') {
      for (const [k, v] of Object.entries(extras.dayBombHits)) {
        const day = Number(k);
        if (Number.isInteger(day) && day >= 0 && day <= 6
            && typeof v === 'number' && v >= 0 && v <= 50) {
          safeDayBombHits[day] = v;
        }
      }
    }

    // A weekly set on a board that was not the week's canonical never reaches
    // the leaderboard, for the daily's reason and then some: a week's whole
    // leaderboard is ONE board, so a divergent row is not a slower time on the
    // same puzzle, it is an incomparable time on a different one. The seed goes
    // ONTO the row in the same breath, because until now a weekly row recorded
    // nothing about which board produced it, divergence was not merely
    // unguarded, it was undetectable afterward.
    //
    // The node is weeklyBoard/{weekStart}, NOT canonicalSeedPath(weekStart):
    // that helper maps a DAILY bucket key to its canonical (and correctly sends
    // a `_weekly_first` fit row to the weekly board). Here the bucket is
    // already known to be weekly, so the path is direct.
    //
    // Fails OPEN exactly like the daily's, an unreadable canonical is
    // "unavailable", never "mismatch". Reusing planScoreSubmission keeps that
    // rule in one place; rows: null because a weekly row is keyed by uid, so
    // there is no duplicate-row concept for it to test.
    const playedSeed = typeof extras.rngSeed === 'string' ? extras.rngSeed : null;
    if (playedSeed) {
      let canonicalSeed = null;
      try {
        canonicalSeed = (await db.ref(`weeklyBoard/${weekStart}/rngSeed`).once('value')).val();
      } catch { /* read failed, proceed with the write */ }
      const { verdict } = planScoreSubmission({
        rows: null, uid: null, bucketKey: weekStart, playedSeed, canonicalSeed,
      });
      if (verdict === 'divergent') return 'divergent';
    }

    const ref = db.ref(`weekly/${weekStart}/${uid}`);

    // Additive per-day write: only touches the days in this submission,
    // never overwrites prior days. Fixes #27.
    const updates = {
      name: sanitizedName,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    };
    if (playedSeed) updates.rngSeed = playedSeed;
    for (const [day, time] of Object.entries(safeDayTimes)) {
      updates[`dayTimes/${day}`] = time;
    }
    for (const [day, hits] of Object.entries(safeDayBombHits)) {
      updates[`dayBombHits/${day}`] = hits;
    }
    if (typeof extras.totalMoves === 'number' && extras.totalMoves > 0 && extras.totalMoves < 1000) {
      updates.totalMoves = extras.totalMoves;
    }

    try {
      await ref.update(updates);
      await ref.child('bestTime').transaction(current => {
        if (current === null || bestTime <= current) return bestTime;
        return undefined;
      }).catch(err => reportCaughtError('weekly-besttime-transaction', err));
      return true;
    } catch {
      // First write for this player+week, node doesn't exist yet, so
      // update() failed the hasChildren rule. set() is safe here because
      // there's no prior data to clobber.
      const payload = {
        name: sanitizedName,
        bestTime,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
      };
      if (playedSeed) payload.rngSeed = playedSeed;
      if (Object.keys(safeDayTimes).length > 0) payload.dayTimes = safeDayTimes;
      if (Object.keys(safeDayBombHits).length > 0) payload.dayBombHits = safeDayBombHits;
      if (typeof extras.totalMoves === 'number' && extras.totalMoves > 0 && extras.totalMoves < 1000) {
        payload.totalMoves = extras.totalMoves;
      }
      await ref.set(payload);
      return true;
    }
  } catch (err) {
    console.warn('Weekly score submit failed:', err.message);
    return false;
  }
}

function _queueFailedWeeklySubmission(weekStart, uid, name, bestTime, dayTimes, extras) {
  try {
    const pending = safeGetJSON(PENDING_WEEKLY_KEY) || [];
    const existingIdx = pending.findIndex(e => e && e.weekStart === weekStart && e.uid === uid);
    if (existingIdx >= 0) {
      // Merge today's day into the existing queued entry so both days
      // reach Firebase on flush, with additive writes each day is
      // independent.
      const existing = pending[existingIdx];
      existing.dayTimes = { ...existing.dayTimes, ...(dayTimes || {}) };
      if (extras?.dayBombHits) {
        existing.extras = existing.extras || {};
        existing.extras.dayBombHits = { ...(existing.extras.dayBombHits || {}), ...extras.dayBombHits };
      }
      existing.bestTime = Math.min(existing.bestTime, bestTime);
      existing.name = name;
      existing.queuedAt = Date.now();
      existing.attempts = 0;
    } else {
      pending.push({
        weekStart, uid, name, bestTime,
        dayTimes: dayTimes || {},
        extras: extras || {},
        queuedAt: Date.now(),
        attempts: 0,
      });
    }
    while (pending.length > PENDING_MAX_ENTRIES) pending.shift();
    safeSetJSON(PENDING_WEEKLY_KEY, pending);
  } catch (err) {
    console.warn('Could not queue pending weekly submission:', err.message);
  }
}

/**
 * Resubmit any queued failed weekly writes. Called by initFirebase() on
 * every successful boot, next to flushPendingSubmissions(). Same staleness
 * rules as the daily queue.
 */
export async function flushPendingWeeklySubmissions() {
  // Test-session gate (see flushPendingSubmissions). The weekly path
  // writes per-day data additively, but a stray test-session flush
  // would still pollute the player's live weekly row.
  if (isTestEnvironment()) return;
  if (!isFirebaseOnline()) return;
  let pending;
  try {
    pending = safeGetJSON(PENDING_WEEKLY_KEY);
  } catch (err) {
    console.warn('Could not read pending weekly submissions:', err.message);
    return;
  }
  if (!Array.isArray(pending) || pending.length === 0) return;

  // Same flush-time identity resolution as the daily queue (issue #132): the
  // weekly row path weekly/{weekStart}/{uid} is rebuilt from the CURRENT uid,
  // since a frozen pre-switch uid fails the `auth.uid === $uid` rule forever.
  let currentUid = null;
  try {
    const { getUid } = await import('./firebaseProgress.js');
    currentUid = getUid();
  } catch { /* progress module unavailable, treat as auth-not-settled */ }
  if (!currentUid) return;

  const stillPending = [];
  const now = Date.now();
  let flushed = 0;
  for (const raw of pending) {
    if (now - raw.queuedAt > PENDING_MAX_AGE_MS) continue;
    if (raw.attempts >= PENDING_MAX_ATTEMPTS) continue;
    raw.attempts++;
    const entry = restampPendingWeeklyEntry(raw, currentUid);
    const ok = await _doSubmitWeeklyScore(
      entry.weekStart, entry.uid, entry.name, entry.bestTime, entry.dayTimes, entry.extras || {}
    );
    if (ok) flushed++;
    else stillPending.push(entry);
  }
  try {
    safeSetJSON(PENDING_WEEKLY_KEY, stillPending);
  } catch (err) {
    console.warn('Could not save pending weekly submissions:', err.message);
  }
  if (flushed > 0) {
    console.log(`Re-submitted ${flushed} pending weekly score(s) after reconnect.`);
  }
}

/**
 * Fetch the weekly leaderboard for a given weekStart. Returns an
 * array sorted by bestTime ascending (faster on top), with ties broken
 * by attempts-used (more attempts → better tiebreaker so single-day
 * flukes don't beat full-week explorers). Returns [] when offline or
 * empty.
 */
export async function fetchWeeklyLeaderboard(weekStart) {
  if (!isFirebaseOnline() || !weekStart) return [];
  try {
    const snap = await Promise.race([
      db.ref(`weekly/${weekStart}`).once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    if (!snap.exists()) return [];

    const rows = [];
    snap.forEach((child) => {
      const v = child.val();
      if (v && typeof v.bestTime === 'number') {
        const dayTimes = v.dayTimes || {};
        const dayBombHits = v.dayBombHits || {};
        // Find which day produced the best time so we can report the
        // strikes from that specific play. If bestTime appears on
        // multiple days (rare, players matching their own time), the
        // first match wins, fine for the leaderboard column.
        let bestDay = null;
        for (const [k, t] of Object.entries(dayTimes)) {
          if (Math.abs(t - v.bestTime) < 0.05) { bestDay = Number(k); break; }
        }
        const bestDayBombHits = bestDay != null && typeof dayBombHits[bestDay] === 'number'
          ? dayBombHits[bestDay] : null;
        rows.push({
          uid: child.key,
          name: v.name || 'Anonymous',
          bestTime: v.bestTime,
          dayTimes,
          dayBombHits,
          bestDay,
          bestDayBombHits,
          totalMoves: typeof v.totalMoves === 'number' ? v.totalMoves : null,
          attemptsUsed: Object.keys(dayTimes).length,
        });
      }
    });

    rows.sort((a, b) => {
      if (a.bestTime !== b.bestTime) return a.bestTime - b.bestTime;
      return b.attemptsUsed - a.attemptsUsed; // more attempts → higher rank on tie
    });
    // Join each row to the live name by uid (weekly rows ARE uid-keyed);
    // the row's stored name is the fallback.
    const names = await fetchPlayerNames();
    for (const r of rows) r.name = resolveDisplayName(r.uid, r.name, names);
    return rows;
  } catch (err) {
    console.warn('Weekly leaderboard fetch failed:', err.message);
    return [];
  }
}

/**
 * Write `dailyMeta/{date}` if it doesn't already exist. Rules enforce
 * write-once server-side; the client check here is a bandwidth optimisation,
 * not a guarantee. The FIRST successful client submission for a date lands
 * the features; everyone else no-ops.
 */
async function upsertDailyMeta(dateString, features) {
  if (!isFirebaseOnline()) return;
  const ref = db.ref(`dailyMeta/${dateString}`);
  const snap = await ref.once('value');
  if (snap.exists()) return;
  await ref.set({
    features,
    writtenAt: firebase.database.ServerValue.TIMESTAMP,
  });
}

/**
 * Fetch the current user's daily history, most-recently-PLAYED-first, limited
 * to `daysBack` recent entries. Returns an array of
 * `{ date, time, archive, playedDate }` or null if Firebase is offline.
 * `date` is the BOARD's date (the row key, join dailyMeta/par against this);
 * `playedDate` is the ET day the run actually happened (equal to `date` for
 * live rows; the submittedAt day for archive replays, see
 * attributePlayedDate). Time-series surfaces must place plays by playedDate,
 * or an archive replay back-dates today's performance into the past. Par and
 * delta are computed at render time against the current PAR_MODEL + dailyMeta
 * features, so that older entries automatically reflect the latest
 * coefficients after a refit (no server-side rewrite needed).
 */
export async function fetchUserDailyHistory(uid, daysBack = 30) {
  if (!isFirebaseOnline() || !uid) return null;
  try {
    const ref = db.ref(`users/${uid}/dailyHistory`);
    const snapshot = await Promise.race([
      ref.once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    if (!snapshot.exists()) return [];

    const entries = [];
    snapshot.forEach((child) => {
      const v = child.val();
      if (v && typeof v.time === 'number') {
        const archive = v.archive === true;
        entries.push({
          date: child.key,
          time: v.time,
          archive,
          playedDate: attributePlayedDate(child.key, archive, v.submittedAt, etDateStringOfMs),
        });
      }
    });

    entries.sort((a, b) => b.playedDate.localeCompare(a.playedDate) || b.date.localeCompare(a.date));
    return entries.slice(0, daysBack);
  } catch (err) {
    console.warn('Firebase daily-history fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch the full daily score tree, a map of `{ date: [{uid, name, time, bombHits, ...}, ...] }`.
 * Flattens each date's pushId-keyed object into a plain array. Used by
 * the stats page's percentile-trend chart to rank the signed-in user
 * against the full field on each date. World-readable.
 * Returns null on error.
 */
export async function fetchAllDailyScores() {
  if (!isFirebaseOnline()) return null;
  try {
    const snapshot = await Promise.race([
      db.ref('daily').once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    if (!snapshot.exists()) return {};
    const byDate = {};
    snapshot.forEach((dateChild) => {
      const date = dateChild.key;
      const scores = [];
      dateChild.forEach((entryChild) => {
        const v = entryChild.val();
        if (v && typeof v.time === 'number') {
          scores.push({
            uid: v.uid || null,
            name: v.name || 'Anonymous',
            time: v.time,
            bombHits: v.bombHits || 0,
          });
        }
      });
      byDate[date] = scores;
    });
    return byDate;
  } catch (err) {
    console.warn('Firebase all-daily fetch failed:', err.message);
    return null;
  }
}

/**
 * Fetch the full dailyMeta tree, a map of `{ date: features }`. Used by
 * the history chart to compute each historical entry's par on the fly
 * against the current PAR_MODEL. World-readable, no auth needed.
 * Returns null on error.
 */
export async function fetchAllDailyMeta() {
  if (!isFirebaseOnline()) return null;
  try {
    const snapshot = await Promise.race([
      db.ref('dailyMeta').once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    if (!snapshot.exists()) return {};

    const byDate = {};
    snapshot.forEach((child) => {
      const v = child.val();
      if (v && v.features) byDate[child.key] = v.features;
    });
    return byDate;
  } catch (err) {
    console.warn('Firebase dailyMeta fetch failed:', err.message);
    return null;
  }
}

// NOTE: Client-side validation is not sufficient for security.
// Firebase Security Rules should be configured to enforce:
//   - Time range validation (5-3600 seconds)
//   - Rate limiting per user/IP
//   - Name length and content sanitization
//   - Date string format validation
// See: https://firebase.google.com/docs/database/security

/**
 * Fetch the playerNames/{uid} → name map (world-readable). Cached for
 * PLAYER_NAMES_TTL_MS so a burst of leaderboard renders shares one read.
 * Returns {} (never null) so callers can look up with a fallback
 * unconditionally. Reads the whole node, fine at this community's scale (~tens
 * of bytes/player); if it ever grows large, switch to per-uid reads for only
 * the uids present in the rendered leaderboard.
 */
export async function fetchPlayerNames({ force = false } = {}) {
  if (!isFirebaseOnline()) return _playerNamesCache || {};
  const now = Date.now();
  if (!force && _playerNamesCache && now - _playerNamesCacheAt < PLAYER_NAMES_TTL_MS) {
    return _playerNamesCache;
  }
  try {
    const snap = await Promise.race([
      db.ref('playerNames').once('value'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    const out = {};
    if (snap.exists()) {
      snap.forEach((child) => {
        const v = child.val();
        const nm = v && typeof v.name === 'string' ? v.name.trim() : '';
        if (nm) out[child.key] = nm;
      });
    }
    _playerNamesCache = out;
    _playerNamesCacheAt = now;
    return out;
  } catch (err) {
    console.warn('playerNames fetch failed:', err && err.message);
    return _playerNamesCache || {};
  }
}

/**
 * Resolve a leaderboard row's display name: the live playerNames value for its
 * uid, else the row's own stored (denormalized) name, else 'Anonymous'.
 */
export function resolveDisplayName(uid, storedName, namesMap) {
  return (uid && namesMap && namesMap[uid]) || storedName || 'Anonymous';
}

/**
 * Fetch the online daily leaderboard for a given date.
 * @param {string} dateString YYYY-MM-DD format
 * @returns {Promise<Array<{name: string, time: number, bombHits: number, uid: string|null}>>}
 *   sorted entries. uid rides along for the Adjusted (handicap) and
 *   Friends leaderboard views; rows are public either way.
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
        uid: val.uid || null,
      });
    });

    // Already sorted by time from Firebase query, but ensure it
    entries.sort((a, b) => a.time - b.time);
    // Join each row to the live name by uid (a Settings name change shows on
    // every past row instantly); the row's stored name is the fallback.
    const names = await fetchPlayerNames();
    for (const e of entries) e.name = resolveDisplayName(e.uid, e.name, names);
    return entries;
  } catch (err) {
    console.warn('Firebase fetch failed:', err.message);
    return null; // null signals to fall back to local
  }
}

