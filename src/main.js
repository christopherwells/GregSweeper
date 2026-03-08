import { generateBoard, createEmptyBoard, calculateAdjacency } from './logic/boardGenerator.js?v=0.6';
import { floodFillReveal, checkWin, revealAllMines, chordReveal } from './logic/boardSolver.js?v=0.6';
import { getDifficultyForLevel, getTimedDifficulty, getMaxZeroCluster, getSpeedRating, MAX_LEVEL, MAX_TIMED_LEVEL } from './logic/difficulty.js?v=0.6';
import {
  computeVisibleCells, getHiddenNumberRate, applyHiddenNumbers,
  decodeAdjacentHidden, decodeAllHidden,
  getRefogTimeout, computeRefogCells,
} from './logic/fogOfWar.js?v=0.6';
import { findSafeCell, scanRowCol, defuseMine, shieldDefuse, xRayScan } from './logic/powerUps.js?v=0.6';
import { createDailyRNG } from './logic/seededRandom.js?v=0.6';
import {
  loadStats, saveGameResult, resetStats,
  loadDailyLeaderboard, addDailyLeaderboardEntry,
  loadTheme, saveTheme,
  loadModePowerUps, saveModePowerUps,
  loadModeLives, saveModeLives,
} from './storage/statsStorage.js?v=0.7';
import {
  playReveal, playFlag, playUnflag, playExplosion,
  playCascade, playWin, playPowerUp, playShieldBreak,
  playLevelUp, playFreeze, playXRay,
  playDecode, playTimeRecord, isMuted, setMuted, loadMuted,
} from './audio/sounds.js?v=0.6';
import {
  getAchievementState, getTotalScore, checkNewUnlocks,
  getHighestTier, getAllTierNames, getTierIcon, getTierColor,
} from './logic/achievements.js?v=0.6';
import {
  initFirebase, isFirebaseOnline, submitOnlineScore, fetchOnlineLeaderboard,
} from './firebase/firebaseLeaderboard.js?v=0.6';

// ── Theme Unlock Progression ──────────────────────────
// Themes unlock based on highest level ever beaten (permanent).
// Dying in normal mode resets current level to 1 but keeps unlocks.
const THEME_UNLOCKS = {
  classic:          { levelRequired: 0,  displayName: 'Classic',        mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  dark:             { levelRequired: 0,  displayName: 'Dark',           mine: '💣', flag: '🚩', smiley: '😊', smileyWin: '😎', smileyLoss: '😵' },
  ocean:            { levelRequired: 2,  displayName: 'Ocean',          mine: '🐡', flag: '⚓', smiley: '🐟', smileyWin: '🐬', smileyLoss: '🫧' },
  sunset:           { levelRequired: 3,  displayName: 'Sunset',         mine: '☀️', flag: '🚩', smiley: '🌤️', smileyWin: '🌞', smileyLoss: '🌧️' },
  forest:           { levelRequired: 4,  displayName: 'Forest',         mine: '🍄', flag: '🌿', smiley: '🌲', smileyWin: '🦉', smileyLoss: '🪵' },
  candy:            { levelRequired: 5,  displayName: 'Candy',          mine: '🍬', flag: '🍭', smiley: '🧁', smileyWin: '🎂', smileyLoss: '🍩' },
  midnight:         { levelRequired: 6,  displayName: 'Midnight',       mine: '🌙', flag: '⭐', smiley: '🦇', smileyWin: '🌕', smileyLoss: '🌑' },
  stealth:          { levelRequired: 7,  displayName: 'Stealth',        mine: '💣', flag: '🏴', smiley: '🥷', smileyWin: '🕵️', smileyLoss: '💀' },
  neon:             { levelRequired: 8,  displayName: 'Neon',           mine: '⚡', flag: '🎯', smiley: '💡', smileyWin: '🔆', smileyLoss: '💤' },
  'cherry-blossom': { levelRequired: 9,  displayName: 'Cherry Blossom', mine: '🌸', flag: '🎀', smiley: '🌷', smileyWin: '🦋', smileyLoss: '🥀' },
  aurora:           { levelRequired: 10, displayName: 'Aurora',         mine: '❄️', flag: '🌌', smiley: '🌀', smileyWin: '🌈', smileyLoss: '🌫️' },
  volcano:          { levelRequired: 11, displayName: 'Volcano',        mine: '🌋', flag: '🔥', smiley: '🪨', smileyWin: '🏔️', smileyLoss: '💨' },
  ice:              { levelRequired: 12, displayName: 'Ice',            mine: '🧊', flag: '❄️', smiley: '⛄', smileyWin: '🏔️', smileyLoss: '💧' },
  cyberpunk:        { levelRequired: 13, displayName: 'Cyberpunk',      mine: '🤖', flag: '🔌', smiley: '🖥️', smileyWin: '🦾', smileyLoss: '⚠️' },
  retro:            { levelRequired: 14, displayName: 'Retro',          mine: '👾', flag: '🕹️', smiley: '🎮', smileyWin: '🏆', smileyLoss: '👻' },
  holographic:      { levelRequired: 15, displayName: 'Holographic',    mine: '💠', flag: '🔮', smiley: '🔮', smileyWin: '🪩', smileyLoss: '🫥' },
  galaxy:           { levelRequired: 16, displayName: 'Galaxy',         mine: '☄️', flag: '🛸', smiley: '🪐', smileyWin: '🌟', smileyLoss: '🌑' },
  toxic:            { levelRequired: 17, displayName: 'Toxic',          mine: '☢️', flag: '🧪', smiley: '🧫', smileyWin: '🧬', smileyLoss: '💀' },
  royal:            { levelRequired: 18, displayName: 'Royal',          mine: '👑', flag: '⚔️', smiley: '🏰', smileyWin: '👑', smileyLoss: '⚰️' },
  prismatic:        { levelRequired: 19, displayName: 'Prismatic',      mine: '🌈', flag: '✨', smiley: '💎', smileyWin: '🦄', smileyLoss: '🫧' },
  void:             { levelRequired: 20, displayName: 'Void',           mine: '🕳️', flag: '⚫', smiley: '👁️', smileyWin: '🌀', smileyLoss: '💫' },
  arctic:           { levelRequired: 21, displayName: 'Arctic',         mine: '🐻‍❄️', flag: '🏔️', smiley: '🦭', smileyWin: '🐧', smileyLoss: '🥶' },
  jungle:           { levelRequired: 22, displayName: 'Jungle',         mine: '🐍', flag: '🦜', smiley: '🐒', smileyWin: '🦁', smileyLoss: '🦴' },
  obsidian:         { levelRequired: 23, displayName: 'Obsidian',       mine: '🖤', flag: '⛓️', smiley: '🗿', smileyWin: '💎', smileyLoss: '🪦' },
  matrix:           { levelRequired: 24, displayName: 'Matrix',         mine: '🟢', flag: '🔴', smiley: '👁️', smileyWin: '🔓', smileyLoss: '🔒' },
  inferno:          { levelRequired: 25, displayName: 'Inferno',        mine: '🔥', flag: '💀', smiley: '😈', smileyWin: '👹', smileyLoss: '💀' },
  celestial:        { levelRequired: 26, displayName: 'Celestial',      mine: '🌟', flag: '🌠', smiley: '🌙', smileyWin: '☀️', smileyLoss: '🌑' },
  bloodmoon:        { levelRequired: 27, displayName: 'Blood Moon',     mine: '🩸', flag: '🌑', smiley: '🐺', smileyWin: '🦇', smileyLoss: '⚰️' },
  synthwave:        { levelRequired: 28, displayName: 'Synthwave',      mine: '🎹', flag: '🎧', smiley: '🎛️', smileyWin: '🎶', smileyLoss: '📴' },
  supernova:        { levelRequired: 29, displayName: 'Supernova',      mine: '💥', flag: '🚀', smiley: '🛰️', smileyWin: '⭐', smileyLoss: '🌑' },
  legendary:        { levelRequired: 30, displayName: 'Legendary',      mine: '🐉', flag: '🏰', smiley: '⚔️', smileyWin: '🐉', smileyLoss: '💀' },
};

function getUnlockedThemes() {
  const stats = loadStats();
  const maxLevel = stats.maxLevelReached || 1;
  const unlocked = {};
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    unlocked[theme] = maxLevel >= info.levelRequired;
  }
  return unlocked;
}

function updateThemeSwatches() {
  const unlocked = getUnlockedThemes();
  let lockedCount = 0;
  for (const swatch of $$('.theme-swatch')) {
    const theme = swatch.dataset.theme;
    const isUnlocked = unlocked[theme] !== false;
    const lockEl = swatch.querySelector('.swatch-lock');
    const nameEl = swatch.querySelector('.swatch-name');

    if (isUnlocked) {
      swatch.classList.remove('locked', 'locked-collapsed');
      if (lockEl) lockEl.classList.add('hidden');
      if (nameEl) nameEl.classList.remove('hidden');
    } else {
      swatch.classList.add('locked');
      // Collapse locked themes by default
      const toggleBtn = $('#toggle-locked-themes');
      if (toggleBtn && !toggleBtn.classList.contains('expanded')) {
        swatch.classList.add('locked-collapsed');
      }
      if (lockEl) lockEl.classList.remove('hidden');
      if (nameEl) nameEl.classList.add('hidden');
      lockedCount++;
    }
  }
  // Update toggle button
  const toggleBtn = $('#toggle-locked-themes');
  const countSpan = $('#locked-theme-count');
  if (toggleBtn) {
    if (lockedCount > 0) {
      toggleBtn.classList.remove('hidden');
      if (countSpan) countSpan.textContent = lockedCount;
    } else {
      toggleBtn.classList.add('hidden');
    }
  }
}

function checkThemeUnlocks(prevMaxLevel, currentMaxLevel) {
  const newlyUnlocked = [];
  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    if (info.levelRequired > 0 && prevMaxLevel < info.levelRequired && currentMaxLevel >= info.levelRequired) {
      newlyUnlocked.push({ theme, displayName: info.displayName });
    }
  }
  return newlyUnlocked;
}

function showThemeUnlockToasts(unlocked) {
  const toast = $('#theme-unlock-toast');
  if (!toast) return;
  let index = 0;

  function showNext() {
    if (index >= unlocked.length) return;
    const item = unlocked[index];
    toast.querySelector('.theme-unlock-toast-name').textContent = item.displayName;
    toast.classList.remove('hidden', 'hiding');

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('hiding');
        index++;
        if (index < unlocked.length) {
          setTimeout(showNext, 200);
        }
      }, 300);
    }, 3000);
  }

  // Delay to not overlap with achievement toasts
  setTimeout(showNext, 1200);
}

// ── State ──────────────────────────────────────────────

const state = {
  board: [],
  rows: 10,
  cols: 10,
  totalMines: 10,
  status: 'idle',       // idle | playing | won | lost
  firstClick: true,
  flagCount: 0,
  revealedCount: 0,
  elapsedTime: 0,
  timerId: null,
  timeLimit: 0,         // countdown seconds for timed mode (0 = no limit)

  currentLevel: 1,
  gameMode: 'daily',    // normal | timed | fogOfWar | daily
  dailySeed: null,
  dailyBombHits: 0,

  powerUps: { revealSafe: 0, shield: 0, scanRowCol: 0, freeze: 0, xray: 0, decode: 0 },
  shieldActive: false,
  scanMode: false,
  xrayMode: false,
  freezeActive: false,
  usedPowerUps: false,  // track for purist achievement

  fogOfWarEnabled: false,
  visibleCells: new Set(),
  fogRadius: 1.5,
  cellTimestamps: {},      // track last-activity per cell for creeping fog
  refogTimerId: null,      // interval for creeping fog check

  shaking: false,
  showParticles: false,
  theme: 'classic',
  hitMine: null,  // {row, col} of the mine that killed you
  zoomLevel: 100,  // percentage (50–200)
  lives: 0,  // extra lives for retry-on-death
};

// ── DOM References ─────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const boardEl = $('#board');
const mineCounterEl = $('#mine-counter');
const timerEl = $('#timer-display');
const resetBtn = $('#reset-btn');
const levelDisplay = $('#level-display');
const livesDisplay = $('#lives-display');
const shakeWrapper = $('#screen-shake-wrapper');
const particleCanvas = $('#particle-canvas');
const scanToast = $('#scan-toast');
const muteBtn = $('#btn-mute');
const bestTimeDisplay = $('#best-time-display');
const maxLevelDisplay = $('#max-level-display');
const streakBorder = $('#streak-border');
const zoomControls = $('#zoom-controls');
const zoomLevelDisplay = $('#zoom-level');
const boardScrollWrapper = $('#board-scroll-wrapper');

// ── Board Rendering ────────────────────────────────────

function resizeCells() {
  const container = document.getElementById('board-container');
  if (!container || !state.cols) return;
  const gap = 2; // --grid-gap
  const borderPad = 8; // 2px border + 2px padding on each side
  const availableWidth = container.clientWidth - borderPad;
  const cellSize = Math.floor((availableWidth - (state.cols - 1) * gap) / state.cols);
  const capped = Math.min(50, Math.max(24, cellSize));
  document.documentElement.style.setProperty('--cell-size', `${capped}px`);
}

function renderBoard() {
  boardEl.innerHTML = '';
  resizeCells();
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;

  const shouldAnimate = state._initialized;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell unrevealed';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;
      if (shouldAnimate) {
        const delay = (r + c) * 12; // diagonal wave
        cellEl.classList.add('cascade-in');
        cellEl.style.animationDelay = `${delay}ms`;
        setTimeout(() => cellEl.classList.remove('cascade-in'), 300 + delay);
      }
      boardEl.appendChild(cellEl);
    }
  }
}

function getThemeEmoji(type) {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'classic';
  const themeInfo = THEME_UNLOCKS[currentTheme];
  if (type === 'mine') return themeInfo?.mine || '💣';
  if (type === 'flag') return themeInfo?.flag || '🚩';
  if (type === 'smiley') return themeInfo?.smiley || '😊';
  if (type === 'smileyWin') return themeInfo?.smileyWin || '😎';
  if (type === 'smileyLoss') return themeInfo?.smileyLoss || '😵';
  return '💣';
}

function updateCell(r, c) {
  const cell = state.board[r]?.[c];
  if (!cell) return;
  const cellEl = boardEl.children[r * state.cols + c];
  if (!cellEl) return;

  // Fog of war check
  if (state.fogOfWarEnabled && !state.visibleCells.has(`${r},${c}`)) {
    cellEl.className = 'cell fogged';
    cellEl.textContent = '';
    return;
  }

  if (cell.isRevealed) {
    if (cell.isDefused) {
      cellEl.className = 'cell revealed defused';
      cellEl.textContent = getThemeEmoji('mine');
    } else if (cell.isMine) {
      const isHit = state.hitMine && state.hitMine.row === r && state.hitMine.col === c;
      cellEl.className = `cell revealed mine${isHit ? ' mine-hit' : ''}`;
      cellEl.textContent = getThemeEmoji('mine');
    } else if (cell.adjacentMines > 0) {
      if (cell.isHiddenNumber) {
        cellEl.className = 'cell revealed hidden-number';
        cellEl.textContent = '?';
      } else {
        cellEl.className = `cell revealed num-${cell.adjacentMines}`;
        cellEl.textContent = cell.adjacentMines;
        // Pop-in animation for numbered cells during cascade reveals
        if (cell.revealAnimDelay > 0) {
          cellEl.classList.add('num-pop', 'number-glow');
          cellEl.style.animationDelay = `${cell.revealAnimDelay}ms`;
        }
      }
    } else {
      cellEl.className = 'cell revealed empty';
      cellEl.textContent = '';
    }
    if (cell.revealAnimDelay > 0) {
      cellEl.style.animationDelay = `${cell.revealAnimDelay}ms`;
      cellEl.classList.add('revealing');
    }
  } else if (cell.isFlagged) {
    cellEl.className = 'cell unrevealed flagged';
    cellEl.textContent = getThemeEmoji('flag');
  } else {
    cellEl.className = 'cell unrevealed';
    cellEl.textContent = '';
  }
}

function updateAllCells() {
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      updateCell(r, c);
    }
  }
}

function updateLivesDisplay() {
  if (!livesDisplay) return;
  if (state.gameMode === 'normal' || state.gameMode === 'fogOfWar') {
    if (state.lives > 0) {
      const hearts = state.lives <= 5 ? '❤️'.repeat(state.lives) : `❤️ ×${state.lives}`;
      livesDisplay.textContent = hearts;
    } else {
      livesDisplay.textContent = '💔 0';
    }
    livesDisplay.classList.remove('hidden');
  } else {
    livesDisplay.classList.add('hidden');
  }
}

function updateHeader() {
  const remaining = state.totalMines - state.flagCount;
  if (remaining < 0) {
    mineCounterEl.textContent = '-' + String(Math.abs(remaining)).padStart(2, '0');
  } else {
    mineCounterEl.textContent = String(remaining).padStart(3, '0');
  }
  updateTimerDisplay();

  // Level display — show timed labels like "Beginner" if available
  if (state.gameMode === 'timed') {
    const tdiff = getTimedDifficulty(state.currentLevel);
    levelDisplay.textContent = tdiff.label || `Level ${state.currentLevel}`;
  } else {
    levelDisplay.textContent = `Level ${state.currentLevel}`;
  }

  // Update mode pill active states
  for (const pill of $$('.mode-pill')) {
    pill.classList.toggle('active', pill.dataset.mode === state.gameMode);
  }
  for (const btn of $$('.mode-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === state.gameMode);
  }

  updateLivesDisplay();

  // Show best time for timed/normal mode (with speed rating for timed)
  const stats = loadStats();
  if (bestTimeDisplay) {
    const bestKey = `level${state.currentLevel}`;
    const best = stats.bestTimes[bestKey];
    if (best != null && (state.gameMode === 'timed' || state.gameMode === 'normal')) {
      if (state.gameMode === 'timed') {
        const rating = getSpeedRating(state.currentLevel, best);
        bestTimeDisplay.textContent = `Best: ${best}s ${rating.icon}`;
      } else {
        bestTimeDisplay.textContent = `Best: ${best}s`;
      }
      bestTimeDisplay.classList.remove('hidden');
    } else {
      bestTimeDisplay.classList.add('hidden');
    }
  }

  // Show max level reached in normal mode
  if (maxLevelDisplay) {
    const maxLevel = stats.maxLevelReached || 1;
    if (state.gameMode === 'normal' && maxLevel > 1) {
      maxLevelDisplay.textContent = `Peak: ${maxLevel}`;
      maxLevelDisplay.classList.remove('hidden');
    } else {
      maxLevelDisplay.classList.add('hidden');
    }
  }

  if (state.status === 'won') resetBtn.textContent = getThemeEmoji('smileyWin');
  else if (state.status === 'lost') resetBtn.textContent = getThemeEmoji('smileyLoss');
  else resetBtn.textContent = getThemeEmoji('smiley');
}

function updatePowerUpBar() {
  const totalPowerUps = Object.values(state.powerUps).reduce((a, b) => a + b, 0);
  const powerUpBar = $('#powerup-bar');
  const isChallenge = state.gameMode === 'normal';
  const isFog = state.gameMode === 'fogOfWar';

  // Hide entire bar when no power-ups available
  if (totalPowerUps === 0 && !state.shieldActive && !state.scanMode && !state.xrayMode) {
    powerUpBar.classList.add('hidden');
  } else {
    powerUpBar.classList.remove('hidden');
  }

  for (const btn of $$('.powerup-btn')) {
    const type = btn.dataset.powerup;
    const count = state.powerUps[type] || 0;

    // Show/hide mode-specific buttons
    if (btn.classList.contains('challenge-only')) {
      btn.style.display = isChallenge ? '' : 'none';
    } else if (btn.classList.contains('fog-only')) {
      btn.style.display = isFog ? '' : 'none';
    }

    btn.querySelector('.powerup-count').textContent = count;
    btn.disabled = count === 0 || state.status === 'won' || state.status === 'lost';
    btn.classList.toggle('active-powerup', type === 'shield' && state.shieldActive);
    btn.classList.toggle('scan-active', type === 'scanRowCol' && state.scanMode);
    btn.classList.toggle('xray-active', type === 'xray' && state.xrayMode);
  }
  // Board state classes
  boardEl.classList.toggle('scan-mode', state.scanMode);
  boardEl.classList.toggle('xray-mode', state.xrayMode);
  boardEl.classList.toggle('shield-active', state.shieldActive);
}

// ── Streak Fire Effect ─────────────────────────────────

function updateStreakBorder() {
  if (!streakBorder) return;
  const stats = loadStats();
  const streak = stats.currentStreak || 0;
  const prevStreak = streakBorder.dataset.prevStreak ? parseInt(streakBorder.dataset.prevStreak) : 0;

  streakBorder.classList.remove('active', 'streak-1', 'streak-2', 'streak-3');

  if (streak >= 5) {
    streakBorder.classList.add('active', 'streak-3');
  } else if (streak >= 3) {
    streakBorder.classList.add('active', 'streak-2');
  } else if (streak >= 2) {
    streakBorder.classList.add('active', 'streak-1');
  }

  // Streak shake animation when streak increases
  if (streak > prevStreak && streak >= 2) {
    streakBorder.classList.remove('streak-shake');
    void streakBorder.offsetWidth;
    streakBorder.classList.add('streak-shake');
    setTimeout(() => streakBorder.classList.remove('streak-shake'), 500);
  }
  streakBorder.dataset.prevStreak = streak;
}

// ── Timer ──────────────────────────────────────────────

function getDisplayTime() {
  // Timed mode always counts up now (no countdown)
  return Math.min(state.elapsedTime, 999);
}

function updateTimerDisplay() {
  const display = getDisplayTime();
  timerEl.textContent = String(display).padStart(3, '0');
  // No urgency classes — timed mode counts up
  timerEl.classList.remove('timer-critical', 'timer-warning');
}

function startTimer() {
  if (state.timerId) return;
  state.timerId = setInterval(() => {
    state.elapsedTime++;
    updateTimerDisplay();
    // Timer tick pulse
    timerEl.classList.remove('timer-tick');
    void timerEl.offsetWidth;
    timerEl.classList.add('timer-tick');
    setTimeout(() => timerEl.classList.remove('timer-tick'), 300);
  }, 1000);
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  timerEl.classList.remove('timer-critical', 'timer-warning');
  stopCreepingFog();
}

// ── Creeping Fog ──────────────────────────────────────

function startCreepingFog() {
  if (state.refogTimerId) return;
  state.refogTimerId = setInterval(() => {
    if (state.status !== 'playing' || !state.fogOfWarEnabled) return;

    const timeout = getRefogTimeout(state.currentLevel);
    const now = Date.now();
    const toRefog = computeRefogCells(state.board, state.cellTimestamps, now, timeout);

    if (toRefog.length > 0) {
      for (const cell of toRefog) {
        cell.isRevealed = false;
        state.revealedCount = Math.max(0, state.revealedCount - 1);
        delete state.cellTimestamps[`${cell.row},${cell.col}`];
      }
      // Recompute fog visibility
      const allRevealed = getRevealedCells();
      state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
      updateAllCells();
      updateHeader();
    }
  }, 2000); // Check every 2 seconds
}

function stopCreepingFog() {
  if (state.refogTimerId) {
    clearInterval(state.refogTimerId);
    state.refogTimerId = null;
  }
}

function handleTimedLoss() {
  state.status = 'lost';
  stopTimer();
  resetBtn.textContent = getThemeEmoji('smileyLoss');
  resetBtn.classList.add('smiley-loss-shake');
  setTimeout(() => resetBtn.classList.remove('smiley-loss-shake'), 500);
  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel, { gameMode: state.gameMode });
  saveModePowerUps(state.gameMode, state.powerUps);

  // Death penalty: reset to level 1 in normal mode
  const lostLevel = state.currentLevel;
  if (state.gameMode === 'normal' && state.currentLevel > 1) {
    state.currentLevel = 1;
  }

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  gameoverTitle.textContent = 'Time\'s Up!';
  if (lostLevel > 1 && state.gameMode === 'normal') {
    gameoverTime.textContent = `You ran out of time! Reset to Level 1`;
  } else {
    gameoverTime.textContent = `You ran out of time!`;
  }
  $('#gameover-record').classList.add('hidden');
  $('#gameover-nextlevel').classList.add('hidden');
  $('#gameover-submit-daily').classList.add('hidden');
  $('#gameover-powerup-earned').classList.add('hidden');
  $('#gameover-share').classList.add('hidden');
  $('#gameover-achievements').classList.add('hidden');

  setTimeout(() => showModal('gameover-overlay'), 400);
  updatePowerUpBar();
  updateStreakBorder();
}

// ── Game Actions ───────────────────────────────────────

function newGame() {
  stopTimer();
  const diff = state.gameMode === 'timed'
    ? getTimedDifficulty(state.currentLevel)
    : getDifficultyForLevel(state.currentLevel);
  const prevRows = state.rows;
  const prevCols = state.cols;

  state.rows = diff.rows;
  state.cols = diff.cols;
  state.totalMines = diff.mines;
  state.board = createEmptyBoard(state.rows, state.cols);
  state.status = 'idle';
  state.firstClick = true;
  state.flagCount = 0;
  state.revealedCount = 0;
  state.elapsedTime = 0;
  state.timeLimit = 0; // Timed mode now counts up — no countdown
  state.shieldActive = false;
  state.scanMode = false;
  state.xrayMode = false;
  state.freezeActive = false;
  state.usedPowerUps = false;
  state.shaking = false;
  state.showParticles = false;
  state.hitMine = null;
  state.visibleCells = new Set();
  state.fogOfWarEnabled = state.gameMode === 'fogOfWar';
  state.cellTimestamps = {};
  if (state.refogTimerId) { clearInterval(state.refogTimerId); state.refogTimerId = null; }
  state.dailySeed = state.gameMode === 'daily' ? new Date().toISOString().slice(0, 10) : null;
  state.dailyBombHits = 0;

  // Daily mode: vary board dimensions using the daily seed
  if (state.gameMode === 'daily' && state.dailySeed) {
    const dailyRng = createDailyRNG(state.dailySeed);
    // Use first 3 RNG values for board dimensions
    const dimRng1 = dailyRng();
    const dimRng2 = dailyRng();
    const dimRng3 = dailyRng();
    state.rows = 8 + Math.floor(dimRng1 * 5);    // 8–12
    state.cols = 8 + Math.floor(dimRng2 * 5);    // 8–12
    const density = 0.14 + dimRng3 * 0.16;        // 14%–30%
    state.totalMines = Math.max(5, Math.round(state.rows * state.cols * density));

    // Pre-generate the board NOW with a fixed exclude position (center)
    // so EVERY player gets the exact same mine layout regardless of first click
    const fixedRow = Math.floor(state.rows / 2);
    const fixedCol = Math.floor(state.cols / 2);
    const boardRng = createDailyRNG(state.dailySeed);
    state.board = generateBoard(state.rows, state.cols, state.totalMines, fixedRow, fixedCol, boardRng);
    state.firstClick = false;
    state.status = 'idle'; // stays idle until actual first click
  }

  // Load per-mode power-ups
  const modePU = loadModePowerUps(state.gameMode);
  if (state.gameMode === 'timed') {
    // Timed mode: no power-ups
    state.powerUps = { revealSafe: 0, shield: 0, scanRowCol: 0, freeze: 0, xray: 0 };
  } else if (state.gameMode === 'daily') {
    // Daily mode: fixed set, not persisted
    state.powerUps = { revealSafe: 0, shield: 0, scanRowCol: 0, freeze: 0, xray: 0 };
  } else {
    state.powerUps = {
      revealSafe: modePU.revealSafe || 0,
      shield: modePU.shield || 0,
      scanRowCol: modePU.scanRowCol || 0,
      freeze: modePU.freeze || 0,
      xray: modePU.xray || 0,
    };
  }

  // Load per-mode lives
  if (state.gameMode === 'normal' || state.gameMode === 'fogOfWar') {
    state.lives = loadModeLives(state.gameMode);
  } else {
    state.lives = 0;
  }

  hideAllModals();
  adjustCellSize();
  renderBoard();
  updateAllCells();
  updateHeader();
  updateTimerDisplay();
  updatePowerUpBar();
  updateStreakBorder();
  updateLivesDisplay();
  updateZoom();

  // Board transition animation when size changes
  if (state._initialized && (prevRows !== state.rows || prevCols !== state.cols)) {
    boardEl.classList.add('board-transition');
    setTimeout(() => boardEl.classList.remove('board-transition'), 600);
  }

  // Show level info toast on new game (except first load)
  if (state._initialized && (state.gameMode === 'normal' || state.gameMode === 'timed')) {
    const label = diff.label ? `${diff.label}` : null;
    showLevelInfoToast(state.currentLevel, diff, label);
  }
  state._initialized = true;
}

// Dynamically adjust cell size to fit the board on screen
function adjustCellSize() {
  const maxWidth = Math.min(window.innerWidth * 0.88, 520);
  const gapSpace = (state.cols - 1) * 2 + 8; // grid gaps + padding
  const maxCellSize = Math.floor((maxWidth - gapSpace) / state.cols);
  const cellSize = Math.min(40, Math.max(16, maxCellSize));
  document.documentElement.style.setProperty('--cell-size', cellSize + 'px');
}

// ── Zoom (for Timed mode large boards) ────────────────

function needsZoom() {
  return state.gameMode === 'timed' && (state.cols > 13 || state.rows > 13);
}

function updateZoom() {
  if (needsZoom()) {
    zoomControls.classList.remove('hidden');
    boardScrollWrapper.classList.add('zoomed');
    const scale = state.zoomLevel / 100;
    boardEl.style.transform = `scale(${scale})`;
    boardEl.style.transformOrigin = 'top left';
    zoomLevelDisplay.textContent = `${state.zoomLevel}%`;
  } else {
    zoomControls.classList.add('hidden');
    boardScrollWrapper.classList.remove('zoomed');
    boardEl.style.transform = '';
    boardEl.style.transformOrigin = '';
    state.zoomLevel = 100;
  }
}

function zoomIn() {
  state.zoomLevel = Math.min(200, state.zoomLevel + 25);
  updateZoom();
}

function zoomOut() {
  state.zoomLevel = Math.max(50, state.zoomLevel - 25);
  updateZoom();
}

function revealCell(row, col) {
  if (state.status === 'won' || state.status === 'lost') return;

  const cell = state.board[row][col];
  if (cell.isRevealed || cell.isFlagged) return;

  // Scan mode intercept
  if (state.scanMode) {
    performScan(row, col);
    return;
  }

  // X-Ray mode intercept
  if (state.xrayMode) {
    performXRay(row, col);
    return;
  }

  // First click — generate board (or start pre-generated daily board)
  if (state.firstClick) {
    const rng = state.dailySeed ? createDailyRNG(state.dailySeed) : undefined;
    const maxZC = (state.gameMode === 'normal' || state.gameMode === 'fogOfWar')
      ? getMaxZeroCluster(state.currentLevel) : Infinity;
    state.board = generateBoard(state.rows, state.cols, state.totalMines, row, col, rng, { maxZeroCluster: maxZC });
    state.firstClick = false;
    state.status = 'playing';
    startTimer();

    if (state.fogOfWarEnabled) {
      state.visibleCells = computeVisibleCells([{ row, col }], state.fogRadius, state.rows, state.cols);
    }
  } else if (state.status === 'idle' && state.gameMode === 'daily') {
    // Daily mode: board was pre-generated for consistency.
    // If first click lands on a mine, relocate it to keep first-click-safe.
    const clickedCell = state.board[row][col];
    if (clickedCell.isMine) {
      clickedCell.isMine = false;
      // Find the first non-mine cell not adjacent to the click to place the mine
      for (let r = 0; r < state.rows; r++) {
        for (let c = 0; c < state.cols; c++) {
          if (!state.board[r][c].isMine && (Math.abs(r - row) > 1 || Math.abs(c - col) > 1)) {
            state.board[r][c].isMine = true;
            r = state.rows; // break outer
            break;
          }
        }
      }
      calculateAdjacency(state.board);
    }
    state.status = 'playing';
    startTimer();
  }

  const currentCell = state.board[row][col];

  // Shield deactivates after any click (consumed whether mine or safe)
  if (state.shieldActive && !currentCell.isMine) {
    state.shieldActive = false;
    updatePowerUpBar();
  }

  if (currentCell.isMine) {
    if (state.shieldActive) {
      state.shieldActive = false;
      playShieldBreak();
      shieldDefuse(state.board, row, col);
      currentCell.isRevealed = true;
      state.revealedCount++;
      state.totalMines--;

      // Shield-break flash
      const flash = document.createElement('div');
      flash.className = 'shield-break-flash';
      document.getElementById('app').appendChild(flash);
      setTimeout(() => flash.remove(), 600);

      // Defused cell pop animation
      const cellEl = boardEl.children[row * state.cols + col];
      if (cellEl) cellEl.classList.add('shield-defused-cell');

      updateAllCells();
      updateHeader();
      updatePowerUpBar();
      if (checkWin(state.board)) handleWin();
      return;
    }
    // Daily mode: bomb hit re-fogs instead of ending
    if (state.gameMode === 'daily') {
      handleDailyBombHit(row, col);
      return;
    }
    handleLoss(row, col);
    return;
  }

  let newlyRevealed = [];
  if (currentCell.adjacentMines === 0) {
    const revealed = floodFillReveal(state.board, row, col);
    state.revealedCount += revealed.length;
    newlyRevealed = revealed;
    playCascade(revealed.length);
  } else {
    currentCell.isRevealed = true;
    currentCell.revealAnimDelay = 0;
    state.revealedCount++;
    newlyRevealed = [currentCell];
    playReveal();
  }

  if (state.fogOfWarEnabled) {
    // Apply hidden numbers to newly revealed cells
    const hiddenRate = getHiddenNumberRate(state.currentLevel);
    applyHiddenNumbers(newlyRevealed, hiddenRate);

    // Decode adjacent hidden numbers (revealing a cell decodes its neighbors)
    decodeAdjacentHidden(state.board, row, col);

    // Update cell timestamps for creeping fog
    const now = Date.now();
    for (const c of newlyRevealed) {
      state.cellTimestamps[`${c.row},${c.col}`] = now;
    }
    // Also refresh timestamps for neighbors of newly revealed cells
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < state.rows && nc >= 0 && nc < state.cols) {
          const key = `${nr},${nc}`;
          if (state.board[nr][nc].isRevealed) {
            state.cellTimestamps[key] = now;
          }
        }
      }
    }

    // Start creeping fog timer if not already running
    if (!state.refogTimerId) {
      startCreepingFog();
    }

    const allRevealed = getRevealedCells();
    state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
  }

  updateAllCells();
  updateHeader();

  if (checkWin(state.board)) handleWin();
}

function toggleFlag(row, col) {
  if (state.status !== 'playing' && state.status !== 'idle') return;
  const cell = state.board[row][col];
  if (cell.isRevealed) return;

  const wasFlagged = cell.isFlagged;
  cell.isFlagged = !cell.isFlagged;
  state.flagCount += cell.isFlagged ? 1 : -1;
  if (cell.isFlagged) playFlag(); else playUnflag();
  updateCell(row, col);
  // Flag pop / unflag shrink animation
  const cellEl = boardEl.children[row * state.cols + col];
  if (cellEl) {
    if (cell.isFlagged) {
      cellEl.classList.add('flag-pop');
      setTimeout(() => cellEl.classList.remove('flag-pop'), 350);
    } else {
      cellEl.classList.add('unflag-shrink');
      setTimeout(() => cellEl.classList.remove('unflag-shrink'), 200);
    }
  }
  // Mine counter bump
  const mineCountEl = document.getElementById('mine-counter');
  if (mineCountEl) {
    mineCountEl.classList.remove('counter-bump');
    void mineCountEl.offsetWidth; // force reflow
    mineCountEl.classList.add('counter-bump');
    setTimeout(() => mineCountEl.classList.remove('counter-bump'), 250);
  }
  updateHeader();
}

function handleChordReveal(row, col) {
  if (state.status !== 'playing') return;
  const result = chordReveal(state.board, row, col);
  if (!result || !result.revealed) return;

  state.revealedCount += result.revealed.filter(c => !c.isMine).length;

  if (state.fogOfWarEnabled) {
    // Apply hidden numbers to chord-revealed cells
    const hiddenRate = getHiddenNumberRate(state.currentLevel);
    applyHiddenNumbers(result.revealed.filter(c => !c.isMine), hiddenRate);

    // Decode adjacent hidden numbers for the chord origin
    decodeAdjacentHidden(state.board, row, col);

    // Update cell timestamps for creeping fog
    const now = Date.now();
    for (const c of result.revealed) {
      if (!c.isMine) state.cellTimestamps[`${c.row},${c.col}`] = now;
    }
    // Refresh timestamps for neighbors of origin
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < state.rows && nc >= 0 && nc < state.cols) {
          if (state.board[nr][nc].isRevealed) {
            state.cellTimestamps[`${nr},${nc}`] = now;
          }
        }
      }
    }

    // Start creeping fog timer if not already running
    if (!state.refogTimerId) {
      startCreepingFog();
    }

    const allRevealed = getRevealedCells();
    state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
  }

  updateAllCells();
  updateHeader();

  // Chord ripple animation on revealed cells
  if (result.revealed && !result.hitMine) {
    for (const c of result.revealed) {
      if (!c.isMine) {
        const idx = c.row * state.cols + c.col;
        const cellEl = boardEl.children[idx];
        if (cellEl) {
          const dist = Math.abs(c.row - row) + Math.abs(c.col - col);
          cellEl.classList.add('chord-ripple');
          cellEl.style.animationDelay = `${dist * 40}ms`;
          setTimeout(() => {
            cellEl.classList.remove('chord-ripple');
            cellEl.style.animationDelay = '';
          }, 350 + dist * 40);
        }
      }
    }
  }

  if (result.hitMine) {
    const mineCell = result.revealed.find(c => c.isMine);
    if (state.gameMode === 'daily') {
      handleDailyBombHit(mineCell.row, mineCell.col);
    } else {
      handleLoss(mineCell.row, mineCell.col);
    }
  } else if (checkWin(state.board)) {
    handleWin();
  }
}

function handleWin() {
  state.status = 'won';
  stopTimer();
  resetBtn.textContent = getThemeEmoji('smileyWin');
  resetBtn.classList.add('smiley-win-bounce');
  setTimeout(() => resetBtn.classList.remove('smiley-win-bounce'), 800);

  const prevStats = loadStats();
  const prevMaxLevel = prevStats.maxLevelReached || 1;

  const isDaily = state.gameMode === 'daily';
  const stats = saveGameResult(true, state.elapsedTime, state.currentLevel, {
    isDaily,
    usedPowerUps: state.usedPowerUps,
    gameMode: state.gameMode,
  });
  const earnedPowerUp = awardPowerUps(stats);

  // Persist power-ups after win (award changes them)
  saveModePowerUps(state.gameMode, state.powerUps);

  playWin();
  showCelebration();
  haptic([50, 30, 50, 30, 80]);

  // Check for newly unlocked themes
  const newThemes = checkThemeUnlocks(prevMaxLevel, stats.maxLevelReached || 1);
  if (newThemes.length > 0) {
    showThemeUnlockToasts(newThemes);
  }

  // Check for newly unlocked achievement tiers
  const newUnlocks = checkNewUnlocks(prevStats, stats);

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  const gameoverRecord = $('#gameover-record');
  const nextLevelBtn = $('#gameover-nextlevel');
  const submitDailyBtn = $('#gameover-submit-daily');
  const powerupEarned = $('#gameover-powerup-earned');
  const shareBtn = $('#gameover-share');
  const achievementsDiv = $('#gameover-achievements');

  gameoverTitle.textContent = 'You Win!';
  // Win title bounce animation
  gameoverTitle.classList.remove('win-title-bounce');
  void gameoverTitle.offsetWidth;
  gameoverTitle.classList.add('win-title-bounce');
  setTimeout(() => gameoverTitle.classList.remove('win-title-bounce'), 700);

  const strikesInfo = state.gameMode === 'daily' && state.dailyBombHits > 0
    ? ` | 💥 ${state.dailyBombHits} strike${state.dailyBombHits !== 1 ? 's' : ''}`
    : '';

  // Timed mode: show speed rating
  if (state.gameMode === 'timed') {
    const rating = getSpeedRating(state.currentLevel, state.elapsedTime);
    gameoverTime.textContent = `Time: ${state.elapsedTime}s — ${rating.icon} ${rating.name}!`;
  } else {
    gameoverTime.textContent = `Time: ${state.elapsedTime}s${strikesInfo}`;
  }

  // Stats cascade animation on time display
  gameoverTime.classList.remove('stats-cascade');
  void gameoverTime.offsetWidth;
  gameoverTime.classList.add('stats-cascade');
  gameoverTime.style.animationDelay = '0.1s';
  setTimeout(() => gameoverTime.classList.remove('stats-cascade'), 500);

  const bestKey = `level${state.currentLevel}`;
  const isNewRecord = stats.bestTimes[bestKey] === state.elapsedTime;
  if (isNewRecord) {
    if (state.gameMode === 'timed') {
      const rating = getSpeedRating(state.currentLevel, state.elapsedTime);
      gameoverRecord.textContent = `🏆 New Record: ${state.elapsedTime}s ${rating.icon}`;
    } else {
      gameoverRecord.textContent = '🎉 New Record!';
    }
    gameoverRecord.classList.remove('hidden');

    // Extra celebration for timed mode records
    if (state.gameMode === 'timed') {
      playTimeRecord();
      setTimeout(() => showConfettiBurst(0.5, 0.3, 40), 200);
      setTimeout(() => showConfettiBurst(0.3, 0.5, 30), 500);
      setTimeout(() => showConfettiBurst(0.7, 0.5, 30), 800);
    }
  } else {
    gameoverRecord.classList.add('hidden');
  }

  if (earnedPowerUp) {
    powerupEarned.textContent = `Earned: ${earnedPowerUp}`;
    powerupEarned.classList.remove('hidden');
    // Animate power-up buttons with earned bounce
    setTimeout(() => {
      for (const btn of $$('.powerup-btn')) {
        const count = state.powerUps[btn.dataset.powerup] || 0;
        if (count > 0) {
          btn.classList.add('powerup-earned');
          setTimeout(() => btn.classList.remove('powerup-earned'), 600);
        }
      }
    }, 300);
  } else {
    powerupEarned.classList.add('hidden');
  }

  // Show life-earned preview for levels divisible by 3
  const lifeEarnedEl = $('#gameover-life-earned');
  const completedLevel = state.currentLevel;
  if ((state.gameMode === 'normal' || state.gameMode === 'fogOfWar') && completedLevel % 3 === 0) {
    lifeEarnedEl.textContent = '❤️ +1 Life earned! (Next Level to claim)';
    lifeEarnedEl.classList.remove('hidden');
  } else {
    lifeEarnedEl.classList.add('hidden');
  }

  // Show newly unlocked achievement tiers in game over
  if (newUnlocks.length > 0) {
    achievementsDiv.innerHTML = '';
    for (const unlock of newUnlocks) {
      const badge = document.createElement('div');
      badge.className = 'gameover-achievement-badge tier-up-badge';
      badge.innerHTML = `<span>${unlock.categoryIcon}</span><span>${unlock.category} ${unlock.tierIcon} ${unlock.tier.charAt(0).toUpperCase() + unlock.tier.slice(1)}</span>`;
      achievementsDiv.appendChild(badge);
    }
    achievementsDiv.classList.remove('hidden');

    // Show achievement toasts
    showAchievementToasts(newUnlocks);
  } else {
    achievementsDiv.classList.add('hidden');
  }

  const maxLevel = state.gameMode === 'timed' ? MAX_TIMED_LEVEL : MAX_LEVEL;
  if (state.currentLevel < maxLevel && state.gameMode !== 'daily') {
    nextLevelBtn.classList.remove('hidden');
  } else {
    nextLevelBtn.classList.add('hidden');
  }

  if (isDaily) {
    submitDailyBtn.classList.remove('hidden');
  } else {
    submitDailyBtn.classList.add('hidden');
  }

  // Always show share button on win
  shareBtn.classList.remove('hidden');

  showModal('gameover-overlay');
  updatePowerUpBar();
  updateStreakBorder();
}

function handleLoss(mineRow, mineCol) {
  state.status = 'lost';
  stopTimer();
  resetBtn.textContent = getThemeEmoji('smileyLoss');
  resetBtn.classList.add('smiley-loss-shake');
  setTimeout(() => resetBtn.classList.remove('smiley-loss-shake'), 500);

  state.hitMine = { row: mineRow, col: mineCol };

  // Chain explosion: reveal mines in expanding rings from the hit
  chainRevealMines(mineRow, mineCol);

  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel, { gameMode: state.gameMode });

  // Power-ups persist on loss within same mode
  saveModePowerUps(state.gameMode, state.powerUps);

  // Death penalty: lives-aware
  const lostLevel = state.currentLevel;
  const isLevelMode = state.gameMode === 'normal' || state.gameMode === 'fogOfWar';
  const hasLives = isLevelMode && state.lives > 0;

  // Only reset to level 1 if no lives remain
  if (isLevelMode && !hasLives && state.currentLevel > 1) {
    state.currentLevel = 1;
  }

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  const useLifeBtn = $('#gameover-uselife');
  const useLifeCount = $('#uselife-count');

  gameoverTitle.textContent = 'Game Over';
  gameoverTitle.classList.remove('win-title-bounce');
  void gameoverTitle.offsetWidth;
  gameoverTitle.classList.add('win-title-bounce');
  setTimeout(() => gameoverTitle.classList.remove('win-title-bounce'), 700);

  if (hasLives) {
    gameoverTime.textContent = `Time: ${state.elapsedTime}s · ❤️ ${state.lives} ${state.lives === 1 ? 'life' : 'lives'} remaining`;
    useLifeBtn.classList.remove('hidden');
    useLifeCount.textContent = state.lives;
  } else if (lostLevel > 1 && isLevelMode) {
    gameoverTime.textContent = `Time: ${state.elapsedTime}s · Reset to Level 1`;
    useLifeBtn.classList.add('hidden');
  } else {
    gameoverTime.textContent = `Time: ${state.elapsedTime}s`;
    useLifeBtn.classList.add('hidden');
  }

  // Stats cascade on loss
  gameoverTime.classList.remove('stats-cascade');
  void gameoverTime.offsetWidth;
  gameoverTime.classList.add('stats-cascade');
  gameoverTime.style.animationDelay = '0.1s';
  setTimeout(() => gameoverTime.classList.remove('stats-cascade'), 500);
  $('#gameover-record').classList.add('hidden');
  $('#gameover-nextlevel').classList.add('hidden');
  $('#gameover-submit-daily').classList.add('hidden');
  $('#gameover-powerup-earned').classList.add('hidden');
  $('#gameover-life-earned').classList.add('hidden');
  $('#gameover-share').classList.add('hidden');
  $('#gameover-achievements').classList.add('hidden');

  setTimeout(() => showModal('gameover-overlay'), 900);
  updatePowerUpBar();
  updateStreakBorder();
  updateLivesDisplay();
}

// ── Daily Mode: Bomb Hit Re-Fog ─────────────────────────

function handleDailyBombHit(mineRow, mineCol) {
  state.dailyBombHits++;

  // Defuse the hit mine so it won't kill again
  defuseMine(state.board, mineRow, mineCol);
  state.board[mineRow][mineCol].isRevealed = true;
  state.totalMines--;

  // Re-fog ALL non-mine revealed cells
  let refogCount = 0;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = state.board[r][c];
      if (cell.isRevealed && !cell.isMine && !(r === mineRow && c === mineCol)) {
        cell.isRevealed = false;
        cell.isHiddenNumber = false;
        refogCount++;
      }
    }
  }
  state.revealedCount = 1; // only the defused mine cell remains revealed

  // Shake + muffled explosion effect
  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([80, 30, 60]);

  // Show strike toast
  const strikes = state.dailyBombHits;
  scanToast.textContent = `💥 Strike ${strikes} — Board re-fogged!`;
  scanToast.classList.remove('hidden');
  setTimeout(() => scanToast.classList.add('hidden'), 2500);

  updateAllCells();
  updateHeader();
}

// ── Power-Ups ──────────────────────────────────────────

function useRevealSafe() {
  if (state.powerUps.revealSafe <= 0 || state.status === 'won' || state.status === 'lost') return;
  const cell = findSafeCell(state.board);
  if (!cell) return;
  playPowerUp();
  state.powerUps.revealSafe--;
  state.usedPowerUps = true;
  saveModePowerUps(state.gameMode, state.powerUps);
  cell.isRevealed = true;
  cell.revealAnimDelay = 0;
  state.revealedCount++;

  const cellEl = boardEl.children[cell.row * state.cols + cell.col];
  if (cellEl) {
    cellEl.classList.add('golden-reveal');
    // Golden ripple ring
    const rect = cellEl.getBoundingClientRect();
    const boardRect = boardEl.getBoundingClientRect();
    const ripple = document.createElement('div');
    ripple.className = 'golden-ripple';
    ripple.style.left = (rect.left - boardRect.left + rect.width / 2) + 'px';
    ripple.style.top = (rect.top - boardRect.top + rect.height / 2) + 'px';
    boardEl.style.position = 'relative';
    boardEl.appendChild(ripple);
    setTimeout(() => ripple.remove(), 800);
  }

  if (state.fogOfWarEnabled) {
    state.visibleCells = computeVisibleCells(getRevealedCells(), state.fogRadius, state.rows, state.cols);
  }

  updateAllCells();
  updateHeader();
  updatePowerUpBar();
  if (checkWin(state.board)) handleWin();
}

function useShield() {
  if (state.powerUps.shield <= 0 || state.status === 'won' || state.status === 'lost') return;
  playPowerUp();
  state.powerUps.shield--;
  state.usedPowerUps = true;
  state.shieldActive = true;
  saveModePowerUps(state.gameMode, state.powerUps);
  updatePowerUpBar();
}

function activateScan() {
  if (state.powerUps.scanRowCol <= 0 || state.status === 'won' || state.status === 'lost') return;
  playPowerUp();
  state.usedPowerUps = true;
  state.scanMode = !state.scanMode;
  updatePowerUpBar();
}

function performScan(row, col) {
  state.powerUps.scanRowCol--;
  state.scanMode = false;
  saveModePowerUps(state.gameMode, state.powerUps);
  const result = scanRowCol(state.board, row, col);

  // Add sweep line animations across the scanned row and column
  boardEl.style.position = 'relative';
  const clickedEl = boardEl.children[row * state.cols + col];
  if (clickedEl) {
    const rect = clickedEl.getBoundingClientRect();
    const boardRect = boardEl.getBoundingClientRect();

    // Horizontal sweep line across the row
    const sweepH = document.createElement('div');
    sweepH.className = 'scan-sweep-h';
    sweepH.style.top = (rect.top - boardRect.top + rect.height / 2) + 'px';
    boardEl.appendChild(sweepH);
    setTimeout(() => sweepH.remove(), 600);

    // Vertical sweep line down the column
    const sweepV = document.createElement('div');
    sweepV.className = 'scan-sweep-v';
    sweepV.style.left = (rect.left - boardRect.left + rect.width / 2) + 'px';
    boardEl.appendChild(sweepV);
    setTimeout(() => sweepV.remove(), 600);
  }

  // Highlight the row with staggered delays outward from clicked cell
  for (let c = 0; c < state.cols; c++) {
    const el = boardEl.children[row * state.cols + c];
    if (el) {
      const distance = Math.abs(c - col);
      el.style.animationDelay = (distance * 40) + 'ms';
      el.classList.add('scan-highlight');
    }
  }
  // Highlight the column with staggered delays outward from clicked cell
  for (let r = 0; r < state.rows; r++) {
    const el = boardEl.children[r * state.cols + col];
    if (el) {
      const distance = Math.abs(r - row);
      el.style.animationDelay = (distance * 40) + 'ms';
      el.classList.add('scan-highlight');
    }
  }

  // Highlight mine cells in red (like x-ray) for better visibility
  const minesInScan = [];
  for (let c = 0; c < state.cols; c++) {
    if (state.board[row][c].isMine && !state.board[row][c].isRevealed) {
      const el = boardEl.children[row * state.cols + c];
      if (el) minesInScan.push({ el, delay: Math.abs(c - col) * 40 });
    }
  }
  for (let r = 0; r < state.rows; r++) {
    if (state.board[r][col].isMine && !state.board[r][col].isRevealed) {
      const el = boardEl.children[r * state.cols + col];
      if (el && !minesInScan.some(m => m.el === el)) {
        minesInScan.push({ el, delay: Math.abs(r - row) * 40 });
      }
    }
  }
  minesInScan.forEach(({ el, delay }) => {
    setTimeout(() => el.classList.add('xray-mine'), 200 + delay);
  });

  scanToast.textContent = `Row ${row + 1}: ${result.rowMines} mine${result.rowMines !== 1 ? 's' : ''} | Col ${col + 1}: ${result.colMines} mine${result.colMines !== 1 ? 's' : ''}`;
  scanToast.classList.remove('hidden');

  setTimeout(() => {
    scanToast.classList.add('hidden');
    for (const el of $$('.scan-highlight')) {
      el.classList.remove('scan-highlight');
      el.style.animationDelay = '';
    }
    for (const el of $$('.xray-mine')) {
      el.classList.remove('xray-mine');
    }
  }, 3000);

  updatePowerUpBar();
}

// ── Freeze Power-Up ──────────────────────────────────
function useFreeze() {
  if (state.powerUps.freeze <= 0 || state.status === 'won' || state.status === 'lost') return;
  if (state.freezeActive) return; // Already frozen
  playFreeze();
  state.powerUps.freeze--;
  state.usedPowerUps = true;
  state.freezeActive = true;
  saveModePowerUps(state.gameMode, state.powerUps);

  // Pause the timer for 15 seconds
  const wasTimerId = state.timerId;
  stopTimer();

  // Show icy overlay
  const overlay = document.createElement('div');
  overlay.className = 'freeze-overlay';
  document.getElementById('board-container').appendChild(overlay);

  scanToast.textContent = '⏸️ Timer frozen for 15s!';
  scanToast.classList.remove('hidden');

  setTimeout(() => {
    overlay.remove();
    scanToast.classList.add('hidden');
    state.freezeActive = false;
    // Resume timer only if still playing
    if (state.status === 'playing') {
      startTimer();
    }
  }, 15000);

  updatePowerUpBar();
}

// ── X-Ray Power-Up ──────────────────────────────────
function activateXRay() {
  if (state.powerUps.xray <= 0 || state.status === 'won' || state.status === 'lost') return;
  playPowerUp();
  state.usedPowerUps = true;
  state.xrayMode = !state.xrayMode;
  updatePowerUpBar();
}

function performXRay(row, col) {
  state.powerUps.xray--;
  state.xrayMode = false;
  playXRay();
  saveModePowerUps(state.gameMode, state.powerUps);

  const mines = xRayScan(state.board, row, col);

  // Highlight the 5×5 area
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < state.rows && nc >= 0 && nc < state.cols) {
        const el = boardEl.children[nr * state.cols + nc];
        if (el) el.classList.add('xray-area');
      }
    }
  }

  // Add scan-line sweep across the X-Ray area
  const centerEl = boardEl.children[row * state.cols + col];
  if (centerEl) {
    const scanLine = document.createElement('div');
    scanLine.className = 'xray-scan-line';
    boardEl.style.position = 'relative';
    boardEl.appendChild(scanLine);
    setTimeout(() => scanLine.remove(), 700);
  }

  // Highlight mines with pulsing red glow (staggered for drama)
  mines.forEach((mine, i) => {
    setTimeout(() => {
      const el = boardEl.children[mine.row * state.cols + mine.col];
      if (el) el.classList.add('xray-mine');
    }, 200 + i * 80);
  });

  // Use top-positioned toast so it doesn't block the 5×5 highlight area
  scanToast.textContent = `🔬 X-Ray: ${mines.length} mine${mines.length !== 1 ? 's' : ''} in area`;
  scanToast.classList.add('xray-toast-top');
  scanToast.classList.remove('hidden');

  setTimeout(() => {
    scanToast.classList.add('hidden');
    scanToast.classList.remove('xray-toast-top');
    for (const el of $$('.xray-area')) el.classList.remove('xray-area');
    for (const el of $$('.xray-mine')) el.classList.remove('xray-mine');
  }, 3000);

  updatePowerUpBar();
}

// ── Decode Power-Up (Fog of War) ─────────────────────
function useDecode() {
  if (!state.powerUps.decode || state.powerUps.decode <= 0 || state.status === 'won' || state.status === 'lost') return;
  playDecode();
  state.powerUps.decode--;
  state.usedPowerUps = true;
  saveModePowerUps(state.gameMode, state.powerUps);

  const decoded = decodeAllHidden(state.board);
  if (decoded.length > 0) {
    // Wave animation on decoded cells
    decoded.forEach((cell, i) => {
      const el = boardEl.children[cell.row * state.cols + cell.col];
      if (el) {
        el.style.animationDelay = `${i * 30}ms`;
        el.classList.add('decode-wave');
        setTimeout(() => el.classList.remove('decode-wave'), 500 + i * 30);
      }
    });
  }

  scanToast.textContent = `🔓 Decoded ${decoded.length} cell${decoded.length !== 1 ? 's' : ''}!`;
  scanToast.classList.remove('hidden');
  setTimeout(() => scanToast.classList.add('hidden'), 2000);

  updateAllCells();
  updatePowerUpBar();
}

function awardPowerUps(stats) {
  // Timed and Daily modes don't award power-ups
  if (state.gameMode === 'timed' || state.gameMode === 'daily') return '';

  // Determine available power-up types based on mode
  const isChallenge = state.gameMode === 'normal';
  const isFogOfWar = state.gameMode === 'fogOfWar';

  const baseTypes = ['revealSafe', 'shield', 'scanRowCol'];
  const challengeTypes = [...baseTypes, 'freeze', 'xray'];
  const fogTypes = [...baseTypes];

  const types = isChallenge ? challengeTypes : isFogOfWar ? fogTypes : baseTypes;
  const labels = {
    revealSafe: '🔍 Reveal Safe', shield: '🛡️ Shield', scanRowCol: '🎯 Scan',
    freeze: '⏸️ Freeze', xray: '🔬 X-Ray',
    decode: '🔓 Decode',
  };

  const awarded = [];

  // Scale rewards by level (Challenge mode)
  const level = state.currentLevel;
  let numAwards;
  if (isChallenge) {
    if (level <= 3) numAwards = 3;
    else if (level <= 6) numAwards = 2;
    else numAwards = 1;
  } else if (isFogOfWar) {
    // Fog mode: +1 of each base type + 1 decode per win
    for (const t of baseTypes) {
      state.powerUps[t] = (state.powerUps[t] || 0) + 1;
    }
    state.powerUps.decode = (state.powerUps.decode || 0) + 1;
    awarded.push('+1 each 🔍🛡️🎯🔓');
    numAwards = 0; // skip random awards below
  } else {
    numAwards = 1;
  }

  for (let i = 0; i < numAwards; i++) {
    const pick = types[Math.floor(Math.random() * types.length)];
    state.powerUps[pick]++;
    awarded.push(labels[pick]);
  }

  // Streak bonus every 3 wins
  if (stats.currentStreak > 0 && stats.currentStreak % 3 === 0) {
    const bonus = types[Math.floor(Math.random() * types.length)];
    state.powerUps[bonus]++;
    awarded.push(`bonus ${labels[bonus]}`);
  }

  return awarded.join(' + ') + (awarded.length > 1 ? '!' : '');
}

// ── Effects ────────────────────────────────────────────

function triggerShake() {
  shakeWrapper.classList.add('shaking');
  setTimeout(() => shakeWrapper.classList.remove('shaking'), 450);
}

function triggerHeavyShake() {
  shakeWrapper.classList.add('heavy-shaking');
  setTimeout(() => shakeWrapper.classList.remove('heavy-shaking'), 700);
}

function haptic(pattern) {
  if (navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

function showRedFlash() {
  const flash = document.createElement('div');
  flash.className = 'red-flash';
  document.getElementById('app').appendChild(flash);
  setTimeout(() => flash.remove(), 600);
}

function showGreenFlash() {
  const flash = document.createElement('div');
  flash.className = 'green-flash';
  document.getElementById('app').appendChild(flash);
  setTimeout(() => flash.remove(), 500);
}

// Chain-reveal mines outward from hit point for dramatic effect
function chainRevealMines(hitRow, hitCol) {
  revealAllMines(state.board);

  // Find all mine cells and sort by distance from hit
  const mineCells = [];
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (state.board[r][c].isMine) {
        const dist = Math.abs(r - hitRow) + Math.abs(c - hitCol);
        mineCells.push({ r, c, dist });
      }
    }
  }
  mineCells.sort((a, b) => a.dist - b.dist);

  // Reveal immediately — add staggered explosion animation
  updateAllCells();
  for (let i = 0; i < mineCells.length; i++) {
    const { r, c } = mineCells[i];
    const cellEl = boardEl.children[r * state.cols + c];
    if (cellEl) {
      cellEl.style.animationDelay = `${i * 50}ms`;
      cellEl.classList.add('mine-chain');
    }
  }
}

// ── Celebration Effects ─────────────────────────────────

function showCelebration() {
  showGreenFlash();

  // Single lightweight confetti burst — 60 particles, simple shapes
  showConfettiBurst(0.5, 0.4, 60);
}

function showConfettiBurst(originX, originY, count) {
  const canvas = particleCanvas;
  const ctx = canvas.getContext('2d');
  const rect = boardEl.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  canvas.classList.add('active');

  // Themed particle colors
  const themeColors = {
    classic: ['#ff4444', '#4488ff', '#44cc44', '#ffdd44', '#ff44ff', '#ffd700'],
    dark: ['#e94560', '#53a8ff', '#00d4aa', '#ffd93d', '#c084fc', '#ff6b6b'],
    neon: ['#00ff88', '#ff0066', '#00ccff', '#ffff00', '#ff6600', '#cc44ff'],
    ocean: ['#64d2ff', '#5eead4', '#fbbf24', '#34d399', '#a78bfa', '#00e5ff'],
    sunset: ['#ff6b6b', '#ffa07a', '#ffc107', '#ff8a65', '#bb86fc', '#87d68d'],
    candy: ['#ff69b4', '#e040fb', '#7c4dff', '#ffd740', '#69f0ae', '#ff4081'],
    midnight: ['#cc88ff', '#7c4dff', '#80b0ff', '#ffd740', '#69f0ae', '#b388ff'],
    aurora: ['#00e5a0', '#00bcd4', '#b388ff', '#69f0ae', '#00e5ff', '#a7ffeb'],
    galaxy: ['#ea80fc', '#d050ff', '#82b1ff', '#ff80ab', '#b9f6ca', '#ce93d8'],
    forest: ['#4a8a3a', '#7ec87e', '#d4a843', '#c4a265', '#8bc34a', '#ffd700'],
    stealth: ['#707070', '#505050', '#909090', '#b0a060', '#888888', '#c0c0c0'],
    'cherry-blossom': ['#ff91a4', '#ffb6c1', '#f8c8dc', '#f48fb1', '#ce93d8', '#a8e6cf'],
    volcano: ['#ff6622', '#ff4420', '#ff9944', '#ffcc44', '#ff8830', '#ffd700'],
    ice: ['#b3e5fc', '#e1f5fe', '#80deea', '#b2ebf2', '#e0f7fa', '#ffffff'],
    cyberpunk: ['#ff0080', '#00ffff', '#ffcc00', '#aa44ff', '#ff4444', '#00ff88'],
    retro: ['#e6a23c', '#33cc66', '#ff4444', '#4488ff', '#ffd700', '#cc8844'],
    holographic: ['#ff9ff3', '#48dbfb', '#c8d6e5', '#a29bfe', '#55efc4', '#fd79a8'],
    toxic: ['#76ff03', '#ffea00', '#ff6d00', '#aa00ff', '#00e676', '#eeff41'],
    royal: ['#ffd700', '#4a0080', '#cc1133', '#fffff0', '#e6b800', '#800080'],
    prismatic: ['#ff0000', '#ff8800', '#ffff00', '#00cc00', '#0066ff', '#8800ff'],
    void: ['#4a0066', '#1a0033', '#808080', '#cccccc', '#660099', '#330066'],
    arctic: ['#e0f0ff', '#80d0ff', '#a8e0ff', '#c0c0c0', '#b8d8f0', '#ffffff'],
    jungle: ['#33aa33', '#cc4422', '#9933cc', '#ffcc00', '#88cc22', '#44bb44'],
    obsidian: ['#c0c0c0', '#808080', '#b8860b', '#a9a9a9', '#d3d3d3', '#ffd700'],
    matrix: ['#00ff00', '#33cc33', '#66ff66', '#00cc00', '#99ff99', '#00ff88'],
    inferno: ['#ff6600', '#cc0000', '#ffcc00', '#ff4400', '#ff8800', '#ffd700'],
    celestial: ['#ffd700', '#1a1a4e', '#e0e0ff', '#4488ff', '#ffec80', '#6666cc'],
    bloodmoon: ['#8b0000', '#cc0000', '#660000', '#990000', '#4a0000', '#ff2222'],
    synthwave: ['#ff0080', '#00ffff', '#8800ff', '#ff6600', '#ff44aa', '#00ccff'],
    supernova: ['#ffffff', '#4488ff', '#ff8800', '#aa44ff', '#ffd700', '#ff4444'],
    legendary: ['#ffd700', '#cc0000', '#8800aa', '#c0c0c0', '#ffec80', '#800080'],
  };
  const colors = themeColors[state.theme] || themeColors.classic;

  const particles = [];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 8;
    particles.push({
      x: canvas.width * originX + (Math.random() - 0.5) * 20,
      y: canvas.height * originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      gravity: 0.12 + Math.random() * 0.05,
      life: 1,
      decay: 0.008 + Math.random() * 0.008,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 3 + Math.random() * 5,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.2,
      isCircle: Math.random() > 0.5,
    });
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.life -= p.decay;
      p.rotation += p.rotationSpeed;

      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);

      if (p.isCircle) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      }

      ctx.restore();
    }

    ctx.globalAlpha = 1;
    if (alive) {
      requestAnimationFrame(animate);
    } else {
      canvas.classList.remove('active');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(animate);
}

// ── Achievements ───────────────────────────────────────

function showAchievementToasts(unlocks) {
  const toast = $('#achievement-toast');
  let index = 0;

  function showNext() {
    if (index >= unlocks.length) return;
    const unlock = unlocks[index];
    toast.querySelector('.achievement-toast-icon').textContent = unlock.categoryIcon;
    toast.querySelector('.achievement-toast-title').textContent = 'Achievement Unlocked!';
    toast.querySelector('.achievement-toast-name').textContent =
      `${unlock.category} — ${unlock.tier.charAt(0).toUpperCase() + unlock.tier.slice(1)} ${unlock.tierIcon}`;
    toast.classList.remove('hidden', 'hiding');

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('hiding');
        index++;
        if (index < unlocks.length) {
          setTimeout(showNext, 200);
        }
      }, 300);
    }, 2500);
  }

  // Delay first toast slightly to let game over show first
  setTimeout(showNext, 600);
}

function updateAchievementsDisplay() {
  const grid = $('#achievements-grid');
  const progressFill = $('#achievement-progress-fill');
  const progressText = $('#achievement-progress-text');

  const stats = loadStats();
  const achievements = getAchievementState(stats);
  const { total, max } = getTotalScore(stats);

  // Update progress bar
  progressFill.style.width = `${(total / max) * 100}%`;
  progressText.textContent = `${total} / ${max}`;

  grid.innerHTML = '';

  for (const ach of achievements) {
    const item = document.createElement('div');
    item.className = 'achievement-category-card';

    // Tier badges row
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

    // Progress bar to next tier
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
  const modeLabel = { normal: 'Challenge', timed: 'Timed', fogOfWar: 'Fog of War', daily: 'Daily' }[mode] || 'Challenge';

  const stats = loadStats();
  const streakText = stats.currentStreak > 1 ? ` | 🔥 ${stats.currentStreak} streak` : '';
  const tier = getHighestTier(stats);
  const tierText = tier ? ` | ${tier.icon} ${tier.name}` : '';

  let dateStr = '';
  if (mode === 'daily') {
    dateStr = ` (${new Date().toISOString().slice(0, 10)})`;
  }

  const levelLabel = diff.label || `Level ${level}`;

  if (mode === 'daily') {
    const strikesText = state.dailyBombHits > 0 ? ` | 💥 ${state.dailyBombHits} strike${state.dailyBombHits !== 1 ? 's' : ''}` : '';
    return `${getThemeEmoji('mine')} GregSweeper — Daily${dateStr}\n` +
           `⏱️ ${time}s (${state.rows}×${state.cols})${strikesText}${tierText}\n` +
           `Can you beat my time?\n\n` +
           `https://christopherwells.github.io/GregSweeper/`;
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
    navigator.share({ text }).catch(() => {
      copyToClipboard(text);
    });
  } else {
    copyToClipboard(text);
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showShareCopiedToast();
  }).catch(() => {
    // Fallback
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

// ── Helpers ────────────────────────────────────────────

function getRevealedCells() {
  const cells = [];
  for (const row of state.board) {
    for (const cell of row) {
      if (cell.isRevealed) cells.push(cell);
    }
  }
  return cells;
}

// ── Modals ─────────────────────────────────────────────

function showModal(id) {
  $(`#${id}`).classList.remove('hidden');
}

function hideModal(id) {
  $(`#${id}`).classList.add('hidden');
}

function hideAllModals() {
  for (const modal of $$('.modal')) modal.classList.add('hidden');
}

function updateStatsDisplay() {
  const stats = loadStats();
  $('#stat-played').textContent = stats.totalGames;
  const rate = stats.totalGames > 0 ? Math.round((stats.wins / stats.totalGames) * 100) : 0;
  $('#stat-win-rate').textContent = `${rate}%`;
  $('#stat-streak').textContent = stats.currentStreak;
  $('#stat-best-streak').textContent = stats.bestStreak;

  const bestKey = `level${state.currentLevel}`;
  const best = stats.bestTimes[bestKey];
  $('#stat-best-time').textContent = best != null ? `${best}s` : '--';

  // Recent games chart
  const chart = $('#recent-games-chart');
  chart.innerHTML = '';
  const recent = stats.recentGames.slice(-20);

  if (recent.length === 0) {
    chart.innerHTML = '<span class="chart-empty">Play some games to see your history!</span>';
  } else {
    // Find max time among wins for scaling
    const winTimes = recent.filter(g => g.won).map(g => g.time);
    const maxTime = winTimes.length > 0 ? Math.max(...winTimes, 30) : 30;

    for (const game of recent) {
      const bar = document.createElement('div');
      bar.className = `game-bar ${game.won ? 'win' : 'loss'}`;
      if (game.won) {
        // Taller = faster (invert so fast wins are tall)
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
}

async function updateLeaderboardDisplay() {
  const dateStr = new Date().toISOString().slice(0, 10);
  $('#leaderboard-date').textContent = `Date: ${dateStr}`;
  const statusBadge = $('#leaderboard-status');
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';

  // Try online first, fall back to local
  let entries = null;
  let isOnline = false;

  if (isFirebaseOnline()) {
    entries = await fetchOnlineLeaderboard(dateStr);
    if (entries !== null) {
      isOnline = true;
    }
  }

  // Fall back to local if online failed
  if (entries === null) {
    entries = loadDailyLeaderboard(dateStr);
  }

  // Update status badge
  if (statusBadge) {
    statusBadge.textContent = isOnline ? '🌐 Online' : '📱 Local';
    statusBadge.className = `lb-status ${isOnline ? 'online' : 'offline'}`;
  }

  if (entries.length === 0) {
    $('#leaderboard-table').classList.add('hidden');
    $('#leaderboard-empty').classList.remove('hidden');
    return;
  }

  $('#leaderboard-table').classList.remove('hidden');
  $('#leaderboard-empty').classList.add('hidden');

  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    const bombCol = entry.bombHits != null ? `<td>${entry.bombHits}</td>` : '<td>-</td>';
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.time}s</td>${bombCol}`;
    tbody.appendChild(tr);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Event Handlers ─────────────────────────────────────

let longPressTimer = null;
let longPressTriggered = false;
let lastTouchTime = 0;  // Guard against touch + synthetic mouse double-fire

boardEl.addEventListener('mousedown', (e) => {
  // Skip synthetic mouse events fired after touch
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
// Non-passive touchstart so we can preventDefault to block browser scroll/gesture interference
let touchedCellRow = null;
let touchedCellCol = null;
let touchStartX = 0;
let touchStartY = 0;
let touchedCellEl = null;

boardEl.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  const cellEl = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.cell');
  if (!cellEl) return;

  // Prevent browser from hijacking touch for scrolling/gestures
  e.preventDefault();

  longPressTriggered = false;
  touchedCellRow = parseInt(cellEl.dataset.row);
  touchedCellCol = parseInt(cellEl.dataset.col);
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchedCellEl = cellEl;

  // Visual feedback — show the cell is being pressed
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
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  // Remove hold visual
  if (touchedCellEl) {
    touchedCellEl.classList.remove('touch-holding');
    touchedCellEl = null;
  }
  if (longPressTriggered) {
    longPressTriggered = false;
    touchedCellRow = null;
    touchedCellCol = null;
    e.preventDefault();
    return;
  }
  if (touchedCellRow == null || touchedCellCol == null) return;
  e.preventDefault();  // Block synthetic mousedown
  const row = touchedCellRow;
  const col = touchedCellCol;
  touchedCellRow = null;
  touchedCellCol = null;

  const cell = state.board[row]?.[col];
  if (cell && cell.isRevealed && cell.adjacentMines > 0) {
    handleChordReveal(row, col);
  } else {
    revealCell(row, col);
  }
});

boardEl.addEventListener('touchmove', (e) => {
  // Only cancel long-press if finger moved more than 20px (prevents jitter cancellation)
  const touch = e.touches[0];
  const dx = Math.abs(touch.clientX - touchStartX);
  const dy = Math.abs(touch.clientY - touchStartY);
  if (dx > 20 || dy > 20) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (touchedCellEl) {
      touchedCellEl.classList.remove('touch-holding');
      touchedCellEl = null;
    }
    touchedCellRow = null;
    touchedCellCol = null;
  }
}, { passive: true });

resetBtn.addEventListener('click', () => {
  resetBtn.classList.add('smiley-pressed');
  setTimeout(() => resetBtn.classList.remove('smiley-pressed'), 150);
  state.currentLevel = 1;
  newGame();
});

// Power-up buttons
for (const btn of $$('.powerup-btn')) {
  btn.addEventListener('click', () => {
    const type = btn.dataset.powerup;
    if (type === 'revealSafe') useRevealSafe();
    else if (type === 'shield') useShield();
    else if (type === 'scanRowCol') activateScan();
    else if (type === 'freeze') useFreeze();
    else if (type === 'xray') activateXRay();
    else if (type === 'decode') useDecode();
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
$('#btn-settings').addEventListener('click', () => {
  updateThemeSwatches();
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
$('#btn-help').addEventListener('click', () => showModal('help-modal'));
$('#title-bar').addEventListener('click', () => showModal('about-modal'));

// Close modals
for (const closeBtn of $$('.modal-close')) {
  closeBtn.addEventListener('click', (e) => {
    e.target.closest('.modal').classList.add('hidden');
  });
}
for (const modal of $$('.modal')) {
  modal.addEventListener('click', (e) => {
    // Don't dismiss game-over modal by clicking outside — require button press
    if (e.target === modal && modal.id !== 'gameover-overlay') {
      modal.classList.add('hidden');
    }
  });
}

// Theme selection
for (const swatch of $$('.theme-swatch')) {
  swatch.addEventListener('click', () => {
    // Block if locked
    if (swatch.classList.contains('locked')) {
      swatch.classList.add('swatch-shake');
      setTimeout(() => swatch.classList.remove('swatch-shake'), 400);
      return;
    }
    const theme = swatch.dataset.theme;
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    saveTheme(theme);
    for (const s of $$('.theme-swatch')) s.classList.remove('active');
    swatch.classList.add('active');
    // Refresh themed emojis (smiley, flags, mines)
    if (state.status === 'won') resetBtn.textContent = getThemeEmoji('smileyWin');
    else if (state.status === 'lost') resetBtn.textContent = getThemeEmoji('smileyLoss');
    else resetBtn.textContent = getThemeEmoji('smiley');
    updateAllCells();
  });
}

// Theme collapse toggle
const toggleLockedBtn = $('#toggle-locked-themes');
if (toggleLockedBtn) {
  toggleLockedBtn.addEventListener('click', () => {
    const isExpanded = toggleLockedBtn.classList.toggle('expanded');
    for (const swatch of $$('.theme-swatch.locked')) {
      swatch.classList.toggle('locked-collapsed', !isExpanded);
    }
    toggleLockedBtn.textContent = isExpanded ? '🔓 Hide locked themes' : '';
    if (!isExpanded) {
      const countSpan = document.createElement('span');
      toggleLockedBtn.textContent = '🔒 Show ';
      const s = document.createElement('span');
      s.id = 'locked-theme-count';
      s.textContent = $$('.theme-swatch.locked').length;
      toggleLockedBtn.appendChild(s);
      toggleLockedBtn.appendChild(document.createTextNode(' locked themes'));
    }
  });
}

// Mode selection
const timedDiffPanel = $('#timed-difficulty');

function updateTimedDiffVisibility() {
  if (timedDiffPanel) {
    if (state.gameMode === 'timed') {
      timedDiffPanel.classList.remove('hidden');
    } else {
      timedDiffPanel.classList.add('hidden');
    }
  }
}

// Shared mode-switch logic
function switchMode(mode) {
  state.gameMode = mode;
  if (mode !== 'timed') state.currentLevel = 1;
  for (const m of $$('.mode-btn')) m.classList.toggle('active', m.dataset.mode === mode);
  for (const p of $$('.mode-pill')) p.classList.toggle('active', p.dataset.mode === mode);
  updateTimedDiffVisibility();
  newGame();
}

for (const modeBtn of $$('.mode-btn')) {
  modeBtn.addEventListener('click', () => switchMode(modeBtn.dataset.mode));
}

// Mode pill quick-switcher in info bar
for (const pill of $$('.mode-pill')) {
  pill.addEventListener('click', () => switchMode(pill.dataset.mode));
}

// Timed difficulty selection (Beginner / Intermediate / Expert)
for (const diffBtn of $$('.timed-diff-btn')) {
  diffBtn.addEventListener('click', () => {
    const level = parseInt(diffBtn.dataset.level, 10);
    state.currentLevel = level;
    for (const d of $$('.timed-diff-btn')) d.classList.remove('active');
    diffBtn.classList.add('active');
    newGame();
  });
}

function syncTimedDiffButtons() {
  for (const d of $$('.timed-diff-btn')) {
    d.classList.toggle('active', parseInt(d.dataset.level, 10) === state.currentLevel);
  }
}

// Reset Profile
$('#btn-reset-profile').addEventListener('click', () => {
  if (confirm('Are you sure you want to reset your profile? This will erase ALL stats, achievements, and leaderboard data. This cannot be undone.')) {
    resetStats();
    // Reset theme to classic (since unlocks depend on stats)
    state.theme = 'classic';
    document.documentElement.setAttribute('data-theme', 'classic');
    saveTheme('classic');
    for (const s of $$('.theme-swatch')) s.classList.remove('active');
    const classicSwatch = $('.theme-swatch[data-theme="classic"]');
    if (classicSwatch) classicSwatch.classList.add('active');
    updateThemeSwatches();
    // Reset game state
    state.currentLevel = 1;
    state.powerUps = { revealSafe: 0, shield: 0, scanRowCol: 0, freeze: 0, xray: 0 };
    updatePowerUpBar();
    newGame();
    // Close settings modal
    $('#settings-modal').classList.add('hidden');
  }
});

// Game over actions
$('#gameover-retry').addEventListener('click', () => {
  // If player had lives but chose not to use one, reset to level 1 but keep lives
  const isLevelMode = state.gameMode === 'normal' || state.gameMode === 'fogOfWar';
  if (isLevelMode && state.status === 'lost' && state.lives > 0) {
    state.currentLevel = 1;
  }
  newGame();
});

$('#gameover-uselife').addEventListener('click', () => {
  if (state.lives <= 0) return;
  state.lives--;
  saveModeLives(state.gameMode, state.lives);
  // Animate lives display
  if (livesDisplay) {
    livesDisplay.classList.remove('life-used');
    void livesDisplay.offsetWidth;
    livesDisplay.classList.add('life-used');
    setTimeout(() => livesDisplay.classList.remove('life-used'), 500);
  }
  // currentLevel stays the same — retry at same level
  newGame();
});

$('#gameover-nextlevel').addEventListener('click', () => {
  const maxLevel = state.gameMode === 'timed' ? MAX_TIMED_LEVEL : MAX_LEVEL;
  const completedLevel = state.currentLevel;
  if (state.currentLevel < maxLevel) state.currentLevel++;

  // Award a life every 3 completed levels (Challenge & Fog of War)
  if ((state.gameMode === 'normal' || state.gameMode === 'fogOfWar') && completedLevel % 3 === 0) {
    state.lives++;
    saveModeLives(state.gameMode, state.lives);
    showLifeEarnedToast(completedLevel);
  }

  playLevelUp();
  showLevelUpToast(state.currentLevel);
  showCelebration();
  syncTimedDiffButtons();
  newGame();
});
$('#gameover-submit-daily').addEventListener('click', async () => {
  const name = prompt('Enter your name (max 20 chars):');
  if (name && name.trim()) {
    const sanitized = name.trim().slice(0, 20);
    const dateStr = new Date().toISOString().slice(0, 10);
    // Save locally
    addDailyLeaderboardEntry(dateStr, sanitized, state.elapsedTime);
    // Also save to Firebase
    await submitOnlineScore(dateStr, sanitized, state.elapsedTime, state.dailyBombHits || 0);
    $('#gameover-submit-daily').classList.add('hidden');
  }
});
$('#gameover-share').addEventListener('click', () => handleShare());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Don't capture when a modal is open (except game over)
  const anyModalOpen = [...$$('.modal')].some(m => !m.classList.contains('hidden'));

  if (e.key === 'Escape') {
    // Don't let Escape dismiss game-over modal
    const gameoverOpen = !$('#gameover-overlay').classList.contains('hidden');
    if (!gameoverOpen) hideAllModals();
    return;
  }

  if (e.key === 'r' || e.key === 'R') {
    state.currentLevel = 1;
    newGame();
    return;
  }

  if (anyModalOpen) return;

  if (e.key === '1') useRevealSafe();
  else if (e.key === '2') useShield();
  else if (e.key === '3') activateScan();
  else if (e.key === '4') useFreeze();
  else if (e.key === '5') activateXRay();
  else if (e.key === '6') useDecode();
});

// ── Level Up Toast ─────────────────────────────────────

function showLevelUpToast(level) {
  const toast = document.createElement('div');
  toast.className = 'level-up-toast';
  toast.textContent = `Level ${level}!`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ── Life Earned Toast ──────────────────────────────────

function showLifeEarnedToast(completedLevel) {
  const toast = document.createElement('div');
  toast.className = 'level-up-toast';
  toast.style.borderColor = 'var(--color-loss, #ff4444)';
  toast.style.boxShadow = '0 4px 20px rgba(229, 57, 53, 0.3)';
  toast.innerHTML = `❤️ +1 Life! <span style="font-size:11px; opacity:0.7">(Level ${completedLevel} clear)</span>`;
  document.getElementById('app').appendChild(toast);
  // Pulse lives display
  if (livesDisplay) {
    livesDisplay.classList.remove('life-pulse');
    void livesDisplay.offsetWidth;
    livesDisplay.classList.add('life-pulse');
    setTimeout(() => livesDisplay.classList.remove('life-pulse'), 600);
  }
  setTimeout(() => toast.remove(), 3000);
}

// ── Level Info Toast ───────────────────────────────────

function showLevelInfoToast(level, diff, label) {
  const toast = document.createElement('div');
  toast.className = 'level-info-toast';
  const sizeLabel = `${diff.rows}×${diff.cols}`;
  const mineLabel = `${diff.mines} mines`;
  const timeLabel = ''; // Timed mode counts up now, no time limit to show
  const title = label ? `${label}` : `Level ${level}`;
  toast.innerHTML = `<strong>${title}</strong><br><span class="level-info-details">${sizeLabel} · ${mineLabel}${timeLabel}</span>`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ── Mute Toggle ────────────────────────────────────────

if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    const nowMuted = !isMuted();
    setMuted(nowMuted);
    muteBtn.textContent = nowMuted ? '🔇' : '🔊';
    muteBtn.title = nowMuted ? 'Unmute' : 'Mute';
  });
}

// ── Init ───────────────────────────────────────────────

function init() {
  const theme = loadTheme();
  const unlocked = getUnlockedThemes();

  // If saved theme is locked, fall back to best unlocked theme
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
  document.documentElement.setAttribute('data-theme', activeTheme);
  const activeSwatch = $(`.theme-swatch[data-theme="${activeTheme}"]`);
  if (activeSwatch) {
    for (const s of $$('.theme-swatch')) s.classList.remove('active');
    activeSwatch.classList.add('active');
  }

  // Load mute preference
  const muted = loadMuted();
  if (muteBtn) {
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  }

  // Initialize Firebase for online leaderboard
  initFirebase();

  newGame();
}

// Recalculate cell sizes on window resize
window.addEventListener('resize', () => {
  resizeCells();
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;
});

init();
