import { generateBoard, createEmptyBoard, calculateAdjacency } from './logic/boardGenerator.js?v=1.2';
import { floodFillReveal, checkWin, revealAllMines, chordReveal } from './logic/boardSolver.js?v=1.2';
import { getDifficultyForLevel, getTimedDifficulty, MAX_LEVEL, MAX_TIMED_LEVEL } from './logic/difficulty.js?v=1.2';
import { computeVisibleCells } from './logic/fogOfWar.js?v=1.2';
import { findSafeCell, scanRowCol, defuseMine } from './logic/powerUps.js?v=1.2';
import { createDailyRNG } from './logic/seededRandom.js?v=1.2';
import {
  loadStats, saveGameResult, resetStats,
  loadDailyLeaderboard, addDailyLeaderboardEntry,
  loadTheme, saveTheme,
} from './storage/statsStorage.js?v=1.2';
import {
  playReveal, playFlag, playUnflag, playExplosion,
  playCascade, playWin, playPowerUp, playShieldBreak,
  playLevelUp, isMuted, setMuted, loadMuted,
} from './audio/sounds.js?v=1.2';
import {
  getAchievementState, getTotalScore, checkNewUnlocks,
  getHighestTier, getAllTierNames, getTierIcon, getTierColor,
} from './logic/achievements.js?v=1.2';

// ── Theme Unlock Progression ──────────────────────────
// Themes unlock based on highest level ever beaten (permanent).
// Dying in normal mode resets current level to 1 but keeps unlocks.
const THEME_UNLOCKS = {
  classic:  { levelRequired: 0,  displayName: 'Classic' },
  dark:     { levelRequired: 0,  displayName: 'Dark' },
  ocean:    { levelRequired: 2,  displayName: 'Ocean' },
  sunset:   { levelRequired: 3,  displayName: 'Sunset' },
  candy:    { levelRequired: 4,  displayName: 'Candy' },
  neon:     { levelRequired: 5,  displayName: 'Neon' },
  midnight: { levelRequired: 6,  displayName: 'Midnight' },
  aurora:   { levelRequired: 8,  displayName: 'Aurora' },
  galaxy:   { levelRequired: 10, displayName: 'Galaxy' },
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
  for (const swatch of $$('.theme-swatch')) {
    const theme = swatch.dataset.theme;
    const isUnlocked = unlocked[theme] !== false;
    const lockEl = swatch.querySelector('.swatch-lock');
    const nameEl = swatch.querySelector('.swatch-name');

    if (isUnlocked) {
      swatch.classList.remove('locked');
      if (lockEl) lockEl.classList.add('hidden');
      if (nameEl) nameEl.classList.remove('hidden');
    } else {
      swatch.classList.add('locked');
      if (lockEl) lockEl.classList.remove('hidden');
      if (nameEl) nameEl.classList.add('hidden');
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
  gameMode: 'normal',   // normal | timed | fogOfWar | daily
  dailySeed: null,

  powerUps: { revealSafe: 0, shield: 0, scanRowCol: 0 },
  shieldActive: false,
  scanMode: false,
  usedPowerUps: false,  // track for purist achievement

  fogOfWarEnabled: false,
  visibleCells: new Set(),
  fogRadius: 1.5,

  shaking: false,
  showParticles: false,
  theme: 'classic',
  hitMine: null,  // {row, col} of the mine that killed you
};

// ── DOM References ─────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const boardEl = $('#board');
const mineCounterEl = $('#mine-counter');
const timerEl = $('#timer-display');
const resetBtn = $('#reset-btn');
const levelDisplay = $('#level-display');
const modeDisplay = $('#mode-display');
const shakeWrapper = $('#screen-shake-wrapper');
const particleCanvas = $('#particle-canvas');
const scanToast = $('#scan-toast');
const muteBtn = $('#btn-mute');
const bestTimeDisplay = $('#best-time-display');
const maxLevelDisplay = $('#max-level-display');
const streakBorder = $('#streak-border');

// ── Board Rendering ────────────────────────────────────

function renderBoard() {
  boardEl.innerHTML = '';
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;

  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell unrevealed';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;
      boardEl.appendChild(cellEl);
    }
  }
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
    if (cell.isMine) {
      const isHit = state.hitMine && state.hitMine.row === r && state.hitMine.col === c;
      cellEl.className = `cell revealed mine${isHit ? ' mine-hit' : ''}`;
      cellEl.textContent = '💣';
    } else if (cell.adjacentMines > 0) {
      cellEl.className = `cell revealed num-${cell.adjacentMines}`;
      cellEl.textContent = cell.adjacentMines;
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
    cellEl.textContent = '🚩';
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

  if (state.gameMode === 'daily') {
    const dateStr = new Date().toISOString().slice(0, 10);
    modeDisplay.textContent = `Daily ${dateStr}`;
  } else {
    if (state.gameMode === 'timed' && state.timeLimit > 0) {
      modeDisplay.textContent = `Timed (${state.timeLimit}s)`;
    } else {
      const modeLabels = { normal: 'Normal', fogOfWar: 'Fog of War' };
      modeDisplay.textContent = modeLabels[state.gameMode] || 'Normal';
    }
  }

  // Show best time for timed/normal mode
  const stats = loadStats();
  if (bestTimeDisplay) {
    const bestKey = `level${state.currentLevel}`;
    const best = stats.bestTimes[bestKey];
    if (best != null && (state.gameMode === 'timed' || state.gameMode === 'normal')) {
      bestTimeDisplay.textContent = `Best: ${best}s`;
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

  if (state.status === 'won') resetBtn.textContent = '😎';
  else if (state.status === 'lost') resetBtn.textContent = '😵';
  else resetBtn.textContent = '😊';
}

function updatePowerUpBar() {
  const totalPowerUps = Object.values(state.powerUps).reduce((a, b) => a + b, 0);
  const powerUpBar = $('#powerup-bar');

  // Hide entire bar when no power-ups available
  if (totalPowerUps === 0 && !state.shieldActive && !state.scanMode) {
    powerUpBar.classList.add('hidden');
  } else {
    powerUpBar.classList.remove('hidden');
  }

  for (const btn of $$('.powerup-btn')) {
    const type = btn.dataset.powerup;
    const count = state.powerUps[type] || 0;
    btn.querySelector('.powerup-count').textContent = count;
    btn.disabled = count === 0 || state.status === 'won' || state.status === 'lost';
    btn.classList.toggle('active-powerup', type === 'shield' && state.shieldActive);
    btn.classList.toggle('scan-active', type === 'scanRowCol' && state.scanMode);
  }
  // Board state classes
  boardEl.classList.toggle('scan-mode', state.scanMode);
  boardEl.classList.toggle('shield-active', state.shieldActive);
}

// ── Streak Fire Effect ─────────────────────────────────

function updateStreakBorder() {
  if (!streakBorder) return;
  const stats = loadStats();
  const streak = stats.currentStreak || 0;

  streakBorder.classList.remove('active', 'streak-1', 'streak-2', 'streak-3');

  if (streak >= 5) {
    streakBorder.classList.add('active', 'streak-3');
  } else if (streak >= 3) {
    streakBorder.classList.add('active', 'streak-2');
  } else if (streak >= 2) {
    streakBorder.classList.add('active', 'streak-1');
  }
}

// ── Timer ──────────────────────────────────────────────

function getDisplayTime() {
  if (state.gameMode === 'timed' && state.timeLimit > 0) {
    return Math.max(0, state.timeLimit - state.elapsedTime);
  }
  return Math.min(state.elapsedTime, 999);
}

function updateTimerDisplay() {
  const display = getDisplayTime();
  timerEl.textContent = String(display).padStart(3, '0');

  // Urgency classes for timed mode countdown
  if (state.gameMode === 'timed' && state.timeLimit > 0) {
    const remaining = state.timeLimit - state.elapsedTime;
    timerEl.classList.toggle('timer-critical', remaining <= 10 && remaining > 0);
    timerEl.classList.toggle('timer-warning', remaining <= 30 && remaining > 10);
  } else {
    timerEl.classList.remove('timer-critical', 'timer-warning');
  }
}

function startTimer() {
  if (state.timerId) return;
  state.timerId = setInterval(() => {
    state.elapsedTime++;
    updateTimerDisplay();

    // Timed mode: check for time-out
    if (state.gameMode === 'timed' && state.timeLimit > 0) {
      const remaining = state.timeLimit - state.elapsedTime;
      if (remaining <= 0) {
        handleTimedLoss();
      }
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  timerEl.classList.remove('timer-critical', 'timer-warning');
}

function handleTimedLoss() {
  state.status = 'lost';
  stopTimer();
  resetBtn.textContent = '😵';
  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel);

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
  state.timeLimit = state.gameMode === 'timed' ? (diff.timeLimit || 120) : 0;
  state.shieldActive = false;
  state.scanMode = false;
  state.usedPowerUps = false;
  state.shaking = false;
  state.showParticles = false;
  state.hitMine = null;
  state.visibleCells = new Set();
  state.fogOfWarEnabled = state.gameMode === 'fogOfWar';
  state.dailySeed = state.gameMode === 'daily' ? new Date().toISOString().slice(0, 10) : null;

  hideAllModals();
  adjustCellSize();
  renderBoard();
  updateAllCells();
  updateHeader();
  updateTimerDisplay();
  updatePowerUpBar();
  updateStreakBorder();

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

function revealCell(row, col) {
  if (state.status === 'won' || state.status === 'lost') return;

  const cell = state.board[row][col];
  if (cell.isRevealed || cell.isFlagged) return;

  // Scan mode intercept
  if (state.scanMode) {
    performScan(row, col);
    return;
  }

  // First click — generate board
  if (state.firstClick) {
    const rng = state.dailySeed ? createDailyRNG(state.dailySeed) : undefined;
    state.board = generateBoard(state.rows, state.cols, state.totalMines, row, col, rng);
    state.firstClick = false;
    state.status = 'playing';
    startTimer();

    if (state.fogOfWarEnabled) {
      state.visibleCells = computeVisibleCells([{ row, col }], state.fogRadius, state.rows, state.cols);
    }
  }

  const currentCell = state.board[row][col];

  if (currentCell.isMine) {
    if (state.shieldActive) {
      state.shieldActive = false;
      playShieldBreak();
      defuseMine(state.board, row, col);
      currentCell.isRevealed = true;
      state.revealedCount++;
      state.totalMines--;
      updateAllCells();
      updateHeader();
      updatePowerUpBar();
      if (checkWin(state.board)) handleWin();
      return;
    }
    handleLoss(row, col);
    return;
  }

  if (currentCell.adjacentMines === 0) {
    const revealed = floodFillReveal(state.board, row, col);
    state.revealedCount += revealed.length;
    playCascade(revealed.length);

    if (state.fogOfWarEnabled) {
      const allRevealed = getRevealedCells();
      state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
    }
  } else {
    currentCell.isRevealed = true;
    currentCell.revealAnimDelay = 0;
    state.revealedCount++;
    playReveal();

    if (state.fogOfWarEnabled) {
      const allRevealed = getRevealedCells();
      state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
    }
  }

  updateAllCells();
  updateHeader();

  if (checkWin(state.board)) handleWin();
}

function toggleFlag(row, col) {
  if (state.status !== 'playing' && state.status !== 'idle') return;
  const cell = state.board[row][col];
  if (cell.isRevealed) return;

  cell.isFlagged = !cell.isFlagged;
  state.flagCount += cell.isFlagged ? 1 : -1;
  if (cell.isFlagged) playFlag(); else playUnflag();
  updateCell(row, col);
  updateHeader();
}

function handleChordReveal(row, col) {
  if (state.status !== 'playing') return;
  const result = chordReveal(state.board, row, col);
  if (!result || !result.revealed) return;

  state.revealedCount += result.revealed.filter(c => !c.isMine).length;

  if (state.fogOfWarEnabled) {
    const allRevealed = getRevealedCells();
    state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
  }

  updateAllCells();
  updateHeader();

  if (result.hitMine) {
    handleLoss(result.revealed.find(c => c.isMine).row, result.revealed.find(c => c.isMine).col);
  } else if (checkWin(state.board)) {
    handleWin();
  }
}

function handleWin() {
  state.status = 'won';
  stopTimer();
  resetBtn.textContent = '😎';

  const prevStats = loadStats();
  const prevMaxLevel = prevStats.maxLevelReached || 1;

  const isDaily = state.gameMode === 'daily';
  const stats = saveGameResult(true, state.elapsedTime, state.currentLevel, {
    isDaily,
    usedPowerUps: state.usedPowerUps,
  });
  const earnedPowerUp = awardPowerUps(stats);

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
  gameoverTime.textContent = `Time: ${state.elapsedTime}s`;

  const bestKey = `level${state.currentLevel}`;
  if (stats.bestTimes[bestKey] === state.elapsedTime) {
    gameoverRecord.textContent = '🎉 New Record!';
    gameoverRecord.classList.remove('hidden');
  } else {
    gameoverRecord.classList.add('hidden');
  }

  if (earnedPowerUp) {
    powerupEarned.textContent = `Earned: ${earnedPowerUp}`;
    powerupEarned.classList.remove('hidden');
  } else {
    powerupEarned.classList.add('hidden');
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
  resetBtn.textContent = '😵';

  state.hitMine = { row: mineRow, col: mineCol };

  // Chain explosion: reveal mines in expanding rings from the hit
  chainRevealMines(mineRow, mineCol);

  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel);

  // Death penalty: reset to level 1 in normal mode
  const lostLevel = state.currentLevel;
  if (state.gameMode === 'normal' && state.currentLevel > 1) {
    state.currentLevel = 1;
  }

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  gameoverTitle.textContent = 'Game Over';
  if (lostLevel > 1 && state.gameMode === 'normal') {
    gameoverTime.textContent = `Time: ${state.elapsedTime}s · Reset to Level 1`;
  } else {
    gameoverTime.textContent = `Time: ${state.elapsedTime}s`;
  }
  $('#gameover-record').classList.add('hidden');
  $('#gameover-nextlevel').classList.add('hidden');
  $('#gameover-submit-daily').classList.add('hidden');
  $('#gameover-powerup-earned').classList.add('hidden');
  $('#gameover-share').classList.add('hidden');
  $('#gameover-achievements').classList.add('hidden');

  setTimeout(() => showModal('gameover-overlay'), 900);
  updatePowerUpBar();
  updateStreakBorder();
}

// ── Power-Ups ──────────────────────────────────────────

function useRevealSafe() {
  if (state.powerUps.revealSafe <= 0 || state.status === 'won' || state.status === 'lost') return;
  const cell = findSafeCell(state.board);
  if (!cell) return;
  playPowerUp();
  state.powerUps.revealSafe--;
  state.usedPowerUps = true;
  cell.isRevealed = true;
  cell.revealAnimDelay = 0;
  state.revealedCount++;

  const cellEl = boardEl.children[cell.row * state.cols + cell.col];
  if (cellEl) cellEl.classList.add('golden-reveal');

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
  const result = scanRowCol(state.board, row, col);

  // Highlight the row and column
  for (let c = 0; c < state.cols; c++) {
    const el = boardEl.children[row * state.cols + c];
    if (el) el.classList.add('scan-highlight');
  }
  for (let r = 0; r < state.rows; r++) {
    const el = boardEl.children[r * state.cols + col];
    if (el) el.classList.add('scan-highlight');
  }

  scanToast.textContent = `Row ${row + 1}: ${result.rowMines} mine${result.rowMines !== 1 ? 's' : ''} | Col ${col + 1}: ${result.colMines} mine${result.colMines !== 1 ? 's' : ''}`;
  scanToast.classList.remove('hidden');

  setTimeout(() => {
    scanToast.classList.add('hidden');
    for (const el of $$('.scan-highlight')) el.classList.remove('scan-highlight');
  }, 3000);

  updatePowerUpBar();
}

function awardPowerUps(stats) {
  const types = ['revealSafe', 'shield', 'scanRowCol'];
  const labels = { revealSafe: '🔍 Reveal Safe', shield: '🛡️ Shield', scanRowCol: '🎯 Scan' };
  const pick = types[Math.floor(Math.random() * types.length)];
  state.powerUps[pick]++;

  if (stats.currentStreak > 0 && stats.currentStreak % 3 === 0) {
    const bonus = types[Math.floor(Math.random() * types.length)];
    state.powerUps[bonus]++;
    return `${labels[pick]} + bonus ${labels[bonus]}!`;
  }
  return labels[pick];
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
  const modeLabel = { normal: 'Normal', timed: 'Timed', fogOfWar: 'Fog of War', daily: 'Daily' }[mode] || 'Normal';

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
    return `💣 GregSweeper — Daily Challenge${dateStr}\n` +
           `⏱️ ${time}s (${diff.rows}x${diff.cols})${tierText}\n` +
           `Can you beat my time?\n\n` +
           `https://christopherwells.github.io/GregSweeper/`;
  }

  return `💣 GregSweeper — ${modeLabel}\n` +
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

function updateLeaderboardDisplay() {
  const dateStr = new Date().toISOString().slice(0, 10);
  $('#leaderboard-date').textContent = `Date: ${dateStr}`;
  const entries = loadDailyLeaderboard(dateStr);
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';

  if (entries.length === 0) {
    $('#leaderboard-table').classList.add('hidden');
    $('#leaderboard-empty').classList.remove('hidden');
    return;
  }

  $('#leaderboard-table').classList.remove('hidden');
  $('#leaderboard-empty').classList.add('hidden');

  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.time}s</td>`;
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
  }, 400);
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
  // Only cancel long-press if finger moved more than 15px (prevents jitter cancellation)
  const touch = e.touches[0];
  const dx = Math.abs(touch.clientX - touchStartX);
  const dy = Math.abs(touch.clientY - touchStartY);
  if (dx > 15 || dy > 15) {
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
  });
}

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
    if (e.target === modal) modal.classList.add('hidden');
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
  });
}

// Mode selection
for (const modeBtn of $$('.mode-btn')) {
  modeBtn.addEventListener('click', () => {
    const mode = modeBtn.dataset.mode;
    state.gameMode = mode;
    state.currentLevel = 1;
    for (const m of $$('.mode-btn')) m.classList.remove('active');
    modeBtn.classList.add('active');
    newGame();
  });
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
    state.powerUps = { revealSafe: 0, shield: 0, scanRowCol: 0 };
    updatePowerUpBar();
    newGame();
    // Close settings modal
    $('#settings-modal').classList.add('hidden');
  }
});

// Game over actions
$('#gameover-retry').addEventListener('click', () => newGame());
$('#gameover-nextlevel').addEventListener('click', () => {
  const maxLevel = state.gameMode === 'timed' ? MAX_TIMED_LEVEL : MAX_LEVEL;
  if (state.currentLevel < maxLevel) state.currentLevel++;
  playLevelUp();
  showLevelUpToast(state.currentLevel);
  showCelebration();
  newGame();
});
$('#gameover-submit-daily').addEventListener('click', () => {
  const name = prompt('Enter your name:');
  if (name && name.trim()) {
    const dateStr = new Date().toISOString().slice(0, 10);
    addDailyLeaderboardEntry(dateStr, name.trim(), state.elapsedTime);
    $('#gameover-submit-daily').classList.add('hidden');
  }
});
$('#gameover-share').addEventListener('click', () => handleShare());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Don't capture when a modal is open (except game over)
  const anyModalOpen = [...$$('.modal')].some(m => !m.classList.contains('hidden'));

  if (e.key === 'Escape') {
    hideAllModals();
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
});

// ── Level Up Toast ─────────────────────────────────────

function showLevelUpToast(level) {
  const toast = document.createElement('div');
  toast.className = 'level-up-toast';
  toast.textContent = `Level ${level}!`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ── Level Info Toast ───────────────────────────────────

function showLevelInfoToast(level, diff, label) {
  const toast = document.createElement('div');
  toast.className = 'level-info-toast';
  const sizeLabel = `${diff.rows}×${diff.cols}`;
  const mineLabel = `${diff.mines} mines`;
  const timeLabel = state.gameMode === 'timed' ? ` · ${diff.timeLimit}s` : '';
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

  newGame();
}

init();
