// ── GregSweeper Entry Point ────────────────────────────
// All game logic and UI rendering is in modules.
// This file handles imports, event wiring, and init.

// ── Local Date Utility ──────────────────────────────
// getLocalDateString imported from seededRandom.js

import { state } from './state/gameState.js';
import { $, $$, boardEl, resetBtn, flagModeToggle, boardScrollWrapper, muteBtn } from './ui/domHelpers.js';
import { resizeCells, updateAllCells, getThemeEmoji, needsZoom, updateZoom, zoomIn, zoomOut, invalidateEmojiCache, setFocusedCell, announceGame } from './ui/boardRenderer.js';
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
import { loadHandicaps, getHandicap, estimateHandicapFromHistory } from './logic/handicaps.js';
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
  initFirebase, isFirebaseOnline, submitOnlineScore, fetchOnlineLeaderboard, fetchUserDailyHistory, fetchAllDailyMeta, fetchAllDailyScores,
} from './firebase/firebaseLeaderboard.js';
import { initAnonymousAuth, loadProgress, saveDailyHistoryEntry, getUid } from './firebase/firebaseProgress.js';
// Stats-tab renderer + chart toolkit are lazy-imported in populateDailyPanel
// so they stay off the critical load path — they only come in when the
// user actually opens the Stats modal. Saves ~3 network round-trips
// (statsRenderer, charts, dailyHistoryChart) on every cold load.
import { generateBoard, cleanSolverArtifacts } from './logic/boardGenerator.js';
import { isBoardSolvable } from './logic/boardSolver.js';
import { createDailyRNG, getLocalDateString } from './logic/seededRandom.js';
import { selectDailyRngSeed } from './logic/selectDailyRngSeed.js';
import { loadExperimentTarget, getCurrentTarget, getTargetGimmickName } from './logic/experimentDesign.js';
import { loadDailyBoard, deserializeBoard } from './firebase/dailyBoardSync.js';
import {
  EMOJI_PACKS, EFFECTS, TITLES,
  loadEmojiPack, saveEmojiPack, getActiveEmojiPack, isPackUnlocked,
  isEffectUnlocked, isTitleUnlocked,
  loadEffects, saveEffects, loadTitle, saveTitle,
} from './ui/collectionManager.js';
import { isModifierPopupDisabled, setModifierPopupDisabled, getGimmickDefs, getDailyGimmick, applyGimmicks } from './logic/gimmicks.js';
import { isStorageFailing, safeGet, safeSet, safeRemove } from './storage/storageAdapter.js';
import { pauseTimer, resumeTimer } from './game/timerManager.js';
import { startTutorial } from './ui/tutorialManager.js';

// ── Theme-color meta tag (Android nav bar) ───────────
function updateThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-app-bg').trim();
  if (bg) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  }
}

// ── Stats Display ─────────────────────────────────────

// Default tab = the mode the player most recently played (when meaningful).
function pickDefaultStatsTab() {
  if (state.gameMode === 'timed') return 'timed';
  if (state.gameMode === 'normal') return 'challenge';
  return 'daily';
}

function setActiveStatsTab(tab) {
  for (const btn of $$('.stats-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const panel of $$('.stats-panel')) {
    panel.classList.toggle('hidden', panel.id !== `stats-panel-${tab}`);
  }
}

async function updateStatsDisplay() {
  setActiveStatsTab(pickDefaultStatsTab());
  populateChallengePanel();
  populateQuickPlayPanel();
  await populateDailyPanel(); // async — fetches Firebase
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
  // nightly refit catches up.
  let handicap = getHandicap(uid);
  if (handicap === 0 && history && history.length >= 3) {
    const pairs = history
      .map(h => {
        const f = metaByDate[h.date];
        if (!f) return null;
        return { time: h.time, predictedPar: predictPar(f) };
      })
      .filter(Boolean);
    handicap = estimateHandicapFromHistory(pairs);
  }
  const { renderDailyStatsTab } = await import('./ui/statsRenderer.js');
  renderDailyStatsTab({
    history: history || [],
    metaByDate: metaByDate || {},
    scoresByDate: scoresByDate || {},
    uid,
    handicap,
  });
}

// Tab switcher — bind once at module load.
for (const btn of $$('.stats-tab')) {
  btn.addEventListener('click', () => setActiveStatsTab(btn.dataset.tab));
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

async function updateLeaderboardDisplay() {
  const dateStr = getLocalDateString();
  $('#leaderboard-date').textContent = prettyDate(dateStr);
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
  $('#leaderboard-empty').classList.toggle('hidden', hasEntries);

  // Get daily par and solver moves. Any cached par in localStorage was
  // computed against whatever PAR_MODEL was shipping when the daily was
  // played — it could be stale after a refit. If we have cached features
  // (either in-memory from a fresh play or in localStorage), always
  // recompute par from them against the CURRENT coefficients so the
  // leaderboard "Par" column matches today's model. Only fall through to
  // the expensive regenerate-from-seed path when no features are cached.
  const cached = loadDailyPar(dateStr);
  const featuresForPar = state.dailyFeatures || cached.features || null;
  let dailyPar = 0;
  let dailyMoves = state.dailyMoves || cached.moves;
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
        const forcedGimmick = getTargetGimmickName(getCurrentTarget());
        activeGimmicks = getDailyGimmick(rngSeed, createDailyRNG, forcedGimmick);

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

  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
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
  const modeLabel = { normal: 'Challenge', timed: 'Timed', skillTrainer: 'Skill Trainer', daily: 'Daily' }[mode] || 'Challenge';

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
  showModal('settings-modal');
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
$('#btn-collection').addEventListener('click', () => {
  renderCollectionModal();
  showModal('collection-modal');
});
$('#btn-help').addEventListener('click', () => showModal('help-modal'));
$('#title-bar').addEventListener('click', () => showModal('about-modal'));

// Collection tab switching
for (const tab of $$('.collection-tab')) {
  tab.addEventListener('click', () => {
    for (const t of $$('.collection-tab')) t.classList.remove('active');
    tab.classList.add('active');
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
    if (isDailyCompleted(today)) {
      dailyEl.textContent = streak > 0 ? `Completed! 🔥 ${streak} day streak` : 'Completed today!';
      if (dailyCard) dailyCard.classList.add('daily-completed');
    } else {
      dailyEl.textContent = streak > 0 ? `🔥 ${streak} day streak` : "Today's challenge";
      if (dailyCard) dailyCard.classList.remove('daily-completed');
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

  updateTitleProgress();
  titleScreen.classList.remove('hidden');
  app.classList.add('hidden');
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
        showToast("You've already completed today's daily!");
        return;
      }
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

const titleSettingsBtn = $('#title-settings-btn');
if (titleSettingsBtn) {
  titleSettingsBtn.addEventListener('click', () => {
    // Load saved player name into settings input
    const nameInput = $('#player-name-input');
    if (nameInput) nameInput.value = getPlayerName();
    showModalFromTitle('settings-modal');
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
  // Show NEW badge if user hasn't seen current version
  if (getLastSeenVersion() !== CURRENT_VERSION) {
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

// Diagnostics — ground-truth snapshot of what this device sees. Dynamic
// import so the module stays off the critical load path until opened.
$('#btn-diagnostics').addEventListener('click', async () => {
  $('#settings-modal').classList.add('hidden');
  const m = await import('./ui/diagnosticsModal.js');
  m.openDiagnosticsModal(CURRENT_VERSION);
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
    const sanitized = name.trim().slice(0, 20);
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

function init() {
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

  // Cloud progress sync: anonymous auth + silent restore
  initAnonymousAuth().then(() => loadProgress()).then(cloud => {
    if (cloud) applyCloudProgress(cloud);
  }).catch(() => {}); // silent — progress stays local-only

  // Preload handicaps so the end-of-game modal can render personal par
  // without a race. Fire-and-forget; getHandicap() falls back to 0
  // when the file hasn't loaded yet.
  loadHandicaps();

  // Warm the experiment-target cache so selectDailyRngSeed has the
  // current target when the user lands on a daily. If the fetch hasn't
  // resolved yet, the module falls back to DEFAULT_TARGET.
  loadExperimentTarget();

  // Warn if localStorage is broken (private browsing, quota, etc.)
  if (isStorageFailing()) {
    showToast('⚠️ Playing in temporary mode — progress won\'t be saved', 5000);
  }

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
  }

  if (!isOnboarded()) {
    // First time — launch interactive tutorial, then start challenge mode
    startTutorial(() => {
      state.gameMode = 'normal';
      hideTitleScreen();
      newGame();
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
    if (!tryResumeGame()) newGame();
  } else {
    // Returning user — show title screen
    showTitleScreen();
    // Pre-load the game in background so it's ready
    if (!tryResumeGame()) newGame();
  }

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
    if (state.status === 'playing') {
      resumeTimer();
    }
  }
});
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

init();
