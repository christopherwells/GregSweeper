import { state, getRevealedCells } from '../state/gameState.js?v=0.9.1';
import { $, $$, boardEl, resetBtn } from '../ui/domHelpers.js?v=0.9.1';
import {
  renderBoard, updateCell, updateAllCells, updateCells, getThemeEmoji,
  adjustCellSize, updateZoom,
} from '../ui/boardRenderer.js?v=0.9.1';
import {
  updateHeader, updateCheckpointDisplay, updateProgressBar,
  updateCellsRemaining, updateStreakDisplay, updateStreakBorder,
  updateFlagModeBar,
} from '../ui/headerRenderer.js?v=0.9.1';
import { updatePowerUpBar } from '../ui/powerUpBar.js?v=0.9.1';
import { hideAllModals, showModal, hideModal } from '../ui/modalManager.js?v=0.9.1';
import { showLevelInfoToast } from '../ui/toastManager.js?v=0.9.1';
import { startTimer, stopTimer, startMineShift, updateTimerDisplay } from './timerManager.js?v=0.9.1';
import { handleWin, handleLoss, handleDailyBombHit } from './winLossHandler.js?v=0.9.1';
import { performScan, performXRay, performMagnet, tryLifeline } from './powerUpActions.js?v=0.9.1';
import { generateBoard, createEmptyBoard, calculateAdjacency } from '../logic/boardGenerator.js?v=0.9.1';
import { floodFillReveal, checkWin, chordReveal } from '../logic/boardSolver.js?v=0.9.1';
import { getDifficultyForLevel, getTimedDifficulty, getMaxZeroCluster } from '../logic/difficulty.js?v=0.9.1';
import { shieldDefuse } from '../logic/powerUps.js?v=0.9.1';
import { getGimmicksForLevel, applyGimmicks, isLockedCell, hasSeenGimmick, markGimmickSeen, getGimmickDef, isModifierPopupDisabled, setModifierPopupDisabled, getDailyGimmick } from '../logic/gimmicks.js?v=0.9.1';
import { createDailyRNG } from '../logic/seededRandom.js?v=0.9.1';
import {
  loadModePowerUps, loadCheckpoint, clearGameState,
} from '../storage/statsStorage.js?v=0.9.1';
import {
  playReveal, playFlag, playUnflag, playCascade, playShieldBreak,
} from '../audio/sounds.js?v=0.9.1';
import { loadEffects } from '../ui/collectionManager.js?v=0.9.1';

// ── Gimmick Intro Popup ───────────────────────────────

function showGimmickIntros(gimmickDefs) {
  let index = 0;
  const iconEl = document.getElementById('gimmick-intro-icon');
  const nameEl = document.getElementById('gimmick-intro-name');
  const descEl = document.getElementById('gimmick-intro-desc');
  const okBtn = document.getElementById('gimmick-intro-ok');
  const dismissBtn = document.getElementById('gimmick-intro-dismiss');
  if (!iconEl || !nameEl || !descEl || !okBtn) return;

  function showNext() {
    if (index >= gimmickDefs.length) {
      hideModal('gimmick-intro-overlay');
      return;
    }
    const def = gimmickDefs[index];
    iconEl.textContent = def.icon;
    nameEl.textContent = `Modifier: ${def.name}`;
    descEl.textContent = def.desc;
    showModal('gimmick-intro-overlay');
  }

  // Remove old listeners if any, add fresh ones
  const newBtn = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newBtn, okBtn);
  newBtn.addEventListener('click', () => {
    index++;
    if (index < gimmickDefs.length) {
      showNext();
    } else {
      hideModal('gimmick-intro-overlay');
    }
  });

  // "Don't show again" button
  if (dismissBtn) {
    const newDismissBtn = dismissBtn.cloneNode(true);
    dismissBtn.parentNode.replaceChild(newDismissBtn, dismissBtn);
    newDismissBtn.addEventListener('click', () => {
      setModifierPopupDisabled(true);
      hideModal('gimmick-intro-overlay');
    });
  }

  showNext();
}

// ── Game Actions ───────────────────────────────────────

export function newGame() {
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
  state.magnetMode = false;
  state.usedPowerUps = false;
  state.shaking = false;
  state.showParticles = false;
  state.hitMine = null;
  state.suggestedMove = null;
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

    // Apply daily modifiers (~35% of days)
    const dailyGimmicks = getDailyGimmick(state.dailySeed, createDailyRNG);
    if (dailyGimmicks.length > 0) {
      state.activeGimmicks = dailyGimmicks;
      // Use a separate seeded RNG for gimmick application
      const gimmickApplyRng = createDailyRNG(state.dailySeed + '-gimmick-apply');
      state.gimmickData = applyGimmicks(state.board, 1, state.activeGimmicks, gimmickApplyRng);
    }
  }

  // Load per-mode power-ups
  const modePU = loadModePowerUps(state.gameMode);
  const emptyPU = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
  if (state.gameMode === 'timed' || state.gameMode === 'daily') {
    state.powerUps = { ...emptyPU };
  } else {
    state.powerUps = {
      revealSafe: modePU.revealSafe || 0,
      shield: modePU.shield || 0,
      lifeline: modePU.lifeline || 0,
      scanRowCol: modePU.scanRowCol || 0,
      magnet: modePU.magnet || 0,
      xray: modePU.xray || 0,
    };
  }

  // Gimmicks / modifiers (set by challenge mode on first click, or daily mode above)
  if (state.gameMode !== 'daily') {
    state.activeGimmicks = [];
    state.gimmickData = {};
  }

  // Load checkpoint
  if (state.gameMode === 'normal') {
    state.checkpoint = loadCheckpoint(state.gameMode);
  } else {
    state.checkpoint = 1;
  }

  // Reset dirty cells tracking
  state.dirtyCells = new Set();
  state.flagMode = false;

  hideAllModals();
  adjustCellSize();
  renderBoard();
  updateAllCells();
  updateHeader();
  updateTimerDisplay();
  updatePowerUpBar();
  updateStreakBorder();
  updateCheckpointDisplay();
  updateProgressBar();
  updateCellsRemaining();
  updateStreakDisplay();
  updateFlagModeBar();
  updateZoom();

  // Apply board border effect from collection
  const effects = loadEffects();
  boardEl.classList.remove('border-glow', 'border-pulse', 'border-rainbow');
  if (effects.borders && effects.borders !== 'none') {
    boardEl.classList.add(`border-${effects.borders}`);
  }

  // Clear saved game state for current mode (new game = fresh start)
  clearGameState(state.gameMode);

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

export function revealCell(row, col) {
  if (state.status === 'won' || state.status === 'lost') return;

  const cell = state.board[row][col];
  if (cell.isRevealed || cell.isFlagged) return;
  if (cell.isWall) return; // Walls are inert

  // Locked cell check
  if (cell.isLocked && isLockedCell(state.board, row, col)) {
    import('../ui/toastManager.js?v=0.9.1').then(m => {
      m.showToast('🔒 Unlock neighbors first!', 1500);
    });
    return;
  }

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

  // Magnet mode intercept
  if (state.magnetMode) {
    performMagnet(row, col);
    return;
  }

  // First click — generate board (or start pre-generated daily board)
  if (state.firstClick) {
    const rng = state.dailySeed ? createDailyRNG(state.dailySeed) : undefined;
    const maxZC = state.gameMode === 'normal'
      ? getMaxZeroCluster(state.currentLevel) : Infinity;
    state.board = generateBoard(state.rows, state.cols, state.totalMines, row, col, rng, { maxZeroCluster: maxZC });

    // Apply gimmicks for challenge mode
    if (state.gameMode === 'normal') {
      const gimmickRng = rng || Math.random;
      state.activeGimmicks = getGimmicksForLevel(state.currentLevel, gimmickRng);
      if (state.activeGimmicks.length > 0) {
        state.gimmickData = applyGimmicks(state.board, state.currentLevel, state.activeGimmicks, gimmickRng);

        // Show first-encounter popup for new modifiers (unless disabled)
        if (!isModifierPopupDisabled()) {
          const newGimmicks = [];
          for (const g of state.activeGimmicks) {
            if (!hasSeenGimmick(g)) {
              markGimmickSeen(g);
              const def = getGimmickDef(g);
              if (def) newGimmicks.push(def);
            }
          }
          if (newGimmicks.length > 0) {
            showGimmickIntros(newGimmicks);
          }
        }

        // Start mine shift timer if active
        if (state.gimmickData.mineShift) {
          startMineShift(state.gimmickData.mineShift.interval);
        }
      }
    }

    state.firstClick = false;
    state.status = 'playing';
    startTimer();

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

    // Show modifier intro popup for daily gimmicks (always show in Daily, not just unseen)
    if (state.activeGimmicks.length > 0 && !isModifierPopupDisabled()) {
      const defs = state.activeGimmicks.map(g => getGimmickDef(g)).filter(Boolean);
      if (defs.length > 0) {
        showGimmickIntros(defs);
      }
    }
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
    // Lifeline: passive save from mine death
    if (tryLifeline(row, col)) return;
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

  updateCells(newlyRevealed);
  updateHeader();
  updateCellsRemaining();

  if (checkWin(state.board)) handleWin();
}

export function toggleFlag(row, col) {
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

export function handleChordReveal(row, col) {
  if (state.status !== 'playing') return;
  const result = chordReveal(state.board, row, col);
  if (!result || !result.revealed) return;

  state.revealedCount += result.revealed.filter(c => !c.isMine).length;

  updateCells(result.revealed);
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
