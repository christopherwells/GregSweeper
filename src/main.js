// ── GregSweeper Entry Point ────────────────────────────
// All game logic and UI rendering is in modules.
// This file handles imports, event wiring, and init.

// ── Local Date Utility ──────────────────────────────
// getLocalDateString imported from seededRandom.js

import { state } from './state/gameState.js';
import { $, $$, boardEl, resetBtn, flagModeToggle, boardScrollWrapper, muteBtn } from './ui/domHelpers.js';
import { resizeCells, updateAllCells, getThemeEmoji, needsZoom, updateZoom, zoomIn, zoomOut, invalidateEmojiCache, setFocusedCell, announceGame } from './ui/boardRenderer.js';
import { preloadSprites, spriteImgHTML } from './ui/spriteLoader.js';
import { updateHeader, updateStreakBorder, updateFlagModeBar, getCheckpointForLevel, CHECKPOINT_INTERVAL } from './ui/headerRenderer.js';
import { updatePowerUpBar } from './ui/powerUpBar.js';
import { showModal, hideModal, hideAllModals } from './ui/modalManager.js';
import { showToast, showLevelUpToast, showCheckpointToast } from './ui/toastManager.js';
import { showCelebration, haptic } from './ui/effectsRenderer.js';
import { THEME_UNLOCKS, getUnlockedThemes, loadThemeCSS } from './ui/themeManager.js';
import { applyThemeEffects, clearThemeEffects } from './ui/themeEffects.js';
import { newGame, revealCell, toggleFlag, handleChordReveal } from './game/gameActions.js';
import './game/winLossHandler.js'; // side-effect: registers handleWin with powerUpActions
import { useRevealSafe, useShield, activateScan, activateXRay, activateMagnet } from './game/powerUpActions.js';
import { switchMode, isChaosUnlocked, updateModeUI } from './game/modeManager.js';
import { persistGameState, tryResumeGame } from './game/gamePersistence.js';
import { getDifficultyForLevel, getTimedDifficulty, getSpeedRating, MAX_LEVEL, MAX_TIMED_LEVEL, CHAOS_UNLOCK_LEVEL, DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE } from './logic/difficulty.js';
import { computeDailyFeatures, predictPar } from './logic/dailyFeatures.js';
import { loadHandicaps, getHandicap, estimateHandicapDetails } from './logic/handicaps.js';
import {
  loadStats, saveTheme, loadTheme, resetStats,
  saveCheckpoint, loadCheckpoint,
  loadDailyLeaderboard, addDailyLeaderboardEntry,
  saveModePowerUps, loadGameState,
  isOnboarded, setOnboarded,
  isDailyCompleted,
  getDailyStreak,
  getPlayerName, setPlayerName,
  getLastSeenVersion, setLastSeenVersion,
  saveDailyPar, loadDailyPar, applyCloudProgress,
  hasSeenNotice, markNoticeSeen,
} from './storage/statsStorage.js';

const CURRENT_VERSION = 'v1.5';

import {
  playLevelUp, isMuted, setMuted, loadMuted,
  setSFXVolume, getSFXVolume,
} from './audio/sounds.js';
import {
  getAchievementState, getTotalScore, checkNewUnlocks,
  getHighestTier, getAllTierNames, getTierIcon, getTierColor,
} from './logic/achievements.js';
import {
  initFirebase, isFirebaseOnline, submitOnlineScore, fetchOnlineLeaderboard, fetchUserDailyHistory, fetchAllDailyMeta, fetchAllDailyScores, fetchWeeklyLeaderboard,
} from './firebase/firebaseLeaderboard.js';
import { initAnonymousAuth, loadProgress, saveDailyHistoryEntry, getUid, loadWeeklyAttempts, loadLocalWeeklyAttempts, replaceLocalWeeklyAttempts, pruneStaleLocalWeeklyAttempts, subscribeToUidChanges } from './firebase/firebaseProgress.js';
import { getAuthState, subscribeAuthState, linkWithGoogle, sendEmailLink, tryCompleteEmailLink, signOut as authSignOut } from './firebase/firebaseAuth.js';
import { isTestEnvironment } from './firebase/env.js';
// Stats-tab renderer + chart toolkit are lazy-imported in populateDailyPanel
// so they stay off the critical load path — they only come in when the
// user actually opens the Stats modal. Saves ~3 network round-trips
// (statsRenderer, charts, dailyHistoryChart) on every cold load.
import { generateBoard, cleanSolverArtifacts } from './logic/boardGenerator.js';
import { isBoardSolvable } from './logic/boardSolver.js';
import { createDailyRNG, getLocalDateString, getWeekStart, getWeekDayIndex } from './logic/seededRandom.js';
import { selectDailyRngSeed } from './logic/selectDailyRngSeed.js';
import { loadExperimentTarget, getTargetGimmickName, getMissionForSeed } from './logic/experimentDesign.js';
import { loadDailyBoard, deserializeBoard } from './firebase/dailyBoardSync.js';
import { loadWeeklyBoard } from './firebase/weeklyBoardSync.js';
import {
  EMOJI_PACKS, EFFECTS, TITLES,
  loadEmojiPack, saveEmojiPack, getActiveEmojiPack, isPackUnlocked,
  isEffectUnlocked, isTitleUnlocked,
  loadEffects, saveEffects, loadTitle, saveTitle,
} from './ui/collectionManager.js';
import { isModifierPopupDisabled, setModifierPopupDisabled, getGimmickDefs, getDailyGimmick, applyGimmicks } from './logic/gimmicks.js';
import { isStorageFailing, safeGet, safeSet, safeRemove, requestPersistentStorage } from './storage/storageAdapter.js';
import { pauseTimer, resumeTimer, recordInteraction } from './game/timerManager.js';
import { startTutorial, startWarmup } from './ui/tutorialManager.js';
import { initErrorReporter, setErrorReporterCodeVersion, reportTestError } from './diagnostics/errorReporter.js';

// ── Code-version handshake with the service worker ────
// The SW broadcasts its CACHE_NAME on activate and replies to
// `getCodeVersion` requests. We listen for both. `state.codeVersion`
// is the single source of truth for which build is running — used
// as forensic provenance on canonical-board writes (instead of the
// stale literal it used to hardcode) and surfaced in diagnostics.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'codeVersion' && typeof event.data.value === 'string') {
      state.codeVersion = event.data.value;
      // Keep the error reporter's tag in sync so late errors carry the
      // build that produced them, not the boot-time placeholder.
      setErrorReporterCodeVersion(event.data.value);
    }
  });
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'getCodeVersion' });
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'getCodeVersion' });
    }
  });
}

// Attach error listeners as early as possible — before any other module
// runs — so init-time exceptions are captured. The reporter buffers
// events until uid resolves and Firebase is ready, then drains.
initErrorReporter({ codeVersion: state.codeVersion || 'unknown' });

// Expose a single getter for "is the user actively playing right now?"
// so the inline scripts in index.html (SW updatefound, version-mismatch
// detector) can consult the actual game state instead of probing the
// DOM for `.cell.revealed`. The DOM heuristic mistakes "looking at a
// finished board" or "fresh game with no reveals yet" for the wrong
// thing — state.status is the source of truth. Inline scripts call
// this with a `?.()` so a load order race (script before main.js
// initializes the bridge) safely defaults to "not playing".
window._gsIsPlaying = () => state && state.status === 'playing';

// ── Boot overlay helpers ──────────────────────────────
function setBootStatus(text) {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = text;
}
function hideBootOverlay() {
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
    reg.update().catch(() => {});
  });
}

// ── Startup gate ──────────────────────────────────────
// Render nothing user-interactive until three preconditions hold:
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
async function runStartupGate() {
  setBootStatus('Loading…');

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
  if (!isTestEnvironment()) pruneStaleLocalWeeklyAttempts(currentWeek);

  if (firebaseReady && !customSeed) {
    setBootStatus('Loading today\'s puzzle…');
    try {
      // Test branch: skip the Firebase weekly-attempts read too so an
      // existing master attempt doesn't get pulled in and gate test.
      const weeklyAttemptsP = isTestEnvironment()
        ? Promise.resolve({})
        : loadWeeklyAttempts(currentWeek).catch(() => null);
      const [dailyRaw, weeklyRaw, attempts] = await Promise.all([
        loadDailyBoard(today).catch(() => null),
        loadWeeklyBoard(currentWeek).catch(() => null),
        weeklyAttemptsP,
      ]);
      if (dailyRaw) {
        state.canonicalDailyBoard = { date: today, raw: dailyRaw };
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

  // Stale-completion check: only clear the local "completed today"
  // flag when we POSITIVELY confirm a divergent rngSeed on a Firebase
  // score we've matched to this user. If we can't find a score (uid
  // mismatch, network race, fresh device, offline submission, etc.)
  // we trust the local flag — it's set because the user on this
  // device actually completed the daily, and absence of a Firebase
  // record is more often a sync issue than a server-side deletion.
  //
  // The earlier version of this check cleared the flag on any "non-
  // clean" outcome including missing-score, which let the user replay
  // a daily they had already completed when their uid lookup raced.
  if (firebaseReady && !customSeed && isDailyCompleted(today)) {
    setBootStatus('Verifying today\'s play…');
    const myUid = await _waitForUid(3000);
    const canonicalSeed = state.canonicalDailyBoard?.raw?.rngSeed || null;
    if (myUid && canonicalSeed) {
      try {
        const snap = await firebase.database().ref(`daily/${today}`).once('value');
        let myScore = null;
        snap.forEach((child) => {
          const v = child.val();
          if (v && v.uid === myUid) {
            myScore = v;
            return true; // stop iteration
          }
          return undefined;
        });
        const myScoreSeed = myScore?.rngSeed || null;
        const isDivergent = myScore && myScoreSeed && myScoreSeed !== canonicalSeed;
        if (isDivergent) {
          // Confirmed divergent — clear the completion flag plus the
          // cached par/moves so newGame recomputes them against the
          // canonical layout. Don't touch streak fields; replaying
          // maintains the streak via lastDailyDate === today.
          safeRemove('minesweeper_daily_completed_date');
          safeRemove('minesweeper_daily_par_' + today);
          safeRemove('minesweeper_daily_moves_' + today);
        }
      } catch (err) {
        console.warn('startup gate: completion verification failed:', err.message);
      }
    }
  }
}

// Wait for anonymous auth to complete and return the resulting uid, or
// null if it never arrives. Polls because initAnonymousAuth is fire-and-
// forget from init() — we don't have a promise to await directly.
async function _waitForUid(timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const uid = getUid();
    if (uid) return uid;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
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

// ── Theme-color meta tag (Android nav bar) ───────────
function updateThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-app-bg').trim();
  if (bg) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  }
}

// ── Stats Display ─────────────────────────────────────

// Owner-only Model tab. Renders the per-refit timeline (RMSE, bias,
// candidate CVs) from src/logic/modelHistory.json. Tab button is hidden
// at boot in index.html and only unhidden when getUid() === OWNER_UID,
// so other players never see the tab. The JSON file itself ships with
// the rest of the static assets — privacy-by-obscurity, not Firebase
// rules. Worth revisiting if the user base grows past ~10.
const OWNER_UID = '5Ht9d2io0ugU1NGsjdJmZvkJi382';
const MODEL_HISTORY_PATH = './src/logic/modelHistory.json';

// Default tab = the mode the player most recently played (when meaningful).
function pickDefaultStatsTab() {
  if (state.gameMode === 'timed') return 'timed';
  if (state.gameMode === 'normal') return 'challenge';
  if (state.gameMode === 'weekly') return 'weekly';
  return 'daily';
}

function setActiveStatsTab(tab) {
  for (const btn of $$('.stats-tab')) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const panel of $$('.stats-panel')) {
    panel.classList.toggle('hidden', panel.id !== `stats-panel-${tab}`);
  }
}

// Help / Settings use the same tabbed pattern so each section fits on
// one screen with no scrolling (scrolling mid-game is jarring).
function setActiveHelpTab(tab) {
  for (const btn of $$('.help-tab')) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const panel of $$('.help-panel')) {
    panel.classList.toggle('hidden', panel.id !== `help-panel-${tab}`);
  }
}

function setActiveSettingsTab(tab) {
  for (const btn of $$('.settings-tab')) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const panel of $$('.settings-panel')) {
    panel.classList.toggle('hidden', panel.id !== `settings-panel-${tab}`);
  }
}

// Poll getUid() until anonymous auth resolves it, or until the timeout.
// Anonymous auth typically completes in <500 ms after initAnonymousAuth
// fires at app boot, but on a cold reload (e.g. right after a service
// worker auto-reload from a new deploy) Stats can be opened during the
// race. Without this, the owner gate evaluates `null === OWNER_UID`
// false and the Model tab silently stays hidden.
async function waitForUid(timeoutMs = 3000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const uid = getUid();
    if (uid) return uid;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return getUid();
}

async function updateStatsDisplay() {
  setActiveStatsTab(pickDefaultStatsTab());
  populateChallengePanel();
  populateQuickPlayPanel();
  populateWeeklyPanel();

  // Resolve uid + populate Model tab in parallel with the daily panel —
  // the auth wait shouldn't gate the visible part of the modal.
  await Promise.all([
    populateDailyPanel(),
    (async () => {
      const uid = await waitForUid();
      const isOwner = uid === OWNER_UID;
      $('#stats-tab-model').classList.toggle('hidden', !isOwner);
      if (isOwner) await populateModelPanel();
    })(),
  ]);
}

// Populate the Weekly stats tab. Pulls the player's row from
// weekly/{currentWeek}/{uid} (via fetchWeeklyLeaderboard's uid filter)
// and renders headline cards + the 7-day line chart. Fire-and-forget
// from updateStatsDisplay so it doesn't block the visible daily panel.
async function populateWeeklyPanel() {
  const weekStart = getWeekStart();
  const bestEl = $('#stat-weekly-best');
  const attemptsEl = $('#stat-weekly-attempts');
  const rankEl = $('#stat-weekly-rank');
  const chartEl = $('#chart-weekly-history');
  const pastEl = $('#stat-weekly-past-table');
  if (!bestEl || !chartEl) return;

  // Defaults so the cards never render '--' forever on cold-load.
  bestEl.textContent = '--';
  attemptsEl.textContent = '0/7';
  rankEl.textContent = '--';

  if (!isFirebaseOnline()) {
    chartEl.innerHTML = '<div class="chart-empty">Online play required for weekly stats.</div>';
    return;
  }

  try {
    const [entries, _] = await Promise.all([fetchWeeklyLeaderboard(weekStart), Promise.resolve()]);
    const uid = getUid();
    const myRow = uid ? entries.find(e => e.uid === uid) : null;

    if (myRow) {
      bestEl.textContent = myRow.bestTime.toFixed(1) + 's';
      attemptsEl.textContent = (myRow.attemptsUsed || 0) + '/7';
      const rank = entries.indexOf(myRow) + 1;
      rankEl.textContent = `#${rank} of ${entries.length}`;
    } else {
      bestEl.textContent = '--';
      attemptsEl.textContent = '0/7';
      rankEl.textContent = entries.length > 0 ? `unranked of ${entries.length}` : '--';
    }

    // Render the 7-day chart via the lazy-loaded charts module.
    const { lineChart } = await import('./ui/charts.js');
    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const points = [];
    if (myRow && myRow.dayTimes) {
      for (let d = 0; d < 7; d++) {
        const t = myRow.dayTimes[d];
        if (typeof t === 'number') {
          points.push({ x: DAY_LABELS[d], y: t, label: `${DAY_LABELS[d]}: ${t.toFixed(1)}s` });
        }
      }
    }
    chartEl.innerHTML = '';
    if (points.length === 0) {
      chartEl.innerHTML = '<div class="chart-empty">No attempts yet this week.</div>';
    } else {
      const bestVal = myRow.bestTime;
      const svg = lineChart(points, {
        ariaLabel: 'Weekly puzzle times Mon to Sun',
        yFormat: v => v.toFixed(0) + 's',
        dotClassForValue: v => Math.abs(v - bestVal) < 0.05 ? 'chart-dot-good' : 'chart-dot-even',
        lineClass: 'chart-line',
      });
      chartEl.appendChild(svg);
    }

    // Past weeks table — last 4 finished weeks before this one.
    if (pastEl) {
      const past = await collectPastWeeklyBests(uid, 4);
      if (past.length === 0) {
        pastEl.textContent = 'No past weekly attempts yet.';
      } else {
        pastEl.textContent = past
          .map(p => `${prettyDate(p.weekStart)}  best ${p.bestTime.toFixed(1)}s  (${p.attemptsUsed}/7)`)
          .join('\n');
      }
    }
  } catch (err) {
    console.warn('weekly panel populate failed:', err.message);
  }
}

async function collectPastWeeklyBests(uid, count) {
  if (!uid) return [];
  // Build the list of weekStart strings first, then fetch all weeks in
  // parallel. Each fetchWeeklyLeaderboard is independent — running them
  // sequentially burns ~4 round-trips on the network for the 4-week
  // case. Promise.all cuts that to ~1 round-trip's worth of latency.
  const today = new Date(`${getLocalDateString()}T00:00:00-05:00`);
  const start = new Date(today);
  const dayBefore = (start.getUTCDay() + 6) % 7; // 0=Mon
  start.setUTCDate(start.getUTCDate() - dayBefore - 7); // last week's Monday
  const weekStarts = [];
  for (let i = 0; i < count; i++) {
    const yy = start.getUTCFullYear();
    const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(start.getUTCDate()).padStart(2, '0');
    weekStarts.push(`${yy}-${mm}-${dd}`);
    start.setUTCDate(start.getUTCDate() - 7);
  }
  const settled = await Promise.allSettled(weekStarts.map(w => fetchWeeklyLeaderboard(w)));
  const out = [];
  for (let i = 0; i < weekStarts.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    const row = (r.value || []).find(e => e.uid === uid);
    if (row) out.push({ weekStart: weekStarts[i], bestTime: row.bestTime, attemptsUsed: row.attemptsUsed || 0 });
  }
  return out;
}

// Short month-day label for chart x-axis ticks. Stats tab elsewhere has
// its own copy in statsRenderer.js; duplicating the 5-line helper here
// keeps the lazy-loaded charts.js the only thing main.js pulls from the
// stats stack.
const SHORT_MONTHS_M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDateModel(dateStr) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return dateStr || '';
  return `${SHORT_MONTHS_M[parseInt(parts[1], 10) - 1] || parts[1]} ${parseInt(parts[2], 10)}`;
}

function clearChartContainer(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '';
  return el;
}

function renderChartEmpty(id, message) {
  const el = clearChartContainer(id);
  if (!el) return;
  const d = document.createElement('div');
  d.className = 'chart-empty';
  d.textContent = message;
  el.appendChild(d);
}

// Populate the owner-only Model tab. Skipped entirely for non-owner
// uids (gated in updateStatsDisplay) — non-owners never even fetch
// modelHistory.json.
async function populateModelPanel() {
  // Reset to placeholders while fetching, in case a previous open's
  // values are still in the DOM and this fetch fails.
  $('#stat-model-date').textContent = '…';
  $('#stat-model-n').textContent = '…';
  $('#stat-model-rmse').textContent = '…';
  $('#stat-model-bias').textContent = '…';
  $('#stat-model-target-line').textContent = 'Loading…';
  $('#stat-model-history-table').textContent = '…';
  $('#stat-model-cv-table').textContent = '…';
  renderChartEmpty('chart-model-rmse-bias', 'Loading…');
  renderChartEmpty('chart-model-n', 'Loading…');

  let history;
  try {
    const r = await fetch(MODEL_HISTORY_PATH, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`fetch failed: HTTP ${r.status}`);
    history = await r.json();
    if (!Array.isArray(history)) throw new Error('not an array');
  } catch (err) {
    $('#stat-model-target-line').textContent = `Failed to load model history: ${err.message}`;
    renderChartEmpty('chart-model-rmse-bias', 'Failed to load.');
    renderChartEmpty('chart-model-n', 'Failed to load.');
    return;
  }

  if (history.length === 0) {
    const msg = 'No fits yet — first row lands after the next refit run.';
    $('#stat-model-target-line').textContent = msg;
    $('#stat-model-history-table').textContent = '(empty)';
    $('#stat-model-cv-table').textContent = '(empty)';
    renderChartEmpty('chart-model-rmse-bias', msg);
    renderChartEmpty('chart-model-n', msg);
    return;
  }

  const latest = history[history.length - 1];
  const recent = history.slice(-14);

  const fmtRmse = v => (v == null) ? 'NA' : `${v.toFixed(2)}s`;
  const fmtBias = v => (v == null) ? 'NA' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}s`;

  $('#stat-model-date').textContent = latest.date || '--';
  $('#stat-model-n').textContent = `${latest.n_scores ?? '?'} · ${latest.n_players ?? '?'}`;
  $('#stat-model-rmse').textContent = fmtRmse(latest.rmse);
  $('#stat-model-bias').textContent = fmtBias(latest.bias);
  $('#stat-model-target-line').textContent =
    `Target: ${latest.target || '-'} · Method: ${latest.method || '?'} · Total fits: ${history.length}`;

  // ── Charts ────────────────────────────────────────────
  // Lazy-import so the chart toolkit only comes in when the owner
  // actually opens the Model tab, matching how other Stats charts load.
  const { lineChart } = await import('./ui/charts.js');

  const rmsePoints = recent
    .filter(r => r.rmse != null && Number.isFinite(r.rmse))
    .map(r => ({
      x: shortDateModel(r.date),
      y: r.rmse,
      label: `${r.date}: RMSE ${r.rmse.toFixed(2)}s`,
    }));
  const biasPoints = recent
    .filter(r => r.bias != null && Number.isFinite(r.bias))
    .map(r => ({
      x: shortDateModel(r.date),
      y: r.bias,
      label: `${r.date}: bias ${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(2)}s`,
    }));
  const rmseChartEl = clearChartContainer('chart-model-rmse-bias');
  if (rmseChartEl) {
    if (rmsePoints.length === 0 && biasPoints.length === 0) {
      renderChartEmpty('chart-model-rmse-bias', 'No RMSE data yet.');
    } else {
      rmseChartEl.appendChild(lineChart(rmsePoints, {
        ariaLabel: 'RMSE (solid) and bias (dashed) per refit',
        thresholdLine: 0,
        yFormat: v => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + 's',
        secondary: biasPoints,
      }));
    }
  }

  const nPoints = recent
    .filter(r => r.n_scores != null && Number.isFinite(r.n_scores))
    .map(r => ({
      x: shortDateModel(r.date),
      y: r.n_scores,
      label: `${r.date}: N=${r.n_scores}, ${r.n_players ?? '?'} players`,
    }));
  const nChartEl = clearChartContainer('chart-model-n');
  if (nChartEl) {
    if (nPoints.length === 0) {
      renderChartEmpty('chart-model-n', 'No N data yet.');
    } else {
      nChartEl.appendChild(lineChart(nPoints, {
        ariaLabel: 'Total scores per refit',
        yFormat: v => String(Math.round(v)),
      }));
    }
  }

  // ── Tables ────────────────────────────────────────────
  // History trend table — monospace so columns line up.
  const headerLine  = 'date         meth   N    RMSE     bias      target';
  const dividerLine = '----         ----   --   ----     ----      ------';
  const dataLines = recent.map(r => {
    const meth = (r.method || '?').slice(0, 4);
    return (
      (r.date || '').padEnd(12) + ' ' +
      meth.padEnd(6) + ' ' +
      String(r.n_scores ?? '?').padStart(3) + '  ' +
      fmtRmse(r.rmse).padStart(7) + '  ' +
      fmtBias(r.bias).padStart(8) + '  ' +
      (r.target || '-')
    );
  });
  $('#stat-model-history-table').textContent =
    [headerLine, dividerLine, ...dataLines].join('\n');

  // Candidate CVs from the latest fit. seed-residuals fallback rows have
  // no posterior, so candidates is an empty array — show that explicitly
  // rather than a blank table.
  if (Array.isArray(latest.candidates) && latest.candidates.length > 0) {
    const cvLines = ['feature                    mean       sd        cv'];
    latest.candidates.slice(0, 8).forEach(c => {
      cvLines.push(
        (c.feature || '').padEnd(26) + ' ' +
        (c.mean != null ? c.mean.toFixed(3) : '   -  ').padStart(8) + '  ' +
        (c.sd   != null ? c.sd.toFixed(3)   : '   -  ').padStart(8) + '  ' +
        (c.cv   != null ? c.cv.toFixed(3)   : '   -  ').padStart(8)
      );
    });
    $('#stat-model-cv-table').textContent = cvLines.join('\n');
  } else {
    $('#stat-model-cv-table').textContent =
      '(seed-residuals fallback — no posterior this refit)';
  }
}

function populateChallengePanel() {
  const stats = loadStats();
  const cm = stats.modeStats?.normal || stats; // fallback to legacy aggregate
  $('#stat-challenge-played').textContent = cm.totalGames ?? stats.totalGames ?? 0;
  const total = cm.totalGames ?? stats.totalGames ?? 0;
  const wins = cm.wins ?? stats.wins ?? 0;
  const rate = total > 0 ? Math.round((wins / total) * 100) : 0;
  $('#stat-challenge-win-rate').textContent = `${rate}%`;
  $('#stat-challenge-max-level').textContent = cm.maxLevelReached ?? stats.maxLevelReached ?? 1;
  $('#stat-challenge-checkpoint').textContent = state.checkpoint || 1;
  const bestKey = `level${state.currentLevel}`;
  const best = (cm.bestTimes || stats.bestTimes || {})[bestKey];
  $('#stat-challenge-best-time').textContent = best != null ? `${best}s` : '--';

  const chart = $('#stat-challenge-recent');
  if (!chart) return;
  chart.innerHTML = '';
  const recent = (cm.recentGames || stats.recentGames || []).slice(-20);
  if (recent.length === 0) {
    chart.innerHTML = '<span class="chart-empty">Play some challenge games to see your history!</span>';
    return;
  }
  const winTimes = recent.filter(g => g.won).map(g => g.time);
  const maxTime = winTimes.length > 0 ? Math.max(...winTimes, 30) : 30;
  for (const game of recent) {
    const bar = document.createElement('div');
    bar.className = `game-bar ${game.won ? 'win' : 'loss'}`;
    if (game.won) {
      const pct = Math.max(15, 100 - (game.time / maxTime) * 70);
      bar.style.height = `${pct}%`;
      bar.title = `Win: ${game.time}s (Level ${game.level || '?'})`;
    } else {
      bar.style.height = '30%';
      bar.title = 'Loss';
    }
    chart.appendChild(bar);
  }
}

function populateQuickPlayPanel() {
  const stats = loadStats();
  const tm = stats.modeStats?.timed;
  if (!tm) {
    $('#stat-timed-played').textContent = '0';
    $('#stat-timed-win-rate').textContent = '0%';
    $('#stat-timed-streak').textContent = '0';
    $('#stat-timed-best-streak').textContent = '0';
    $('#stat-timed-best-times').innerHTML = '<span class="chart-empty">Play some Quick Play games!</span>';
    return;
  }
  $('#stat-timed-played').textContent = tm.totalGames || 0;
  const rate = tm.totalGames > 0 ? Math.round((tm.wins / tm.totalGames) * 100) : 0;
  $('#stat-timed-win-rate').textContent = `${rate}%`;
  $('#stat-timed-streak').textContent = tm.currentStreak || 0;
  $('#stat-timed-best-streak').textContent = tm.bestStreak || 0;

  const labels = ['Beginner', 'Intermediate', 'Expert', 'Extreme'];
  const cont = $('#stat-timed-best-times');
  cont.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const t = (tm.bestTimes || {})[`level${i + 1}`];
    const mini = document.createElement('div');
    mini.className = 'stat-mini';
    mini.innerHTML = `<div class="stat-mini-label">${labels[i]}</div><div class="stat-mini-value">${t != null ? t + 's' : '--'}</div>`;
    cont.appendChild(mini);
  }
}

async function populateDailyPanel() {
  // Show an unobtrusive loading state while we pull from Firebase.
  const tierChartIds = [
    'chart-handicap-trajectory', 'chart-daily-history',
    'chart-complexity-delta', 'chart-strike-rate',
    'chart-modifier-heatmap', 'chart-consistency',
    'chart-percentile-trend',
  ];
  for (const id of tierChartIds) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="chart-empty">Loading…</div>';
  }

  const uid = getUid();
  if (!uid) {
    for (const id of tierChartIds) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="chart-empty">Sign-in still pending. Open again in a moment.</div>';
    }
    return;
  }

  // Fetch in parallel. handicaps.json is a static asset.
  const [history, metaByDate, scoresByDate, handicapsMap] = await Promise.all([
    fetchUserDailyHistory(uid, 365),
    fetchAllDailyMeta(),
    fetchAllDailyScores(),
    loadHandicaps(),
  ]);

  if (history === null || metaByDate === null) {
    for (const id of tierChartIds) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="chart-empty">Couldn\'t reach Firebase. Try again later.</div>';
    }
    return;
  }

  // Use the refitted handicap from handicaps.json when available. Fall
  // back to a client-computed mean residual against the user's own
  // history so first-time players see something meaningful before the
  // nightly refit catches up. Provisional flag tells the stats renderer
  // to qualify the number ("(provisional, N plays)") so the player
  // understands it'll tighten as more data accumulates.
  let handicap = getHandicap(uid);
  let handicapProvisional = false;
  if (handicap === 0 && history && history.length >= 2) {
    const pairs = history
      .map(h => {
        const f = metaByDate[h.date];
        if (!f) return null;
        // Cross-reference the user's bombHits for this date so the
        // provisional handicap subtracts secPerBombHit × bombHits before
        // averaging residuals. Without this, a single bomb-hit day swings
        // the provisional handicap by ~14s, masking the player's true
        // skill until the nightly refit catches up.
        const myScore = Array.isArray(scoresByDate?.[h.date])
          ? scoresByDate[h.date].find(s => s.uid === uid) : null;
        return {
          time: h.time,
          predictedPar: predictPar(f),
          bombHits: myScore?.bombHits || 0,
        };
      })
      .filter(Boolean);
    const est = estimateHandicapDetails(pairs);
    if (est) {
      handicap = est.handicap;
      handicapProvisional = true;
    }
  }
  const { renderDailyStatsTab } = await import('./ui/statsRenderer.js');
  renderDailyStatsTab({
    history: history || [],
    metaByDate: metaByDate || {},
    scoresByDate: scoresByDate || {},
    uid,
    handicap,
    handicapProvisional,
  });
}

// Tab switchers — bind once at module load.
for (const btn of $$('.stats-tab')) {
  btn.addEventListener('click', () => setActiveStatsTab(btn.dataset.tab));
}
for (const btn of $$('.help-tab')) {
  btn.addEventListener('click', () => setActiveHelpTab(btn.dataset.tab));
}
for (const btn of $$('.settings-tab')) {
  btn.addEventListener('click', () => setActiveSettingsTab(btn.dataset.tab));
}

// ── Leaderboard Display ───────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const LONG_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function prettyDate(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const mo = LONG_MONTH_NAMES[parseInt(parts[1], 10) - 1];
  if (!mo) return dateStr;
  return `${mo} ${parseInt(parts[2], 10)}, ${parts[0]}`;
}

async function renderWeeklyLeaderboard(weekStart) {
  $('#leaderboard-date').textContent = `Week of ${prettyDate(weekStart)}`;
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';
  // Repurpose the table header for weekly: "Best" instead of "Time",
  // "Played" instead of "Par". Restored to the daily defaults if the
  // player switches back to a daily tab via the modal's tab strip.
  const thead = $('#leaderboard-table thead');
  if (thead) {
    thead.innerHTML = `<tr><th>#</th><th>Name</th><th>Best</th><th class="lb-col-extra">${spriteImgHTML('strike', 'sprite-header', 'Strikes')}</th><th>Played</th><th class="lb-col-extra">Pace</th></tr>`;
  }
  const entries = await fetchWeeklyLeaderboard(weekStart);
  const hasEntries = entries.length > 0;
  $('#leaderboard-table').classList.toggle('hidden', !hasEntries);
  $('#leaderboard-empty').textContent = 'No weekly times yet. Be the first to set one.';
  $('#leaderboard-empty').classList.toggle('hidden', hasEntries);
  if (!hasEntries) return;
  // Column repurposing for weekly:
  //   Time   = bestTime (best across the player's 7 attempts)
  //   💥     = strike count from THAT specific best play
  //   Par    = N/7 attempts used
  //   Pace   = bestTime / solver totalMoves (s per click)
  // Older rows from before the schema added dayBombHits/totalMoves
  // render '-' for those cells — graceful degradation, no upgrade
  // step required.
  const myUidW = getUid();
  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    if (myUidW && entry.uid === myUidW) tr.classList.add('lb-row-mine');
    const used = entry.attemptsUsed || 0;
    const bombs = (typeof entry.bestDayBombHits === 'number')
      ? `<td class="lb-col-extra">${entry.bestDayBombHits}</td>`
      : '<td class="lb-col-extra">-</td>';
    const pace = (entry.totalMoves && entry.totalMoves > 0)
      ? `<td class="lb-col-extra">${(entry.bestTime / entry.totalMoves).toFixed(2)}</td>`
      : '<td class="lb-col-extra">-</td>';
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.bestTime.toFixed(1)}s</td>${bombs}<td>${used}/7</td>${pace}`;
    tbody.appendChild(tr);
  });
}

// Pick the default leaderboard tab based on current mode. Player in
// weekly → start on Weekly tab; otherwise Daily.
function _defaultLeaderboardTab() {
  if (state.gameMode === 'weekly' && state.weeklySeed) return 'weekly';
  return 'daily';
}

function _setActiveLeaderboardTab(tab) {
  for (const btn of $$('.leaderboard-tab')) {
    const isActive = btn.dataset.lbTab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
}

// Shared daily-par resolver. Cheap path: cached features (date-keyed in
// localStorage, or in-memory from a fresh play) -> predictPar. Fallback:
// solve today's canonical board, or only if Firebase has nothing,
// regenerate locally, then cache the result. ignoreInMemory skips the
// in-memory state.dailyFeatures source so the title card gets strictly
// today's-date par and never a previous play's leftover features.
async function computeDailyParForDate(dateStr, ignoreInMemory = false) {
  const cached = loadDailyPar(dateStr);
  const featuresForPar = (ignoreInMemory ? null : state.dailyFeatures) || cached.features || null;
  let dailyPar = 0;
  let dailyMoves = (ignoreInMemory ? 0 : state.dailyMoves) || cached.moves;
  if (featuresForPar) {
    dailyPar = predictPar(featuresForPar);
    if (!dailyMoves && featuresForPar.totalClicks) dailyMoves = featuresForPar.totalClicks;
  }
  if (dailyPar === 0) {
    // Compute par on-demand. Try the canonical board on Firebase first
    // — every player today plays that exact layout, so par must come
    // from solving IT, not whatever the local generator would produce.
    // Falls back to local generation only when Firebase has nothing
    // (very first player of a new date OR offline).
    try {
      let pBoard, pRows, pCols, pMines, activeGimmicks;
      let parResult;

      const canonicalRaw = await loadDailyBoard(dateStr).catch(() => null);
      if (canonicalRaw) {
        const r = deserializeBoard(canonicalRaw);
        pBoard = r.board;
        pRows = r.rows;
        pCols = r.cols;
        pMines = r.totalMines;
        activeGimmicks = r.activeGimmicks || [];
        const pFixedR = Math.floor(pRows / 2), pFixedC = Math.floor(pCols / 2);
        parResult = isBoardSolvable(pBoard, pRows, pCols, pFixedR, pFixedC);
        cleanSolverArtifacts(pBoard);
      } else {
        // Mirror the daily-gen path: resolve the effective RNG seed first so
        // the computed par matches what the player will actually see when
        // they start today's daily (especially on adaptive-experiment days).
        const rngSeed = selectDailyRngSeed(dateStr);
        const dimRng = createDailyRNG(rngSeed);
        pRows = DAILY_MIN_SIZE + Math.floor(dimRng() * DAILY_SIZE_RANGE);
        pCols = DAILY_MIN_SIZE + Math.floor(dimRng() * DAILY_SIZE_RANGE);
        const pDensity = DAILY_MIN_DENSITY + dimRng() * DAILY_DENSITY_RANGE;
        pMines = Math.max(5, Math.round(pRows * pCols * pDensity));
        const pFixedR = Math.floor(pRows / 2), pFixedC = Math.floor(pCols / 2);
        // Recover the mission that won the seed selection so we
        // force-inject the same gimmick (and respect the single-only
        // constraint for coverage slots) the selector evaluated.
        const parMission = getMissionForSeed(rngSeed);
        const forcedGimmick = getTargetGimmickName(parMission.target);
        activeGimmicks = getDailyGimmick(rngSeed, createDailyRNG, forcedGimmick, parMission.singleOnly);

        for (let attempt = 0; attempt < 50; attempt++) {
          const boardRng = attempt === 0
            ? createDailyRNG(rngSeed)
            : createDailyRNG(rngSeed + '-retry-' + attempt);
          pBoard = generateBoard(pRows, pCols, pMines, pFixedR, pFixedC, boardRng);
          cleanSolverArtifacts(pBoard);
          if (activeGimmicks.length > 0) {
            const gRng = createDailyRNG(rngSeed + '-gimmick-apply-' + attempt);
            applyGimmicks(pBoard, 1, activeGimmicks, gRng);
          }
          parResult = isBoardSolvable(pBoard, pRows, pCols, pFixedR, pFixedC);
          cleanSolverArtifacts(pBoard);
          if (parResult.solvable || parResult.remainingUnknowns === 0) break;
        }
      }

      if (parResult && (parResult.solvable || parResult.remainingUnknowns === 0)) {
        const features = computeDailyFeatures(
          { board: pBoard, rows: pRows, cols: pCols, totalMines: pMines, activeGimmicks },
          parResult,
        );
        dailyPar = predictPar(features);
        dailyMoves = parResult.totalClicks;
        saveDailyPar(dateStr, dailyPar, dailyMoves, features);
      }
    } catch (e) { dailyPar = 0; }
  }
  return { par: dailyPar, moves: dailyMoves };
}

async function updateLeaderboardDisplay() {
  const tab = _defaultLeaderboardTab();
  _setActiveLeaderboardTab(tab);
  await _renderLeaderboardForTab(tab);
}

async function _renderLeaderboardForTab(tab) {
  if (tab === 'weekly') {
    await renderWeeklyLeaderboard(getWeekStart());
    return;
  }
  // Restore the daily-style table header in case it was last rendered
  // for the weekly tab (which repurposes Best/Played columns).
  const thead = $('#leaderboard-table thead');
  if (thead) {
    thead.innerHTML = `<tr><th>#</th><th>Name</th><th>Time</th><th class="lb-col-extra">${spriteImgHTML('strike', 'sprite-header', 'Strikes')}</th><th>Par</th><th class="lb-col-extra">Pace</th></tr>`;
  }
  const today = getLocalDateString();
  const dateStr = today;
  const headerStr = prettyDate(today);
  $('#leaderboard-date').textContent = headerStr;
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';

  let entries = null;

  if (isFirebaseOnline()) {
    entries = await fetchOnlineLeaderboard(dateStr);
  }

  if (entries === null) {
    entries = loadDailyLeaderboard(dateStr);
  }

  const hasEntries = entries.length > 0;
  $('#leaderboard-table').classList.toggle('hidden', !hasEntries);
  $('#leaderboard-empty').textContent = (dateStr === today)
    ? 'No times yet today. Be the first to finish it.'
    : 'No entries for this day.';
  $('#leaderboard-empty').classList.toggle('hidden', hasEntries);

  // Daily par + solver moves (shared with the title-card par badge).
  const { par: dailyPar, moves: dailyMoves } = await computeDailyParForDate(dateStr);

  const myUid = getUid();
  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    if (myUid && entry.uid === myUid) tr.classList.add('lb-row-mine');
    const bombCol = entry.bombHits != null
      ? `<td class="lb-col-extra">${entry.bombHits}</td>`
      : '<td class="lb-col-extra">-</td>';
    let parCol = '<td>-</td>';
    if (dailyPar > 0) {
      const delta = entry.time - dailyPar;
      const abs = Math.abs(delta).toFixed(1);
      if (delta < -0.5) parCol = `<td class="par-under">-${abs}</td>`;
      else if (delta > 0.5) parCol = `<td class="par-over">+${abs}</td>`;
      else parCol = `<td class="par-even">E</td>`;
    }
    let paceCol = '<td class="lb-col-extra">-</td>';
    if (dailyMoves > 0) {
      paceCol = `<td class="lb-col-extra">${(entry.time / dailyMoves).toFixed(1)}</td>`;
    }
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.time}s</td>${bombCol}${parCol}${paceCol}`;
    tbody.appendChild(tr);
  });

  // (History chart moved to Stats modal → Daily tab → History section.)
}

// ── Collection Display ───────────────────────────────

function renderCollectionModal() {
  const stats = loadStats();
  const maxLevel = stats.maxLevelReached || 1;

  // Themes tab — clone theme swatches from THEME_UNLOCKS
  const themeGrid = $('#collection-theme-grid');
  themeGrid.innerHTML = '';
  const unlocked = getUnlockedThemes();
  const currentTheme = state.theme;

  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch' + (theme === currentTheme ? ' active' : '') + (unlocked[theme] === false ? ' locked' : '');
    btn.dataset.theme = theme;
    const swatchColors = {
      classic: 'linear-gradient(135deg, #c0c0c0, #e0e0e0)',
      dark: 'linear-gradient(135deg, #1a1a2e, #1e2745)',
      ocean: 'linear-gradient(135deg, #1b3a4b, #1e4a5f)',
      sunset: 'linear-gradient(135deg, #2d1b2e, #3d2240)',
      forest: 'linear-gradient(135deg, #2d3a2e, #3e5a3a)',
      candy: 'linear-gradient(135deg, #fff0f5, #ffc1d3)',
      midnight: 'linear-gradient(135deg, #1a1040, #221555)',
      stealth: 'linear-gradient(135deg, #1a1a1a, #2a2a2a)',
      neon: 'linear-gradient(135deg, #0a0a0a, #1a1a1a)',
      'cherry-blossom': 'linear-gradient(135deg, #f5e6ee, #f0c4d8)',
      aurora: 'linear-gradient(135deg, #0b1628, #122040)',
      volcano: 'linear-gradient(135deg, #2a1008, #5c2210)',
      ice: 'linear-gradient(135deg, #d8eaf5, #a8ceea)',
      cyberpunk: 'linear-gradient(135deg, #0a0a1a, #1a1a3a)',
      retro: 'linear-gradient(135deg, #1a0a2e, #3a1860)',
      holographic: 'linear-gradient(135deg, #1a1a2a, #2a2a3e)',
      copper: 'linear-gradient(135deg, #1c1410, #8b5e3c)',
      sakura: 'linear-gradient(135deg, #fdf0f4, #f5c6d0)',
      galaxy: 'linear-gradient(135deg, #0a0015, #1a0838)',
      lavender: 'linear-gradient(135deg, #f0ecf8, #c8b8e0)',
      toxic: 'linear-gradient(135deg, #0a0f0a, #1a2a18)',
      autumn: 'linear-gradient(135deg, #201810, #8c5828)',
      royal: 'linear-gradient(135deg, #1e1038, #2e1a55)',
      coral: 'linear-gradient(135deg, #1c100e, #b85848)',
      emerald: 'linear-gradient(135deg, #081c14, #18603c)',
      prismatic: 'linear-gradient(135deg, #141420, #222238)',
      slate: 'linear-gradient(135deg, #1c2028, #4a5468)',
      void: 'linear-gradient(135deg, #080808, #0e0e0e)',
      arctic: 'linear-gradient(135deg, #e8f0f8, #c0d8f0)',
      deepspace: 'linear-gradient(135deg, #0a0818, #2a2050)',
      jungle: 'linear-gradient(135deg, #0c1a0c, #1e3a1e)',
      obsidian: 'linear-gradient(135deg, #000000, #111111)',
      phantom: 'linear-gradient(135deg, #101218, #2c3040)',
      matrix: 'linear-gradient(135deg, #000000, #0a1a0a)',
      solar: 'linear-gradient(135deg, #fdf8ec, #e8c850)',
      bloodmoon: 'linear-gradient(135deg, #080000, #2a0810)',
      inferno: 'linear-gradient(135deg, #0d0000, #3d1008)',
      synthwave: 'linear-gradient(135deg, #0a0020, #1a0848)',
      celestial: 'linear-gradient(135deg, #080c1a, #182040)',
      supernova: 'linear-gradient(135deg, #1a0808, #3a1810)',
      legendary: 'linear-gradient(135deg, #0e0618, #261240)',
      chaos: 'linear-gradient(135deg, #0a0a14, #1a0a2e)',
    };
    const bg = swatchColors[theme] || '#888';
    btn.innerHTML = `<span class="swatch-color" style="background: ${bg}"></span>` +
      `<span class="swatch-name">${info.displayName}</span>` +
      (unlocked[theme] === false ? `<span class="swatch-lock">🔒 Lv.${info.levelRequired}</span>` : '');
    btn.addEventListener('click', () => {
      if (unlocked[theme] === false) {
        btn.classList.add('swatch-shake');
        setTimeout(() => btn.classList.remove('swatch-shake'), 400);
        return;
      }
      state.theme = theme;
      loadThemeCSS(theme);
      document.documentElement.setAttribute('data-theme', theme);
      applyThemeEffects(theme);
      updateThemeColor();
      saveTheme(theme);
      for (const s of themeGrid.querySelectorAll('.theme-swatch')) s.classList.remove('active');
      btn.classList.add('active');
      updateAllCells();
    });
    themeGrid.appendChild(btn);
  }

  // Emoji tab
  const emojiGrid = $('#emoji-pack-grid');
  emojiGrid.innerHTML = '';
  const activePack = loadEmojiPack();

  for (const [packId, pack] of Object.entries(EMOJI_PACKS)) {
    const card = document.createElement('div');
    const packUnlocked = isPackUnlocked(packId);
    card.className = 'emoji-pack-card' + (packId === activePack ? ' active' : '') + (!packUnlocked ? ' locked' : '');
    card.innerHTML = `
      <div class="emoji-pack-preview">${pack.mine} ${pack.flag} ${pack.smiley}</div>
      <div class="emoji-pack-name">${pack.name}</div>
      ${!packUnlocked ? `<div class="emoji-pack-lock">🔒 Lv.${pack.unlock.value}</div>` : ''}
    `;
    card.addEventListener('click', () => {
      if (!packUnlocked) {
        card.classList.add('swatch-shake');
        setTimeout(() => card.classList.remove('swatch-shake'), 400);
        return;
      }
      saveEmojiPack(packId);
      invalidateEmojiCache();
      for (const c of emojiGrid.querySelectorAll('.emoji-pack-card')) c.classList.remove('active');
      card.classList.add('active');
      showToast(`Emoji pack: ${pack.name}`);
    });
    emojiGrid.appendChild(card);
  }

  // Effects tab
  const effectsConfig = loadEffects();
  for (const [category, options] of Object.entries(EFFECTS)) {
    const grid = $(`#effects-${category}`);
    if (!grid) continue;
    grid.innerHTML = '';
    for (const [effectId, effect] of Object.entries(options)) {
      const effUnlocked = isEffectUnlocked(category, effectId);
      const opt = document.createElement('div');
      opt.className = 'effect-option' + (effectsConfig[category] === effectId ? ' active' : '') + (!effUnlocked ? ' locked' : '');
      opt.innerHTML = `<span class="effect-name">${effect.name}</span>` +
        (!effUnlocked ? `<span class="effect-lock">🔒 Lv.${effect.unlock.value}</span>` : '');
      opt.addEventListener('click', () => {
        if (!effUnlocked) {
          opt.classList.add('swatch-shake');
          setTimeout(() => opt.classList.remove('swatch-shake'), 400);
          return;
        }
        effectsConfig[category] = effectId;
        saveEffects(effectsConfig);
        for (const o of grid.querySelectorAll('.effect-option')) o.classList.remove('active');
        opt.classList.add('active');
      });
      grid.appendChild(opt);
    }
  }

  // Titles tab
  const titlesGrid = $('#titles-grid');
  titlesGrid.innerHTML = '';
  const activeTitle = loadTitle();
  const titleDisplay = $('#active-title-display');

  for (const [titleId, title] of Object.entries(TITLES)) {
    const titleUnlocked = isTitleUnlocked(titleId);
    const card = document.createElement('div');
    card.className = 'title-card' + (titleId === activeTitle ? ' active' : '') + (!titleUnlocked ? ' locked' : '');
    card.innerHTML = `<span class="title-name">${title.name}</span>` +
      (!titleUnlocked ? `<span class="title-lock">🔒 Lv.${title.unlock.value}</span>` : '');
    card.addEventListener('click', () => {
      if (!titleUnlocked) {
        card.classList.add('swatch-shake');
        setTimeout(() => card.classList.remove('swatch-shake'), 400);
        return;
      }
      saveTitle(titleId);
      for (const c of titlesGrid.querySelectorAll('.title-card')) c.classList.remove('active');
      card.classList.add('active');
      if (titleDisplay) titleDisplay.textContent = `Active: ${title.name}`;
    });
    titlesGrid.appendChild(card);
  }

  if (titleDisplay) {
    const t = TITLES[activeTitle];
    titleDisplay.textContent = t ? `Active: ${t.name}` : '';
  }
}

// ── Achievements Display ──────────────────────────────

function updateAchievementsDisplay() {
  const grid = $('#achievements-grid');
  const progressFill = $('#achievement-progress-fill');
  const progressText = $('#achievement-progress-text');

  const stats = loadStats();
  const achievements = getAchievementState(stats);
  const { total, max } = getTotalScore(stats);

  progressFill.style.width = `${(total / max) * 100}%`;
  progressText.textContent = `${total} / ${max}`;

  grid.innerHTML = '';

  // Zero-state: a brand-new player sees a wall of locks. Frame it so it
  // reads as "go play" rather than "you have nothing". Most categories
  // unlock on the very first win.
  let achZero = document.getElementById('ach-zero-banner');
  if (total === 0) {
    if (!achZero) {
      achZero = document.createElement('div');
      achZero.id = 'ach-zero-banner';
      achZero.className = 'chart-empty';
      grid.parentNode.insertBefore(achZero, grid);
    }
    achZero.textContent = 'Nothing unlocked yet. Most of these fire on your very first win, so go play a game.';
  } else if (achZero) {
    achZero.remove();
  }

  for (const ach of achievements) {
    const item = document.createElement('div');
    item.className = 'achievement-category-card';

    const tierNames = getAllTierNames();
    let tiersHtml = '<div class="tier-badges">';
    for (let i = 0; i < tierNames.length; i++) {
      const isUnlocked = i <= ach.tierIndex;
      const tierName = tierNames[i];
      const icon = getTierIcon(tierName);
      const color = getTierColor(tierName);
      tiersHtml += `<span class="tier-badge ${isUnlocked ? 'unlocked' : 'locked'}" title="${tierName}" style="${isUnlocked ? `color:${color}; text-shadow: 0 0 6px ${color}40` : ''}">${icon}</span>`;
    }
    tiersHtml += '</div>';

    let progressHtml = '';
    if (ach.nextTier) {
      progressHtml = `
        <div class="ach-progress-row">
          <div class="ach-progress-bar">
            <div class="ach-progress-fill" style="width: ${ach.progress * 100}%"></div>
          </div>
          <span class="ach-progress-label">Next: ${ach.format(ach.nextValue)}</span>
        </div>
      `;
    } else {
      progressHtml = `<div class="ach-progress-label ach-maxed">Maxed Out!</div>`;
    }

    item.innerHTML = `
      <div class="ach-header">
        <span class="ach-cat-icon">${ach.icon}</span>
        <div class="ach-cat-info">
          <div class="ach-cat-name">${ach.name}</div>
          <div class="ach-cat-desc">${ach.desc}</div>
        </div>
        <span class="ach-current-tier">${ach.currentTierIcon}</span>
      </div>
      ${tiersHtml}
      ${progressHtml}
    `;
    grid.appendChild(item);
  }
}

// ── Share Card ─────────────────────────────────────────

function generateShareCard() {
  const level = state.currentLevel;
  const time = state.elapsedTime;
  const diff = state.gameMode === 'timed'
    ? getTimedDifficulty(level)
    : getDifficultyForLevel(level);
  const mode = state.gameMode;
  const modeLabel = { normal: 'Challenge', timed: 'Timed', daily: 'Daily', weekly: 'Weekly', chaos: 'Chaos' }[mode] || 'Challenge';

  const stats = loadStats();
  const streakText = stats.currentStreak > 1 ? ` | 🔥 ${stats.currentStreak} streak` : '';
  const tier = getHighestTier(stats);
  const tierText = tier ? ` | ${tier.icon} ${tier.name}` : '';

  let dateStr = '';
  if (mode === 'daily') {
    dateStr = ` (${getLocalDateString()})`;
  }

  const levelLabel = diff.label || `Level ${level}`;

  if (mode === 'daily') {
    // Four-line Wordle-style card: title + par comparison + pace bar +
    // (optional) strikes + URL. The pace bar is 8 dots where each dot
    // represents 2.5% of par (so the bar fills completely at ±20%).
    // Green fills for under-par, red for over-par; an empty bar means
    // the player landed within a couple of tenths of par exactly.
    const date = getLocalDateString();
    const par = state.dailyPar || 0;
    const lines = [`${getThemeEmoji('mine')} GregSweeper · ${date}`];

    if (par > 0) {
      const delta = time - par;
      const sign = delta >= 0 ? '+' : '−';
      const absDelta = Math.abs(delta).toFixed(1);
      lines.push(`⏱ ${time}s · par ${par.toFixed(1)}s (${sign}${absDelta}s)`);

      // Pace bar. 8 dots, each = 2.5% of par. Full bar at ±20% delta.
      const magnitude = Math.min(1, Math.abs(delta) / (par * 0.2));
      const filled = Math.round(magnitude * 8);
      const fillDot = delta <= 0 ? '🟢' : '🔴';
      lines.push(fillDot.repeat(filled) + '⚪'.repeat(8 - filled));
    } else {
      lines.push(`⏱ ${time}s`);
    }

    if (state.dailyBombHits > 0) {
      lines.push(`💥×${state.dailyBombHits}`);
    }
    lines.push(`https://christopherwells.github.io/GregSweeper/?mode=daily`);
    return lines.join('\n');
  }

  if (mode === 'timed') {
    const rating = getSpeedRating(level, time);
    return `${getThemeEmoji('mine')} GregSweeper — Timed ${levelLabel}\n` +
           `${rating.icon} ${rating.name} — ${time}s (${diff.rows}×${diff.cols})${tierText}\n\n` +
           `https://christopherwells.github.io/GregSweeper/`;
  }

  return `${getThemeEmoji('mine')} GregSweeper — ${modeLabel}\n` +
         `${levelLabel} (${diff.rows}x${diff.cols}) in ${time}s${streakText}${tierText}\n\n` +
         `https://christopherwells.github.io/GregSweeper/`;
}

function handleShare() {
  const text = generateShareCard();
  if (navigator.share) {
    navigator.share({ text }).catch(() => copyToClipboard(text));
  } else {
    copyToClipboard(text);
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showShareCopiedToast();
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showShareCopiedToast();
  });
}

function showShareCopiedToast() {
  const toast = document.createElement('div');
  toast.className = 'share-copied-toast';
  toast.textContent = '📋 Copied to clipboard!';
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ── Event Handlers ─────────────────────────────────────

// Track when a modal was opened from the title screen
let _returnToTitle = false;
// Track previous theme so we can restore it when leaving chaos
let _previousTheme = null;

function closeModalAndReturn(modalId) {
  hideModal(modalId);
  if (_returnToTitle) {
    _returnToTitle = false;
    showTitleScreen();
  }
}

let longPressTimer = null;
let longPressTriggered = false;
let lastTouchTime = 0;

boardEl.addEventListener('mousedown', (e) => {
  if (Date.now() - lastTouchTime < 500) return;
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const row = parseInt(cellEl.dataset.row);
  const col = parseInt(cellEl.dataset.col);

  if (e.button === 0) {
    const cell = state.board[row]?.[col];
    if (cell && cell.isRevealed && cell.adjacentMines > 0) {
      handleChordReveal(row, col);
    } else {
      revealCell(row, col);
    }
  }
});

boardEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const row = parseInt(cellEl.dataset.row);
  const col = parseInt(cellEl.dataset.col);
  toggleFlag(row, col);
});

// Touch support: tap to reveal, long press to flag
let touchedCellRow = null;
let touchedCellCol = null;
let touchStartX = 0;
let touchStartY = 0;
let touchedCellEl = null;

boardEl.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  const cellEl = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.cell');
  if (!cellEl) return;
  e.preventDefault();

  longPressTriggered = false;
  touchedCellRow = parseInt(cellEl.dataset.row);
  touchedCellCol = parseInt(cellEl.dataset.col);
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchedCellEl = cellEl;

  cellEl.classList.add('touch-holding');

  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    if (touchedCellEl) {
      touchedCellEl.classList.remove('touch-holding');
      touchedCellEl = null;
    }
    if (touchedCellRow != null && touchedCellCol != null) {
      toggleFlag(touchedCellRow, touchedCellCol);
      haptic([40]);
    }
  }, 300);
}, { passive: false });

boardEl.addEventListener('touchend', (e) => {
  lastTouchTime = Date.now();
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (touchedCellEl) { touchedCellEl.classList.remove('touch-holding'); touchedCellEl = null; }
  if (longPressTriggered) {
    longPressTriggered = false;
    touchedCellRow = null;
    touchedCellCol = null;
    e.preventDefault();
    return;
  }
  if (touchedCellRow == null || touchedCellCol == null) return;
  e.preventDefault();
  const row = touchedCellRow;
  const col = touchedCellCol;
  touchedCellRow = null;
  touchedCellCol = null;

  const cell = state.board[row]?.[col];
  if (cell && cell.isRevealed && cell.adjacentMines > 0) {
    handleChordReveal(row, col);
  } else if (state.flagMode && !cell?.isRevealed) {
    toggleFlag(row, col);
  } else {
    revealCell(row, col);
  }
});

boardEl.addEventListener('touchmove', (e) => {
  const touch = e.touches[0];
  const dx = Math.abs(touch.clientX - touchStartX);
  const dy = Math.abs(touch.clientY - touchStartY);
  if (dx > 20 || dy > 20) {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (touchedCellEl) { touchedCellEl.classList.remove('touch-holding'); touchedCellEl = null; }
    touchedCellRow = null;
    touchedCellCol = null;
  }
}, { passive: true });

// touchcancel fires when the OS takes the gesture away (modal opens, scroll
// handoff, incoming call). Without this, the long-press timer stays armed
// and the holding-class stays painted until the next interaction.
boardEl.addEventListener('touchcancel', () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (touchedCellEl) { touchedCellEl.classList.remove('touch-holding'); touchedCellEl = null; }
  touchedCellRow = null;
  touchedCellCol = null;
  longPressTriggered = false;
}, { passive: true });

// ── Keyboard Navigation ─────────────────────────────
boardEl.addEventListener('keydown', (e) => {
  // Only handle when board is active
  if (state.status !== 'idle' && state.status !== 'playing') return;
  let r = state.focusedRow;
  let c = state.focusedCol;
  let handled = true;

  switch (e.key) {
    case 'ArrowUp':    r = Math.max(0, r - 1); break;
    case 'ArrowDown':  r = Math.min(state.rows - 1, r + 1); break;
    case 'ArrowLeft':  c = Math.max(0, c - 1); break;
    case 'ArrowRight': c = Math.min(state.cols - 1, c + 1); break;
    case 'Enter':
    case ' ': {
      // Reveal or chord
      const cell = state.board[r]?.[c];
      if (cell && cell.isRevealed && cell.adjacentMines > 0) {
        handleChordReveal(r, c);
      } else {
        revealCell(r, c);
      }
      break;
    }
    case 'f':
    case 'F':
      toggleFlag(r, c);
      break;
    default:
      handled = false;
  }

  if (handled) {
    e.preventDefault();
    if (r !== state.focusedRow || c !== state.focusedCol) {
      setFocusedCell(r, c);
    }
  }
});

resetBtn.addEventListener('click', () => {
  resetBtn.classList.add('smiley-pressed');
  setTimeout(() => resetBtn.classList.remove('smiley-pressed'), 150);
  // Daily/Weekly are canonical single-puzzle modes — no reset. The smiley
  // is rendered disabled in these modes (see updateHeader); this guard is
  // the parallel safeguard against any pre-first-render click.
  if (state.gameMode === 'daily' || state.gameMode === 'weekly') return;
  if (state.gameMode === 'normal') {
    state.currentLevel = state.checkpoint || loadCheckpoint(state.gameMode) || 1;
  } else {
    state.currentLevel = 1;
  }
  newGame();
});

// Power-up buttons
for (const btn of $$('.powerup-btn')) {
  btn.addEventListener('click', () => {
    const type = btn.dataset.powerup;
    if (type === 'revealSafe') useRevealSafe();
    else if (type === 'shield') useShield();
    else if (type === 'scanRowCol') activateScan();
    else if (type === 'magnet') activateMagnet();
    else if (type === 'xray') activateXRay();
  });
}

// Flag mode toggle
if (flagModeToggle) {
  flagModeToggle.addEventListener('click', () => {
    state.flagMode = !state.flagMode;
    updateFlagModeBar();
  });
}

// Zoom controls
$('#zoom-in').addEventListener('click', zoomIn);
$('#zoom-out').addEventListener('click', zoomOut);

// Pinch-to-zoom for touch devices
let pinchStartDist = 0;
let pinchStartZoom = 100;
boardScrollWrapper.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStartDist = Math.hypot(dx, dy);
    pinchStartZoom = state.zoomLevel;
  }
}, { passive: true });
boardScrollWrapper.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && needsZoom()) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    const ratio = dist / pinchStartDist;
    state.zoomLevel = Math.round(Math.min(200, Math.max(50, pinchStartZoom * ratio)));
    updateZoom();
  }
}, { passive: true });

// Nav buttons
$('#btn-home').addEventListener('click', () => {
  showTitleScreen();
});
$('#btn-settings').addEventListener('click', () => {
  setActiveSettingsTab('general');
  showModal('settings-modal');
  // Refresh the daily-reminder toggle's state from Firebase whenever
  // the Settings modal opens — covers the case where prefs were
  // updated on another device or the auth uid resolved late.
  syncReminderUI();
  _updateSettingsUid();
  _updateSettingsAccount();
});
$('#btn-stats').addEventListener('click', () => {
  updateStatsDisplay();
  showModal('stats-modal');
});
$('#btn-achievements').addEventListener('click', () => {
  updateAchievementsDisplay();
  showModal('achievements-modal');
});
$('#btn-leaderboard').addEventListener('click', () => {
  updateLeaderboardDisplay();
  showModal('leaderboard-modal');
});

// Leaderboard tab clicks: switch between Daily / Weekly views
// without closing the modal. The active tab is set by both the click
// and by updateLeaderboardDisplay's default-tab logic; clicking just
// re-renders the body for the picked tab.
for (const tabBtn of $$('.leaderboard-tab')) {
  tabBtn.addEventListener('click', () => {
    const tab = tabBtn.dataset.lbTab;
    if (!tab) return;
    _setActiveLeaderboardTab(tab);
    _renderLeaderboardForTab(tab);
  });
}
$('#btn-collection').addEventListener('click', () => {
  renderCollectionModal();
  showModal('collection-modal');
});
$('#btn-help').addEventListener('click', () => { setActiveHelpTab('basics'); showModal('help-modal'); });
$('#title-bar').addEventListener('click', () => showModal('about-modal'));

// Collection tab switching
for (const tab of $$('.collection-tab')) {
  tab.addEventListener('click', () => {
    for (const t of $$('.collection-tab')) {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    }
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const panels = ['themes', 'emoji', 'effects', 'titles'];
    for (const p of panels) {
      $(`#collection-${p}`).classList.toggle('hidden', p !== tab.dataset.tab);
    }
  });
}

// Close modals
for (const closeBtn of $$('.modal-close')) {
  closeBtn.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal');
    if (modal) closeModalAndReturn(modal.id);
  });
}
for (const modal of $$('.modal')) {
  modal.addEventListener('click', (e) => {
    if (e.target === modal && modal.id !== 'gameover-overlay') {
      // Don't close if user is typing in an input inside the modal (mobile keyboard can cause stray taps)
      const active = document.activeElement;
      if (active && modal.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      closeModalAndReturn(modal.id);
    }
  });
}

// Mode selection handled by title screen mode cards (see below)

// Quick Play size tabs (above board)
for (const tab of $$('.timed-tab')) {
  tab.addEventListener('click', () => {
    const level = parseInt(tab.dataset.level, 10);
    state.currentLevel = level;
    for (const t of $$('.timed-tab')) t.classList.remove('active');
    tab.classList.add('active');
    // Sync settings modal buttons
    for (const d of $$('.timed-diff-btn')) d.classList.toggle('active', parseInt(d.dataset.level, 10) === level);
    newGame();
  });
}

// Quick Play timer toggle
const timerToggleBtn = $('#timer-toggle');
if (timerToggleBtn) {
  timerToggleBtn.addEventListener('click', () => {
    state.timerHidden = !state.timerHidden;
    timerToggleBtn.classList.toggle('timer-off', state.timerHidden);
    const timerEl = $('#timer-display');
    if (timerEl) {
      timerEl.style.visibility = state.timerHidden ? 'hidden' : 'visible';
    }
  });
}

// ── Title Screen ──────────────────────────────────────

// Today's Greg-par for the Daily card subtitle. Resolved once per date
// per session (the solve is not free) by refreshTitleDailyPar(); read
// synchronously by updateTitleProgress().
let _titleDailyPar = { date: null, secs: 0 };

function updateTitleProgress() {
  const stats = loadStats();
  const challengeEl = $('#title-challenge-progress');
  const timedEl = $('#title-timed-progress');
  const dailyEl = $('#title-daily-progress');

  if (challengeEl) {
    const cLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
    challengeEl.textContent = `Level ${cLevel} · ${Math.min(100, Math.round(cLevel / MAX_LEVEL * 100))}%`;
  }
  if (timedEl) {
    const tWins = stats.modeStats?.timed?.wins || 0;
    timedEl.textContent = tWins > 0 ? `${tWins} wins` : 'Race the clock';
  }
  if (dailyEl) {
    const today = getLocalDateString();
    const dailyCard = $('.mode-card[data-mode="daily"]');
    const { streak } = getDailyStreak();
    const parLine = (_titleDailyPar.date === today && _titleDailyPar.secs > 0)
      ? `<span class="mode-card-par">Par: ${_titleDailyPar.secs} seconds</span>`
      : '';
    const completed = isDailyCompleted(today);
    let descriptor;
    if (completed) {
      descriptor = streak > 0 ? `Completed! 🔥 ${streak} day streak` : 'Completed today!';
    } else {
      descriptor = streak > 0 ? `🔥 ${streak} day streak` : 'Same puzzle worldwide';
    }
    dailyEl.innerHTML = descriptor + parLine;
    if (dailyCard) dailyCard.classList.toggle('daily-completed', completed);
  }

  // Weekly card — always visible. Shows attempts used and best time
  // when the gate has populated state.cachedWeeklyDayAttempts and
  // state.weeklyDayTimes (both pre-fetched at startup).
  const weeklyCard = $('.mode-card[data-mode="weekly"]');
  const weeklyProgressEl = $('#title-weekly-progress');
  if (weeklyCard && weeklyProgressEl) {
    const dayIdx = getWeekDayIndex();
    const attempts = state.cachedWeeklyDayAttempts || {};
    const used = Object.keys(attempts).length;
    const todayAlreadyAttempted = !!attempts[dayIdx];
    if (todayAlreadyAttempted) {
      weeklyProgressEl.textContent = used >= 7 ? `Done · ${used}/7` : `Played today · ${used}/7`;
      weeklyCard.classList.add('daily-completed');
    } else if (used > 0) {
      weeklyProgressEl.textContent = `Play today · ${used}/7 used`;
      weeklyCard.classList.remove('daily-completed');
    } else {
      weeklyProgressEl.textContent = 'Same puzzle all week. Your best run wins.';
      weeklyCard.classList.remove('daily-completed');
    }
  }

  // Chaos mode card
  const chaosEl = $('#title-chaos-progress');
  const chaosCard = $('.mode-card[data-mode="chaos"]');
  if (chaosCard) {
    const unlocked = isChaosUnlocked();
    if (unlocked) {
      chaosCard.classList.remove('mode-card-locked');
      chaosCard.style.display = '';
      const chaosStats = stats.modeStats?.chaos;
      const bestRun = chaosStats?.bestRun || 0;
      const totalRuns = chaosStats?.totalRuns || 0;
      if (chaosEl) {
        chaosEl.textContent = totalRuns > 0
          ? `Best: ${bestRun} board${bestRun !== 1 ? 's' : ''} · ${totalRuns} run${totalRuns !== 1 ? 's' : ''}`
          : 'Roguelike madness';
      }
    } else {
      chaosCard.style.display = 'none';
    }
  }
}

// Restores the pre-chaos theme if it was stashed when entering chaos.
// Exported so it can fire on any path that leaves chaos (title screen,
// checkpoint selector, direct switchMode), not just title-screen returns.
// Conditional on _previousTheme so it's idempotent and safe to call always.
export function restorePreChaosTheme() {
  if (!_previousTheme) return;
  document.documentElement.setAttribute('data-theme', _previousTheme);
  applyThemeEffects(_previousTheme);
  updateThemeColor();
  _previousTheme = null;
}

function showTitleScreen() {
  const titleScreen = $('#title-screen');
  const app = $('#app');
  if (!titleScreen || !app) return;

  // Persist current game state before showing title (guard is inside persistGameState)
  persistGameState();

  restorePreChaosTheme();

  // Idle-pause overlay is a gameplay-only surface — if it was left up by
  // a paused-then-Home-buttoned game, hide it explicitly when the title
  // screen comes back. The _pauseForIdle path is already status-gated to
  // 'playing', so this only matters when stale state survives navigation.
  const idleOverlay = document.getElementById('idle-pause-overlay');
  if (idleOverlay) idleOverlay.classList.add('hidden');
  state.idlePaused = false;

  updateTitleProgress();
  refreshTitleDailyPar(); // fills in "Par: N seconds" once resolved
  titleScreen.classList.remove('hidden');
  app.classList.add('hidden');
}

// Resolve today's Greg-par for the Daily card, once per date per
// session. Fire-and-forget: the title shows immediately with the
// fallback subtitle, then the par badge fills in when this resolves.
async function refreshTitleDailyPar() {
  const today = getLocalDateString();
  if (_titleDailyPar.date === today && _titleDailyPar.secs > 0) return;
  try {
    const { par } = await computeDailyParForDate(today, true);
    if (par > 0) {
      _titleDailyPar = { date: today, secs: Math.round(par) };
      updateTitleProgress();
    }
  } catch { /* keep the fallback subtitle */ }
}

// Draw the player's eye to the Daily card after onboarding. Adds a
// pulsing-glow class for ~5 seconds, removed early on first click.
// Called once at end-of-tutorial; subsequent title-screen visits are
// unaffected.
function spotlightDailyCard() {
  const dailyCard = document.querySelector('.mode-card[data-mode="daily"]');
  if (!dailyCard) return;
  dailyCard.classList.add('spotlight');
  const cleanup = () => dailyCard.classList.remove('spotlight');
  setTimeout(cleanup, 5000);
  dailyCard.addEventListener('click', cleanup, { once: true });
}

function hideTitleScreen() {
  const titleScreen = $('#title-screen');
  const app = $('#app');
  if (!titleScreen || !app) return;

  titleScreen.classList.add('hidden');
  app.classList.remove('hidden');

  // Re-apply theme effects now that #board is visible
  // (applyThemeEffects silently returns if called during title screen since #board doesn't exist)
  const activeTheme = document.documentElement.getAttribute('data-theme') || 'classic';
  applyThemeEffects(activeTheme);
}

// ── Checkpoint Selector (Challenge mode) ────────────────
// Built dynamically from GIMMICK_DEFS (no duplicated icon/name data)
const GIMMICK_LABELS = (() => {
  const labels = {};
  for (const [key, def] of Object.entries(getGimmickDefs())) {
    if (!def.chaosOnly) labels[def.intro] = { icon: def.icon, name: def.name };
  }
  return labels;
})()

function showCheckpointSelector() {
  const stats = loadStats();
  const maxLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
  // maxLevelReached is the level you WON — the next level you'd play is maxLevel + 1
  const nextPlayable = Math.min(maxLevel + 1, MAX_LEVEL);
  const savedGame = loadGameState('normal');
  const hasSavedGame = !!(savedGame && savedGame.board && savedGame.gameMode);

  const resumeEl = $('#checkpoint-resume');
  const listEl = $('#checkpoint-list');

  // Resume button (if a saved game exists)
  if (hasSavedGame) {
    resumeEl.classList.remove('hidden');
    resumeEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'checkpoint-resume-btn';
    btn.innerHTML = `<span class="resume-icon">▶️</span><span class="resume-label">Resume Game<br><span class="resume-level">Level ${savedGame.currentLevel}</span></span>`;
    btn.addEventListener('click', () => {
      hideModal('checkpoint-modal');
      hideTitleScreen();
      switchMode('normal');
    });
    resumeEl.appendChild(btn);
  } else {
    resumeEl.classList.add('hidden');
  }

  // Checkpoint list
  listEl.innerHTML = '';
  const highestCheckpoint = getCheckpointForLevel(nextPlayable);

  for (let cp = 1; cp <= MAX_LEVEL; cp += CHECKPOINT_INTERVAL) {
    const unlocked = cp <= highestCheckpoint || cp === 1;
    const btn = document.createElement('button');
    btn.className = 'checkpoint-btn' + (unlocked ? '' : ' checkpoint-locked');

    // Build label
    let levelText = `Level ${cp}`;
    if (cp + CHECKPOINT_INTERVAL - 1 <= MAX_LEVEL) {
      levelText = `Level ${cp}–${Math.min(cp + CHECKPOINT_INTERVAL - 1, MAX_LEVEL)}`;
    }

    const gimmick = GIMMICK_LABELS[cp];
    let modifierHtml = '';
    if (gimmick) {
      modifierHtml = `<span class="cp-modifier"><span class="cp-modifier-icon">${gimmick.icon}</span> ${gimmick.name}</span>`;
    } else if (!unlocked) {
      modifierHtml = `<span class="cp-modifier">Reach Level ${cp}</span>`;
    }

    btn.innerHTML = `<span class="cp-level">${levelText}</span>${modifierHtml}`;

    if (unlocked) {
      btn.addEventListener('click', () => {
        hideModal('checkpoint-modal');
        hideTitleScreen();
        state.gameMode = 'normal';
        updateModeUI('normal');
        state.currentLevel = cp;
        newGame();
      });
    }

    listEl.appendChild(btn);

    // Stop after last unlocked + one row of locked (show a few locked ones as tease)
    if (!unlocked && cp > highestCheckpoint + CHECKPOINT_INTERVAL * 2) break;
  }

  showModal('checkpoint-modal');
}

// Checkpoint modal close button
const cpModal = $('#checkpoint-modal');
if (cpModal) {
  cpModal.querySelector('.modal-close')?.addEventListener('click', () => hideModal('checkpoint-modal'));
  cpModal.addEventListener('click', (e) => {
    if (e.target === cpModal) hideModal('checkpoint-modal');
  });
}

// Title screen mode cards
for (const card of $$('.mode-card')) {
  card.addEventListener('click', () => {
    const mode = card.dataset.mode;
    if (mode === 'normal') {
      showCheckpointSelector();
      return;
    }
    if (mode === 'chaos') {
      if (!isChaosUnlocked()) {
        showToast(`Reach Challenge Level ${CHAOS_UNLOCK_LEVEL} to unlock Chaos mode!`);
        return;
      }
      // Apply chaos theme automatically
      _previousTheme = state.theme;
      document.documentElement.setAttribute('data-theme', 'chaos');
      loadThemeCSS('chaos');
      applyThemeEffects('chaos');
      updateThemeColor();
      hideTitleScreen();
      switchMode('chaos');
      return;
    }
    if (mode === 'daily') {
      const today = getLocalDateString();
      if (isDailyCompleted(today)) {
        showToast("Already done for today. Weekly's open if you want more.");
        return;
      }
      state.dailySeed = null;
      state.dailyRngSeed = null;
    }
    if (mode === 'weekly') {
      const weekStart = getWeekStart();
      const dayIdx = getWeekDayIndex();
      // Cloud-synced gate: refuse a second attempt on the same day.
      if (state.cachedWeeklyDayAttempts && state.cachedWeeklyDayAttempts[dayIdx]) {
        showToast("You've already played today's weekly puzzle. Come back tomorrow!");
        return;
      }
      // Set up weekly state BEFORE switchMode so newGame's weekly branch
      // sees the weekStart + day index when it resolves the canonical.
      state.gameMode = 'weekly';
      state.weeklySeed = weekStart;
      state.weeklyDay = dayIdx;
      state.isDailyPractice = false;
      hideTitleScreen();
      switchMode('weekly');
      return;
    }
    hideTitleScreen();
    switchMode(mode);
  });
}

// Title screen footer buttons — open modals on top of title screen
// Settings/Stats/Collection modals live outside #app (in the HTML) so they
// render regardless of #app's visibility, with z-index above the title screen.
function showModalFromTitle(modalId) {
  _returnToTitle = true;
  showModal(modalId);
}

const titleHelpBtn = $('#title-help-btn');
if (titleHelpBtn) {
  titleHelpBtn.addEventListener('click', () => { setActiveHelpTab('basics'); showModalFromTitle('help-modal'); });
}
const titleSettingsBtn = $('#title-settings-btn');
if (titleSettingsBtn) {
  titleSettingsBtn.addEventListener('click', () => {
    // Load saved player name into settings input
    const nameInput = $('#player-name-input');
    if (nameInput) nameInput.value = getPlayerName();
    setActiveSettingsTab('general');
    showModalFromTitle('settings-modal');
    syncReminderUI();
    _updateSettingsUid();
    _updateSettingsAccount();
  });
}
const titleWhatsnewBtn = $('#title-whatsnew-btn');
if (titleWhatsnewBtn) {
  titleWhatsnewBtn.addEventListener('click', () => {
    setLastSeenVersion(CURRENT_VERSION);
    // Remove NEW badge if present
    const badge = titleWhatsnewBtn.querySelector('.whatsnew-badge');
    if (badge) badge.remove();
    showModalFromTitle('whatsnew-modal');
  });
  // Show NEW badge ONLY for returning visitors who saw an older
  // version. First-time visitors (lastSeen empty) get no badge —
  // they haven't missed anything, the NEW label would just confuse.
  // Mark them as "having seen" the current version so the badge
  // never fires for them retroactively after the next deploy.
  const lastSeen = getLastSeenVersion();
  if (!lastSeen) {
    setLastSeenVersion(CURRENT_VERSION);
  } else if (lastSeen !== CURRENT_VERSION) {
    const badge = document.createElement('span');
    badge.className = 'whatsnew-badge';
    badge.textContent = 'NEW';
    titleWhatsnewBtn.appendChild(badge);
  }
}
const titleStatsBtn = $('#title-stats-btn');
if (titleStatsBtn) {
  titleStatsBtn.addEventListener('click', () => {
    updateStatsDisplay();
    showModalFromTitle('stats-modal');
  });
}
const titleCollectionBtn = $('#title-collection-btn');
if (titleCollectionBtn) {
  titleCollectionBtn.addEventListener('click', () => {
    renderCollectionModal();
    showModalFromTitle('collection-modal');
  });
}
const titleAchievementsBtn = $('#title-achievements-btn');
if (titleAchievementsBtn) {
  titleAchievementsBtn.addEventListener('click', () => {
    updateAchievementsDisplay();
    showModalFromTitle('achievements-modal');
  });
}
const titleLeaderboardBtn = $('#title-leaderboard-btn');
if (titleLeaderboardBtn) {
  titleLeaderboardBtn.addEventListener('click', () => {
    updateLeaderboardDisplay();
    showModalFromTitle('leaderboard-modal');
  });
}

// Clear Cache & Reload
$('#btn-clear-cache').addEventListener('click', () => {
  if (window.gregsweeperCacheClear) window.gregsweeperCacheClear();
});

// Replay the tutorial on demand. Always includes the warm-up board
// (the Settings hint promises it), independent of the one-time
// onboarding gates. Routes back to the title screen when done.
$('#btn-replay-tutorial').addEventListener('click', () => {
  $('#settings-modal').classList.add('hidden');
  _returnToTitle = false;
  startTutorial(() => startWarmup(() => showTitleScreen()));
});

// Diagnostics — ground-truth snapshot of what this device sees. Dynamic
// import so the module stays off the critical load path until opened.
$('#btn-diagnostics').addEventListener('click', async () => {
  $('#settings-modal').classList.add('hidden');
  const m = await import('./ui/diagnosticsModal.js');
  m.openDiagnosticsModal(CURRENT_VERSION);
});

// Report-a-problem: open a new GH issue with device state pre-filled in
// the body. The user reviews + edits before submitting; nothing is sent
// to GitHub until they click "Submit new issue" on github.com itself.
// Closes the "find Christopher's email in the commit log" UX hole.
$('#btn-report-problem').addEventListener('click', () => {
  const uid = getUid() || 'not-signed-in';
  const codeVersion = state.codeVersion || CURRENT_VERSION || 'unknown';
  const ua = navigator.userAgent || 'unknown';
  const theme = localStorage.getItem('minesweeper_theme') || 'classic';
  const mode = state.gameMode || 'idle';
  const url = window.location.href;
  const ts = new Date().toISOString();
  const body = [
    '<!-- Describe what you saw, what you expected, and how to reproduce. -->',
    '',
    '',
    '---',
    '**Device state at time of report (auto-filled, edit if anything is sensitive):**',
    '',
    '```',
    `version: ${codeVersion}`,
    `mode:    ${mode}`,
    `theme:   ${theme}`,
    `uid:     ${uid.slice(0, 8)}...`,
    `ua:      ${ua}`,
    `url:     ${url}`,
    `ts:      ${ts}`,
    '```',
  ].join('\n');
  const ghUrl = 'https://github.com/christopherwells/GregSweeper/issues/new?'
    + 'title=' + encodeURIComponent('Bug: ')
    + '&body=' + encodeURIComponent(body)
    + '&labels=bug,from-app';
  window.open(ghUrl, '_blank', 'noopener,noreferrer');
});

// ── Account section in Settings ────────────────────────
// Renders one of two views based on whether the user is signed in via
// a permanent provider (Google / Email link) or still anonymous.

function _updateSettingsAccount() {
  const signedOut = $('#account-signed-out');
  const signedIn = $('#account-signed-in');
  if (!signedOut || !signedIn) return;
  const auth = getAuthState();
  if (auth.uid && !auth.isAnonymous) {
    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');
    const emailEl = $('#account-email');
    const providerEl = $('#account-provider');
    if (emailEl) emailEl.textContent = auth.email || auth.displayName || 'signed in';
    if (providerEl) providerEl.textContent = `Signed in via ${auth.providerLabel}. Your streak and progress sync across devices.`;
  } else {
    signedIn.classList.add('hidden');
    signedOut.classList.remove('hidden');
    // Reset transient sub-views (email form, "check your email" hint)
    const form = $('#email-link-form');
    const sent = $('#email-link-sent');
    if (form) form.classList.add('hidden');
    if (sent) sent.classList.add('hidden');
    const input = $('#email-link-input');
    if (input) input.value = '';
  }
}

// Confirmation modal shared by:
//   (a) the credential-already-in-use prompt when a second device tries
//       to sign in to an account that already exists
//   (b) the "enter your email" prompt when an email-link is clicked on
//       a device that didn't request the link (no localStorage stash)
// Returns a Promise resolving to either `true` / `string` (the typed
// email) on confirm, or `false` on cancel.
function openAccountConfirmModal({ title, body, okLabel = 'Continue', cancelLabel = 'Cancel', input = false, inputPlaceholder = 'you@example.com', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#account-confirm-modal');
    const titleEl = $('#account-confirm-title');
    const bodyEl = $('#account-confirm-body');
    const inputWrap = $('#account-confirm-input-wrap');
    const inputEl = $('#account-confirm-input');
    const okBtn = $('#account-confirm-ok');
    const cancelBtn = $('#account-confirm-cancel');
    if (!modal || !okBtn || !cancelBtn) { resolve(false); return; }

    titleEl.textContent = title || 'Confirm';
    bodyEl.innerHTML = body || '';
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle('reset-profile-btn', danger);
    okBtn.classList.toggle('clear-cache-btn', !danger);
    okBtn.classList.toggle('account-btn-inline', true);
    if (input) {
      inputWrap.classList.remove('hidden');
      inputEl.value = '';
      inputEl.placeholder = inputPlaceholder;
      setTimeout(() => inputEl.focus(), 50);
    } else {
      inputWrap.classList.add('hidden');
    }

    const cleanup = () => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl?.removeEventListener('keydown', onKey);
    };
    const onOk = () => {
      const value = input ? (inputEl.value || '').trim() : true;
      cleanup();
      resolve(value || false);
    };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    inputEl?.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
  });
}

// Used by linkWithGoogle / tryCompleteEmailLink. Renders the warning
// that signing in will abandon the device's current anonymous data.
async function _confirmCredentialConflict({ providerLabel, email }) {
  const safeEmail = email ? _escapeHtml(String(email)) : '';
  const safeProvider = _escapeHtml(String(providerLabel || 'this'));
  const who = safeEmail
    ? `the ${safeProvider} account <strong>${safeEmail}</strong>`
    : `that ${safeProvider} account`;
  return await openAccountConfirmModal({
    title: 'Switch to existing account?',
    body:
      `An account already exists for ${who}. Signing in here will switch this device to that account — your phone's streak, history, and progress will appear here.` +
      `<br><br><strong>Any progress this device has made anonymously will be lost.</strong>`,
    okLabel: 'Continue',
    danger: true,
  });
}

function _escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Used by tryCompleteEmailLink when the click-destination device doesn't
// have the email stashed in localStorage (link sent from another device).
async function _promptForEmailLinkEmail() {
  const value = await openAccountConfirmModal({
    title: 'Enter your email to finish signing in',
    body: 'For security, please confirm the email you used to request this sign-in link.',
    okLabel: 'Sign in',
    input: true,
  });
  return typeof value === 'string' ? value : null;
}

// Google sign-in button. Shown only when anonymous.
$('#btn-signin-google')?.addEventListener('click', async () => {
  const btn = $('#btn-signin-google');
  btn.disabled = true;
  const result = await linkWithGoogle({ onCredentialConflict: _confirmCredentialConflict });
  btn.disabled = false;
  if (result.status === 'linked' || result.status === 'switched') {
    showToast(`Signed in as ${result.email || 'your account'}`);
    _updateSettingsAccount();
    _updateSettingsUid();
  } else if (result.status === 'popup-blocked') {
    showToast('Popup blocked — try again or use email link');
  } else if (result.status === 'error') {
    showToast(`Sign-in failed: ${result.message || 'unknown error'}`);
  }
  // cancelled / popup-closed → silent
});

// Email link sign-in button — reveals the email input form. Send button
// fires off the email; "Check your email" hint appears below.
$('#btn-signin-email')?.addEventListener('click', () => {
  $('#email-link-form')?.classList.remove('hidden');
  $('#email-link-sent')?.classList.add('hidden');
  setTimeout(() => $('#email-link-input')?.focus(), 50);
});
$('#btn-cancel-email-link')?.addEventListener('click', () => {
  $('#email-link-form')?.classList.add('hidden');
  $('#email-link-input').value = '';
});
$('#btn-send-email-link')?.addEventListener('click', async () => {
  const input = $('#email-link-input');
  const email = (input?.value || '').trim();
  const btn = $('#btn-send-email-link');
  btn.disabled = true;
  const result = await sendEmailLink(email);
  btn.disabled = false;
  if (result.status === 'sent') {
    $('#email-link-form')?.classList.add('hidden');
    $('#email-link-sent')?.classList.remove('hidden');
  } else if (result.status === 'invalid-email') {
    showToast('Please enter a valid email address');
  } else {
    showToast(`Couldn't send link: ${result.message || 'try again'}`);
  }
});
$('#email-link-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#btn-send-email-link')?.click();
  }
});

// Sign out — pre-clears push subscription, signs out, re-anonymizes.
$('#btn-signout')?.addEventListener('click', async () => {
  const confirmed = await openAccountConfirmModal({
    title: 'Sign out?',
    body: 'You\'ll go back to playing as an anonymous device. Your synced progress stays with your account — sign in again to bring it back.',
    okLabel: 'Sign out',
    danger: true,
  });
  if (!confirmed) return;
  const btn = $('#btn-signout');
  btn.disabled = true;
  await authSignOut();
  btn.disabled = false;
  showToast('Signed out');
  _updateSettingsAccount();
  _updateSettingsUid();
});

// Refresh the Account section whenever auth state changes, so a
// background link/switch (e.g. from tryCompleteEmailLink at boot)
// flips the Settings UI without the user having to close + reopen.
subscribeAuthState(() => {
  _updateSettingsAccount();
  _updateSettingsUid();
});

// When the uid switches mid-session (sign-in from a second device), reload
// the new uid's progress and apply it. applyCloudProgress takes max-merge
// across fields, so the user's higher checkpoint stays even on switch and
// the streak / lastDailyDate adopt the newer (cloud) values.
subscribeToUidChanges(async ({ uid, isInitial }) => {
  if (isInitial) return; // initial load is handled by the existing init() chain
  if (!uid) return;
  try {
    const cloud = await loadProgress();
    if (cloud) applyCloudProgress(cloud);
    // Re-prime the daily-residuals cache so the personal-par estimate
    // catches up to the new account's recent plays right away.
    const { backfillResidualsFromFirebase } = await import('./logic/handicaps.js');
    backfillResidualsFromFirebase(uid).catch(() => {});
    // applyCloudProgress wrote the merged streak / checkpoint values to
    // localStorage, but the UI on screen was rendered with the OLD uid's
    // numbers. Refresh the title screen + header so the player sees the
    // adopted streak immediately instead of having to reload.
    try { updateTitleProgress(); } catch {}
    try { updateHeader(); } catch {}
  } catch (err) {
    console.warn('post-switch progress reload failed:', err && err.message);
  }
});

// Settings → render the anonymous uid + click-to-copy. GDPR Recital 30
// treats the anonymous Firebase auth uid as personal data; the user has
// a right to see it. Short form by default; clicking copies the full
// uid to clipboard for use in right-to-erasure requests.
function _updateSettingsUid() {
  const el = $('#settings-uid-display');
  if (!el) return;
  const uid = getUid();
  if (uid) {
    el.textContent = uid.slice(0, 8) + '…' + uid.slice(-4);
    el.dataset.fullUid = uid;
    el.title = 'Click to copy full ID';
  } else {
    el.textContent = 'not yet signed in';
    delete el.dataset.fullUid;
    el.title = '';
  }
}
$('#settings-uid-display').addEventListener('click', async () => {
  const el = $('#settings-uid-display');
  const full = el?.dataset.fullUid;
  if (!full) return;
  try {
    await navigator.clipboard.writeText(full);
    showToast('Anonymous ID copied');
  } catch {
    showToast('Couldn\'t copy — long-press the ID and Copy manually');
  }
});

// Delete my data (server-side). Opens a pre-filled email with the user's
// anonymous uid so Christopher can run scripts/delete-user-data.mjs against
// it. Privacy policy commits to 30-day turnaround. Inline scrub would need
// either a Cloud Function or a Firebase write that's broad enough to defeat
// auth scoping — the email path keeps the user-side change tiny and the
// server-side change auditable.
$('#btn-delete-my-data').addEventListener('click', () => {
  const uid = getUid() || 'unknown-uid';
  const subject = 'GregSweeper: delete my data';
  const body = [
    'Please delete all data associated with my anonymous GregSweeper ID:',
    '',
    `  ${uid}`,
    '',
    'I understand this removes my leaderboard rows, weekly best-times,',
    'and progress from Firebase. It cannot be undone.',
    '',
    '(Privacy policy: https://christopherwells.github.io/GregSweeper/privacy.html)',
  ].join('\n');
  const url = 'mailto:christopher.wells.23@gmail.com'
    + '?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(body);
  window.location.href = url;
});

// Reset Profile
$('#btn-reset-profile').addEventListener('click', () => {
  if (confirm('Are you sure you want to reset your profile? This will erase ALL stats, achievements, and leaderboard data. This cannot be undone.')) {
    _returnToTitle = false; // Stay in game after reset
    resetStats();
    state.theme = 'classic';
    document.documentElement.setAttribute('data-theme', 'classic');
    applyThemeEffects('classic');
    updateThemeColor();
    saveTheme('classic');
    state.currentLevel = 1;
    state.powerUps = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
    updatePowerUpBar();
    newGame();
    $('#settings-modal').classList.add('hidden');
    hideTitleScreen(); // Show the game after reset
  }
});

// Game over actions
$('#gameover-retry').addEventListener('click', () => {
  const postDeathBar = $('#post-death-bar');
  if (postDeathBar) postDeathBar.classList.add('hidden');
  // Weekly: refuse a fresh attempt if today's slot has already been
  // used. The reset (smiley) button and the mode-card handler both
  // enforce this; the Play Again button on the gameover modal was the
  // only gameplay entry-point that didn't, so clicking Play Again
  // after a weekly win spawned a second attempt for the same day.
  if (state.gameMode === 'weekly') {
    const dayIdx = getWeekDayIndex();
    if (state.cachedWeeklyDayAttempts && state.cachedWeeklyDayAttempts[dayIdx]) {
      showToast("You've already played today's weekly puzzle. Come back tomorrow!");
      hideModal('gameover-overlay');
      showTitleScreen();
      return;
    }
  }
  // Chaos mode: "Play Again" starts a fresh run
  if (state.gameMode === 'chaos') {
    state.chaosRound = 1;
    state.chaosTotalTime = 0;
    state.chaosModifiers = [];
  }
  newGame();
});

// Chaos mode: "Next Board" advances to the next round
const chaosNextBtn = $('#gameover-chaos-next');
if (chaosNextBtn) {
  chaosNextBtn.addEventListener('click', () => {
    state.chaosRound = (state.chaosRound || 1) + 1;
    newGame();
  });
}

// Explore Board — dismiss modal, keep board visible for analysis
$('#gameover-explore').addEventListener('click', () => {
  hideModal('gameover-overlay');
  const postDeathBar = $('#post-death-bar');
  if (postDeathBar) postDeathBar.classList.remove('hidden');
});

// Post-death floating replay button
$('#post-death-replay').addEventListener('click', () => {
  const postDeathBar = $('#post-death-bar');
  if (postDeathBar) postDeathBar.classList.add('hidden');
  // Same weekly gate as the gameover-retry handler — daily/weekly use
  // a one-attempt-per-day mechanic, so post-death replay must respect
  // it. Daily lock-out lives in newGame's daily branch; weekly needs
  // the explicit check here.
  if (state.gameMode === 'weekly') {
    const dayIdx = getWeekDayIndex();
    if (state.cachedWeeklyDayAttempts && state.cachedWeeklyDayAttempts[dayIdx]) {
      showToast("You've already played today's weekly puzzle. Come back tomorrow!");
      showTitleScreen();
      return;
    }
  }
  newGame();
});

$('#gameover-nextlevel').addEventListener('click', () => {
  const maxLevel = state.gameMode === 'timed' ? MAX_TIMED_LEVEL : MAX_LEVEL;
  const completedLevel = state.currentLevel;
  if (state.currentLevel < maxLevel) state.currentLevel++;

  const isLevelMode = state.gameMode === 'normal';
  if (isLevelMode) {
    const newCheckpoint = getCheckpointForLevel(state.currentLevel);
    if (newCheckpoint > state.checkpoint) {
      state.checkpoint = newCheckpoint;
      saveCheckpoint(state.gameMode, newCheckpoint);
      showCheckpointToast(newCheckpoint);
    }
  }

  playLevelUp();
  showLevelUpToast(state.currentLevel);
  showCelebration();
  newGame();
});

$('#gameover-submit-daily').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  const nameInput = $('#daily-name-input');
  const name = nameInput ? nameInput.value : '';
  if (name && name.trim()) {
    // Strip @ to defang accidental email pastes before the Firebase
    // rules reject them. Server-side regex catches anything we miss
    // here, but client-side strip gives a faster, friendlier path.
    const sanitized = name.trim().replace(/@/g, '').slice(0, 20);
    if (!sanitized) {
      showToast('Please pick a handle (no @ symbols).');
      e.currentTarget.disabled = false;
      return;
    }
    // Anchor to the puzzle's seed, not the current local date — submitting
    // a score at 12:00:01 AM for yesterday's puzzle would otherwise land on
    // today's leaderboard.
    const dateStr = state.dailySeed || getLocalDateString();
    const scoreTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
    addDailyLeaderboardEntry(dateStr, sanitized, scoreTime);
    await submitOnlineScore(dateStr, sanitized, scoreTime, state.dailyBombHits || 0, {
      uid: getUid(),
      par: state.dailyPar,
      features: state.dailyFeatures,
      bombHitEvents: state.dailyBombHitEvents || [],
      rngSeed: state.dailyRngSeed || dateStr,
    });
    // Skip personal-history write for practice dailies — they play on a
    // custom seed and don't belong on the regular daily timeline.
    if (!state.isDailyPractice) {
      saveDailyHistoryEntry(dateStr, { time: scoreTime });
    }
    const dailySubmitForm = $('#daily-submit-form');
    if (dailySubmitForm) dailySubmitForm.classList.add('hidden');
    showToast('✅ Score submitted!');
  }
});

$('#gameover-share').addEventListener('click', () => handleShare());

$('#gameover-done').addEventListener('click', () => {
  hideModal('gameover-overlay');
  showTitleScreen();
});

// Daily-win opt-in CTA. Click → enable push notifications with the
// player's preferred hour (default 9am ET). Picked here because the
// player has just completed a daily and the dopamine moment is fresh
// — the same toggle in Settings converts at a fraction of this rate.
$('#gameover-remind-tomorrow').addEventListener('click', async () => {
  const btn = $('#gameover-remind-tomorrow');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '⏳ Setting up…';
  try {
    const { enableNotifications, loadNotificationPrefs } = await import('./firebase/firebasePush.js');
    const prefs = await loadNotificationPrefs();
    const result = await enableNotifications({
      hourLocal: typeof prefs.hourLocal === 'number' ? prefs.hourLocal : 9,
      dailyReminder: true,
      streakWarning: prefs.streakWarning ?? false,
    });
    if (result === true || result === 'ok') {
      btn.textContent = '✅ Reminder set for tomorrow';
      showToast('Notifications on — see you tomorrow!');
    } else if (result === 'ios-needs-install') {
      btn.textContent = '📱 Install to home screen first';
      showToast('Install GregSweeper to your home screen on iOS first');
      btn.disabled = false;
    } else if (result === 'denied') {
      btn.textContent = '⚠️ Permission blocked';
      showToast('Notification permission was blocked in browser settings');
    } else {
      btn.textContent = 'Try again';
      btn.disabled = false;
    }
  } catch (err) {
    console.warn('Daily-win remind opt-in failed:', err?.message || err);
    btn.textContent = 'Try again';
    btn.disabled = false;
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Don't intercept keys when user is typing in an input field
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Belt-and-suspenders: also check activeElement (some mobile keyboards fire events with wrong target)
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;

  const anyModalOpen = [...$$('.modal')].some(m => !m.classList.contains('hidden'));

  if (e.key === 'Escape') {
    const gameoverOpen = !$('#gameover-overlay').classList.contains('hidden');
    if (!gameoverOpen) {
      const visibleModals = [...$$('.modal')].filter(m => !m.classList.contains('hidden'));
      if (visibleModals.length > 0) {
        closeModalAndReturn(visibleModals[visibleModals.length - 1].id);
      }
    }
    return;
  }

  if (anyModalOpen) return;

  if (e.key === 'r' || e.key === 'R') {
    if (state.gameMode === 'normal') {
      state.currentLevel = state.checkpoint || loadCheckpoint(state.gameMode) || 1;
    } else {
      state.currentLevel = 1;
    }
    newGame();
    return;
  }

  if (e.key === '1') useRevealSafe();
  else if (e.key === '2') useShield();
  else if (e.key === '3') activateScan();
  else if (e.key === '4') activateMagnet();
  else if (e.key === '5') activateXRay();
});

// ── Mute Toggle ────────────────────────────────────────

if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    const nowMuted = !isMuted();
    setMuted(nowMuted);
    muteBtn.textContent = nowMuted ? '🔇' : '🔊';
    muteBtn.title = nowMuted ? 'Unmute' : 'Mute';
  });
}

// ── Player Name Setting ──────────────────────────────

const playerNameInput = $('#player-name-input');
if (playerNameInput) {
  playerNameInput.value = getPlayerName();
  playerNameInput.addEventListener('input', () => {
    setPlayerName(playerNameInput.value.trim().slice(0, 20));
  });
}

// ── Audio Volume Controls ─────────────────────────────

const sfxSlider = $('#sfx-volume');
if (sfxSlider) {
  sfxSlider.value = getSFXVolume();
  sfxSlider.addEventListener('input', () => setSFXVolume(Number(sfxSlider.value)));
}

// ── Modifier Popup Toggle ─────────────────────────────

const modifierToggle = $('#modifier-popup-toggle');
if (modifierToggle) {
  // v1.4.1: re-enable popups for all users (one-time reset).
  // Use the storage adapter so we don't throw in iOS private browsing
  // (where raw localStorage.setItem rejects), which would re-run this
  // migration on every page load and could break surrounding init.
  if (safeGet('minesweeper_popup_reset_v141') !== 'done') {
    setModifierPopupDisabled(false);
    safeSet('minesweeper_popup_reset_v141', 'done');
  }

  // v1.4.35: a wall-rendering / adjacency bug in the prior cache version
  // could let players "complete" a daily on a board with wrong numbers and
  // missing walls. Reset today's daily completion + cached par/moves so
  // affected players can replay properly with this fix in place. One-time
  // per device, keyed to the cache version.
  if (safeGet('minesweeper_daily_reset_v1435') !== 'done') {
    const today = getLocalDateString();
    safeRemove('minesweeper_daily_completed_date');
    safeRemove('minesweeper_daily_par_' + today);
    safeRemove('minesweeper_daily_moves_' + today);
    // Also clear any in-progress daily save so newGame regenerates with the fix
    safeRemove('minesweeper_game_state_daily');
    safeSet('minesweeper_daily_reset_v1435', 'done');
  }
  modifierToggle.checked = !isModifierPopupDisabled();
  modifierToggle.addEventListener('change', () => {
    setModifierPopupDisabled(!modifierToggle.checked);
  });
}

// ── Daily reminder push notification ──────────────────
const dailyReminderToggle = $('#daily-reminder-toggle');
const reminderHourSelect = $('#reminder-hour-select');
const dailyReminderHint = $('#daily-reminder-hint');
const streakWarningToggle = $('#streak-warning-toggle');

async function syncReminderUI() {
  if (!dailyReminderToggle) return;
  // Always leave the toggle interactive. A previous version disabled
  // it when isPushSupported() returned false at sync-time (eg before
  // firebase-messaging-compat finished loading) — but nothing ever
  // re-enabled it once support arrived. The toggle handler itself
  // returns a clear error toast when push isn't supported, so a
  // disabled-by-default state buys us nothing except silent failures.
  dailyReminderToggle.disabled = false;
  try {
    const { loadNotificationPrefs } = await import('./firebase/firebasePush.js');
    const prefs = await loadNotificationPrefs();
    dailyReminderToggle.checked = !!prefs.enabled;
    if (reminderHourSelect) {
      reminderHourSelect.value = String(prefs.hourLocal ?? 9);
      reminderHourSelect.disabled = false;
    }
    if (streakWarningToggle) {
      streakWarningToggle.checked = !!prefs.streakWarning;
      // Disable when notifications themselves are off — toggling
      // streak-rescue alone without parent push enabled is a no-op.
      streakWarningToggle.disabled = !prefs.enabled;
    }
  } catch (err) {
    console.warn('syncReminderUI failed:', err.message);
  }
}

if (dailyReminderToggle) {
  // Defer initial sync until Firebase auth has had time to resolve.
  // syncReminderUI is also called when the Settings modal opens.
  setTimeout(syncReminderUI, 1500);

  // Auto-heal stale FCM tokens on every app load. Events like a SW
  // unregister (Settings → Check for Updates) can leave Firebase
  // pointing to a dead token; the next cron then 404s and the
  // subscription gets auto-cleared, killing future pushes until the
  // user manually re-toggles. This call regenerates the token via
  // getToken() and writes whatever's current to Firebase, so a stale
  // record self-heals on the next visit.
  setTimeout(async () => {
    try {
      const { refreshTokenIfStale } = await import('./firebase/firebasePush.js');
      await refreshTokenIfStale();
    } catch {}
  }, 3000);

  dailyReminderToggle.addEventListener('change', async () => {
    const wantsOn = dailyReminderToggle.checked;
    const { enableNotifications, disableNotifications, isIOS, isInstalledPWA } = await import('./firebase/firebasePush.js');
    if (wantsOn) {
      const hour = parseInt(reminderHourSelect?.value || '9', 10);
      const streakOn = !!streakWarningToggle?.checked;
      const result = await enableNotifications({ hourLocal: hour, dailyReminder: true, streakWarning: streakOn });
      if (result === 'success') {
        if (streakWarningToggle) streakWarningToggle.disabled = false;
        showToast('🔔 Daily reminders enabled');
      } else if (result === 'denied') {
        dailyReminderToggle.checked = false;
        showToast('Notifications are blocked in your browser settings — enable them there to use this.');
      } else if (result === 'ios-needs-install') {
        dailyReminderToggle.checked = false;
        showToast('Install GregSweeper to your home screen first to enable notifications.');
      } else if (result === 'no-key') {
        dailyReminderToggle.checked = false;
        showToast('Push not configured yet — VAPID key missing on this build.');
      } else if (result === 'unsupported') {
        dailyReminderToggle.checked = false;
        showToast("This browser doesn't support push notifications.");
      } else if (result === 'token-null') {
        dailyReminderToggle.checked = false;
        showToast('FCM returned no token. Try uninstalling and reinstalling the PWA.');
      } else if (result === 'token-error') {
        dailyReminderToggle.checked = false;
        showToast('Token write failed. Check connection and try again.');
      } else {
        dailyReminderToggle.checked = false;
        showToast('Could not enable notifications. Try again later.');
      }
    } else {
      const result = await disableNotifications();
      if (result === 'success') {
        if (streakWarningToggle) {
          streakWarningToggle.checked = false;
          streakWarningToggle.disabled = true;
        }
        showToast('🔕 Daily reminders disabled');
      }
    }
  });
}

if (reminderHourSelect) {
  reminderHourSelect.addEventListener('change', async () => {
    const { updateNotificationHour } = await import('./firebase/firebasePush.js');
    const hour = parseInt(reminderHourSelect.value, 10);
    const ok = await updateNotificationHour(hour);
    if (ok) showToast(`Reminder time set to ${reminderHourSelect.options[reminderHourSelect.selectedIndex].textContent}`);
  });
}

if (streakWarningToggle) {
  streakWarningToggle.addEventListener('change', async () => {
    const { updateStreakWarning } = await import('./firebase/firebasePush.js');
    const enabled = streakWarningToggle.checked;
    const ok = await updateStreakWarning(enabled);
    if (ok) {
      showToast(enabled ? '🔥 Streak rescue on (8pm ET)' : 'Streak rescue off');
    } else {
      streakWarningToggle.checked = !enabled;
      showToast('Could not update. Try again later.');
    }
  });
}

// Colorblind mode toggle
const colorblindToggle = $('#colorblind-toggle');
const COLORBLIND_KEY = 'minesweeper_colorblind';
function applyColorblind(enabled) {
  document.documentElement.setAttribute('data-colorblind', enabled ? 'true' : 'false');
  safeSet(COLORBLIND_KEY, enabled ? '1' : '0');
}
if (colorblindToggle) {
  const cbEnabled = safeGet(COLORBLIND_KEY) === '1';
  colorblindToggle.checked = cbEnabled;
  applyColorblind(cbEnabled);
  colorblindToggle.addEventListener('change', () => applyColorblind(colorblindToggle.checked));
}

// ── Init ───────────────────────────────────────────────

async function init() {
  preloadSprites();
  const theme = loadTheme();
  const unlocked = getUnlockedThemes();

  let activeTheme = theme;
  if (unlocked[theme] === false) {
    const stats = loadStats();
    const maxLevel = stats.maxLevelReached || 1;
    const sortedThemes = Object.entries(THEME_UNLOCKS)
      .filter(([, info]) => maxLevel >= info.levelRequired)
      .sort((a, b) => b[1].levelRequired - a[1].levelRequired);
    activeTheme = sortedThemes.length > 0 ? sortedThemes[0][0] : 'classic';
    saveTheme(activeTheme);
  }

  state.theme = activeTheme;
  loadThemeCSS(activeTheme);
  document.documentElement.setAttribute('data-theme', activeTheme);
  applyThemeEffects(activeTheme);
  updateThemeColor();

  const muted = loadMuted();
  if (muteBtn) {
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  }

  initFirebase();

  // Wire FCM token re-subscription to uid changes BEFORE auth settles
  // so the listener catches the first uid switch even if it happens
  // unusually fast (persisted email-link return URL on boot).
  import('./firebase/firebasePush.js').then(m => m.initPushAuthListener()).catch(() => {});

  // Cloud progress sync: anonymous auth + silent restore. Also completes
  // the email-link flow if the boot URL has the email-link return params,
  // so the user lands on the title screen already signed in.
  initAnonymousAuth().then(async () => {
    try {
      await tryCompleteEmailLink({
        onCredentialConflict: _confirmCredentialConflict,
        promptForEmail: _promptForEmailLinkEmail,
      });
    } catch (err) {
      console.warn('tryCompleteEmailLink failed:', err && err.message);
    }
    const cloud = await loadProgress();
    if (cloud) applyCloudProgress(cloud);
  }).catch(() => {}); // silent — progress stays local-only

  // Preload handicaps so the end-of-game modal can render personal par
  // without a race. Fire-and-forget; getHandicap() falls back to 0
  // when the file hasn't loaded yet.
  loadHandicaps();

  // Rebuild the provisional-handicap residual cache from Firebase
  // dailyHistory after anon auth resolves. Covers cache clears, private-
  // browsing sessions, and cross-device opens — a player who finished
  // three dailies on their phone won't reset their provisional handicap
  // when they first open the PWA on their laptop. Save-scumming via a
  // uid reset legitimately resets the cache (new uid = no history to
  // backfill), which is the intended behaviour for that gesture.
  initAnonymousAuth().then(async () => {
    const uid = getUid();
    if (!uid) return;
    const { backfillResidualsFromFirebase } = await import('./logic/handicaps.js');
    backfillResidualsFromFirebase(uid).catch(() => {});
  }).catch(() => {});

  // Warm the experiment-target cache so selectDailyRngSeed has the
  // current target when the user lands on a daily. If the fetch hasn't
  // resolved yet, the module falls back to DEFAULT_TARGET.
  loadExperimentTarget();

  // Warn if localStorage is broken (private browsing, quota, etc.)
  if (isStorageFailing()) {
    showToast('⚠️ Playing in temporary mode — progress won\'t be saved', 5000);
  }

  // Ask the browser to mark our storage as persistent so it isn't
  // evicted by the browser's storage-pressure cleanup. iOS Safari
  // grants silently for installed PWAs; desktop Chrome / Firefox grant
  // automatically once the engagement heuristic passes (no permission
  // prompt). Fire-and-forget — the diagnostics modal can read the
  // cached result from getPersistentStorageStatus().
  requestPersistentStorage().catch(() => {});

  const urlParams = new URLSearchParams(window.location.search);
  const deepLinkMode = urlParams.get('mode');

  // Diagnostics button is hidden for casual users. Unhide when `?debug=1`
  // is in the URL (once per device — we persist a localStorage flag so
  // the button stays visible on return visits without needing the param
  // again). `?debug=0` clears the flag if we ever want to re-hide it.
  const DEBUG_UI_KEY = 'gregsweeper_debug_ui';
  if (urlParams.get('debug') === '1') {
    safeSet(DEBUG_UI_KEY, '1');
  } else if (urlParams.get('debug') === '0') {
    safeRemove(DEBUG_UI_KEY);
  }
  if (safeGet(DEBUG_UI_KEY) === '1') {
    const g = $('#settings-diagnostics-group');
    if (g) g.classList.remove('hidden');
    // Expose a console helper for verifying the error reporter end-to-end.
    // Usage: open DevTools, run `gsTestError('label')`, then check
    // Firebase Console → errors/{uid}/{timestamp} for the row.
    window.gsTestError = (label) => reportTestError(label);
  }

  // Startup gate — block rendering until the SW is current, Firebase is
  // ready, and the canonical board for today is in memory. Keeps the
  // boot overlay up across the whole wait so the player never sees a
  // flash of a divergent board.
  await runStartupGate();

  if (!isOnboarded()) {
    // First time — launch interactive tutorial, then route to the title
    // screen with a one-time spotlight on the Daily card. Previously this
    // flow force-launched Challenge L1 and bypassed the title screen
    // entirely, meaning first-time users never saw the Daily card on
    // day one. The Daily is the highest-value conversion moment for
    // the dataset-growth audience, so the FTU funnel now ends here.
    startTutorial(() => {
      const toTitle = () => { showTitleScreen(); spotlightDailyCard(); };
      // One gentle no-modifier warm-up board bridges the 5x5 tutorial
      // and a full Daily. Once ever — marked before it runs so closing
      // the tab mid-warm-up doesn't relaunch it next visit.
      if (!hasSeenNotice('warmup_done')) {
        markNoticeSeen('warmup_done');
        startWarmup(toTitle);
      } else {
        toTitle();
      }
    });
  } else if (deepLinkMode === 'daily') {
    // Deep link to daily mode. ?seed=<custom> lets you play a fresh puzzle
    // under a non-today seed (e.g. after you've finished today's). Practice
    // runs submit to Firebase so the backend gets your uid, but don't
    // touch streak, bestTimes, completion flags, or personal history.
    state.gameMode = 'daily';
    const customSeed = urlParams.get('seed');
    if (customSeed) {
      state.dailySeed = customSeed;
      state.isDailyPractice = true;
    }
    hideTitleScreen();
    if (!tryResumeGame()) await newGame();
  } else if (deepLinkMode === 'weekly') {
    // Deep link to weekly mode (used by push notifications and direct
    // shares). Drop into the weekly card's click-handler equivalent
    // state setup, then route through the daily flow.
    const weekStart = getWeekStart();
    const dayIdx = getWeekDayIndex();
    if (state.cachedWeeklyDayAttempts && state.cachedWeeklyDayAttempts[dayIdx]) {
      // Already played today — show the title screen with the weekly
      // card surfacing the "Played today" status. Don't auto-launch.
      showTitleScreen();
      if (!tryResumeGame()) await newGame();
    } else {
      state.gameMode = 'weekly';
      state.weeklySeed = weekStart;
      state.weeklyDay = dayIdx;
      hideTitleScreen();
      if (!tryResumeGame()) await newGame();
    }
  } else {
    // Returning user — show title screen
    showTitleScreen();
    // Pre-load the game in background so it's ready
    if (!tryResumeGame()) await newGame();
  }

  // All routing settled and the appropriate UI surface (tutorial /
  // daily board / title screen) has rendered — release the boot overlay.
  hideBootOverlay();

  // Persist game state periodically (only when actively playing)
  let _lastPersistTime = 0;
  setInterval(() => {
    if (state.status === 'playing' && state.elapsedTime !== _lastPersistTime) {
      _lastPersistTime = state.elapsedTime;
      persistGameState();
    }
  }, 5000); // Every 5s for reliable mobile persistence
}

// Pause timer + persist when app loses focus; resume when visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state.status === 'playing') pauseTimer();
    persistGameState(); // Always persist (guard is inside)
  } else {
    // Coming back from a hidden tab counts as fresh activity — without
    // this, the idle-pause timer would fire ~30s after refocus because
    // lastInteractionTime froze when we went hidden.
    recordInteraction();
    if (state.status === 'playing' && !state.idlePaused) {
      resumeTimer();
    }
  }
});

// Idle-pause: any user input refreshes the idle clock. Capture-phase
// listeners so that the dismissing pointerdown/keydown can be swallowed
// when we're paused — without that, tapping the overlay to resume would
// also reveal whatever cell is under the tap. pointermove doesn't have
// board side-effects so it doesn't need swallowing; it's throttled to
// ~1Hz since trackpads fire 60+/sec.
let _lastMoveStamp = 0;
document.addEventListener('pointerdown', (ev) => {
  const wasPaused = state.idlePaused;
  recordInteraction();
  if (wasPaused) {
    ev.stopPropagation();
    ev.preventDefault();
  }
}, { capture: true });
document.addEventListener('keydown', (ev) => {
  const wasPaused = state.idlePaused;
  recordInteraction();
  if (wasPaused) {
    ev.stopPropagation();
    ev.preventDefault();
  }
}, { capture: true });
document.addEventListener('pointermove', () => {
  const now = Date.now();
  if (now - _lastMoveStamp > 1000) {
    _lastMoveStamp = now;
    recordInteraction();
  }
}, { passive: true });
window.addEventListener('beforeunload', () => {
  persistGameState(); // Guard is inside persistGameState
});
// pagehide fires more reliably than beforeunload on mobile (swipe-kill)
window.addEventListener('pagehide', () => {
  persistGameState(); // Guard is inside persistGameState
});

// Recalculate cell sizes on window resize
window.addEventListener('resize', () => {
  resizeCells();
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;
});

// Safety net: if init throws anywhere, drop the boot overlay so the
// user isn't stuck on a black screen with a spinner.
init().catch((err) => {
  console.error('init failed:', err);
  hideBootOverlay();
});
