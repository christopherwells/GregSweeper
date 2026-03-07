import { generateBoard, createEmptyBoard, calculateAdjacency } from './logic/boardGenerator.js';
import { floodFillReveal, checkWin, revealAllMines, chordReveal } from './logic/boardSolver.js';
import { getDifficultyForLevel, MAX_LEVEL } from './logic/difficulty.js';
import { computeVisibleCells } from './logic/fogOfWar.js';
import { findSafeCell, scanRowCol, defuseMine } from './logic/powerUps.js';
import { createDailyRNG } from './logic/seededRandom.js';
import {
  loadStats, saveGameResult,
  loadDailyLeaderboard, addDailyLeaderboardEntry,
  loadTheme, saveTheme,
} from './storage/statsStorage.js';

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

  currentLevel: 1,
  gameMode: 'normal',   // normal | timed | fogOfWar | daily
  dailySeed: null,

  powerUps: { revealSafe: 1, shield: 1, scanRowCol: 1 },
  shieldActive: false,
  scanMode: false,

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
  mineCounterEl.textContent = String(Math.max(0, remaining)).padStart(3, '0');
  timerEl.textContent = String(state.elapsedTime).padStart(3, '0');
  levelDisplay.textContent = `Level ${state.currentLevel}`;

  const modeLabels = { normal: 'Normal', timed: 'Timed', fogOfWar: 'Fog of War', daily: 'Daily' };
  modeDisplay.textContent = modeLabels[state.gameMode] || 'Normal';

  if (state.status === 'won') resetBtn.textContent = '😎';
  else if (state.status === 'lost') resetBtn.textContent = '😵';
  else resetBtn.textContent = '😊';
}

function updatePowerUpBar() {
  for (const btn of $$('.powerup-btn')) {
    const type = btn.dataset.powerup;
    const count = state.powerUps[type] || 0;
    btn.querySelector('.powerup-count').textContent = count;
    btn.disabled = count === 0 || state.status !== 'playing';
    btn.classList.toggle('active-powerup', type === 'shield' && state.shieldActive);
    btn.classList.toggle('scan-active', type === 'scanRowCol' && state.scanMode);
  }
  // Board state classes
  boardEl.classList.toggle('scan-mode', state.scanMode);
  boardEl.classList.toggle('shield-active', state.shieldActive);
}

// ── Timer ──────────────────────────────────────────────

function startTimer() {
  if (state.timerId) return;
  state.timerId = setInterval(() => {
    state.elapsedTime++;
    timerEl.textContent = String(Math.min(state.elapsedTime, 999)).padStart(3, '0');
  }, 1000);
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

// ── Game Actions ───────────────────────────────────────

function newGame() {
  stopTimer();
  const diff = getDifficultyForLevel(state.currentLevel);
  state.rows = diff.rows;
  state.cols = diff.cols;
  state.totalMines = diff.mines;
  state.board = createEmptyBoard(state.rows, state.cols);
  state.status = 'idle';
  state.firstClick = true;
  state.flagCount = 0;
  state.revealedCount = 0;
  state.elapsedTime = 0;
  state.shieldActive = false;
  state.scanMode = false;
  state.shaking = false;
  state.showParticles = false;
  state.hitMine = null;
  state.visibleCells = new Set();
  state.fogOfWarEnabled = state.gameMode === 'fogOfWar';
  state.dailySeed = state.gameMode === 'daily' ? new Date().toISOString().slice(0, 10) : null;

  hideAllModals();
  renderBoard();
  updateAllCells();
  updateHeader();
  updatePowerUpBar();
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

    if (state.fogOfWarEnabled) {
      const allRevealed = getRevealedCells();
      state.visibleCells = computeVisibleCells(allRevealed, state.fogRadius, state.rows, state.cols);
    }
  } else {
    currentCell.isRevealed = true;
    currentCell.revealAnimDelay = 0;
    state.revealedCount++;

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

  const stats = saveGameResult(true, state.elapsedTime, state.currentLevel);
  const earnedPowerUp = awardPowerUps(stats);

  showParticles();

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  const gameoverRecord = $('#gameover-record');
  const nextLevelBtn = $('#gameover-nextlevel');
  const submitDailyBtn = $('#gameover-submit-daily');
  const powerupEarned = $('#gameover-powerup-earned');

  gameoverTitle.textContent = 'You Win!';
  gameoverTime.textContent = `Time: ${state.elapsedTime}s`;

  const bestKey = `level${state.currentLevel}`;
  if (stats.bestTimes[bestKey] === state.elapsedTime) {
    gameoverRecord.textContent = 'New Record!';
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

  if (state.currentLevel < MAX_LEVEL) {
    nextLevelBtn.classList.remove('hidden');
  } else {
    nextLevelBtn.classList.add('hidden');
  }

  if (state.gameMode === 'daily') {
    submitDailyBtn.classList.remove('hidden');
  } else {
    submitDailyBtn.classList.add('hidden');
  }

  showModal('gameover-overlay');
  updatePowerUpBar();
}

function handleLoss(mineRow, mineCol) {
  state.status = 'lost';
  stopTimer();
  resetBtn.textContent = '😵';

  state.hitMine = { row: mineRow, col: mineCol };
  revealAllMines(state.board);
  updateAllCells();

  triggerShake();
  saveGameResult(false, state.elapsedTime, state.currentLevel);

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  gameoverTitle.textContent = 'Game Over';
  gameoverTime.textContent = `Time: ${state.elapsedTime}s`;
  $('#gameover-record').classList.add('hidden');
  $('#gameover-nextlevel').classList.add('hidden');
  $('#gameover-submit-daily').classList.add('hidden');
  $('#gameover-powerup-earned').classList.add('hidden');

  setTimeout(() => showModal('gameover-overlay'), 600);
  updatePowerUpBar();
}

// ── Power-Ups ──────────────────────────────────────────

function useRevealSafe() {
  if (state.powerUps.revealSafe <= 0 || state.status !== 'playing') return;
  const cell = findSafeCell(state.board);
  if (!cell) return;
  state.powerUps.revealSafe--;
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
  if (state.powerUps.shield <= 0 || state.status !== 'playing') return;
  state.powerUps.shield--;
  state.shieldActive = true;
  updatePowerUpBar();
}

function activateScan() {
  if (state.powerUps.scanRowCol <= 0 || state.status !== 'playing') return;
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
  setTimeout(() => shakeWrapper.classList.remove('shaking'), 400);
}

function showParticles() {
  const canvas = particleCanvas;
  const ctx = canvas.getContext('2d');
  const rect = boardEl.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  canvas.classList.add('active');

  const themeColors = {
    classic: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#ffd700'],
    dark: ['#e94560', '#53a8ff', '#00d4aa', '#ffd93d', '#c084fc'],
    neon: ['#00ff88', '#ff0066', '#00ccff', '#ffff00', '#ff6600'],
  };
  const colors = themeColors[state.theme] || themeColors.classic;

  const particles = [];
  for (let i = 0; i < 100; i++) {
    particles.push({
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 12,
      vy: (Math.random() - 0.5) * 12 - 4,
      gravity: 0.15,
      life: 1,
      decay: 0.008 + Math.random() * 0.008,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 3 + Math.random() * 4,
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
      p.life -= p.decay;

      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
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
  const recent = stats.recentGames.slice(-10);
  for (const game of recent) {
    const bar = document.createElement('div');
    bar.className = `game-bar ${game.won ? 'win' : 'loss'}`;
    bar.style.height = game.won ? `${Math.min(100, (game.time / 300) * 100)}%` : '100%';
    bar.title = game.won ? `Win: ${game.time}s` : 'Loss';
    chart.appendChild(bar);
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

boardEl.addEventListener('mousedown', (e) => {
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
boardEl.addEventListener('touchstart', (e) => {
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  longPressTriggered = false;
  const row = parseInt(cellEl.dataset.row);
  const col = parseInt(cellEl.dataset.col);

  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    toggleFlag(row, col);
  }, 500);
}, { passive: true });

boardEl.addEventListener('touchend', (e) => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (longPressTriggered) {
    longPressTriggered = false;
    e.preventDefault();
    return;
  }
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  e.preventDefault();
  const row = parseInt(cellEl.dataset.row);
  const col = parseInt(cellEl.dataset.col);

  const cell = state.board[row]?.[col];
  if (cell && cell.isRevealed && cell.adjacentMines > 0) {
    handleChordReveal(row, col);
  } else {
    revealCell(row, col);
  }
});

boardEl.addEventListener('touchmove', () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
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
$('#btn-settings').addEventListener('click', () => showModal('settings-modal'));
$('#btn-stats').addEventListener('click', () => {
  updateStatsDisplay();
  showModal('stats-modal');
});
$('#btn-leaderboard').addEventListener('click', () => {
  updateLeaderboardDisplay();
  showModal('leaderboard-modal');
});
$('#btn-help').addEventListener('click', () => showModal('help-modal'));

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

// Game over actions
$('#gameover-retry').addEventListener('click', () => newGame());
$('#gameover-nextlevel').addEventListener('click', () => {
  if (state.currentLevel < MAX_LEVEL) state.currentLevel++;
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

// ── Init ───────────────────────────────────────────────

function init() {
  const theme = loadTheme();
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const activeSwatch = $(`.theme-swatch[data-theme="${theme}"]`);
  if (activeSwatch) {
    for (const s of $$('.theme-swatch')) s.classList.remove('active');
    activeSwatch.classList.add('active');
  }

  newGame();
}

init();
