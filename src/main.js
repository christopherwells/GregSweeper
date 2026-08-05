// ── GregSweeper Entry Point ────────────────────────────
// All game logic and UI rendering is in modules.
// This file handles imports, event wiring, and init.

// ── Local Date Utility ──────────────────────────────
// getLocalDateString imported from seededRandom.js

import { state, clearCoastlinePractice } from './state/gameState.js';
import { PROD_SITE_BASE } from './config.js';
import { $, $$, boardEl, resetBtn, flagModeToggle, boardScrollWrapper, muteBtn, escapeHtml } from './ui/domHelpers.js';
import { resizeCells, updateAllCells, needsZoom, updateZoom, zoomIn, zoomOut, setFocusedCell, renderWallOverlays, showGimmickRegion, clearGimmickRegion } from './ui/boardRenderer.js';
import { renderWormOverlays } from './ui/wormRenderer.js';
import { preloadSprites, medalImgForEmoji, gimmickSpriteImgHTML, achievementSpriteImgHTML, uiSpriteImgHTML } from './ui/spriteLoader.js';
import { startGregMascot } from './ui/gregMascot.js';
import { updateHeader, updateFlagModeBar, getCheckpointForLevel, CHECKPOINT_INTERVAL } from './ui/headerRenderer.js';
import { updatePowerUpBar } from './ui/powerUpBar.js';
import { showModal, hideModal } from './ui/modalManager.js';
import { showToast, showLevelUpToast, showCheckpointToast } from './ui/toastManager.js';
import { showCelebration, haptic } from './ui/effectsRenderer.js';
import { THEME_UNLOCKS, getUnlockedThemes, loadThemeCSS, updateThemeColor, enterChaosTheme } from './ui/themeManager.js';
import { applyThemeEffects, applyTitleSceneEffects } from './ui/themeEffects.js';
import { newGame, revealCell, toggleFlag, handleChordReveal, rearmPlateTimers } from './game/gameActions.js';
import './game/winLossHandler.js'; // side-effect: registers handleWin with powerUpActions
import { useRevealSafe, useShield, activateScan, activateXRay, activateMagnet } from './game/powerUpActions.js';
import { switchMode, isChaosUnlocked, updateModeUI } from './game/modeManager.js';
import { resolveCruxDate, streakBearingDates } from './logic/archiveEligibility.js';
import { challengeSaveIsCurrent } from './logic/resumeEligibility.js';
import { persistGameState, tryResumeGame } from './game/gamePersistence.js';
import { MAX_TIMED_LEVEL, CHAOS_UNLOCK_LEVEL } from './logic/difficulty.js';
import { CHALLENGE_MAX_LEVEL, CHALLENGE_BLOCK_SIZE, MOD_INTRO_BLOCKS, SHAPE_INTRO_BLOCKS } from './logic/challenge250.js';
import { loadHandicaps } from './logic/handicaps.js';
import {
  loadStats, saveTheme, loadTheme, resetStats,
  saveCheckpoint, loadCheckpoint, loadGameState,
  isOnboarded, isDailyCompleted, backfillMoltDays, applyChallenge250Reset,
  getPlayerName, setPlayerName,
  getLastSeenVersion, setLastSeenVersion,
  applyCloudProgress, resetDailyStatsForAccountSwitch,
  reconcileStreakFromHistory, reconcileWeekStreakFromHistory,
  hasSeenNotice, markNoticeSeen,
  clearGameState,
} from './storage/statsStorage.js';

const CURRENT_VERSION = 'v1.10';

import {
  playLevelUp, isMuted, setMuted, loadMuted,
  setSFXVolume, getSFXVolume,
} from './audio/sounds.js';
import {
  getAchievementState, getTotalScore, getAllTierNames, getTierColor,
} from './logic/achievements.js';
import { initFirebase } from './firebase/firebaseLeaderboard.js';
import { initAnonymousAuth, loadProgress, loadDailyHistory, fetchPlayedWeeks, getUid, loadWeeklyAttempts, loadLocalWeeklyAttempts, replaceLocalWeeklyAttempts, pruneStaleLocalWeeklyAttempts, subscribeToUidChanges, subscribeToCloudProgressUpdates, reportClientSeen, publishPlayerName } from './firebase/firebaseProgress.js';
import { getAuthState, subscribeAuthState, linkWithGoogle, sendEmailLink, tryCompleteEmailLink, signOut as authSignOut } from './firebase/firebaseAuth.js';
import { isTestEnvironment } from './firebase/env.js';
import { getLocalDateString, getWeekStart, getWeekDayIndex, addCalendarDays } from './logic/seededRandom.js';
import { loadExperimentTarget } from './logic/experimentDesign.js';
import { prefetchUpcomingDailyBoards } from './firebase/dailyBoardSync.js';
import { showCruxTeaser } from './ui/cruxTeaser.js';
import { prefetchUpcomingWeeklyBoards } from './firebase/weeklyBoardSync.js';
import { isModifierPopupDisabled, setModifierPopupDisabled, getGimmickDefs } from './logic/gimmicks.js';
import { isStorageFailing, safeGet, safeSet, safeRemove, requestPersistentStorage } from './storage/storageAdapter.js';
import { pauseTimer, resumeTimer, stopTimer, recordInteraction } from './game/timerManager.js';
import { isLiveGameExpired, isWeeklyAttemptCacheStale } from './logic/resumeEligibility.js';
import { blocksManualRestart } from './logic/modeRules.js';
import { remindCtaOutcome } from './logic/remindCta.js';
import { parseCoastlineParam, tilingLabel } from './logic/coastlineLink.js';
import { setDailyShapeOverride } from './logic/shapeRotation.js';
// 2026-07-10 split: main.js keeps entry wiring + init; these modules own
// their surfaces (each also binds its own DOM wiring at import time).
import { runStartupGate, hideBootOverlay } from './game/startupGate.js';
import { updateStatsDisplay } from './ui/statsModal.js';
import { updateLeaderboardDisplay } from './ui/leaderboardModal.js';
import {
  showTitleScreen, hideTitleScreen, updateTitleProgress, spotlightDailyCard,
  showModalFromTitle, closeModalAndReturn, setReturnToTitle,
} from './ui/titleScreen.js';
import { handleShare, copyToClipboard } from './ui/shareActions.js';
import { startTutorial, startWarmup } from './ui/tutorialManager.js';
import { initErrorReporter, setErrorReporterCodeVersion, reportTestError, reportCaughtError } from './diagnostics/errorReporter.js';

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
      // Stale-client beacon: stamp users/{uid}/lastSeen with the build
      // this device is ACTUALLY running (the SW's cache name, not the
      // JS bundle's idea of itself). Written once per session; the
      // Sebastien incident (device silently stuck on v1.5.162 for days)
      // was only diagnosable by error-log spelunking without this.
      reportClientSeen(event.data.value);
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
  // No-SW fallback (first-ever visit before install, or SW unsupported):
  // report the bundle's own version so the beacon never goes missing.
  setTimeout(() => {
    if (!state.codeVersion) reportClientSeen('js-' + CURRENT_VERSION);
  }, 6000);
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

// Tab switchers — bind once at module load.
for (const btn of $$('.help-tab')) {
  btn.addEventListener('click', () => setActiveHelpTab(btn.dataset.tab));
}
for (const btn of $$('.settings-tab')) {
  btn.addEventListener('click', () => setActiveSettingsTab(btn.dataset.tab));
}

// ── Collection Display ───────────────────────────────

function renderCollectionModal() {
  // Themes only — the emoji-pack / effects / titles tabs were cut
  // 2026-06-12 (selection chaff; themes carry the whole identity).
  for (const t of Object.keys(THEME_UNLOCKS)) loadThemeCSS(t);
  const themeGrid = $('#collection-theme-grid');
  themeGrid.innerHTML = '';
  const unlocked = getUnlockedThemes();
  const currentTheme = state.theme;

  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch' + (theme === currentTheme ? ' active' : '') + (unlocked[theme] === false ? ' locked' : '');
    btn.dataset.theme = theme;
    // Mini-board preview: real .cell elements inside this card's own
    // data-theme scope, so the theme's fog, numbers, objects, and
    // fog-art drawing all render live. (Replaced the gradient-dot
    // swatches 2026-06-11 - a color circle said nothing about the
    // world.) All theme stylesheets are loaded before this renders.
    const flagEmoji = info.flag || '🚩';
    const mineEmoji = info.mine || '💣';
    btn.innerHTML =
      `<span class="swatch-board" data-theme="${theme}">` +
        `<span class="cell unrevealed"></span>` +
        `<span class="cell revealed num-1">1</span>` +
        `<span class="cell unrevealed flagged">${flagEmoji}</span>` +
        `<span class="cell revealed num-2">2</span>` +
        `<span class="cell revealed num-3">3</span>` +
        `<span class="cell revealed mine">${mineEmoji}</span>` +
        `<span class="cell revealed"></span>` +
        `<span class="cell unrevealed"></span>` +
      `</span>` +
      `<span class="swatch-name">${info.displayName}</span>` +
      (unlocked[theme] === false ? `<span class="swatch-lock">${uiSpriteImgHTML('modLocked', 'inline-lock')} Lv.${info.levelRequired}</span>` : '');
    btn.addEventListener('click', () => {
      if (unlocked[theme] === false) {
        btn.classList.add('swatch-shake');
        setTimeout(() => btn.classList.remove('swatch-shake'), 400);
        return;
      }
      applyThemeLive(theme);
      for (const s of themeGrid.querySelectorAll('.theme-swatch')) s.classList.remove('active');
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
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

  // Two sections: engine-certified skill feats lead (the identity),
  // accumulation follows. List rows, not identical cards — the earned
  // medal opens each row, the next step reads as one plain sentence,
  // and a six-dot tier track replaces the old wall of emoji badges.
  const tierNames = getAllTierNames();
  const renderRow = (ach) => {
    const row = document.createElement('div');
    row.className = 'ach-row';

    let track = '<span class="ach-track" aria-hidden="true">';
    for (let i = 0; i < tierNames.length; i++) {
      const earned = i <= ach.tierIndex;
      const color = getTierColor(tierNames[i]);
      track += `<i class="ach-dot${earned ? ' earned' : ''}"${earned ? ` style="background:${color}"` : ''}></i>`;
    }
    track += '</span>';

    // The next step as one plain sentence. Counting categories phrase
    // the DELTA ("3 more for 🥈"); best-time categories phrase the bar
    // to beat ("beat 30s for 🥇").
    let nextLine;
    if (!ach.nextTier) {
      nextLine = 'Complete';
    } else if (ach.inverted) {
      nextLine = `beat ${ach.nextValue}s for ${ach.nextTierIcon}`;
    } else {
      const have = Number.isFinite(ach.value) ? ach.value : 0;
      const need = Math.max(0, ach.nextValue - have);
      nextLine = `${need} more for ${ach.nextTierIcon}`;
    }

    // The category icon is the permanent identity (greyed while locked,
    // full colour once earned); the earned tier rides a small corner
    // medal badge so both the Wave B icon and the Wave A medal show.
    const catIconHtml = achievementSpriteImgHTML(ach.id, 'sprite-medal', ach.name) || ach.icon;
    const tierBadgeHtml = ach.tierIndex >= 0
      ? `<span class="ach-tier-badge">${medalImgForEmoji(ach.currentTierIcon, 'sprite-tier-badge', ach.currentTier) || ach.currentTierIcon}</span>`
      : '';

    row.innerHTML = `
      <span class="ach-medal${ach.tierIndex < 0 ? ' none' : ' earned'}">${catIconHtml}${tierBadgeHtml}</span>
      <div class="ach-main">
        <div class="ach-name-line"><span class="ach-name">${ach.name}</span>${track}</div>
        <div class="ach-sub">${ach.desc} · <span class="ach-next${!ach.nextTier ? ' ach-maxed' : ''}">${nextLine}</span></div>
      </div>
    `;
    if (ach.nextTier) {
      const bar = document.createElement('div');
      bar.className = 'ach-rowbar';
      bar.innerHTML = `<div style="width:${Math.round(ach.progress * 100)}%"></div>`;
      row.appendChild(bar);
    }
    return row;
  };

  const feats = achievements.filter(a => a.group === 'feat');
  const progress = achievements.filter(a => a.group !== 'feat');
  const section = (title, items) => {
    const h = document.createElement('div');
    h.className = 'ach-section-title';
    h.textContent = title;
    grid.appendChild(h);
    for (const a of items) grid.appendChild(renderRow(a));
  };
  section('Skill feats', feats);
  section('Progress', progress);
}

// ── Event Handlers ─────────────────────────────────────

let longPressTimer = null;
let longPressTriggered = false;
let lastTouchTime = 0;

// Sonar / compass region reveal: hover (desktop) or tap (mobile) a revealed
// sonar/compass cell to light up the cells its number counts. A tap toggles a
// PINNED region (touch has no hover to fall back to); hover previews it live.
let _pinnedRegionCell = null;
function _isRegionCell(row, col) {
  const cell = state.board?.[row]?.[col];
  return !!(cell && cell.isRevealed && (cell.isSonar || cell.isCompass));
}
// A pin outlives the game it was set in (nothing clears it on newGame), and on
// the NEXT board those coordinates are just some cell — which could legitimately
// become a revealed sonar later, at which point the hover fallback would light a
// region the player never pinned. Dropping a pin the moment its cell stops
// being a region cell keeps the pin's meaning tied to the click that set it.
function _pinnedRegion() {
  if (_pinnedRegionCell && !_isRegionCell(_pinnedRegionCell.row, _pinnedRegionCell.col)) {
    _pinnedRegionCell = null;
  }
  return _pinnedRegionCell;
}
function _toggleRegionPin(row, col) {
  const pinned = _pinnedRegion();
  if (pinned && pinned.row === row && pinned.col === col) {
    _pinnedRegionCell = null;
    clearGimmickRegion();
  } else {
    _pinnedRegionCell = { row, col };
    showGimmickRegion(row, col);
  }
}
if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
  boardEl.addEventListener('mouseover', (e) => {
    const cellEl = e.target.closest('.cell');
    if (!cellEl) return;
    const row = parseInt(cellEl.dataset.row, 10);
    const col = parseInt(cellEl.dataset.col, 10);
    const pinned = _pinnedRegion();
    if (_isRegionCell(row, col)) showGimmickRegion(row, col);
    else if (pinned) showGimmickRegion(pinned.row, pinned.col);
    else clearGimmickRegion();
  });
  boardEl.addEventListener('mouseleave', () => {
    const pinned = _pinnedRegion();
    if (pinned) showGimmickRegion(pinned.row, pinned.col);
    else clearGimmickRegion();
  });
}

boardEl.addEventListener('mousedown', (e) => {
  if (Date.now() - lastTouchTime < 500) return;
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const row = parseInt(cellEl.dataset.row);
  const col = parseInt(cellEl.dataset.col);

  if (e.button === 0) {
    const cell = state.board[row]?.[col];
    // A sonar/compass number counts a REGION, not its neighbors, so chording it
    // is meaningless — the click toggles its region highlight instead.
    if (cell && cell.isRevealed && (cell.isSonar || cell.isCompass)) {
      _toggleRegionPin(row, col);
      return;
    }
    if (cell && cell.isRevealed && cell.adjacentMines > 0) {
      handleChordReveal(row, col);
    } else if (state.flagMode && !cell?.isRevealed) {
      // Flag-mode toggle is on (set via the header bar) — left-click
      // flags instead of revealing. Right-click still flags directly
      // via the contextmenu handler, so users with right-click muscle
      // memory keep their workflow.
      toggleFlag(row, col);
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
  if (cell && cell.isRevealed && (cell.isSonar || cell.isCompass)) {
    _toggleRegionPin(row, col);
    return;
  }
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
      // Reveal, chord, or (sonar/compass) toggle the counted region.
      const cell = state.board[r]?.[c];
      if (cell && cell.isRevealed && (cell.isSonar || cell.isCompass)) {
        _toggleRegionPin(r, c);
      } else if (cell && cell.isRevealed && cell.adjacentMines > 0) {
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

// ── Post-loss tap-to-interrogate (the Receipt's explore view) ──
// In the lost state, board clicks otherwise do nothing — route them to
// the receipt: tap any cell to ask "was this knowable?" and watch the
// proving region pulse. Additive listener; live-game handlers all guard
// away from the lost state, so there is no conflict.
boardEl.addEventListener('click', (e) => {
  if (state.status !== 'lost') return;
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const row = parseInt(cellEl.dataset.row, 10);
  const col = parseInt(cellEl.dataset.col, 10);
  if (Number.isInteger(row) && Number.isInteger(col)) {
    import('./ui/receiptRenderer.js').then(m => m.handleInterrogateTap(row, col))
      .catch(err => reportCaughtError('receipt-interrogate', err));
  }
});

resetBtn.addEventListener('click', () => {
  resetBtn.classList.add('smiley-pressed');
  setTimeout(() => resetBtn.classList.remove('smiley-pressed'), 150);
  // Daily/Weekly are canonical single-puzzle modes — no reset. The smiley
  // is rendered disabled in these modes (see updateHeader); this guard is
  // the parallel safeguard against any pre-first-render click. Shared with
  // the R keyboard shortcut via blocksManualRestart so no restart surface
  // can drift from the rule.
  if (blocksManualRestart(state.gameMode)) return;
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
// Prev/next theme — cycle through the unlocked themes (ladder order) in-game,
// replacing the old in-game Collection button.
function cycleTheme(dir) {
  const unlocked = getUnlockedThemes();
  const list = Object.keys(unlocked).filter((t) => unlocked[t]);
  if (!list.length) return;
  const cur = document.documentElement.getAttribute('data-theme') || 'classic';
  let i = list.indexOf(cur);
  i = ((i < 0 ? 0 : i) + dir + list.length) % list.length;
  applyThemeLive(list[i]);
}
$('#btn-theme-prev')?.addEventListener('click', () => cycleTheme(-1));
$('#btn-theme-next')?.addEventListener('click', () => cycleTheme(1));
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
// Stats / achievements / collection / themes / help left the in-game
// nav in the 2026-06-10 declutter (all reachable from the title screen;
// the in-game row is four large targets on a phone). Optional chaining
// keeps these wirings safe if the buttons return someday.
$('#btn-stats')?.addEventListener('click', () => {
  updateStatsDisplay();
  showModal('stats-modal');
});
$('#btn-achievements')?.addEventListener('click', () => {
  updateAchievementsDisplay();
  showModal('achievements-modal');
});
$('#btn-leaderboard').addEventListener('click', () => {
  updateLeaderboardDisplay();
  showModal('leaderboard-modal');
});

$('#btn-collection')?.addEventListener('click', () => {
  renderCollectionModal();
  showModal('collection-modal');
});

// ── Live theme carousel ───────────────────────────────────────────────────────
// Apply a theme everywhere it takes effect. Shared by the Collection swatches and
// the carousel so there is one source of truth for "switch theme".
function applyThemeLive(theme) {
  state.theme = theme;
  const cssReady = loadThemeCSS(theme);
  document.documentElement.setAttribute('data-theme', theme);
  applyThemeEffects(theme);
  applyTitleSceneEffects(theme); // refresh the title-screen background when switching on the title
  startGregMascot($('#title-greg-mascot'), theme); // re-mount the title Greg for the new theme
  updateThemeColor();
  saveTheme(theme);
  updateAllCells();
  try { updateHeader(); } catch {} // re-render the in-game LCD Greg so it updates on theme cycle
  // Re-fit the board to the NEW theme's live geometry. Themes may override
  // --grid-gap (candy 3px, matrix 1px vs the 2px default), and #board is
  // width:fit-content — the cells were sized against the OLD theme's gap,
  // so without a refit a wider gap pushed the board past its container
  // (cells spilling off the side; the neon→candy carousel repro). Waits
  // for the lazy stylesheet to actually apply, otherwise the refit still
  // reads the old gap. resizeCells no-ops when no board is rendered.
  // Wall-line and worm-overlay positions are pixel-anchored to the old
  // geometry, so reposition them in the same refit.
  cssReady.then(() => { resizeCells(); renderWallOverlays(); renderWormOverlays(); }).catch(() => {});
}

let _carouselThemes = [];
let _carouselIdx = 0;
let _carouselOpen = false;

function openThemeCarousel() {
  const unlocked = getUnlockedThemes();
  _carouselThemes = Object.keys(THEME_UNLOCKS).filter(t => unlocked[t] !== false);
  if (_carouselThemes.length === 0) _carouselThemes = Object.keys(THEME_UNLOCKS);
  const cur = state.theme || document.documentElement.getAttribute('data-theme') || 'classic';
  _carouselIdx = Math.max(0, _carouselThemes.indexOf(cur));
  _carouselOpen = true;
  $('#theme-carousel').classList.remove('hidden');
  updateCarouselDisplay();
}

function closeThemeCarousel() {
  _carouselOpen = false;
  $('#theme-carousel').classList.add('hidden');
}

function updateCarouselDisplay() {
  const name = _carouselThemes[_carouselIdx];
  const info = THEME_UNLOCKS[name];
  $('#theme-carousel-name').textContent = (info && info.displayName) || name;
  $('#theme-carousel-pos').textContent = `${_carouselIdx + 1} / ${_carouselThemes.length}`;
}

function cycleCarousel(dir) {
  if (!_carouselThemes.length) return;
  const n = _carouselThemes.length;
  _carouselIdx = (_carouselIdx + dir + n) % n;
  applyThemeLive(_carouselThemes[_carouselIdx]);
  updateCarouselDisplay();
}

$('#btn-themes')?.addEventListener('click', () => {
  if (_carouselOpen) closeThemeCarousel(); else openThemeCarousel();
});
$('#theme-carousel-prev')?.addEventListener('click', () => cycleCarousel(-1));
$('#theme-carousel-next')?.addEventListener('click', () => cycleCarousel(1));
$('#theme-carousel-done')?.addEventListener('click', closeThemeCarousel);

// Arrow keys flip themes; Esc closes — only while the carousel is open.
document.addEventListener('keydown', (e) => {
  if (!_carouselOpen) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); cycleCarousel(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); cycleCarousel(1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeThemeCarousel(); }
});
$('#btn-help')?.addEventListener('click', () => { setActiveHelpTab('basics'); showModal('help-modal'); });
$('#title-bar').addEventListener('click', () => showModal('about-modal'));
// Settings → About. The in-game wordmark (the other About entry) is
// hidden on phones to give the board its space, so Settings must carry
// the path everywhere. Hide Settings first: about-modal sits EARLIER
// in the DOM, so stacked it would paint underneath.
$('#btn-about')?.addEventListener('click', () => {
  hideModal('settings-modal');
  showModal('about-modal');
});

// The Lexicon — generated single-technique lessons behind the
// deducibility click-gate. Lazy-loaded: it never touches the boot path,
// game state, or the par pipeline.
const gymCard = $('#mode-card-gym');
if (gymCard) {
  gymCard.addEventListener('click', () => {
    import('./ui/lexiconUI.js').then(m => m.openLexicon())
      .catch(err => reportCaughtError('lexicon-import', err));
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
    // name-capture-modal is the leaderboard-name gate — like gameover-overlay
    // it manages its own dismissal (only a valid name closes it), so a
    // backdrop tap must not close it.
    if (e.target === modal && modal.id !== 'gameover-overlay' && modal.id !== 'name-capture-modal') {
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

// ── Checkpoint Selector (Challenge mode) ────────────────
// Row labels come from the Challenge 250 map's own intro blocks: modifier
// debuts keep their GIMMICK_DEFS icon/name, shape debuts use the
// player-facing shape names (tilingLabel — the 2026-08-02 naming ruling).
const GIMMICK_LABELS = (() => {
  const labels = {};
  const defs = getGimmickDefs();
  for (const [block, key] of Object.entries(MOD_INTRO_BLOCKS)) {
    const def = defs[key];
    if (!def) continue;
    labels[(block - 1) * CHALLENGE_BLOCK_SIZE + 1] = { key, icon: def.icon, name: def.name };
  }
  for (const [block, type] of Object.entries(SHAPE_INTRO_BLOCKS)) {
    labels[(block - 1) * CHALLENGE_BLOCK_SIZE + 1] = { key: null, icon: '', name: tilingLabel(type) };
  }
  return labels;
})()

function showCheckpointSelector() {
  const stats = loadStats();
  const maxLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
  // maxLevelReached is the level you WON — the next level you'd play is
  // maxLevel + 1, and there is no ceiling on that: past the crown the
  // endless zone banks checkpoints forever.
  const nextPlayable = maxLevel + 1;
  const savedGame = loadGameState('normal');
  // The Resume button must offer only what tryResumeGame would actually
  // restore. It used to read the slot raw, so a pre-C250 save advertised
  // "Resume Game · Level 100" to a player the epoch reset had just returned to
  // Level 1 — and the tap resumed it (issue #239). Same pure gate, one answer.
  const hasSavedGame = !!(savedGame && savedGame.board && savedGame.gameMode)
    && challengeSaveIsCurrent(savedGame, maxLevel);

  const resumeEl = $('#checkpoint-resume');
  const listEl = $('#checkpoint-list');

  // Resume button (if a saved game exists)
  if (hasSavedGame) {
    resumeEl.classList.remove('hidden');
    resumeEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'checkpoint-resume-btn';
    btn.innerHTML = `<span class="resume-icon">${uiSpriteImgHTML('uiReplay', 'ui-icon')}</span><span class="resume-label">Resume Game<br><span class="resume-level">Level ${savedGame.currentLevel}</span></span>`;
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

  // The authored ladder always lists in full; the endless zone lists only as
  // far as the player has actually banked, because it has no end to draw.
  const listMax = Math.max(CHALLENGE_MAX_LEVEL, highestCheckpoint + CHECKPOINT_INTERVAL - 1);
  for (let cp = 1; cp <= listMax; cp += CHECKPOINT_INTERVAL) {
    const unlocked = cp <= highestCheckpoint || cp === 1;
    const btn = document.createElement('button');
    btn.className = 'checkpoint-btn' + (unlocked ? '' : ' checkpoint-locked');

    // Build label
    let levelText = `Level ${cp}-${cp + CHECKPOINT_INTERVAL - 1}`;

    const gimmick = GIMMICK_LABELS[cp];
    let modifierHtml = '';
    if (gimmick) {
      const cpIcon = gimmickSpriteImgHTML(gimmick.key, 'sprite-gimmick', gimmick.name) || gimmick.icon || '';
      modifierHtml = `<span class="cp-modifier"><span class="cp-modifier-icon">${cpIcon}</span> ${gimmick.name}</span>`;
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
        // This entry path bypasses switchMode, so clear the playtest flags
        // here too — a real checkpoint start must record progression, and must
        // not inherit a ?coastline= tiling practice (which would route newGame
        // into the tiling branch and record a challenge run on a test board).
        state.isLevelPractice = false;
        clearCoastlinePractice();
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
    // The Gym card is a .mode-card (for the grid layout) but carries NO
    // data-mode and has its own handler (openLexicon). Without this guard
    // it falls through every branch below to switchMode(undefined), which
    // started a hidden challenge game UNDER the gym overlay and hid the
    // title — so closing the gym revealed that game, and the idle clock
    // painted its pause overlay over the gym. A mode-less card does
    // nothing here; its own handler owns the click.
    if (!mode) return;
    if (mode === 'normal') {
      showCheckpointSelector();
      return;
    }
    if (mode === 'chaos') {
      if (!isChaosUnlocked()) {
        showToast(`Reach Challenge Level ${CHAOS_UNLOCK_LEVEL} to unlock Chaos mode!`);
        return;
      }
      // Apply chaos theme automatically (stash/restore lives in themeManager)
      enterChaosTheme(state.theme);
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
      // Entering via the card is always the OFFICIAL daily, even after
      // a practice (?seed=) session earlier in this tab. Don't touch
      // dailySeed/dailyRngSeed here: switchMode persists the outgoing
      // game first, and nulling the live seeds beforehand used to strip
      // the date fingerprint off that snapshot — the undated save then
      // bypassed every stale-save guard and resumed yesterday's board
      // as "today's" daily. newGame derives the seed from the clock.
      state.isDailyPractice = false;
    }
    if (mode === 'weekly') {
      // Cloud-synced gate: refuse a second attempt on the same day.
      if (state.cachedWeeklyDayAttempts && state.cachedWeeklyDayAttempts[getWeekDayIndex()]) {
        showToast("You've already played today's weekly puzzle. Come back tomorrow!");
        return;
      }
      // No identity pre-set here (same trap as daily: switchMode
      // persists the outgoing game first, and stamping the new
      // gameMode/weekStart/dayIndex onto live state beforehand forged
      // the old game's snapshot as current). newGame's weekly branch
      // derives weekStart + day index from the clock.
      state.isDailyPractice = false;
      hideTitleScreen();
      switchMode('weekly');
      return;
    }
    hideTitleScreen();
    switchMode(mode);
  });
}

const titleHelpBtn = $('#title-help-btn');
if (titleHelpBtn) {
  titleHelpBtn.addEventListener('click', () => { setActiveHelpTab('basics'); showModalFromTitle('help-modal'); });
}

// The Modifiers help tab renders straight from the gimmick registry so
// the reference can never drift from the actual rules. Rendered once at
// boot — the registry is static. Sorted by Challenge intro level so the
// list reads in the order players actually meet them; chaos-only types
// sink to the end (mineShift carries a vestigial intro level, so the
// chaosOnly flag is the sort signal, not the level).
const helpModifierList = $('#help-modifier-list');
if (helpModifierList) {
  const introRank = (d) => (d.chaosOnly ? 999 : (d.intro ?? 998));
  helpModifierList.innerHTML = Object.entries(getGimmickDefs())
    .sort((a, b) => introRank(a[1]) - introRank(b[1]))
    .map(([key, def]) => {
      const icon = gimmickSpriteImgHTML(key, 'sprite-gimmick', def.name) || def.icon || '';
      return `<p>${icon} <strong>${def.name}</strong>: ${def.desc}</p>`;
    })
    .join('');
}

// Progress and More sheets — the grouped footer. A sheet row hides its
// sheet (plain hideModal, NOT closeModalAndReturn: the _returnToTitle
// flag must survive the hop) and opens the destination modal, whose
// close button then returns to the title screen as before.
const titleProgressBtn = $('#title-progress-btn');
if (titleProgressBtn) {
  titleProgressBtn.addEventListener('click', () => showModalFromTitle('progress-sheet'));
}
const titleMoreBtn = $('#title-more-btn');
if (titleMoreBtn) {
  titleMoreBtn.addEventListener('click', () => showModalFromTitle('more-sheet'));
}
function _sheetRowOpens(rowId, sheetId, openFn) {
  const row = $(rowId);
  if (row) row.addEventListener('click', () => { hideModal(sheetId); openFn(); });
}
_sheetRowOpens('#sheet-stats-btn', 'progress-sheet', () => {
  updateStatsDisplay();
  showModalFromTitle('stats-modal');
});
_sheetRowOpens('#sheet-achievements-btn', 'progress-sheet', () => {
  updateAchievementsDisplay();
  showModalFromTitle('achievements-modal');
});
_sheetRowOpens('#sheet-leaderboard-btn', 'progress-sheet', () => {
  updateLeaderboardDisplay();
  showModalFromTitle('leaderboard-modal');
});
_sheetRowOpens('#sheet-collection-btn', 'more-sheet', () => {
  renderCollectionModal();
  showModalFromTitle('collection-modal');
});
// Greg's Journal — the nightly experiment's notebook. The modal shell
// opens instantly; the renderer (and its findings derivation) is
// lazy-loaded like the Gym, since most sessions never open it.
_sheetRowOpens('#sheet-journal-btn', 'more-sheet', () => {
  showModalFromTitle('journal-modal');
  import('./ui/journalView.js')
    .then((m) => m.renderJournalModal())
    .catch((err) => {
      reportCaughtError('journal-import', err);
      const body = $('#journal-body');
      if (body) body.textContent = 'Could not open the journal. Check your connection and try again.';
    });
});
_sheetRowOpens('#sheet-settings-btn', 'more-sheet', () => {
  // Load saved player name into settings input
  const nameInput = $('#player-name-input');
  if (nameInput) nameInput.value = getPlayerName();
  setActiveSettingsTab('general');
  showModalFromTitle('settings-modal');
  syncReminderUI();
  _updateSettingsUid();
  _updateSettingsAccount();
});
const sheetWhatsnewBtn = $('#sheet-whatsnew-btn');
if (sheetWhatsnewBtn) {
  sheetWhatsnewBtn.addEventListener('click', () => {
    setLastSeenVersion(CURRENT_VERSION);
    sheetWhatsnewBtn.querySelector('.whatsnew-badge')?.remove();
    $('#more-btn-dot')?.classList.add('hidden');
    hideModal('more-sheet');
    showModalFromTitle('whatsnew-modal');
  });
  // Show NEW badge ONLY for returning visitors who saw an older
  // version. First-time visitors (lastSeen empty) get no badge —
  // they haven't missed anything, the NEW label would just confuse.
  // Mark them as "having seen" the current version so the badge
  // never fires for them retroactively after the next deploy. The
  // row's badge lives behind the More button now, so a dot on More
  // makes the news visible before the sheet is opened.
  const lastSeen = getLastSeenVersion();
  if (!lastSeen) {
    setLastSeenVersion(CURRENT_VERSION);
  } else if (lastSeen !== CURRENT_VERSION) {
    const badge = document.createElement('span');
    badge.className = 'whatsnew-badge';
    badge.textContent = 'NEW';
    sheetWhatsnewBtn.appendChild(badge);
    $('#more-btn-dot')?.classList.remove('hidden');
  }
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
  setReturnToTitle(false);
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
  const theme = safeGet('minesweeper_theme') || 'classic';
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
  const safeEmail = email ? escapeHtml(String(email)) : '';
  const safeProvider = escapeHtml(String(providerLabel || 'this'));
  const who = safeEmail
    ? `the ${safeProvider} account <strong>${safeEmail}</strong>`
    : `that ${safeProvider} account`;
  return await openAccountConfirmModal({
    title: 'Switch to existing account?',
    body:
      `An account already exists for ${who}. Signing in here will switch this device to that account. Your phone's streak, history, and progress will appear here.` +
      `<br><br><strong>Any progress this device has made anonymously will be lost.</strong>`,
    okLabel: 'Continue',
    danger: true,
  });
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
    showToast('Popup blocked. Try again or use the email link');
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
    body: 'You\'ll go back to playing as an anonymous device. Your synced progress stays with your account. Sign in again to bring it back.',
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
// Real-time cloud sync: any write to users/{uid}/* (from this device
// OR from another device signed in to the same account) fires the
// listener with the updated snapshot. We apply the merge + refresh the
// counters on the title screen / header so a daily completion on PC
// appears on phone within a second, without needing the app reopened.
subscribeToCloudProgressUpdates((cloud) => {
  // overwrite: true — the listener fires when cloud is the new
  // authoritative state, including downgrades from admin resets or a
  // partner device. The max-merge default would stick a higher local
  // value indefinitely after such a write.
  try { applyCloudProgress(cloud, { overwrite: true }); } catch (err) { reportCaughtError('apply-cloud-progress', err); }
  // applyCloudProgress only handles the stats fields (streak / lastDate
  // / checkpoint). Weekly attempts live separately under cloud's
  // weeklyAttempts[weekStart].dayAttempts subtree, and the title screen
  // reads them from state.cachedWeeklyDayAttempts — so we also extract
  // and apply the current week's attempts here, otherwise a weekly day
  // attempt on device A would still show as "2/7 used" on device B.
  try {
    const currentWeek = getWeekStart(getLocalDateString());
    const dayAttempts = cloud.weeklyAttempts
      && cloud.weeklyAttempts[currentWeek]
      && cloud.weeklyAttempts[currentWeek].dayAttempts;
    if (dayAttempts && typeof dayAttempts === 'object') {
      const next = {};
      for (const k of Object.keys(dayAttempts)) {
        const n = Number(k);
        if (Number.isInteger(n) && n >= 0 && n <= 6) next[n] = true;
      }
      state.cachedWeeklyDayAttempts = next;
      state.cachedWeeklyAttemptsWeek = currentWeek;
      if (!isTestEnvironment()) replaceLocalWeeklyAttempts(currentWeek, next);
    } else if (isWeeklyAttemptCacheStale(state.cachedWeeklyAttemptsWeek, currentWeek)) {
      // Week rolled over and the cloud carries NO attempts for the new
      // week yet — the snapshot is authoritative that it's empty, so
      // clear the stale prior-week cache rather than leave it gating the
      // player out of a week that has reset. Re-seed from localStorage
      // (empty for a fresh week) for the synchronous gate.
      state.cachedWeeklyDayAttempts = isTestEnvironment() ? {} : loadLocalWeeklyAttempts(currentWeek);
      state.cachedWeeklyAttemptsWeek = currentWeek;
      if (!isTestEnvironment()) pruneStaleLocalWeeklyAttempts(currentWeek);
    }
  } catch {}
  try { updateTitleProgress(); } catch {}
  try { updateHeader(); } catch {}
});

// Reconcile the daily streak against the authoritative completion history
// (users/{uid}/dailyHistory). The self-heal for streaks corrupted by a
// connectivity drop or a uid split: raises the stored streak to the real
// consecutive-day run once the history is reachable. Upward-only (see
// reconcileStreakFromHistory). One read; call after any cloud merge.
async function _reconcileDailyStreak() {
  try {
    const entries = await loadDailyHistory();
    if (!entries) return;
    // Archive replays are marked in dailyHistory and must not bear streak —
    // a replayed gap day would otherwise splice the run together (#113).
    if (reconcileStreakFromHistory(streakBearingDates(entries))) {
      try { updateTitleProgress(); } catch {}
      try { updateHeader(); } catch {}
    }
  } catch (err) {
    console.warn('streak reconcile failed:', err && err.message);
  }
}

// The weekly's counterpart: raise the week streak to the run the player's own
// weeklyAttempts record implies. Same upward-only self-heal, same reason — a
// counter that starts counting when it ships knows nothing about the fourteen
// weeks already in the account. One owner-scoped read.
async function _reconcileWeekStreak() {
  try {
    const weeks = await fetchPlayedWeeks();
    if (!weeks) return;
    if (reconcileWeekStreakFromHistory(weeks)) {
      try { updateTitleProgress(); } catch {}
    }
  } catch (err) {
    console.warn('week streak reconcile failed:', err && err.message);
  }
}

subscribeToUidChanges(async ({ uid, isInitial }) => {
  if (isInitial) return; // initial load is handled by the existing init() chain
  if (!uid) return;
  try {
    // The user has explicitly chosen to adopt this account's identity,
    // so the local daily streak / lastDailyCompletedDate are obsolete —
    // they belonged to the device's now-abandoned anonymous uid. Reset
    // those fields so applyCloudProgress takes the new account's values
    // verbatim instead of its date-based max-merge keeping the local ones.
    resetDailyStatsForAccountSwitch();
    const cloud = await loadProgress();
    if (cloud) applyCloudProgress(cloud);
    // Adopt the switched-in account's real streak from its completion
    // history. This is what restores a long streak after signing in on a
    // device whose anonymous play history was just reset above.
    await _reconcileDailyStreak();
    await _reconcileWeekStreak();
    // Re-prime the daily-residuals cache so the personal-par estimate
    // catches up to the new account's recent plays right away.
    const { backfillResidualsFromFirebase } = await import('./logic/handicaps.js');
    backfillResidualsFromFirebase(uid).catch(err => reportCaughtError('residuals-backfill-uidswitch', err));
    // Re-publish this device's current leaderboard name under the NEW uid so
    // the switched-in account's rows resolve to the player's live name via the
    // playerNames join. The name is LOCAL (not part of the abandoned per-uid
    // data), so it carries across the switch; without this the new uid's
    // playerNames node stays empty and its past rows fall back to their frozen
    // stored names — breaking the "a name change shows on every record"
    // guarantee on exactly the cross-device link path this feature targets.
    // This is the re-publish firebaseProgress's pending-drop-on-switch relies on.
    publishPlayerName(getPlayerName());
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
    showToast('Couldn\'t copy. Long-press the ID and Copy manually');
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
    `(Privacy policy: ${PROD_SITE_BASE}privacy.html)`,
  ].join('\n');
  const url = 'mailto:christopher.wells.23@gmail.com'
    + '?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(body);
  window.location.href = url;
});

// Reset Profile
$('#btn-reset-profile').addEventListener('click', () => {
  if (confirm('Are you sure you want to reset your profile? This will erase ALL stats, achievements, and leaderboard data. This cannot be undone.')) {
    setReturnToTitle(false); // Stay in game after reset
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
  // Challenge has no top (the endless zone), so only Quick Play caps here.
  // The same rule the Next Level BUTTON follows in winLossHandler; the two
  // used to share a cap, and capping only one of them would either show a
  // dead button or advance past a hidden one.
  const cappedAtTop = state.gameMode === 'timed' && state.currentLevel >= MAX_TIMED_LEVEL;
  const completedLevel = state.currentLevel;
  if (!cappedAtTop) state.currentLevel++;

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

// The daily win card's inline name form was removed: a nameless daily/weekly/
// timed win is now gated by #name-capture-modal (src/ui/nameCapture.js) BEFORE
// the card renders, so by the time the card shows, the auto-submit path in
// winLossHandler always has a saved name. (No #gameover-submit-daily handler.)

$('#gameover-share').addEventListener('click', () => handleShare());

// Copy a link to YESTERDAY's crux teaser (a past board — never today's).
// The hardcoded prod base matches the share card; cruxes are read from
// prod even on the test build, so the link works wherever it's opened.
$('#gameover-crux-challenge')?.addEventListener('click', async () => {
  const yesterday = addCalendarDays(getLocalDateString(), -1);
  const url = `${PROD_SITE_BASE}?crux=${yesterday}`;
  const shareData = {
    title: 'GregSweeper',
    text: 'Greg already proved this one. See how many squares you can prove without a guess.',
    url,
  };
  // Open the native share sheet so the player picks an app (Messages,
  // WhatsApp, email...). Falls back to a clipboard copy with feedback
  // where Web Share isn't available (e.g. desktop Firefox). The old path
  // copied silently AND opened the crux in a new tab, which read as
  // "nothing happened" — never share to anyone.
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    try {
      await navigator.share(shareData);
    } catch (e) {
      // User dismissed the sheet, or share failed — stay quiet.
    }
  } else {
    copyToClipboard(url);
    showToast('Challenge link copied. Paste it to a friend.');
  }
});

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
  btn.innerHTML = `${uiSpriteImgHTML('uiLoading', 'btn-icon')} Setting up…`;
  try {
    const { enableNotifications, loadNotificationPrefs } = await import('./firebase/firebasePush.js');
    const prefs = await loadNotificationPrefs();
    const result = await enableNotifications({
      hourLocal: typeof prefs.hourLocal === 'number' ? prefs.hourLocal : 9,
      dailyReminder: true,
      streakWarning: prefs.streakWarning ?? false,
    });
    // Outcome mapping lives in the pure remindCta helper: the old inline
    // test compared against `true`/'ok' — values enableNotifications never
    // returns — so a SUCCESSFUL enable rendered "Try again" every time
    // (2026-07-10 audit).
    const outcome = remindCtaOutcome(result);
    if (outcome === 'enabled') {
      btn.innerHTML = `${uiSpriteImgHTML('uiSuccess', 'btn-icon')} Reminder set for tomorrow`;
      showToast('Notifications on. See you tomorrow!');
    } else if (outcome === 'install') {
      btn.innerHTML = `${uiSpriteImgHTML('uiPhone', 'btn-icon')} Install to home screen first`;
      showToast('Install GregSweeper to your home screen on iOS first');
      btn.disabled = false;
    } else if (outcome === 'blocked') {
      btn.innerHTML = `${uiSpriteImgHTML('uiWarning', 'btn-icon')} Permission blocked`;
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
    // The name gate is non-dismissible (like gameover-overlay) — Escape must
    // not close it while focus sits on its Save button (its input already
    // short-circuits above).
    const nameGateEl = $('#name-capture-modal');
    const nameGateOpen = nameGateEl && !nameGateEl.classList.contains('hidden');
    if (!gameoverOpen && !nameGateOpen) {
      const visibleModals = [...$$('.modal')].filter(m => !m.classList.contains('hidden'));
      if (visibleModals.length > 0) {
        closeModalAndReturn(visibleModals[visibleModals.length - 1].id);
      }
    }
    return;
  }

  if (anyModalOpen) return;

  if (e.key === 'r' || e.key === 'R') {
    // Same rule as the smiley: daily/weekly boards are canonical and the
    // clock is the score, so a keyboard restart would be a fresh timer on
    // a board the player has already seen. This shortcut used to skip the
    // guard entirely (2026-07-10 audit).
    if (blocksManualRestart(state.gameMode)) return;
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
    muteBtn.innerHTML = uiSpriteImgHTML(nowMuted ? 'uiMuteOff' : 'uiMuteOn', 'ui-icon-nav', nowMuted ? 'Unmute' : 'Mute');
    muteBtn.title = nowMuted ? 'Unmute' : 'Mute';
  });
}

// ── Player Name Setting ──────────────────────────────

const playerNameInput = $('#player-name-input');
if (playerNameInput) {
  playerNameInput.value = getPlayerName();
  // Live-save on each keystroke. setPlayerName silently declines to
  // persist a hate-speech name (returns ok:false) — we stay quiet here
  // rather than toasting mid-word.
  playerNameInput.addEventListener('input', () => {
    setPlayerName(playerNameInput.value.trim().slice(0, 20));
  });
  // On commit (blur / Enter), if the final value was a rejected
  // hate-speech name, surface the message and revert the field to the
  // last good saved name. On a good name, publish it to playerNames/{uid}
  // so every leaderboard (including past rows) shows the new name by uid —
  // this is what makes a name change propagate to previous records.
  playerNameInput.addEventListener('change', () => {
    const result = setPlayerName(playerNameInput.value.trim().slice(0, 20));
    if (result && result.ok === false && result.reason === 'hate') {
      showToast("That name isn't allowed. Please pick another.");
      playerNameInput.value = getPlayerName();
    } else if (result && result.ok && result.value) {
      publishPlayerName(result.value);
    }
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
    } catch (err) { reportCaughtError('push-token-refresh-boot', err); }
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
        showToast('Daily reminders enabled', 2000, 'uiNotifyOn');
      } else if (result === 'denied') {
        dailyReminderToggle.checked = false;
        showToast('Notifications are blocked in your browser settings. Enable them there to use this.');
      } else if (result === 'ios-needs-install') {
        dailyReminderToggle.checked = false;
        showToast('Install GregSweeper to your home screen first to enable notifications.');
      } else if (result === 'no-key') {
        dailyReminderToggle.checked = false;
        showToast("Notifications aren't available on this build yet.");
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
        showToast('Daily reminders disabled', 2000, 'uiNotifyOff');
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
      showToast(enabled ? 'Streak rescue on (8pm ET)' : 'Streak rescue off', 2000, enabled ? 'achStreak' : null);
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

// Classic mines & flags toggle — pins the board objects to the canonical
// sprites on every theme (getThemeEmoji reads data-classic-objects).
const classicObjectsToggle = $('#classic-objects-toggle');
const CLASSIC_OBJECTS_KEY = 'minesweeper_classic_objects';
function applyClassicObjects(enabled) {
  document.documentElement.setAttribute('data-classic-objects', enabled ? 'true' : 'false');
  safeSet(CLASSIC_OBJECTS_KEY, enabled ? '1' : '0');
}
if (classicObjectsToggle) {
  const coEnabled = safeGet(CLASSIC_OBJECTS_KEY) === '1';
  classicObjectsToggle.checked = coEnabled;
  applyClassicObjects(coEnabled);
  classicObjectsToggle.addEventListener('change', () => {
    applyClassicObjects(classicObjectsToggle.checked);
    try { updateAllCells(); } catch {} // re-skin a live board immediately
  });
}

// ── Init ───────────────────────────────────────────────

// Background-resume the mode slot's save behind the TITLE SCREEN, landing it
// in the same paused state Home produces (issue #200 — the #197 leak through
// the boot door). Three routing branches below show the title and then warm
// the saved game up behind it so entering is instant; tryResumeGame ends in
// the deliberately UNGATED startTimer (every other resume site runs with
// #app visible and must tick immediately), so the boot resume left the LCD
// counting behind the title from boot until the player entered the game —
// title minutes charged to the challenge clock, and the worm heartbeat
// burning movesLeft the player never saw (the realized dose the refit fits
// on). Pause right AFTER the resume rather than gating startTimer:
// showTitleScreen has already run at every caller, so #app is hidden and
// resumeTimer's #197 gate holds the pause through title taps and tab
// returns; entering the game re-runs the resume with #app visible
// (hideTitleScreen → switchMode → tryResumeGame → startTimer +
// rearmPlateTimers), waking the clock from the frozen value. Plates are
// deliberately NOT re-armed here, unlike the hideTitleScreen resume sites:
// their deadline is raw wall-clock with no pause, so a plate armed behind
// the title detonates a game the player cannot see (the #192 incident
// shape) — showTitleScreen already tore them down, and the entry path
// re-arms with a fresh countdown, the documented lenient direction.
async function resumeSaveBehindTitle() {
  if (!tryResumeGame()) await newGame();
  else pauseTimer();
}

async function init() {
  // Challenge 250 progression reset — FIRST, before any surface reads
  // maxLevelReached (title progress, theme unlocks, checkpoint selector).
  // One-time and epoch-guarded, so this line is a no-op on every boot
  // after the one that resets. Cross-device resurrection is blocked by
  // the epoch-gated challenge250 cloud node, not by call order.
  applyChallenge250Reset();
  preloadSprites();
  startGregMascot($('#title-greg-mascot')); // inject + animate the header Greg before any routing
  const theme = loadTheme();
  const unlocked = getUnlockedThemes();

  let activeTheme = theme;
  // Guard BOTH not-yet-unlocked and no-longer-existing themes. A saved
  // theme that was cut from the catalog (the 2026-06 trim to the kept
  // set) is undefined in `unlocked` — without the `in` check it would
  // apply with no CSS file behind it and render unstyled.
  if (!(theme in THEME_UNLOCKS) || unlocked[theme] === false) {
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
    muteBtn.innerHTML = uiSpriteImgHTML(muted ? 'uiMuteOff' : 'uiMuteOn', 'ui-icon-nav', muted ? 'Unmute' : 'Mute');
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  }

  initFirebase();

  // Wire FCM token re-subscription to uid changes BEFORE auth settles
  // so the listener catches the first uid switch even if it happens
  // unusually fast (persisted email-link return URL on boot).
  import('./firebase/firebasePush.js').then(m => m.initPushAuthListener()).catch(err => reportCaughtError('push-auth-listener', err));

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
    // Self-heal the streak from the authoritative completion history once
    // auth + cloud have settled. Recovers a streak the local counter lost
    // to an offline gap or a mid-session uid switch on a prior session.
    await _reconcileDailyStreak();
    // Same for the week streak, from the player's own weeklyAttempts record.
    // Without it the counter starts at zero for everyone, which is how the
    // feature shipped telling a player with fourteen unbroken weeks that they
    // had no streak.
    await _reconcileWeekStreak();
    // One-time launch grant of molt days for an existing streak, now that the
    // synced streak is settled. Refresh the title card if it granted any.
    if (backfillMoltDays()) { try { updateTitleProgress(); } catch {} }
  }).catch(err => reportCaughtError('cloud-progress-load', err)); // progress stays local-only on failure — but the failure is reported

  // Preload handicaps so the end-of-game modal can render personal par
  // without a race. Fire-and-forget; getHandicapRatio() falls back to a
  // neutral k=1 when the file hasn't loaded yet.
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
    backfillResidualsFromFirebase(uid).catch(err => reportCaughtError('residuals-backfill', err));
  }).catch(err => reportCaughtError('residuals-backfill-auth', err));

  // Warm the experiment-target cache so selectDailyRngSeed has the
  // current target when the user lands on a daily. If the fetch hasn't
  // resolved yet, the module falls back to DEFAULT_TARGET.
  loadExperimentTarget();

  // Warn if localStorage is broken (private browsing, quota, etc.)
  if (isStorageFailing()) {
    showToast('Playing in temporary mode: progress won\'t be saved', 5000, 'uiWarning');
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
  // ?level=N — test-environment-only practice jump to any challenge level
  // (playtesting a specific gimmick block without grinding to it).
  const _levelParam = parseInt(urlParams.get('level') || '', 10);
  // No upper clamp: the endless zone is a real part of the ladder and has to
  // be reachable for playtesting like any other stretch of it.
  const deepLinkLevel = (isTestEnvironment() && _levelParam >= 1) ? _levelParam : 0;
  // ?coastline= — test-environment-only tiling board (Project Coastline
  // Phase 2). Gated exactly like ?level=, so it is UNREACHABLE in production
  // no matter which of the six lattices the link names; the player-facing
  // surface is a later release step.
  const coastlinePractice = isTestEnvironment() && urlParams.get('coastline') != null;
  // ?dailyShape=<tiling|rect> — test-environment-only override for the daily
  // SHAPE ROTATION (dark while TILING_ROTATION_START is unset). Gated at the
  // derivation like ?level=/?coastline=, and doubly contained: the override
  // only ever applies to a PRACTICE-lane daily (gameActions consults it only
  // when state.isDailyPractice), so even in a test build it cannot touch a
  // recording daily — /test/ shares localStorage with production, and an
  // overridden board recording as the real date would block that day's real
  // play (the ?level= pollution class). Reached via the daily deep link:
  // ?mode=daily&dailyShape=hex[&seed=x] plays a forced-shape practice daily
  // through the FULL daily code path (canonical-miss lane). A Daily-card tap
  // in the same session stays a normal live daily.
  const dailyShapeOverride = (isTestEnvironment() && urlParams.get('dailyShape'))
    ? setDailyShapeOverride(urlParams.get('dailyShape'))
    : null;
  // ?parlab=1 — test-environment-only Par Lab: the designed 100-board
  // battery whose results seed the per-shape par priors (see
  // src/logic/parLab.js for the design). Rides the coastline-practice lane
  // (isLevelPractice, frozen certified boards, nothing records to real
  // progression); results log to namespaced localStorage and export from
  // the lab HUD. Gated at the derivation like ?level=/?coastline=.
  const parLabMode = isTestEnvironment() && urlParams.get('parlab') != null;

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

  // ?crux= share route — a standalone teaser of a PAST daily's hardest
  // step. Resolve the date (empty / "1" = yesterday ET), refuse today and
  // later so the live board is never spoiled, then render and STOP: no
  // startup gate, no game init, works logged-out (cruxes is world-read).
  const cruxParam = urlParams.get('crux');
  if (cruxParam !== null) {
    const todayET = getLocalDateString();
    const yesterdayET = addCalendarDays(todayET, -1);
    // Spoiler + range guard (only yesterday-or-earlier, never before the first
    // canonical; out-of-range falls back to yesterday) — pinned in archiveEligibility.
    const cruxDate = resolveCruxDate(cruxParam, todayET, yesterdayET);
    hideBootOverlay();
    await showCruxTeaser(cruxDate);
    return;
  }

  // ?report= share route — one finding from Greg's Journal as a
  // standalone logged-out page. Same shape as ?crux=: no startup gate,
  // no game init; modelHistory.json is a static bundle asset so the
  // fetch needs no auth. The id is validated against the derived study
  // list inside showJournalReport (findingById); an unknown or empty id
  // renders the journal index, never an error. Lazy import — the module
  // is only ever needed on this route or a share tap.
  const reportParam = urlParams.get('report');
  if (reportParam !== null) {
    hideBootOverlay();
    const { showJournalReport } = await import('./ui/journalReport.js');
    await showJournalReport(reportParam);
    return;
  }

  // Startup gate — block rendering until the SW is current, Firebase is
  // ready, and the canonical board for today is in memory. Keeps the
  // boot overlay up across the whole wait so the player never sees a
  // flash of a divergent board.
  await runStartupGate();

  // Background: pre-fetch + cache the upcoming week of daily boards and
  // the current + next weekly board so they stay playable through an
  // offline stretch. Fire-and-forget and deferred so it never competes
  // with first paint; skips practice (?seed=) and offline sessions.
  if (state.firebaseReady && !urlParams.get('seed')) {
    setTimeout(() => {
      prefetchUpcomingDailyBoards(getLocalDateString()).catch(() => {});
      prefetchUpcomingWeeklyBoards(getWeekStart()).catch(() => {});
    }, 2500);
  }

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
  } else if (parLabMode) {
    // ?parlab=1 — the Par Lab battery (test builds only — gate in the
    // derivation above). Same practice frame as ?coastline=: gameMode
    // 'normal' + isLevelPractice + coastlinePractice, so the frozen-board
    // first-click path and the no-recording contract both apply; the lab
    // module owns board sequencing, per-board specs, and the results log.
    state.gameMode = 'normal';
    updateModeUI('normal');
    state.isLevelPractice = true;
    state.coastlinePractice = true;
    state.currentLevel = 1;
    hideTitleScreen();
    const { startParLab, performParLabRedo } = await import('./ui/parLabUI.js');
    // ?parlabRedo=<boardNumber|id> voids a contaminated run (deliberate
    // mine-popping, an interrupted sitting) BEFORE the session resumes:
    // the board re-issues with a fresh layout, and the voiding syncs as an
    // 'invalid' tombstone the analysis honors.
    const redoToken = urlParams.get('parlabRedo');
    if (redoToken) performParLabRedo(redoToken);
    await startParLab();
    showToast('Par Lab: play each board straight through. Strike penalties count into your time, like the daily. Nothing records to your progression.', 7000);
  } else if (coastlinePractice) {
    // ?coastline= test board (test builds only — gate in the derivation
    // above): a frozen tiling board played as an isLevelPractice run, so
    // nothing records (same localStorage-safety rationale as ?level=).
    // gameMode stays 'normal'; state.coastlinePractice routes newGame's
    // generation + revealCell's frozen first-click path onto the tiling.
    state.gameMode = 'normal';
    updateModeUI('normal');
    state.isLevelPractice = true;
    state.coastlinePractice = true;
    state.coastlineSeed = urlParams.get('seed') || null;
    // ?coastline=<modifier>[,<modifier>...] places those modifiers on the
    // tiling test board (e.g. ?coastline=sonar,mirror); ?coastline=1 or bare
    // is a plain board. Passed through to generateTilingBoard verbatim.
    //
    // An optional "<tiling>:" prefix picks the SHAPE, so
    // ?coastline=hex:sonar,walls is a 6.6.6 honeycomb with those modifiers and
    // a bare ?coastline=rhombille is a plain rhombille board. Without a prefix
    // the tiling is the 4.8.8, so every existing test link keeps working
    // unchanged. The parse itself is pure and node-tested in logic/coastlineLink
    // (it is the one place a tiling name reaches the code from outside it).
    const _coast = parseCoastlineParam(urlParams.get('coastline'));
    state.coastlineType = _coast.type;
    state.coastlineGimmicks = _coast.gimmicks;
    state.currentLevel = 1;
    hideTitleScreen();
    await newGame();
    const _cg = state.coastlineGimmicks;
    const _shape = tilingLabel(state.coastlineType);
    showToast(_cg.length
      ? `Coastline test board — ${_shape} + ${_cg.join(', ')}. Nothing records.`
      : `Coastline test board — ${_shape}. Nothing records.`, 6000);
  } else if (deepLinkLevel > 0) {
    // ?level=N playtest deep link (test builds only — the gate is in
    // deepLinkLevel's derivation): start a PRACTICE challenge run at any
    // level. Practice-gated end to end because /test/ shares this origin's
    // localStorage with prod: no stats, no maxLevelReached/checkpoints, no
    // challenge save slot, no power-up earns.
    state.gameMode = 'normal';
    updateModeUI('normal');
    state.isLevelPractice = true;
    state.currentLevel = deepLinkLevel;
    hideTitleScreen();
    await newGame();
    showToast(`Practice run at Level ${deepLinkLevel}. Nothing records.`, 5000);
  } else if (deepLinkMode === 'daily') {
    // Deep link to daily mode. ?seed=<custom> lets you play a fresh puzzle
    // under a non-today seed (e.g. after you've finished today's). Practice
    // runs submit to Firebase so the backend gets your uid, but don't
    // touch streak, bestTimes, completion flags, or personal history.
    // ?dailyShape= (test env only — derivation above) forces the practice
    // lane too: an overridden board is NOT the canonical, so it must never
    // record as the real date.
    const customSeed = urlParams.get('seed');
    const shapePractice = dailyShapeOverride != null;
    if (!customSeed && !shapePractice && isDailyCompleted(getLocalDateString())) {
      // Already completed (possibly adopted from another device by the
      // startup gate) — the Daily card gates this, and a notification
      // tap must not bypass it into a replay + duplicate submission.
      // Mirror the weekly already-played branch: title screen + toast.
      showTitleScreen();
      showToast("Already done for today. Weekly's open if you want more.");
      await resumeSaveBehindTitle();
    } else {
      state.gameMode = 'daily';
      if (customSeed || shapePractice) {
        // A bare ?dailyShape= run gets a synthetic practice seed, never the
        // real date: practice writes its par cache under state.dailySeed
        // (saveDailyPar), and /test/ shares localStorage with production, so
        // running under today's key would stamp the override board's par
        // onto the real daily's title-card badge.
        state.dailySeed = customSeed || `shape-${getLocalDateString()}`;
        state.isDailyPractice = true;
      }
      hideTitleScreen();
      if (shapePractice) {
        // Never resume into a forced-shape run: a stale save (the real
        // daily's, or a prior run under a DIFFERENT ?dailyShape=) would
        // silently ignore the requested shape.
        await newGame();
        showToast(`Practice daily on ${dailyShapeOverride === 'rect' ? 'a Classic board' : tilingLabel(dailyShapeOverride)}. Nothing records.`, 5000);
      } else if (!tryResumeGame()) {
        await newGame();
      } else {
        rearmPlateTimers();
      }
    }
  } else if (deepLinkMode === 'weekly') {
    // Deep link to weekly mode (used by push notifications and direct
    // shares). Drop into the weekly card's click-handler equivalent
    // state setup, then route through the daily flow.
    const dayIdx = getWeekDayIndex();
    if (state.cachedWeeklyDayAttempts && state.cachedWeeklyDayAttempts[dayIdx]) {
      // Already played today — show the title screen with the weekly
      // card surfacing the "Played today" status. Don't auto-launch.
      showTitleScreen();
      await resumeSaveBehindTitle();
    } else {
      // gameMode routes tryResumeGame to the weekly save slot; the
      // weekStart/dayIndex identity is clock-derived inside newGame.
      state.gameMode = 'weekly';
      hideTitleScreen();
      if (!tryResumeGame()) await newGame(); else rearmPlateTimers();
    }
  } else {
    // Returning user — show title screen
    showTitleScreen();
    // Pre-load the game in background so it's ready — paused, not ticking
    await resumeSaveBehindTitle();
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

// Re-seed the weekly-attempt cache when the ET week has rolled over
// while a long-lived session stayed open. The cache (state.cachedWeekly-
// DayAttempts) is populated once at boot for that day's week; nothing
// re-derives it afterward, so a background tab / installed PWA reopened
// after the Sunday→Monday boundary keeps the prior week's attempts in
// memory — the Weekly card then shows "Done N/7" and the play gate
// refuses a new attempt on a week that has actually reset (the weekly
// "didn't reset" bug). On a detected rollover, re-seed synchronously
// from localStorage (empty for a fresh week → the gate opens at once),
// then refresh authoritatively from Firebase. No-op when the week hasn't
// changed, and skipped on the test build (weekly is freely replayable there).
function refreshWeeklyAttemptCacheIfRolledOver() {
  if (isTestEnvironment()) return;
  const liveWeek = getWeekStart();
  if (!isWeeklyAttemptCacheStale(state.cachedWeeklyAttemptsWeek, liveWeek)) return;

  state.cachedWeeklyDayAttempts = loadLocalWeeklyAttempts(liveWeek);
  state.cachedWeeklyAttemptsWeek = liveWeek;
  pruneStaleLocalWeeklyAttempts(liveWeek);

  // Authoritative refresh: a Firebase read is the source of truth for
  // the week (an empty map legitimately clears a stale local copy).
  // Fire-and-forget — the synchronous local seed above already unblocked
  // the gate; this only corrects it if the cloud disagrees.
  if (state.firebaseReady) {
    loadWeeklyAttempts(liveWeek)
      .then(attempts => {
        if (!attempts) return; // null = read failed; keep the local seed
        if (state.cachedWeeklyAttemptsWeek !== liveWeek) return; // rolled again mid-fetch
        state.cachedWeeklyDayAttempts = attempts;
        replaceLocalWeeklyAttempts(liveWeek, attempts);
        const titleScreen = $('#title-screen');
        if (titleScreen && !titleScreen.classList.contains('hidden')) updateTitleProgress();
      })
      .catch(err => reportCaughtError('weekly-rollover-attempts', err));
  }
}

// Forfeit a live date-anchored game whose ET anchor has lapsed — the
// session slept through midnight in a background tab or suspended PWA,
// so the daily on screen is yesterday's (or the weekly attempt belongs
// to a previous day). A fresh load would reach the same verdict from
// the persisted save via isSaveResumable; this is the live-session
// equivalent. Clears the persisted save, marks the live game expired
// (persistGameState only writes playing/idle, so the dead state can
// never be re-saved), and routes to the title screen. Returns true
// when a game was expired.
function expireRolledOverGame() {
  // Re-derive the weekly-attempt cache first: a long-open session (a
  // background tab or installed PWA) seeds it once at boot and never
  // refreshes it, so crossing the ET week boundary while open leaves
  // last week's attempts in memory and the Weekly card reports the
  // week as already finished. This must run before the updateTitleProgress
  // / showTitleScreen calls below so the refreshed cards read fresh data.
  refreshWeeklyAttemptCacheIfRolledOver();

  const expired = isLiveGameExpired(state, {
    today: getLocalDateString(),
    weekStart: getWeekStart(),
    weekDayIndex: getWeekDayIndex(),
  });
  // The title screen is date-sensitive even with no game in progress
  // ("Completed today!", par line, weekly attempts) — refresh its cards
  // on every wake so midnight can't leave stale copy up.
  const titleScreen = $('#title-screen');
  const titleVisible = titleScreen && !titleScreen.classList.contains('hidden');
  if (!expired) {
    if (titleVisible) updateTitleProgress();
    return false;
  }
  stopTimer();
  state.status = 'expired';
  clearGameState(state.gameMode);
  showTitleScreen();
  showToast("New day! Yesterday's unfinished puzzle has expired.");
  return true;
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
    // Date-rollover check FIRST, so a stale game can't get its timer
    // resumed moments before being torn down.
    if (expireRolledOverGame()) return;
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
  // Wall lines and worm segments are pixel-anchored; re-place them against
  // the new cell rects or they keep the old geometry (walls drifted off
  // their edges on any viewport resize / phone rotation until 2026-07-17)
  renderWallOverlays();
  renderWormOverlays();
});

// Safety net: if init throws anywhere, drop the boot overlay so the
// user isn't stuck on a black screen with a spinner.
init().catch((err) => {
  console.error('init failed:', err);
  hideBootOverlay();
});
