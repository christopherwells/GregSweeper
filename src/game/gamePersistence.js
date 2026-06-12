import { state } from '../state/gameState.js';
import {
  saveGameState, loadGameState, loadDailyPar,
} from '../storage/statsStorage.js';
import { getLocalDateString, getWeekStart, getWeekDayIndex } from '../logic/seededRandom.js';
import { isSaveResumable } from '../logic/resumeEligibility.js';
import { recomputeDisplayedMines } from '../logic/gimmicks.js';
import {
  adjustCellSize, renderBoard, updateAllCells, updateZoom, renderWallOverlays,
} from '../ui/boardRenderer.js';
import {
  updateHeader, updateCheckpointDisplay, updateProgressBar,
  updateCellsRemaining, updateStreakDisplay, updateStreakBorder,
  updateFlagModeBar, updateActiveGimmickBar,
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
      isStrike: c.isStrike || false,
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
      // The Lens points back at the marked start when a player walks
      // off the certified path into a proof-free state — losing this
      // on resume would misfire its error branch on resumed dailies.
      suggestedStart: c.suggestedStart || false,
      row: c.row, col: c.col,
    }))),
    rows: state.rows, cols: state.cols, totalMines: state.totalMines,
    flagCount: state.flagCount, revealedCount: state.revealedCount,
    elapsedTime: state.elapsedTime, currentLevel: state.currentLevel,
    gameMode: state.gameMode, powerUps: { ...state.powerUps },
    shieldActive: state.shieldActive, checkpoint: state.checkpoint,
    dailySeed: state.dailySeed, dailyRngSeed: state.dailyRngSeed || null,
    dailyBombHits: state.dailyBombHits,
    dailyBombHitEvents: state.dailyBombHitEvents || [],
    clickTimeline: state.clickTimeline || [],
    boardCertificate: state.boardCertificate || null,
    weeklySeed: state.weeklySeed || null,
    weeklyDay: state.weeklyDay,
    weeklyRngSeed: state.weeklyRngSeed || null,
    weeklyBombHits: state.weeklyBombHits || 0,
    weeklyBombHitEvents: state.weeklyBombHitEvents || [],
    weeklyDayTimes: state.weeklyDayTimes || {},
    weeklyFeatures: state.weeklyFeatures || null,
    magnetMode: state.magnetMode || false,
    flagMode: state.flagMode || false,
    activeGimmicks: state.activeGimmicks || [],
    gimmickData: state.gimmickData || {},
    wallEdges: state.board._wallEdges ? Array.from(state.board._wallEdges) : [],
    gatedCert: !!state.board._gatedCert,
    firstClick: state.firstClick,
    savedStatus: state.status,
  };
  saveGameState(gs);
}

export function tryResumeGame(mode) {
  const slot = mode || state.gameMode;
  const gs = loadGameState(slot);

  // All resume-eligibility rules (date anchors, seed-identity
  // fingerprints, canonical divergence, corrupt cells) live in
  // resumeEligibility.js — pure and node-tested. The context anchors
  // to the CLOCK, not to live state: a session that survived midnight
  // ET still carries yesterday's dailySeed in state, and trusting it
  // is how yesterday's unfinished daily once resurrected as "today's"
  // puzzle. Practice (?seed=) is the one caller-owned seed, so its
  // live flag and seed are the only state fields consulted.
  const resumable = isSaveResumable(gs, {
    mode: slot,
    today: getLocalDateString(),
    weekStart: getWeekStart(),
    weekDayIndex: getWeekDayIndex(),
    isDailyPractice: !!state.isDailyPractice,
    practiceSeed: state.dailySeed || null,
    canonicalDate: state.canonicalDailyBoard?.date || null,
    canonicalRngSeed: state.canonicalDailyBoard?.raw?.rngSeed || null,
  });
  if (!resumable) return false;

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
  state.dailyRngSeed = gs.dailyRngSeed || gs.dailySeed || null;
  state.dailyBombHits = gs.dailyBombHits || 0;
  state.dailyBombHitEvents = Array.isArray(gs.dailyBombHitEvents) ? gs.dailyBombHitEvents : [];
  state.clickTimeline = Array.isArray(gs.clickTimeline) ? gs.clickTimeline : [];
  // Restore the no-guess certificate so the Certified chip survives a
  // resume (updateActiveGimmickBar below re-renders it). Saves from
  // before the chip shipped lack the field and resume chipless.
  state.boardCertificate = gs.boardCertificate || null;
  state.weeklySeed = gs.weeklySeed || null;
  state.weeklyDay = typeof gs.weeklyDay === 'number' ? gs.weeklyDay : null;
  state.weeklyRngSeed = gs.weeklyRngSeed || null;
  state.weeklyBombHits = gs.weeklyBombHits || 0;
  state.weeklyBombHitEvents = Array.isArray(gs.weeklyBombHitEvents) ? gs.weeklyBombHitEvents : [];
  state.weeklyDayTimes = (gs.weeklyDayTimes && typeof gs.weeklyDayTimes === 'object') ? gs.weeklyDayTimes : {};
  state.weeklyFeatures = gs.weeklyFeatures || null;
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

  // Restore the certification-contract flag (boardSolver reads it as its
  // gating default). Saves from before reveal gating lack the field and
  // resume ungated — correct, their boards were certified ungated.
  if (gs.gatedCert) {
    state.board._gatedCert = true;
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
  updateActiveGimmickBar();
  updateZoom();
  // Seed the module-level precise-time accumulator from the restored
  // elapsedTime BEFORE startTimer, so leaderboard submissions for resumed
  // Daily games include time elapsed prior to the resume.
  seedPreciseAccumulated(state.elapsedTime);
  startTimer();

  return true;
}
