import { state } from '../state/gameState.js?v=1.0.9';
import {
  saveGameState, loadGameState,
} from '../storage/statsStorage.js?v=1.0.9';
import {
  adjustCellSize, renderBoard, updateAllCells, updateZoom,
} from '../ui/boardRenderer.js?v=1.0.9';
import {
  updateHeader, updateCheckpointDisplay, updateProgressBar,
  updateCellsRemaining, updateStreakDisplay, updateStreakBorder,
  updateFlagModeBar,
} from '../ui/headerRenderer.js?v=1.0.9';
import { updatePowerUpBar } from '../ui/powerUpBar.js?v=1.0.9';
import { startTimer, updateTimerDisplay } from './timerManager.js?v=1.0.9';

// ── Game State Persistence ────────────────────────────

export function persistGameState() {
  // Persist for 'playing' and 'idle' (pre-first-click) states
  if (state.status !== 'playing' && state.status !== 'idle') return;
  if (!state.board || state.board.length === 0) return;
  const gs = {
    board: state.board.map(row => row.map(c => ({
      isMine: c.isMine, isRevealed: c.isRevealed, isFlagged: c.isFlagged,
      adjacentMines: c.adjacentMines, isDefused: c.isDefused || false,
      isHiddenNumber: c.isHiddenNumber || false,
      isWall: c.isWall || false, isMystery: c.isMystery || false,
      isLiar: c.isLiar || false, isLocked: c.isLocked || false,
      isWormhole: c.isWormhole || false,
      displayedMines: c.displayedMines != null ? c.displayedMines : undefined,
      wormholePair: c.wormholePair || undefined,
      mirrorZone: c.mirrorZone || undefined,
      inLiarZone: c.inLiarZone || false,
      row: c.row, col: c.col,
    }))),
    rows: state.rows, cols: state.cols, totalMines: state.totalMines,
    flagCount: state.flagCount, revealedCount: state.revealedCount,
    elapsedTime: state.elapsedTime, currentLevel: state.currentLevel,
    gameMode: state.gameMode, powerUps: { ...state.powerUps },
    shieldActive: state.shieldActive, checkpoint: state.checkpoint,
    dailySeed: state.dailySeed, dailyBombHits: state.dailyBombHits,
    magnetMode: state.magnetMode || false,
    flagMode: state.flagMode || false,
    activeGimmicks: state.activeGimmicks || [],
    gimmickData: state.gimmickData || {},
    firstClick: state.firstClick,
    savedStatus: state.status,
  };
  saveGameState(gs);
}

export function tryResumeGame(mode) {
  const gs = loadGameState(mode || state.gameMode);
  if (!gs || !gs.board || !gs.gameMode) return false;

  // Stale daily check: if saved daily seed does not match today, discard
  if (gs.gameMode === 'daily' && gs.dailySeed) {
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (gs.dailySeed !== today) return false;
  }

  state.board = gs.board;
  state.rows = gs.rows;
  state.cols = gs.cols;
  state.totalMines = gs.totalMines;
  state.flagCount = gs.flagCount;
  state.revealedCount = gs.revealedCount;
  state.elapsedTime = gs.elapsedTime;
  state.currentLevel = gs.currentLevel;
  state.gameMode = gs.gameMode;
  state.powerUps = gs.powerUps || { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
  state.shieldActive = gs.shieldActive || false;
  state.checkpoint = gs.checkpoint || 1;
  state.dailySeed = gs.dailySeed || null;
  state.dailyBombHits = gs.dailyBombHits || 0;
  state.status = gs.savedStatus || 'playing';
  state.firstClick = gs.firstClick ?? false;
  state.hitMine = null;
  state.scanMode = false;
  state.xrayMode = false;
  state.magnetMode = gs.magnetMode || false;
  state.flagMode = gs.flagMode || false;
  state.suggestedMove = null;
  state.activeGimmicks = gs.activeGimmicks || [];
  state.gimmickData = gs.gimmickData || {};

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
  startTimer();

  return true;
}
