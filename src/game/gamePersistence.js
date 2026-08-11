import { state, ownsSaveSlot } from '../state/gameState.js';
import {
  saveGameState, loadGameState, loadDailyPar, loadStats,
} from '../storage/statsStorage.js';
import { getLocalDateString, getWeekStart, getWeekDayIndex } from '../logic/seededRandom.js';
import { isSaveResumable } from '../logic/resumeEligibility.js';
import { challengeSpecForLevel } from '../logic/challenge250.js';
import { recomputeDisplayedMines } from '../logic/gimmicks.js';
import { defineCellNeighbors } from '../logic/adjacency.js';
import {
  adjustCellSize, renderBoard, updateAllCells, updateZoom, renderWallOverlays,
} from '../ui/boardRenderer.js';
import {
  updateHeader, updateCheckpointDisplay, updateProgressBar,
  updateCellsRemaining, updateStreakDisplay, updateStreakBorder,
  updateFlagModeBar, updateActiveGimmickBar,
} from '../ui/headerRenderer.js';
import { updatePowerUpBar } from '../ui/powerUpBar.js';
import { startTimer, updateTimerDisplay, seedPreciseAccumulated, startWormCrawl } from './timerManager.js';
import { rehydrateWorms } from '../logic/worms.js';
import { renderWormOverlays } from '../ui/wormRenderer.js';

// ── Game State Persistence ────────────────────────────

export function persistGameState() {
  // Persist for 'playing' and 'idle' (pre-first-click) states
  if (state.status !== 'playing' && state.status !== 'idle') return;
  if (!state.board || state.board.length === 0) return;
  // A run that does not OWN this mode's slot never writes to it. Archive
  // replays share the daily / weekly slot, and ?level= + coastline practice
  // runs share the challenge slot, so persisting one would clobber the real
  // in-progress game (and a past-date save fails resume anyway,
  // resumeEligibility anchors both to the live ET clock). Those lanes are
  // always re-launched from the calendar / list. The matching CLEAR guard
  // lives at the win and loss ends; ownsSaveSlot is the one question.
  if (!ownsSaveSlot(state)) return;
  const gs = {
    board: state.board.map(row => row.map(c => ({
      isMine: c.isMine, isRevealed: c.isRevealed, isFlagged: c.isFlagged,
      adjacentMines: c.adjacentMines, isDefused: c.isDefused || false,
      isStrike: c.isStrike || false,
      isHiddenNumber: c.isHiddenNumber || false,
      isMystery: c.isMystery || false,
      isWormEgg: c.isWormEgg || false,
      isPressurePlate: c.isPressurePlate || false, plateDisarmed: c.plateDisarmed || false,
      plateTimer: c.plateTimer || 0,
      isSonar: c.isSonar || false, sonarCount: c.sonarCount || 0,
      isCompass: c.isCompass || false, compassCount: c.compassCount || 0,
      compassArrow: c.compassArrow || undefined, compassDir: c.compassDir || undefined,
      // The STORED compass ray (explicit-topology boards): on a tiling the
      // ray is a geometry question the neighbor graph cannot answer, so it
      // is computed once at generation and stamped, and BOTH the displayed
      // number and the certifier read it back through compassRayCells,
      // which returns [] for a cell without one. Dropping it here was the
      // CELL_FIELDS defect (issue #189) replayed on the save: the resume's
      // recomputeDisplayedMines silently turned every tiling compass number
      // into 0. Absent on rectangles (they derive the ray from row/col).
      compassRay: Array.isArray(c.compassRay) ? c.compassRay : undefined,
      isLiar: c.isLiar || false, isLocked: c.isLocked || false,
      isWormhole: c.isWormhole || false,
      displayedMines: c.displayedMines != null ? c.displayedMines : undefined,
      wormholePair: c.wormholePair || undefined,
      wormholePairIndex: c.wormholePairIndex ?? undefined,
      mirrorPair: c.mirrorPair || undefined,
      liarOffset: typeof c.liarOffset === 'number' ? c.liarOffset : undefined,
      inLiarZone: c.inLiarZone || false,
      // The Lens points back at the marked start when a player walks
      // off the certified path into a proof-free state, losing this
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
    // Lens invocations MUST survive a resume: the score submission attaches
    // them so the nightly refit can EXCLUDE hinted plays from the par fit.
    // Before 2026-07-10 the snapshot dropped them, so a resumed daily that
    // had used the Lens submitted as an unhinted play and contaminated the
    // model, the exact corruption the instrumentation exists to prevent.
    // Purist-achievement flag: without it a resumed game that had already
    // used a power-up counted as a purist win on completion.
    usedPowerUps: state.usedPowerUps || false,
    // Timed par + features: without them a resumed timed win lost its par
    // line and its timed/{pushId} fit row.
    timedPar: state.timedPar || 0,
    timedFeatures: state.timedFeatures || null,
    // Challenge 250 draw identity: the seed is what live worm hatches key
    // their traits on (matching the wormLoad the builder priced), and the
    // par feeds the expected-time surfaces. Both must survive a resume.
    challengeBoardSeed: state.challengeBoardSeed || null,
    challengePar: state.challengePar || 0,
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
    // Live worms persist as segments + movesLeft + tone + pace; the move
    // clocks re-roll on resume (rehydrateWorms), the lenient direction.
    worms: (state.worms || []).map(w => ({
      segments: w.segments.map(s => ({ r: s.r, c: s.c })),
      movesLeft: w.movesLeft,
      tone: typeof w.tone === 'number' ? w.tone : 0.5,
      pace: typeof w.pace === 'number' ? w.pace : 1,
      eggR: w.eggR,
      eggC: w.eggC,
      lastDir: w.lastDir ? { dr: w.lastDir.dr, dc: w.lastDir.dc } : null,
    })),
    // The hatch log must survive a resume, a resumed daily's submission
    // reports the realized worm dose, same contract as bombHitEvents.
    wormEvents: state.wormEvents || [],
    wallEdges: state.board._wallEdges ? Array.from(state.board._wallEdges) : [],
    // An explicit topology (Coastline tiling boards) rides the save the same
    // way wallEdges does, and for the same reason: the snapshot is JSON, and
    // JSON.stringify drops properties stamped on the board ARRAY. Without
    // this a tiling game saved and resumed comes back RECTANGULAR mid-play,
    // the board silently changes shape under the player, and the adjacency it
    // was certified under is gone. Null on every ordinary board, which is
    // every board shipped today.
    //
    // The GEOMETRY rides alongside (issue #189, the Phase-1 bug re-opened
    // through the half of the contract added later): _cellPos is the
    // renderer's own test for "is this a tiling board", _tiling is what
    // applyWallsTiling / the outline memo rebuild from, and _tilingWalls is
    // the severed-edge list the wall overlay draws (a tiling board does not
    // use _wallEdges). Same field set the canonical payload carries; the
    // save stores _cellPos VERBATIM, so cairo/deltoidal keep their compass
    // ray anchors (ax/ay), the canonical path's documented residual does
    // not apply here. All null/absent on every rectangular board.
    cellNeighbors: state.board._cellNeighbors || null,
    cellPos: state.board._cellPos || null,
    tiling: state.board._tiling || null,
    tilingWalls: Array.isArray(state.board._tilingWalls) ? state.board._tilingWalls : null,
    gatedCert: !!state.board._gatedCert,
    firstClick: state.firstClick,
    savedStatus: state.status,
  };
  saveGameState(gs);
}

// The context every resume decision is judged against. All resume-eligibility
// rules (date anchors, seed-identity fingerprints, canonical divergence,
// corrupt cells) live in resumeEligibility.js, pure and node-tested, and
// this is the one place their inputs are gathered. It anchors to the CLOCK,
// not to live state: a session that survived midnight ET still carries
// yesterday's dailySeed in state, and trusting it is how yesterday's
// unfinished daily once resurrected as "today's" puzzle. Practice (?seed=) is
// the one caller-owned seed, so its live flag and seed are the only state
// fields consulted.
function resumeContext(slot) {
  return {
    mode: slot,
    today: getLocalDateString(),
    weekStart: getWeekStart(),
    weekDayIndex: getWeekDayIndex(),
    isDailyPractice: !!state.isDailyPractice,
    practiceSeed: state.dailySeed || null,
    canonicalDate: state.canonicalDailyBoard?.date || null,
    canonicalRngSeed: state.canonicalDailyBoard?.raw?.rngSeed || null,
    // The weekly's counterpart. The gate stashes this board exactly as it does
    // the daily's, so the check costs nothing extra, it was simply never wired.
    canonicalWeek: state.canonicalWeeklyBoard?.weekStart || null,
    canonicalWeeklyRngSeed: state.canonicalWeeklyBoard?.raw?.rngSeed || null,
    // A challenge save above maxLevelReached + 1 is a position this
    // progression cannot hold, the pre-C250 save the epoch reset never
    // reached (issue #239).
    maxLevelReached: loadStats().modeStats?.challenge?.maxLevelReached || 1,
  };
}

/**
 * Would `tryResumeGame(mode)` find something to resume? Asked by the entry
 * gates BEFORE they decide whether to let the player in, so a gate can tell
 * "come back tomorrow" from "your game is still open" (issue #246). Reads the
 * same slot against the same context the resume itself uses, so the two can
 * never disagree about what is resumable.
 */
export function canResumeMode(mode) {
  const slot = mode || state.gameMode;
  return isSaveResumable(loadGameState(slot), resumeContext(slot));
}

export function tryResumeGame(mode) {
  const slot = mode || state.gameMode;
  const gs = loadGameState(slot);

  if (!isSaveResumable(gs, resumeContext(slot))) return false;

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
  state.usedPowerUps = gs.usedPowerUps === true;
  state.timedPar = typeof gs.timedPar === 'number' ? gs.timedPar : 0;
  state.timedFeatures = gs.timedFeatures || null;
  // Challenge 250 draw identity (worm-trait seed + level par). Pre-engine
  // saves lack both; the worm chain then falls back to the bare-level
  // identity, which is exactly what those boards hatched under.
  state.challengeBoardSeed = gs.challengeBoardSeed || null;
  state.challengePar = typeof gs.challengePar === 'number' ? gs.challengePar : 0;
  if (state.gameMode === 'normal') {
    // Re-derive the spec, but the SHAPE comes from the saved board itself:
    // a library deal is usually a different lattice than the braid's spec
    // for that slot, and the two consumers of challengeSpec.shape (the
    // pre-level card's shape line, the shape-intro gate) must describe the
    // board being resumed. The save's own `tiling` descriptor is the
    // board's shape (null on a rectangle), so no board-restore ordering
    // is involved.
    const braid = challengeSpecForLevel(gs.currentLevel || 1);
    state.challengeSpec = gs.tiling && gs.tiling.type
      ? { ...braid, shape: gs.tiling.type }
      : (gs.cellNeighbors ? braid : { ...braid, shape: 'rect' });
  }
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
  state.worms = rehydrateWorms(gs.worms);
  state.wormEvents = Array.isArray(gs.wormEvents) ? gs.wormEvents : [];
  // No save is ever a Chaos board (Chaos always starts fresh), so a resumed
  // game never inherits a shift cadence. This is the one resume path that does
  // NOT run stopTimer, which is where the leaked cadence used to survive
  // (issue #238); clearing it here means the plan can only ever describe the
  // board on screen.
  state.mineShiftPlan = null;

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

  // Restore an explicit topology before anything reads the board. Every
  // adjacency question downstream, the flood, the chord, the mine counters,
  // the certifier, resolves through this, so it has to be in place first.
  // isSaveResumable already refused a save whose topology failed validation,
  // so this cannot silently stamp a corrupt one.
  if (gs.cellNeighbors) {
    defineCellNeighbors(state.board, gs.rows, gs.cols, gs.cellNeighbors);
    // The geometry restores with the graph (issue #189): _cellPos routes the
    // renderer onto the tiling layout path, _tiling feeds the outline memo and
    // the wall wireframe rebuild, and _tilingWalls is the drawn severed-edge
    // list, always an ARRAY on a tiling board (two consumers branch on its
    // length), mirroring deserializeBoard. isSaveResumable refused any save
    // claiming a topology without cellPos + tiling, so these reads are safe.
    state.board._cellPos = gs.cellPos;
    state.board._tiling = { ...gs.tiling };
    state.board._tilingWalls = Array.isArray(gs.tilingWalls) ? gs.tilingWalls : [];
  }

  // Restore the certification-contract flag (boardSolver reads it as its
  // gating default). Saves from before reveal gating lack the field and
  // resume ungated, correct, their boards were certified ungated.
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
  renderWormOverlays();
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
  // Re-arm the worm heartbeat for restored live worms (the rearmPlateTimers
  // precedent: data persists, the runtime timer re-instantiates).
  startWormCrawl();

  return true;
}
