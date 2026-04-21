import { state } from '../state/gameState.js';
import {
  saveGameState, loadGameState, loadDailyPar,
} from '../storage/statsStorage.js';
import { getLocalDateString } from '../logic/seededRandom.js';
import { recomputeDisplayedMines } from '../logic/gimmicks.js';
import {
  adjustCellSize, renderBoard, updateAllCells, updateZoom, renderWallOverlays,
} from '../ui/boardRenderer.js';
import {
  updateHeader, updateCheckpointDisplay, updateProgressBar,
  updateCellsRemaining, updateStreakDisplay, updateStreakBorder,
  updateFlagModeBar,
} from '../ui/headerRenderer.js';
import { updatePowerUpBar } from '../ui/powerUpBar.js';
import { startTimer, updateTimerDisplay, seedPreciseAccumulated } from './timerManager.js';

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
      isMystery: c.isMystery || false,
      isPressurePlate: c.isPressurePlate || false, plateDisarmed: c.plateDisarmed || false,
      plateTimer: c.plateTimer || 0,
      isSonar: c.isSonar || false, sonarCount: c.sonarCount || 0,
      isCompass: c.isCompass || false, compassCount: c.compassCount || 0,
      compassArrow: c.compassArrow || undefined, compassDir: c.compassDir || undefined,
      isLiar: c.isLiar || false, isLocked: c.isLocked || false,
      isWormhole: c.isWormhole || false,
      displayedMines: c.displayedMines != null ? c.displayedMines : undefined,
      wormholePair: c.wormholePair || undefined,
      wormholePairIndex: c.wormholePairIndex ?? undefined,
      mirrorPair: c.mirrorPair || undefined,
      liarOffset: typeof c.liarOffset === 'number' ? c.liarOffset : undefined,
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
    wallEdges: state.board._wallEdges ? Array.from(state.board._wallEdges) : [],
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
    const today = getLocalDateString();
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

  // Rehydrate par + features from the per-date cache so the resumed game's
  // end-of-game modal can render the full breakdown and the Firebase meta
  // upload sees the same features the original play computed.
  if (state.gameMode === 'daily' && state.dailySeed) {
    const cached = loadDailyPar(state.dailySeed);
    state.dailyPar = cached.par || 0;
    state.dailyMoves = cached.moves || 0;
    state.dailyFeatures = cached.features || null;
  }

  // Restore wall edges on the board. Always create the Set (even if empty)
  // when the walls modifier was active, so any downstream `_wallEdges.has(...)`
  // call doesn't crash on `undefined`. The walls modifier may legitimately
  // produce zero edges in some random rolls.
  if (gs.wallEdges) {
    state.board._wallEdges = new Set(gs.wallEdges);
  }

  // Recompute gimmick displayed values from current mine layout.
  // Older saves may be missing wormholePairIndex or liarOffset, and
  // displayedMines can go stale if a mine shift occurred between saves.
  if (state.activeGimmicks.length > 0) {
    recomputeDisplayedMines(state.board);
  }

  adjustCellSize();
  renderBoard();
  updateAllCells();
  renderWallOverlays();
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
  // Seed the module-level precise-time accumulator from the restored
  // elapsedTime BEFORE startTimer, so leaderboard submissions for resumed
  // Daily games include time elapsed prior to the resume.
  seedPreciseAccumulated(state.elapsedTime);
  startTimer();

  return true;
}
