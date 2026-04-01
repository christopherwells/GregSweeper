import { state, getRevealedCells } from '../state/gameState.js';
import { $, $$, boardEl, resetBtn } from '../ui/domHelpers.js';
import {
  renderBoard, updateCell, updateAllCells, updateCells, getThemeEmoji,
  adjustCellSize, updateZoom, renderWallOverlays,
} from '../ui/boardRenderer.js';
import {
  updateHeader, updateCheckpointDisplay, updateProgressBar,
  updateCellsRemaining, updateStreakDisplay, updateStreakBorder,
  updateFlagModeBar,
} from '../ui/headerRenderer.js';
import { updatePowerUpBar } from '../ui/powerUpBar.js';
import { hideAllModals, showModal, hideModal } from '../ui/modalManager.js';
import { showLevelInfoToast } from '../ui/toastManager.js';
import { startTimer, stopTimer, pauseTimer, resumeTimer, startMineShift, updateTimerDisplay } from './timerManager.js';
import { handleWin, handleLoss, handleDailyBombHit } from './winLossHandler.js';
import { performScan, performXRay, performMagnet, tryLifeline } from './powerUpActions.js';
import { generateBoard, createEmptyBoard, calculateAdjacency } from '../logic/boardGenerator.js';
import { floodFillReveal, checkWin, chordReveal, isBoardSolvable, estimatePlateMovesToDisarm } from '../logic/boardSolver.js';
import { getDifficultyForLevel, getTimedDifficulty, getMaxZeroCluster, getChaosDifficulty } from '../logic/difficulty.js';
import { shieldDefuse } from '../logic/powerUps.js';
import { getGimmicksForLevel, applyGimmicks, applyWalls, isLockedCell, hasWallBetween, hasSeenGimmick, markGimmickSeen, getGimmickDef, isModifierPopupDisabled, setModifierPopupDisabled, getDailyGimmick, getChaosGimmicks } from '../logic/gimmicks.js';
import { createDailyRNG } from '../logic/seededRandom.js';
import {
  loadModePowerUps, loadCheckpoint, clearGameState,
} from '../storage/statsStorage.js';
import {
  playReveal, playFlag, playUnflag, playCascade, playShieldBreak,
} from '../audio/sounds.js';
import { loadEffects } from '../ui/collectionManager.js';

let _lastInputTime = 0;

// ── Local Date Utility ──────────────────────────────
// Use local dates (not UTC) so daily challenges reset at local midnight
function getLocalDateString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// ── Gimmick Intro Popup ───────────────────────────────

function showGimmickIntros(gimmickDefs) {
  let index = 0;
  const iconEl = document.getElementById('gimmick-intro-icon');
  const nameEl = document.getElementById('gimmick-intro-name');
  const descEl = document.getElementById('gimmick-intro-desc');
  const exampleEl = document.getElementById('gimmick-intro-example');
  const okBtn = document.getElementById('gimmick-intro-ok');
  const dismissBtn = document.getElementById('gimmick-intro-dismiss');
  if (!iconEl || !nameEl || !descEl || !okBtn) return;

  function showNext() {
    if (index >= gimmickDefs.length) {
      closeIntro();
      return;
    }
    const def = gimmickDefs[index];
    iconEl.textContent = def.icon;
    nameEl.textContent = `Modifier: ${def.name}`;
    descEl.textContent = def.longDesc || def.desc;
    if (exampleEl) {
      exampleEl.innerHTML = def.exampleHtml || '';
    }
    showModal('gimmick-intro-overlay');
  }

  function closeIntro() {
    hideModal('gimmick-intro-overlay');
    resumeTimer();
  }

  // Remove old listeners if any, add fresh ones
  const newBtn = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newBtn, okBtn);
  newBtn.addEventListener('click', () => {
    index++;
    if (index < gimmickDefs.length) {
      showNext();
    } else {
      closeIntro();
    }
  });

  // "Don't show again" button
  if (dismissBtn) {
    const newDismissBtn = dismissBtn.cloneNode(true);
    dismissBtn.parentNode.replaceChild(newDismissBtn, dismissBtn);
    newDismissBtn.addEventListener('click', () => {
      setModifierPopupDisabled(true);
      closeIntro();
    });
  }

  pauseTimer();
  showNext();
}


// ── Game Actions ───────────────────────────────────────

export function newGame() {
  stopTimer();
  let diff;
  if (state.gameMode === 'chaos') {
    diff = getChaosDifficulty(state.chaosRound || 1);
  } else if (state.gameMode === 'timed') {
    diff = getTimedDifficulty(state.currentLevel);
  } else {
    diff = getDifficultyForLevel(state.currentLevel);
  }
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
  state.dailySeed = state.gameMode === 'daily' ? getLocalDateString() : null;
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
    // The board solver marks cells as revealed during solvability analysis — reset them all
    for (const row of state.board) for (const cell of row) { cell.isRevealed = false; cell.revealAnimDelay = 0; }
    state.revealedCount = 0;
    state.firstClick = false;
    state.status = 'idle'; // stays idle until actual first click

    // Apply daily modifiers (~35% of days) with post-gimmick solvability check
    const dailyGimmicks = getDailyGimmick(state.dailySeed, createDailyRNG);
    if (dailyGimmicks.length > 0) {
      state.activeGimmicks = dailyGimmicks;
      const gimmickApplyRng = createDailyRNG(state.dailySeed + '-gimmick-apply');
      state.gimmickData = applyGimmicks(state.board, 1, state.activeGimmicks, gimmickApplyRng);

      // Verify solvability after gimmicks — if broken, strip gimmicks for this daily
      const fixedRow = Math.floor(state.rows / 2);
      const fixedCol = Math.floor(state.cols / 2);
      const check = isBoardSolvable(state.board, state.rows, state.cols, fixedRow, fixedCol);
      for (const brow of state.board) for (const c of brow) { c.isRevealed = false; c.revealAnimDelay = 0; }
      if (!check.solvable && check.remainingUnknowns > 0) {
        // Strip gimmick effects — regenerate clean board
        const cleanRng = createDailyRNG(state.dailySeed);
        state.board = generateBoard(state.rows, state.cols, state.totalMines, fixedRow, fixedCol, cleanRng);
        for (const brow of state.board) for (const c of brow) { c.isRevealed = false; c.revealAnimDelay = 0; }
        state.activeGimmicks = [];
        state.gimmickData = {};
      }
    }

  }

  // Load per-mode power-ups
  const modePU = loadModePowerUps(state.gameMode);
  const emptyPU = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
  if (state.gameMode === 'timed' || state.gameMode === 'daily' || state.gameMode === 'chaos') {
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

  // Chaos mode: update modifier bar UI
  if (state.gameMode === 'chaos') {
    const roundLabel = document.getElementById('chaos-round-label');
    const modIcons = document.getElementById('chaos-modifier-icons');
    if (roundLabel) roundLabel.textContent = 'Round ' + (state.chaosRound || 1);
    if (modIcons) modIcons.textContent = '';  // Will be populated on first click
  }

  // Reset dirty cells tracking
  state.dirtyCells = new Set();

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
  if (state._initialized && state.gameMode === 'chaos') {
    const chaosRound = state.chaosRound || 1;
    showLevelInfoToast(chaosRound, diff, 'Round ' + chaosRound);
  } else if (state._initialized && (state.gameMode === 'normal' || state.gameMode === 'timed')) {
    const label = diff.label ? `${diff.label}` : null;
    showLevelInfoToast(state.currentLevel, diff, label);
  }
  state._initialized = true;
}

export function revealCell(row, col) {
  if (state.status === 'won' || state.status === 'lost') return;

  // Remove daily "Start here" tooltip and green highlight on first interaction
  const startLabel = document.getElementById('start-here-label');
  if (startLabel) startLabel.remove();
  const startCell = boardEl.querySelector('.suggested-start');
  if (startCell) startCell.classList.remove('suggested-start');

  const cell = state.board[row][col];
  if (cell.isRevealed || cell.isFlagged) return;

  // Locked cell check
  if (cell.isLocked && isLockedCell(state.board, row, col)) {
    import('../ui/toastManager.js').then(m => {
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
    const hasGimmicks = state.gameMode === 'normal' && state.currentLevel > 10;

    // Determine which gimmicks will be active
    const gimmickRng = rng || Math.random;
    if (state.gameMode === 'normal') {
      state.activeGimmicks = getGimmicksForLevel(state.currentLevel, gimmickRng);
    } else {
      state.activeGimmicks = [];
    }

    // Generate walls FIRST so the constructive board generator builds
    // mine layouts that are solvable WITH walls from the start.
    let preWallEdges = null;
    if (state.activeGimmicks.includes('walls')) {
      // Create a temp board just to generate wall edges
      const tempBoard = createEmptyBoard(state.rows, state.cols);
      // Estimate wall intensity (1-5 based on level progression)
      const wallIntensity = Math.min(1 + Math.floor((state.currentLevel - 11) / 15), 5);
      applyWalls(tempBoard, state.rows, state.cols, wallIntensity, gimmickRng);
      preWallEdges = tempBoard._wallEdges;
    }

    // Generate board + apply gimmicks, retry if post-gimmick board isn't solvable
    let postGimmickSolvable = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      state.board = generateBoard(state.rows, state.cols, state.totalMines, row, col,
        rng || Math.random, { maxZeroCluster: maxZC, hasGimmicks, wallEdges: preWallEdges });

      state.gimmickData = {};
      if (state.activeGimmicks.length > 0) {
        if (preWallEdges) state.board._wallEdges = preWallEdges;
        state.gimmickData = applyGimmicks(state.board, state.currentLevel, state.activeGimmicks, gimmickRng);

        // Post-gimmick solvability check
        const check = isBoardSolvable(state.board, state.rows, state.cols, row, col);
        for (const brow of state.board) for (const c of brow) { c.isRevealed = false; c.revealAnimDelay = 0; }
        if (check.solvable || check.remainingUnknowns === 0) {
          postGimmickSolvable = true;
          break;
        }
        // Not solvable — retry with fresh board
      } else {
        postGimmickSolvable = true;
        break;
      }
    }

    // Apply gimmicks for challenge mode (show popups etc.)
    if (state.gameMode === 'normal') {
      if (state.activeGimmicks.length > 0) {

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
      // Refresh all cells to show liar-zone / wormhole / mirror indicators
      updateAllCells();
      renderWallOverlays();
    }

    // Apply gimmicks for chaos mode
    if (state.gameMode === 'chaos') {
      const chaosDiff = getChaosDifficulty(state.chaosRound || 1);
      state.chaosModifiers = getChaosGimmicks(chaosDiff.modifierCount);
      state.activeGimmicks = [...state.chaosModifiers];
      if (state.activeGimmicks.length > 0) {
        state.gimmickData = applyGimmicks(state.board, state.chaosRound || 1, state.activeGimmicks);

        // Start mine shift timer if active
        if (state.gimmickData.mineShift) {
          startMineShift(state.gimmickData.mineShift.interval);
        }
      }

      // Update chaos modifier bar with rolled modifiers
      const modIcons = document.getElementById('chaos-modifier-icons');
      if (modIcons) {
        modIcons.innerHTML = state.chaosModifiers.map(g => {
          const def = getGimmickDef(g);
          return def ? '<span class="chaos-mod-icon" title="' + def.name + '">' + def.icon + '</span>' : '';
        }).join('');
      }
      // Refresh all cells to show modifier indicators
      updateAllCells();
      renderWallOverlays();
    }

    state.firstClick = false;
    state.status = 'playing';
    startTimer();

  } else if (state.status === 'idle' && state.gameMode === 'daily') {
    // Daily mode: board was pre-generated for consistency.
    // If first click lands on a mine, relocate it deterministically.
    const clickedCell = state.board[row][col];
    if (clickedCell.isMine) {
      clickedCell.isMine = false;
      // Use seeded RNG so relocation is deterministic for the same click position
      const relocRng = createDailyRNG(state.dailySeed + '-reloc-' + row + '-' + col);
      // Gather all valid relocation targets (non-mine, not adjacent to click)
      const candidates = [];
      for (let r = 0; r < state.rows; r++) {
        for (let c = 0; c < state.cols; c++) {
          if (!state.board[r][c].isMine &&               (Math.abs(r - row) > 1 || Math.abs(c - col) > 1)) {
            candidates.push({ r, c });
          }
        }
      }
      if (candidates.length > 0) {
        const pick = candidates[Math.floor(relocRng() * candidates.length)];
        state.board[pick.r][pick.c].isMine = true;
      }
      calculateAdjacency(state.board);
      // Re-apply gimmicks that depend on adjacency (liar, wormhole, mirror)
      if (state.activeGimmicks.length > 0) {
        const gimmickApplyRng = createDailyRNG(state.dailySeed + '-gimmick-apply');
        state.gimmickData = applyGimmicks(state.board, 1, state.activeGimmicks, gimmickApplyRng);

        // Verify post-relocation solvability
        const check = isBoardSolvable(state.board, state.rows, state.cols, row, col);
        for (const brow of state.board) for (const c of brow) { c.isRevealed = false; c.revealAnimDelay = 0; }
        if (!check.solvable && check.remainingUnknowns > 0) {
          // Strip gimmick effects from cells, keep raw board
          for (const brow of state.board) for (const c of brow) {
            c.isMystery = false; c.isLiar = false; c.displayedMines = undefined;
            c.mirrorZone = undefined; c.isWormhole = false; c.wormholePair = undefined;
          }
          calculateAdjacency(state.board);
          state.activeGimmicks = [];
          state.gimmickData = {};
        }
      }
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
  const effectiveMines = currentCell.displayedMines != null ? currentCell.displayedMines : currentCell.adjacentMines;
  if (effectiveMines === 0) {
    state.inputLocked = true;
    const revealed = floodFillReveal(state.board, row, col);
    state.revealedCount += revealed.length;
    newlyRevealed = revealed;
    playCascade(revealed.length);
    // Unlock after the longest animation delay + buffer
    const maxDelay = revealed.length > 0
      ? Math.max(...revealed.map(c => c.revealAnimDelay || 0))
      : 0;
    setTimeout(() => { state.inputLocked = false; }, maxDelay + 100);
  } else {
    currentCell.isRevealed = true;
    currentCell.revealAnimDelay = 0;
    state.revealedCount++;
    newlyRevealed = [currentCell];
    playReveal();
  }

  // Wormhole: revealing one side reveals the paired cell too
  for (const rev of [...newlyRevealed]) {
    if (rev.isWormhole && rev.wormholePair) {
      const pair = state.board[rev.wormholePair.row]?.[rev.wormholePair.col];
      if (pair && !pair.isRevealed && !pair.isMine) {
        pair.isRevealed = true;
        pair.revealAnimDelay = 0;
        state.revealedCount++;
        newlyRevealed.push(pair);
        const pairEff = pair.displayedMines != null ? pair.displayedMines : pair.adjacentMines;
        if (pairEff === 0) {
          const cascade = floodFillReveal(state.board, pair.row, pair.col);
          state.revealedCount += cascade.length;
          newlyRevealed.push(...cascade);
        }
      }
    }
  }

  updateCells(newlyRevealed);
  updateHeader();
  updateCellsRemaining();

  // Activate pressure plate timers on newly revealed pressure plates
  for (const cell of newlyRevealed) {
    if (cell.isPressurePlate && !cell.plateDisarmed) {
      startPressurePlateTimer(cell);
    }
  }

  if (checkWin(state.board)) handleWin();
}

// ── Pressure Plate Timer ────────────────────────────────

const activePlates = new Map(); // cell -> timerId

function startPressurePlateTimer(cell) {
  const cellEl = boardEl.children[cell.row * state.cols + cell.col];
  if (!cellEl) return;

  cellEl.classList.add('plate-active');

  // Add timer bar
  const timerBar = document.createElement('div');
  timerBar.className = 'plate-timer';
  cellEl.appendChild(timerBar);

  // Dynamic timer: estimate solver steps needed, scale to seconds
  const est = estimatePlateMovesToDisarm(state.board, cell.row, cell.col);
  const dynamicTime = Math.max(8, Math.round(est.steps * 10));
  cell.plateTimer = dynamicTime;
  let remaining = dynamicTime;
  const startTime = Date.now();

  const tick = setInterval(() => {
    if (state.status !== 'playing') {
      clearInterval(tick);
      activePlates.delete(cell);
      return;
    }

    remaining = Math.max(0, cell.plateTimer - (Date.now() - startTime) / 1000);
    const pct = remaining / cell.plateTimer;
    timerBar.style.transform = 'scaleX(' + pct + ')';

    // Check if player flagged an adjacent mine
    if (checkPlateDisarmed(cell)) {
      clearInterval(tick);
      activePlates.delete(cell);
      cell.plateDisarmed = true;
      cellEl.classList.remove('plate-active', 'pressure-plate');
      cellEl.style.color = '';
      cellEl.style.fontSize = '';
      cellEl.style.fontWeight = '';
      timerBar.remove();
      updateCell(cell.row, cell.col);
      import('../ui/toastManager.js').then(m => m.showToast('✅ Plate disarmed!', 1200));
      return;
    }

    if (remaining <= 0) {
      clearInterval(tick);
      activePlates.delete(cell);
      // Plate detonates! Try lifeline first, then game over
      import('./powerUpActions.js').then(m => {
        if (m.tryLifeline(cell.row, cell.col)) return;
        handleLoss(cell.row, cell.col);
      });
    }
  }, 200);

  activePlates.set(cell, tick);
}

function checkPlateDisarmed(cell) {
  // Disarmed when all non-mine adjacent cells are revealed
  const rows = state.board.length;
  const cols = state.board[0].length;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = cell.row + dr, nc = cell.col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        if (!state.board[nr][nc].isMine && !state.board[nr][nc].isRevealed) return false;
      }
    }
  }
  return true;
}


export function toggleFlag(row, col) {
  if (state.status !== 'playing' && state.status !== 'idle') return;
  if (state.inputLocked) return;
  const cell = state.board[row][col];
  if (cell.isRevealed) return;

  // Can't flag locked cells until they're unlocked
  if (cell.isLocked && isLockedCell(state.board, row, col)) {
    import('../ui/toastManager.js').then(m => {
      m.showToast('🔒 Unlock neighbors first!', 1500);
    });
    return;
  }

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
  if (state.inputLocked) return;
  const now = Date.now();
  if (now - _lastInputTime < 50) return;
  _lastInputTime = now;
  const result = chordReveal(state.board, row, col);
  if (!result || !result.revealed) return;

  state.revealedCount += result.revealed.filter(c => !c.isMine).length;

  updateCells(result.revealed);
  updateHeader();

  // Lock input during chord animation
  if (result.revealed && result.revealed.length > 1 && !result.hitMine) {
    state.inputLocked = true;
    const maxDist = Math.max(...result.revealed.map(c => Math.abs(c.row - row) + Math.abs(c.col - col)));
    setTimeout(() => { state.inputLocked = false; }, 350 + maxDist * 40 + 50);
  }

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
    // Undo the reveal that chordReveal applied so lifeline/daily can handle it
    mineCell.isRevealed = false;
    if (state.gameMode === 'daily') {
      handleDailyBombHit(mineCell.row, mineCell.col);
    } else if (tryLifeline(mineCell.row, mineCell.col)) {
      // Lifeline saved — continue playing
    } else {
      mineCell.isRevealed = true;
      handleLoss(mineCell.row, mineCell.col);
    }
  } else if (checkWin(state.board)) {
    handleWin();
  }
}
