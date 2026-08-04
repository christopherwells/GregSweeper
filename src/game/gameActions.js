import { state, getRevealedCells, recordPlayerAction, modifiersPreResolved } from '../state/gameState.js';
import { $, $$, boardEl, resetBtn } from '../ui/domHelpers.js';
import {
  renderBoard, updateCell, updateAllCells, updateCells, getThemeEmoji,
  adjustCellSize, updateZoom, renderWallOverlays, setDailySuggestedCell,
} from '../ui/boardRenderer.js';
import {
  updateHeader, updateCheckpointDisplay, updateProgressBar,
  updateCellsRemaining, updateStreakDisplay, updateStreakBorder,
  updateFlagModeBar, updateActiveGimmickBar,
} from '../ui/headerRenderer.js';
import { applyGimmickIcon, gimmickSpriteImgHTML, uiSpriteImgHTML } from '../ui/spriteLoader.js';
import { updatePowerUpBar } from '../ui/powerUpBar.js';
import { hideAllModals, showModal, hideModal } from '../ui/modalManager.js';
import { showLevelInfoToast } from '../ui/toastManager.js';
import { startTimer, stopTimer, pauseTimer, resumeTimer, startMineShift, updateTimerDisplay, hatchWormEggs } from './timerManager.js';
import { handleWin, handleLoss, handleDailyBombHit } from './winLossHandler.js';
import { performScan, performXRay, performMagnet, tryLifeline } from './powerUpActions.js';
import { generateBoard, createEmptyBoard, cleanSolverArtifacts, placeMysteryConstructive } from '../logic/boardGenerator.js';
import { generateTilingBoard, containerFor } from '../logic/tilingGenerator.js';
import { coastlineBoardFor, DEFAULT_TILING, tilingLabel, CLASSIC_SHAPE_LABEL } from '../logic/coastlineLink.js';
import { expectedTimeLine } from '../logic/expectedTime.js';
import { personalPar } from '../logic/handicaps.js';
import { challengeSpecForLevel } from '../logic/challenge250.js';
import { buildChallenge250Board, challengeBoardSeed } from '../logic/challenge250Builder.js';
import { floodFillReveal, checkWin, chordReveal, unrevealChordMines, isBoardSolvable, estimatePlateMovesToDisarm, buildNeighborCache, findDecorativeGimmicks, certificateFromCheck } from '../logic/boardSolver.js';
import { plateDisarmCells, cellAt } from '../logic/adjacency.js';
import { getTimedDifficulty, getChaosDifficulty, DAILY_MIN_SIZE, DAILY_SIZE_RANGE, DAILY_MIN_DENSITY, DAILY_DENSITY_RANGE, WEEKLY_MIN_SIZE, WEEKLY_SIZE_RANGE, BOARD_WIDTH_CAP, plateSeconds } from '../logic/difficulty.js';
import { computeDailyFeatures, predictPar } from '../logic/dailyFeatures.js';
import { shieldDefuse } from '../logic/powerUps.js';
import { applyGimmicks, isLockedCell, hasSeenGimmick, markGimmickSeen, getGimmickDef, isModifierPopupDisabled, setModifierPopupDisabled, getDailyGimmick, getWeeklyGimmicks, getChaosGimmicks, recomputeDisplayedMines } from '../logic/gimmicks.js';
import { createDailyRNG, getLocalDateString, getWeekStart, getWeekDayIndex } from '../logic/seededRandom.js';
import { selectDailyRngSeed } from '../logic/selectDailyRngSeed.js';
import { selectWeeklyRngSeed } from '../logic/selectWeeklyRngSeed.js';
import { getTargetGimmickName, getMissionForSeed, missionStamp, getCurrentTarget, getCoverageTargets } from '../logic/experimentDesign.js';
import { resolveDailyShape, buildTilingDailyBoard, getDailyShapeOverride } from '../logic/shapeRotation.js';
import { buildParLabBoard } from '../logic/parLab.js';
import { loadDailyBoard, saveDailyBoard, serializeBoard, deserializeBoard } from '../firebase/dailyBoardSync.js';
import { loadWeeklyBoard, saveWeeklyBoard } from '../firebase/weeklyBoardSync.js';
import { fetchWeeklyLeaderboard } from '../firebase/firebaseLeaderboard.js';
import { getUid, markWeeklyDayAttempted } from '../firebase/firebaseProgress.js';
import { isTestEnvironment } from '../firebase/env.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import {
  loadModePowerUps, loadCheckpoint, clearGameState, saveDailyPar,
  hasSeenNotice, markNoticeSeen,
} from '../storage/statsStorage.js';
import {
  playReveal, playFlag, playUnflag, playCascade, playShieldBreak,
} from '../audio/sounds.js';

let _lastInputTime = 0;

// ── Local Date Utility ──────────────────────────────
// Use local dates (not UTC) so daily challenges reset at local midnight
// getLocalDateString imported from seededRandom.js

// ── Gimmick Intro Popup ───────────────────────────────

function showGimmickIntros(gimmickDefs, recapDefs = []) {
  const iconEl = document.getElementById('gimmick-intro-icon');
  const nameEl = document.getElementById('gimmick-intro-name');
  const descEl = document.getElementById('gimmick-intro-desc');
  const exampleEl = document.getElementById('gimmick-intro-example');
  const okBtn = document.getElementById('gimmick-intro-ok');
  const dismissBtn = document.getElementById('gimmick-intro-dismiss');
  if (!iconEl || !nameEl || !descEl || !okBtn) return;

  // First time a player ever meets a Modifier, lead with a plain-language
  // primer so the per-modifier card isn't a cold dump on a newcomer who
  // just finished the basics tutorial.
  const showPrimer = !hasSeenNotice('modifier_primer');
  const cards = [];
  if (showPrimer) {
    cards.push({
      primer: true,
      iconKey: 'uiModifier',
      name: 'Modifiers',
      body: "This board has a Modifier. GregSweeper sometimes adds special cells that bend the rules: a liar that's off by one, a wormhole that shares counts, and more. You'll get a quick explainer the first time each one appears.",
      exampleHtml: '',
    });
  }
  for (const def of gimmickDefs) {
    cards.push({
      primer: false,
      icon: def.icon,
      gimmickKey: def._key || null,
      name: def.name,
      body: def.longDesc || def.desc,
      exampleHtml: def.exampleHtml || '',
    });
  }
  // Modifiers the player has already learned: one compact recap line
  // instead of re-showing their full explainer every day.
  if (recapDefs && recapDefs.length > 0) {
    cards.push({
      recap: true,
      iconKey: 'uiPuzzle',
      name: 'Also on this board',
      // Sprite-only modifiers (worm) have no icon field — name-only entry
      body: recapDefs.map(d => (d.icon ? `${d.icon} ${d.name}` : d.name)).join(' · '),
      exampleHtml: '',
    });
  }

  let index = 0;

  function showNext() {
    if (index >= cards.length) {
      closeIntro();
      return;
    }
    const card = cards[index];
    if (card.gimmickKey) {
      applyGimmickIcon(iconEl, card.gimmickKey, card.icon);
    } else if (card.iconKey) {
      iconEl.innerHTML = uiSpriteImgHTML(card.iconKey, 'gimmick-intro-icon');
    } else {
      iconEl.textContent = card.icon;
    }
    nameEl.textContent = (card.primer || card.recap) ? card.name : `Modifier: ${card.name}`;
    descEl.textContent = card.body;
    if (exampleEl) {
      exampleEl.innerHTML = card.exampleHtml || '';
    }
    if (card.primer) markNoticeSeen('modifier_primer');
    showModal('gimmick-intro-overlay');
  }

  function closeIntro() {
    hideModal('gimmick-intro-overlay');
    state.modalPaused = false;
    resumeTimer();
  }

  // Remove old listeners if any, add fresh ones
  const newBtn = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newBtn, okBtn);
  newBtn.addEventListener('click', () => {
    index++;
    if (index < cards.length) {
      showNext();
    } else {
      closeIntro();
    }
  });

  // "Skip all modifier explainers" is a global kill switch. Hide it for
  // the whole first-ever run (the run that carries the primer) so a brand
  // new player can't disable every future explainer before understanding
  // what a Modifier even is. It returns to normal on later encounters.
  if (dismissBtn) {
    const newDismissBtn = dismissBtn.cloneNode(true);
    dismissBtn.parentNode.replaceChild(newDismissBtn, dismissBtn);
    newDismissBtn.style.display = showPrimer ? 'none' : '';
    newDismissBtn.addEventListener('click', () => {
      setModifierPopupDisabled(true);
      closeIntro();
    });
  }

  pauseTimer();
  state.modalPaused = true;
  showNext();
}


// ── Game Actions ───────────────────────────────────────


// Reveal wormhole partners for any wormhole cells in the revealed array.
// Mutates the array in-place (appends paired cells + cascades).
function revealWormholePairs(revealed) {
  for (const rev of [...revealed]) {
    // Wormhole: revealing one side reveals the paired cell
    if (rev.isWormhole && rev.wormholePair && !rev.isMine) {
      revealLinkedCell(revealed, rev.wormholePair);
    }
    // Mirror: revealing one side reveals the paired cell (mirrors are never mines)
    if (rev.mirrorPair && !rev.isMine) {
      revealLinkedCell(revealed, rev.mirrorPair);
    }
  }
}

// placeMysteryConstructive moved to boardGenerator.js (shared with the
// Challenge 250 builder) — imported above, behavior unchanged.

function revealLinkedCell(revealed, link) {
  const pair = state.board[link.row]?.[link.col];
  if (pair && !pair.isRevealed && !pair.isMine) {
    pair.isRevealed = true;
    pair.revealAnimDelay = 0;
    state.revealedCount++;
    revealed.push(pair);
    const pairEff = pair.displayedMines != null ? pair.displayedMines : pair.adjacentMines;
    if (pairEff === 0) {
      const cascade = floodFillReveal(state.board, pair.row, pair.col);
      state.revealedCount += cascade.length;
      revealed.push(...cascade);
    }
  }
}

// Re-entrancy guard for newGame. newGame is async (daily/weekly await
// canonical-board fetches, up to 8s on a cold connection) and is fired
// un-awaited by switchMode — so two overlapping runs are reachable in
// real play (double-tap a mode card during a slow fetch, or smiley spam
// during the daily cold start). Without the guard, the SLOWER run's
// post-await phase resumes after the faster run's board is live and
// clobbers it: cleanSolverArtifacts(state.board) wipes isRevealed on
// every cell (a phantom re-fog) and status resets to idle mid-game.
// Each run takes a generation ticket; after every await it checks the
// ticket and abandons itself if a newer run has started.
let _newGameGeneration = 0;

// Mines are STRIKES — priced by info-value, marked, play continues — in the
// canonical modes AND in Par Lab runs; everywhere else a mine is a loss.
// The lab parameterizes the DAILY par model, so its mines must cost what
// daily mines cost (Christopher's ruling, 2026-08-02): a loss-on-mine lab
// measures a more cautious solve than the model's own response frame, and
// its rows would carry that bias straight into the priors. ONE predicate for
// the two routing sites (revealCell's mine branch and handleChordReveal's
// strike-vs-refog split) so they can never disagree about what a mine is.
function mineIsStrike() {
  return state.gameMode === 'daily' || state.gameMode === 'weekly' || !!state.parLab;
}

export async function newGame() {
  const myGeneration = ++_newGameGeneration;
  const staleRun = () => myGeneration !== _newGameGeneration;
  stopTimer();
  // Clear any pressure-plate timers from the previous game. activePlates is
  // module-level, so without this an in-flight tick can fire handleLoss on
  // the new board with the old cell coords.
  for (const id of activePlates.values()) clearInterval(id);
  activePlates.clear();
  // Clear live worms + hatch log from the previous game (the heartbeat
  // itself was torn down by stopTimer above).
  state.worms = [];
  state.wormEvents = [];
  // inputLocked is set transiently during cascade/chord animations and cleared
  // by a setTimeout. Starting a new game between the lock and the timeout would
  // leave the new game with input frozen until the next interaction would
  // normally clear it.
  state.inputLocked = false;
  let diff;
  if (state.gameMode === 'chaos') {
    diff = getChaosDifficulty(state.chaosRound || 1);
  } else if (state.gameMode === 'timed') {
    diff = getTimedDifficulty(state.currentLevel);
  } else {
    // Challenge 250: the level's authored spec owns the dimensions (the
    // sawtooth's getDifficultyForLevel is gone). A tiling spec's container
    // is an exact factorization of its cell count — the same containerFor
    // the builder itself uses — so the placeholder board that renders
    // while the draw runs already has the final shape. The coastline
    // branch below overwrites these for its own practice boards.
    const spec = challengeSpecForLevel(state.currentLevel);
    diff = spec.shape === 'rect'
      ? { rows: spec.rows, cols: spec.cols, mines: spec.mines }
      : { ...containerFor(spec.cells), mines: spec.mines };
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
  state.modalPaused = false; // fresh game must never inherit a stale modal-pause
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
  // Daily identity is derived HERE, from the ET clock, never trusted
  // from whoever called newGame: a live session that crossed midnight
  // still carries yesterday's date in state.dailySeed, and the old
  // keep-if-set logic would regenerate yesterday's board as "today's".
  // Practice (?seed= deep link) is the one caller-owned seed — it sets
  // isDailyPractice before newGame runs.
  if (state.gameMode !== 'daily') {
    state.dailySeed = null;
    state.dailyRngSeed = null;
    state.isDailyPractice = false;
    state.isArchivePlay = false;
    state._archiveRaw = null;
  } else if (!state.isDailyPractice && !state.isArchivePlay) {
    // Archive replays carry a caller-set PAST date in state.dailySeed
    // (launched from the calendar). Only a live daily derives today's date.
    state.dailySeed = getLocalDateString();
  }
  // Weekly identity is likewise clock-derived at creation (callers used
  // to pre-set it, which left a stale weeklySeed/weeklyDay possible in
  // a midnight-crossing session). Reset weekly state when leaving weekly.
  if (state.gameMode !== 'weekly') {
    state.weeklySeed = null;
    state.weeklyDay = null;
    state.weeklyRngSeed = null;
    state.weeklyBombHits = 0;
    state.weeklyBombHitEvents = [];
    state.weeklyDayTimes = {};
    state.weeklyDayBombHits = {};
    state.weeklyFeatures = null;
  } else {
    state.weeklySeed = getWeekStart();
    state.weeklyDay = getWeekDayIndex();
  }
  state.dailyBombHits = 0;
  state.dailyBombHitEvents = [];
  state.clickTimeline = [];
  state.boardCertificate = null;
  state.timedPar = 0;
  state.timedFeatures = null;
  state.coastlinePar = 0;
  state.coastlineFeatures = null;
  state.challengeSpec = null;
  state.challengeBoardSeed = null;
  state.challengeFeatures = null;
  state.challengePar = 0;

  // Project Coastline (test-only): a frozen tiling board, generated HERE like
  // daily/weekly rather than on first click. gameMode stays 'normal' +
  // isLevelPractice so nothing records; state.coastlinePractice routes the
  // frozen first-click path in revealCell. The whole surface is unreachable in
  // production — the ?coastline=1 deep link is isTestEnvironment()-gated.
  if (state.coastlinePractice) {
    let res;
    if (state.parLabSpec) {
      // Par Lab (test-only): the battery board's own spec — shape, lattice
      // dims, mines, modifiers, deterministic per-attempt seed — built by
      // the ONE builder the offline validator proves (buildParLabBoard).
      // Rect specs route through the daily-recipe rect generator inside it;
      // everything downstream of `res` is shared with the coastline path.
      res = buildParLabBoard(state.parLabSpec, state.parLabAttempt || 0);
      if (!res) {
        import('../ui/toastManager.js').then(m => m.showToast('Could not generate the lab board — skip it and tell Christopher.'));
        return;
      }
    } else {
      const seed = state.coastlineSeed || 'coastline-1';
      // Per-tiling board shape and mine count. Six lattices need six different
      // answers: a honeycomb cell is one shape and one size where a 4.8.8's cell
      // count is inflated by its small interstitial squares, and the four Laves
      // lattices need a density that puts them on the constructive placer at all.
      // The table and the measurements behind every number live in coastlineLink,
      // beside the parser that produced the type.
      const tilingType = state.coastlineType || DEFAULT_TILING;
      const dims = coastlineBoardFor(tilingType);
      res = generateTilingBoard({
        type: tilingType, ...dims, seed,
        gimmicks: Array.isArray(state.coastlineGimmicks) ? state.coastlineGimmicks : [],
      });
      if (!res) {
        import('../ui/toastManager.js').then(m => m.showToast('Could not generate a tiling board.'));
        return;
      }
    }
    state.rows = res.rows;
    state.cols = res.cols;
    let mineCount = 0;
    for (const brow of res.board) for (const bcell of brow) if (bcell.isMine) mineCount++;
    state.totalMines = mineCount;
    state.board = res.board;
    state.activeGimmicks = res.activeGimmicks || [];
    state.gimmickData = res.applied || {};
    state.firstClick = false;
    state.status = 'idle';
    // The certificate is the certified opener's own full solve, same contract
    // as daily/weekly: this board proves no-guess from the center cell.
    state.boardCertificate = certificateFromCheck(res.check);
    const oc = res.firstClick;
    const oRow = Math.floor(oc / res.cols), oCol = oc % res.cols;
    state.board[oRow][oCol].suggestedStart = true;
    setDailySuggestedCell({ r: oRow, c: oCol });

    // Features + par for the tiling board. Nothing submits these — a coastline
    // run is isLevelPractice and records nothing — but computing them here is
    // what makes the par chain PROVABLE on a non-rectangular board rather than
    // merely intended: computeDailyFeatures reads the board's own topology for
    // wall edges and zero clusters and derives `tilingType` from `_tiling`, so
    // a wrong number shows up as a wrong par on the test build instead of
    // waiting to surface in a fit months from now.
    //
    // Computed HERE rather than on first click because a tiling board is
    // frozen at generation like daily/weekly, not resolved on the opening
    // click the way challenge and timed boards are.
    try {
      state.coastlineFeatures = computeDailyFeatures(state, res.check);
      state.coastlinePar = predictPar(state.coastlineFeatures);
    } catch (err) {
      state.coastlineFeatures = null;
      state.coastlinePar = 0;
      reportCaughtError('coastline-par-compute', err);
    }
  }

  // Challenge 250: a FROZEN certified board drawn from the level's authored
  // spec (challengeSpecForLevel), generated HERE like daily/weekly rather
  // than on first click. Every attempt draws a fresh layout (death and
  // retry included — the play seed carries per-draw entropy, so no
  // memorize-through and no two players grinding the same L37 board). The
  // builder enforces the ladder rulings per draw: certified from the fixed
  // opener, STRICT load-bearing, the opener blocks' deduction floor.
  if (state.gameMode === 'normal' && !state.coastlinePractice) {
    const spec = challengeSpecForLevel(state.currentLevel);
    state.challengeSpec = spec;
    // Let the placeholder board paint before the CPU-bound draw — a summit
    // spec can cost over a second on desktop, several on a phone, and a
    // synchronous build would freeze the frame mid-transition.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (staleRun()) return;

    let res = null;
    for (let redraw = 0; redraw < 3 && !res; redraw++) {
      // Per-draw entropy: the validator proves the spec's DISTRIBUTION, so
      // the live seed only has to be unique, never reproducible.
      const salt = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
      res = buildChallenge250Board(spec, challengeBoardSeed(spec.level, redraw, salt));
    }
    if (staleRun()) return;
    if (!res) {
      // Validator-proven specs make this near-unreachable; if it happens,
      // say so rather than shipping an uncertified or decorative board.
      reportCaughtError('challenge-board-build', new Error(`L${spec.level} draw exhausted`));
      import('../ui/toastManager.js').then(m => m.showToast('Could not build this level’s board — try again.'));
      return;
    }

    state.rows = res.rows;
    state.cols = res.cols;
    state.totalMines = res.totalMines;
    state.board = res.board;
    state.activeGimmicks = res.activeGimmicks || [];
    state.gimmickData = res.applied || {};
    state.challengeBoardSeed = res.seed;
    state.challengeFeatures = res.features;
    state.challengePar = res.par || 0;
    state.firstClick = false;

    // Same contract as daily/weekly: certified from the marked opener, and
    // the board never mutates after this point.
    state.boardCertificate = certificateFromCheck(res.check);
    const oc = res.firstClick;
    const oRow = Math.floor(oc / res.cols), oCol = oc % res.cols;
    state.board[oRow][oCol].suggestedStart = true;
    setDailySuggestedCell({ r: oRow, c: oCol });
  }

  // Daily mode: vary board dimensions using the daily seed
  if (state.gameMode === 'daily' && state.dailySeed) {
    // Phase 1: resolve the canonical board for this date. The startup
    // gate in main.js pre-fetches today's canonical and stows it in
    // `state.canonicalDailyBoard` BEFORE we get here, so the typical
    // path is a single in-memory read. We fall back to a fresh
    // loadDailyBoard call only when the cached canonical is for a
    // different date (e.g. the tab stayed open across midnight) or
    // when the gate's fetch failed and we want to retry.
    //
    // Practice-daily (`?seed=` URL param) skips the canonical fetch:
    // practice is per-user and shouldn't pollute the shared bucket.
    const wantCanonical = !state.isDailyPractice;
    let reconstructed = null;
    if (wantCanonical) {
      try {
        let canonicalRaw = null;
        if (state.isArchivePlay && state._archiveRaw && state._archiveRaw.date === state.dailySeed) {
          // Archive replay: the calendar already fetched and validated this
          // PAST board, so use it verbatim and never touch the today-stash.
          canonicalRaw = state._archiveRaw.raw;
        } else if (state.canonicalDailyBoard
            && state.canonicalDailyBoard.date === state.dailySeed
            && state.canonicalDailyBoard.raw) {
          canonicalRaw = state.canonicalDailyBoard.raw;
        } else {
          canonicalRaw = await loadDailyBoard(state.dailySeed);
          if (staleRun()) return; // a newer newGame superseded this run mid-fetch
          // Only the live daily seeds the today-stash. An archive fetch is a
          // past date and must never overwrite today's canonical.
          if (canonicalRaw && !state.isArchivePlay) {
            state.canonicalDailyBoard = { date: state.dailySeed, raw: canonicalRaw };
          }
        }
        if (canonicalRaw) reconstructed = deserializeBoard(canonicalRaw);
      } catch (err) {
        // Malformed payload or fetch error — fall through to local
        // generation. We don't want a corrupt canonical to brick the
        // daily for everyone.
        console.warn('canonical board load/deserialize failed, regenerating:', err.message);
      }
    }

    // Archive replays REQUIRE the canonical: there is no local-gen fallback.
    // A regenerated past board could diverge from what actually shipped that
    // day, and we must never write a board into the archive's date slot. The
    // calendar only offers dates whose canonical exists, so reaching here
    // means a fetch failed between the calendar's probe and this generation.
    if (state.isArchivePlay && !reconstructed) {
      console.warn('archive: canonical missing for', state.dailySeed, '— aborting');
      state.isArchivePlay = false;
      state._archiveRaw = null;
      import('../ui/toastManager.js').then(m => m.showToast('That day’s board could not be loaded.'));
      return;
    }

    // Shape rotation (Project Coastline). Resolved only when the board has
    // to be generated HERE — a fetched canonical already IS its shape, and
    // the archive path never reaches local generation (it aborts above).
    // The live lane asks the date-seeded draw (null for every date while
    // TILING_ROTATION_START is unset, so this whole branch is dark in
    // production); the practice lane asks only the test-env ?dailyShape=
    // override, so a ?seed= practice run can never draw a shape and the
    // override can never touch a recording daily.
    let tilingBuilt = null;
    if (!reconstructed) {
      const shapeOverride = getDailyShapeOverride();
      const rotationShape = state.isDailyPractice
        ? (shapeOverride === 'rect' ? null : shapeOverride)
        : resolveDailyShape(state.dailySeed);
      if (rotationShape) {
        try {
          tilingBuilt = buildTilingDailyBoard(state.dailySeed, rotationShape, {
            target: getCurrentTarget(), coverage_targets: getCoverageTargets(),
          });
        } catch (err) {
          // A throw here would be deterministic too (same seed, same code on
          // every client), so the rectangular fallback still keeps all
          // clients in agreement — but it is a generator bug, so say so.
          tilingBuilt = null;
          reportCaughtError('tiling-daily-build', err);
        }
        // A null is deterministic (same seed, same code, same outcome on
        // every client), so falling back to the rectangular path below keeps
        // all clients in agreement — nobody splits.
        if (!tilingBuilt) console.warn('tiling daily generation failed for', state.dailySeed, '— falling back to rectangular');
      }
    }

    if (reconstructed) {
      state.dailyRngSeed = reconstructed.rngSeed || state.dailySeed;
      state.rows = reconstructed.rows;
      state.cols = reconstructed.cols;
      state.totalMines = reconstructed.totalMines;
      state.board = reconstructed.board;
      state.activeGimmicks = reconstructed.activeGimmicks || [];
      state.gimmickData = {};
    } else if (tilingBuilt) {
      // Single-candidate tiling day: the shared builder already ran the
      // mission draw, the gimmick roll, certified generation, and the
      // load-bearing filter. Mirror of the pipeline's tiling branch in
      // scripts/daily-board-pipeline.mjs — same function, same seed, same
      // board, byte for byte.
      state.dailyRngSeed = tilingBuilt.rngSeed;
      state.rows = tilingBuilt.rows;
      state.cols = tilingBuilt.cols;
      state.totalMines = tilingBuilt.totalMines;
      state.board = tilingBuilt.board;
      state.activeGimmicks = tilingBuilt.activeGimmicks || [];
      state.gimmickData = tilingBuilt.applied || {};

      if (wantCanonical) {
        const fallbackPayload = serializeBoard({
          board: state.board, rows: state.rows, cols: state.cols,
          totalMines: state.totalMines, rngSeed: state.dailyRngSeed,
          activeGimmicks: state.activeGimmicks,
          codeVersion: state.codeVersion || 'unknown',
          // The tiling's own certified opener — the container centre is an
          // unrelated slot here (issue #195).
          firstClick: tilingBuilt.firstClick,
        });
        Object.assign(fallbackPayload, missionStamp(tilingBuilt.mission));
        saveDailyBoard(state.dailySeed, fallbackPayload)
          .catch(err => reportCaughtError('daily-board-save', err));
      }
    } else {
      // Fall through to local generation (this is the existing path —
      // we'll write the result back to Firebase below). Resolve effective
      // seed via the candidate-selection helper.
      state.dailyRngSeed = selectDailyRngSeed(state.dailySeed);

      const dailyRng = createDailyRNG(state.dailyRngSeed);
      const dimRng1 = dailyRng();
      const dimRng2 = dailyRng();
      const dimRng3 = dailyRng();
      state.rows = DAILY_MIN_SIZE + Math.floor(dimRng1 * DAILY_SIZE_RANGE);
      state.cols = DAILY_MIN_SIZE + Math.floor(dimRng2 * DAILY_SIZE_RANGE);
      const density = DAILY_MIN_DENSITY + dimRng3 * DAILY_DENSITY_RANGE;
      state.totalMines = Math.max(5, Math.round(state.rows * state.cols * density));

      const fixedRowGen = Math.floor(state.rows / 2);
      const fixedColGen = Math.floor(state.cols / 2);
      const boardRng = createDailyRNG(state.dailyRngSeed);
      state.board = generateBoard(state.rows, state.cols, state.totalMines, fixedRowGen, fixedColGen, boardRng);
      cleanSolverArtifacts(state.board);

      // The winning seed already encodes which mission slot won. Recover
      // the mission so we force-inject the same gimmick (and respect the
      // single-gimmick constraint for coverage slots) the selection
      // routine evaluated against. Without this, the play board would
      // get a force-injected primary gimmick even when a coverage slot
      // won — and the picked board would no longer be the picked board.
      const dailyMission = getMissionForSeed(state.dailyRngSeed);
      const forcedDailyGimmick = getTargetGimmickName(dailyMission.target);
      const dailyGimmicks = getDailyGimmick(
        state.dailyRngSeed, createDailyRNG, forcedDailyGimmick, dailyMission.singleOnly,
      );
      state.activeGimmicks = dailyGimmicks.length > 0 ? dailyGimmicks : [];

      // Capped retry loop with two relaxation tiers:
      //   - Attempts 0..LOAD_BEARING_BUDGET: require board solvable AND every
      //     non-mystery modifier load-bearing. Mirrors the precompute filter.
      //   - Attempts LOAD_BEARING_BUDGET..MAX_DAILY_ATTEMPTS: drop the
      //     load-bearing requirement; just need solvable.
      //   - At MAX_DAILY_ATTEMPTS: strip modifiers entirely and break (matches
      //     the "Daily strips gimmicks if unsolvable" contract). Logged so a
      //     persistent failure shows up in the console for triage.
      // Capped (vs the prior unbounded loop) so a degenerate seed can't hang
      // the page waiting for solvability that will never come.
      const LOAD_BEARING_BUDGET = 25;
      const MAX_DAILY_ATTEMPTS = 100;
      let solvedDaily = false;
      for (let dAttempt = 0; dAttempt < MAX_DAILY_ATTEMPTS; dAttempt++) {
        if (dAttempt > 0) {
          const retryRng = createDailyRNG(state.dailyRngSeed + '-retry-' + dAttempt);
          state.board = generateBoard(state.rows, state.cols, state.totalMines, fixedRowGen, fixedColGen, retryRng);
          cleanSolverArtifacts(state.board);
        }
        if (state.activeGimmicks.length > 0) {
          const gimmickApplyRng = createDailyRNG(state.dailyRngSeed + '-gimmick-apply-' + dAttempt);
          state.gimmickData = applyGimmicks(state.board, 1, state.activeGimmicks, gimmickApplyRng);
        }
        const checkRetry = isBoardSolvable(state.board, state.rows, state.cols, fixedRowGen, fixedColGen);
        cleanSolverArtifacts(state.board);
        if (!(checkRetry.solvable || checkRetry.remainingUnknowns === 0)) continue;
        if (dAttempt < LOAD_BEARING_BUDGET && state.activeGimmicks.length > 0) {
          const decorative = findDecorativeGimmicks(
            state.board, state.rows, state.cols, fixedRowGen, fixedColGen, state.activeGimmicks,
          );
          if (decorative.length > 0) continue;
        }
        solvedDaily = true;
        break;
      }
      if (!solvedDaily) {
        // Strip modifiers and generate a plain board — but VERIFY it.
        // generateBoard's terminal fallback returns its best-effort
        // (possibly unsolvable) board, and this path writes to Firebase
        // as the canonical board for every player on this date — the one
        // place an unverified ship would break the no-guess contract for
        // everyone at once. Gimmick-free boards at daily density certify
        // within a try or two; the bound only prevents a hang.
        console.warn('Daily local-gen exhausted retries; stripping modifiers for', state.dailyRngSeed);
        state.activeGimmicks = [];
        state.gimmickData = {};
        let stripCertified = false;
        for (let sAttempt = 0; sAttempt < 50; sAttempt++) {
          const stripRng = createDailyRNG(state.dailyRngSeed + '-strip-final-' + sAttempt);
          state.board = generateBoard(state.rows, state.cols, state.totalMines, fixedRowGen, fixedColGen, stripRng);
          cleanSolverArtifacts(state.board);
          const stripCheck = isBoardSolvable(state.board, state.rows, state.cols, fixedRowGen, fixedColGen);
          cleanSolverArtifacts(state.board);
          if (stripCheck.solvable || stripCheck.remainingUnknowns === 0) { stripCertified = true; break; }
        }
        if (!stripCertified) {
          reportCaughtError('daily-strip-unverified', new Error(`seed=${state.dailyRngSeed}`));
        }
      }

      // Write our generated board to Firebase. Write-once rules at the
      // server reject duplicates silently; if someone else just wrote
      // first we keep playing our local board (rare race; if it happens
      // the two boards likely match anyway because clients on the same
      // code+target produce the same seed). Fire-and-forget — no need
      // to block rendering on the round-trip.
      if (wantCanonical) {
        const fallbackPayload = serializeBoard({
          board: state.board, rows: state.rows, cols: state.cols,
          totalMines: state.totalMines, rngSeed: state.dailyRngSeed,
          activeGimmicks: state.activeGimmicks,
          codeVersion: state.codeVersion || 'unknown',
        });
        // Stamp the mission INTO the payload so consumers (Greg's Field
        // Note) never re-derive it from the seed's slot index against an
        // experimentTarget.json that may have been refit since generation.
        // Shared with the precompute's buildCanonicalPayload via missionStamp
        // so the two writers describe a board the same way.
        Object.assign(fallbackPayload, missionStamp(dailyMission));
        saveDailyBoard(state.dailySeed, fallbackPayload)
          .catch(err => reportCaughtError('daily-board-save', err));
      }
    }

    state.revealedCount = 0;
    state.firstClick = false;
    state.status = 'idle';

    // The certified opener. A canonical board carries it from deserializeBoard
    // — the ONE definition shared with the Node consumers (nightly sweep,
    // repair, backfill): the stored firstClick on a tiling, the container
    // centre on every rectangle. Re-deriving floor(rows/2), floor(cols/2)
    // here anchored the solve on an unrelated container slot of a tiling
    // canonical (measured: 12 of 18 round-trips diverge, all 12 stall at
    // click 1, par off by up to 22% — issue #195), so features/par/moves
    // came off a failed solve with no error anywhere. A locally generated
    // tiling board carries its builder's opener for the same reason; a
    // locally generated rectangle was generated around the container centre
    // above, which stays its opener.
    const dailyOpener = reconstructed
      ? reconstructed.firstClick
      : tilingBuilt
        ? tilingBuilt.firstClick
        : Math.floor(state.rows / 2) * state.cols + Math.floor(state.cols / 2);
    const fixedRow = Math.floor(dailyOpener / state.cols);
    const fixedCol = dailyOpener % state.cols;

    // Run the solver on the resolved board (canonical or freshly-
    // generated) for features + par + best-start cell.
    const check = isBoardSolvable(state.board, state.rows, state.cols, fixedRow, fixedCol);
    cleanSolverArtifacts(state.board);
    state.dailyFeatures = computeDailyFeatures(state, check, {
      // The certified opener: the contribution features strip-solve from the
      // same anchor the certificate and par features use. Paid once per FINAL
      // board, never in the candidate loops.
      contributionOpener: { row: fixedRow, col: fixedCol },
    });
    state.dailyPar = predictPar(state.dailyFeatures);
    state.dailyMoves = check.totalClicks;
    saveDailyPar(state.dailySeed, state.dailyPar, state.dailyMoves, state.dailyFeatures);

    // Compute best starting cell for "Start here" indicator.
    const nbrCache = buildNeighborCache(state.board, state.rows, state.cols);
    const startCandidates = [];
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        if (!state.board[r][c].isMine && !state.board[r][c].isLocked) {
          startCandidates.push({ r, c, adj: state.board[r][c].adjacentMines });
        }
      }
    }
    const zeroFirst = startCandidates.filter(c => c.adj === 0);
    const nonZero = startCandidates.filter(c => c.adj > 0);
    const ordered = [...zeroFirst, ...nonZero];

    let bestStart = null;
    let bestStartUnknowns = Infinity;
    let bestStartCheck = null;
    for (const cand of ordered) {
      const result = isBoardSolvable(state.board, state.rows, state.cols, cand.r, cand.c, nbrCache);
      if (result.solvable && result.remainingUnknowns === 0) {
        bestStart = cand;
        bestStartCheck = result;
        break;
      }
      if (result.remainingUnknowns < bestStartUnknowns) {
        bestStartUnknowns = result.remainingUnknowns;
        bestStart = cand;
      }
    }
    cleanSolverArtifacts(state.board);
    // The Certified chip's claim is "solvable without guessing from the
    // marked start", so the certificate is the marked start's OWN full
    // solve — not the center check above, which feeds features/par. A
    // board with no full-solve anchor stamps nothing (chip absent).
    state.boardCertificate = certificateFromCheck(bestStartCheck);
    state.revealedCount = 0;
    if (bestStart) {
      state.board[bestStart.r][bestStart.c].suggestedStart = true;
    }
    setDailySuggestedCell(bestStart);
  }

  // Weekly mode: same canonical-board pattern as daily, but using
  // weeklyBoard/{weekStart} for the whole-week board, getWeeklyGimmicks
  // for the 2–4 stacked modifier pool, and selectWeeklyRngSeed for
  // candidate scoring (gimmick count + advanced-logic-moves tiebreaker).
  // Reset weekly per-attempt fields so the bomb-hit handler tracks
  // this attempt cleanly.
  state.weeklyBombHits = 0;
  state.weeklyBombHitEvents = [];
  if (state.gameMode === 'weekly' && state.weeklySeed) {
    let reconstructed = null;
    try {
      let canonicalRaw = null;
      if (state.canonicalWeeklyBoard
          && state.canonicalWeeklyBoard.weekStart === state.weeklySeed
          && state.canonicalWeeklyBoard.raw) {
        canonicalRaw = state.canonicalWeeklyBoard.raw;
      } else {
        canonicalRaw = await loadWeeklyBoard(state.weeklySeed);
        if (staleRun()) return; // a newer newGame superseded this run mid-fetch
        if (canonicalRaw) {
          state.canonicalWeeklyBoard = { weekStart: state.weeklySeed, raw: canonicalRaw };
        }
      }
      if (canonicalRaw) reconstructed = deserializeBoard(canonicalRaw);
    } catch (err) {
      console.warn('weekly canonical load/deserialize failed, regenerating:', err.message);
    }

    if (reconstructed) {
      state.weeklyRngSeed = reconstructed.rngSeed || state.weeklySeed;
      state.rows = reconstructed.rows;
      state.cols = reconstructed.cols;
      state.totalMines = reconstructed.totalMines;
      state.board = reconstructed.board;
      state.activeGimmicks = reconstructed.activeGimmicks || [];
      state.gimmickData = {};
    } else {
      // Fall back to local generation. Same retry pattern as daily.
      state.weeklyRngSeed = selectWeeklyRngSeed(state.weeklySeed);
      const wRng = createDailyRNG(state.weeklyRngSeed);
      const dim1 = wRng();
      const dim2 = wRng();
      const dim3 = wRng();
      state.rows = WEEKLY_MIN_SIZE + Math.floor(dim1 * WEEKLY_SIZE_RANGE);
      // Cap cols at BOARD_WIDTH_CAP (12). Rows can still grow up to 14.
      state.cols = Math.min(WEEKLY_MIN_SIZE + Math.floor(dim2 * WEEKLY_SIZE_RANGE), BOARD_WIDTH_CAP);
      const density = DAILY_MIN_DENSITY + dim3 * DAILY_DENSITY_RANGE;
      state.totalMines = Math.max(5, Math.round(state.rows * state.cols * density));

      const fr = Math.floor(state.rows / 2);
      const fc = Math.floor(state.cols / 2);
      const boardRng = createDailyRNG(state.weeklyRngSeed);
      state.board = generateBoard(state.rows, state.cols, state.totalMines, fr, fc, boardRng);
      cleanSolverArtifacts(state.board);

      const weeklyGimmicks = getWeeklyGimmicks(state.weeklyRngSeed, createDailyRNG);
      state.activeGimmicks = weeklyGimmicks.length > 0 ? weeklyGimmicks : [];

      // Same capped + tiered retry as the daily loop above. Weekly stacks
      // 2–4 modifiers so load-bearing has more types to cover; the relax
      // tier exists for the rare case where the seed can't satisfy all of
      // them simultaneously.
      const LOAD_BEARING_BUDGET_W = 25;
      const MAX_WEEKLY_ATTEMPTS = 100;
      let solvedWeekly = false;
      for (let dAttempt = 0; dAttempt < MAX_WEEKLY_ATTEMPTS; dAttempt++) {
        if (dAttempt > 0) {
          const retryRng = createDailyRNG(state.weeklyRngSeed + '-retry-' + dAttempt);
          state.board = generateBoard(state.rows, state.cols, state.totalMines, fr, fc, retryRng);
          cleanSolverArtifacts(state.board);
        }
        if (state.activeGimmicks.length > 0) {
          const gRng = createDailyRNG(state.weeklyRngSeed + '-gimmick-apply-' + dAttempt);
          state.gimmickData = applyGimmicks(state.board, 1, state.activeGimmicks, gRng);
        }
        const checkRetry = isBoardSolvable(state.board, state.rows, state.cols, fr, fc);
        cleanSolverArtifacts(state.board);
        if (!(checkRetry.solvable || checkRetry.remainingUnknowns === 0)) continue;
        if (dAttempt < LOAD_BEARING_BUDGET_W && state.activeGimmicks.length > 0) {
          const decorative = findDecorativeGimmicks(
            state.board, state.rows, state.cols, fr, fc, state.activeGimmicks,
          );
          if (decorative.length > 0) continue;
        }
        solvedWeekly = true;
        break;
      }
      if (!solvedWeekly) {
        // Same verified-strip discipline as the daily fallback: this
        // board becomes canonical for the whole week, so it must be
        // certified, not best-effort.
        console.warn('Weekly local-gen exhausted retries; stripping modifiers for', state.weeklyRngSeed);
        state.activeGimmicks = [];
        state.gimmickData = {};
        let stripCertified = false;
        for (let sAttempt = 0; sAttempt < 50; sAttempt++) {
          const stripRng = createDailyRNG(state.weeklyRngSeed + '-strip-final-' + sAttempt);
          state.board = generateBoard(state.rows, state.cols, state.totalMines, fr, fc, stripRng);
          cleanSolverArtifacts(state.board);
          const stripCheck = isBoardSolvable(state.board, state.rows, state.cols, fr, fc);
          cleanSolverArtifacts(state.board);
          if (stripCheck.solvable || stripCheck.remainingUnknowns === 0) { stripCertified = true; break; }
        }
        if (!stripCertified) {
          reportCaughtError('weekly-strip-unverified', new Error(`seed=${state.weeklyRngSeed}`));
        }
      }

      // Write our generated weekly board to Firebase. Write-once rules
      // silently no-op duplicates, so a slow first-visitor on Monday
      // morning racing the precompute workflow is harmless — whichever
      // wins, the rest of the week sees that board.
      saveWeeklyBoard(state.weeklySeed, serializeBoard({
        board: state.board, rows: state.rows, cols: state.cols,
        totalMines: state.totalMines, rngSeed: state.weeklyRngSeed,
        activeGimmicks: state.activeGimmicks,
        codeVersion: state.codeVersion || 'unknown',
      })).catch(err => reportCaughtError('weekly-board-save', err));
    }

    state.revealedCount = 0;
    state.firstClick = false;
    state.status = 'idle';

    // Same certified-opener contract as the daily branch above (issue #195):
    // a canonical board's opener comes from deserializeBoard, a locally
    // generated one keeps the container centre it was generated around.
    const weeklyOpener = reconstructed
      ? reconstructed.firstClick
      : Math.floor(state.rows / 2) * state.cols + Math.floor(state.cols / 2);
    const fixedRow = Math.floor(weeklyOpener / state.cols);
    const fixedCol = weeklyOpener % state.cols;

    // Compute features once on canonical resolve. Used by the
    // first-attempt fit-data submit in winLossHandler. Weekly doesn't
    // ship a par to the player (no PAR_MODEL training on memorized
    // boards), but we still need the feature vector so the FIRST
    // attempt of the week — which IS an honest first encounter — can
    // contribute to the next R refit via the daily/{weekStart}_weekly_first
    // synthetic-daily path.
    const wcheck = isBoardSolvable(state.board, state.rows, state.cols, fixedRow, fixedCol);
    cleanSolverArtifacts(state.board);
    state.weeklyFeatures = computeDailyFeatures(state, wcheck, {
      contributionOpener: { row: fixedRow, col: fixedCol },
    });

    // Pre-fetch the player's existing weekly row from Firebase so the
    // win handler can compute bestTime correctly. If we're offline or
    // the player is new this week, weeklyDayTimes stays empty.
    if (state.firebaseReady) {
      try {
        const entries = await fetchWeeklyLeaderboard(state.weeklySeed);
        if (staleRun()) return; // a newer newGame superseded this run mid-fetch
        const myUid = getUid();
        const myRow = myUid ? entries.find(e => e.uid === myUid) : null;
        state.weeklyDayTimes = myRow?.dayTimes ? { ...myRow.dayTimes } : {};
        state.weeklyDayBombHits = myRow?.dayBombHits ? { ...myRow.dayBombHits } : {};
      } catch (err) {
        if (staleRun()) return;
        state.weeklyDayTimes = {};
        state.weeklyDayBombHits = {};
      }
    }

    // Best-start cell for the Start-here label, same as daily.
    const nbrCache = buildNeighborCache(state.board, state.rows, state.cols);
    const startCandidates = [];
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        if (!state.board[r][c].isMine && !state.board[r][c].isLocked) {
          startCandidates.push({ r, c, adj: state.board[r][c].adjacentMines });
        }
      }
    }
    const zeroFirst = startCandidates.filter(c => c.adj === 0);
    const nonZero = startCandidates.filter(c => c.adj > 0);
    const ordered = [...zeroFirst, ...nonZero];

    let bestStart = null;
    let bestStartUnknowns = Infinity;
    let bestStartCheck = null;
    for (const cand of ordered) {
      const result = isBoardSolvable(state.board, state.rows, state.cols, cand.r, cand.c, nbrCache);
      if (result.solvable && result.remainingUnknowns === 0) {
        bestStart = cand;
        bestStartCheck = result;
        break;
      }
      if (result.remainingUnknowns < bestStartUnknowns) {
        bestStartUnknowns = result.remainingUnknowns;
        bestStart = cand;
      }
    }
    cleanSolverArtifacts(state.board);
    // Same contract as daily: the certificate is the marked start's own
    // full solve, or nothing.
    state.boardCertificate = certificateFromCheck(bestStartCheck);
    state.revealedCount = 0;
    if (bestStart) {
      state.board[bestStart.r][bestStart.c].suggestedStart = true;
    }
    setDailySuggestedCell(bestStart);
  }

  // Load per-mode power-ups
  const modePU = loadModePowerUps(state.gameMode);
  const emptyPU = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
  // Par Lab boards run on EMPTY inventory: a power-up (or an auto-consumed
  // lifeline on a mine hit) turns a measured solve time into a measurement
  // of the inventory. The two saveModePowerUps sites in winLossHandler are
  // parLab-guarded so these zeros can never persist over the player's real
  // challenge inventory.
  if (state.gameMode === 'timed' || state.gameMode === 'daily' || state.gameMode === 'weekly' || state.gameMode === 'chaos' || state.parLab) {
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

  // Gimmicks / modifiers: reset here ONLY for modes that resolve them on the
  // first click (challenge / timed / chaos). Daily/weekly canonical boards and
  // coastline tiling boards resolve their modifiers during pre-generation (the
  // branches above already set activeGimmicks / gimmickData), so wiping here
  // would leave the active-modifier bar empty on a board that has modifiers.
  if (!modifiersPreResolved(state.gameMode, state.coastlinePractice)) {
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
  // Render wall overlays NOW for daily mode (board is fully generated before
  // first click). Challenge / chaos render walls inside their first-click
  // handler since gimmicks aren't applied until then.
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

  // Clear saved game state for current mode (new game = fresh start)
  clearGameState(state.gameMode);

  // Board transition animation when size changes
  if (state._initialized && (prevRows !== state.rows || prevCols !== state.cols)) {
    boardEl.classList.add('board-transition');
    setTimeout(() => boardEl.classList.remove('board-transition'), 600);
  }

  // Show level info toast on new game (except first load). On the
  // Challenge 250 ladder this IS the pre-level card: it names the shape
  // and carries the expected time (personalPar for the board just drawn,
  // handicap-adjusted) — a pace cue, never a target the game enforces.
  if (state._initialized && state.gameMode === 'chaos') {
    const chaosRound = state.chaosRound || 1;
    showLevelInfoToast(chaosRound, diff, 'Round ' + chaosRound);
  } else if (state._initialized && (state.gameMode === 'normal' || state.gameMode === 'timed')) {
    const label = diff.label ? `${diff.label}` : null;
    let card = diff;
    let expected = '';
    if (state.gameMode === 'normal' && !state.coastlinePractice) {
      const spec = state.challengeSpec;
      if (spec) {
        card = {
          ...diff,
          mines: state.totalMines,
          shapeLabel: spec.shape === 'rect' ? CLASSIC_SHAPE_LABEL : tilingLabel(spec.shape),
        };
      }
      if (state.challengePar > 0) {
        expected = expectedTimeLine(personalPar(state.challengePar, getUid()));
      }
    }
    showLevelInfoToast(state.currentLevel, card, label, expected);
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
      m.showToast('Unlock neighbors first!', 1500, 'modLocked');
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

  // Past every intercept — this click is a real reveal action. Recorded
  // BEFORE processing so a bomb hit still logs the click that caused it.
  recordPlayerAction('r', row, col);

  // First click — generate board (timed and chaos only). Challenge 250,
  // daily, weekly, and coastline boards are FROZEN at newGame (their
  // branches set firstClick = false), so this branch never sees them.
  if (state.firstClick) {
    state.activeGimmicks = [];
    state.gimmickData = {};

    // Both remaining modes generate a plain base from the actual first
    // click; chaos rolls its modifiers AFTER this loop, outside the
    // certification contract (its chip says "No guarantees").
    let acceptedCheck = null;
    for (;;) {
      state.board = generateBoard(state.rows, state.cols, state.totalMines, row, col, Math.random, {});
      const check = isBoardSolvable(state.board, state.rows, state.cols, row, col);
      cleanSolverArtifacts(state.board);
      if (check.solvable || check.remainingUnknowns === 0) {
        acceptedCheck = check;
        break;
      }
    }

    // Flags placed before the first click sat on the PLACEHOLDER board
    // (createEmptyBoard renders plain fog until this click generates the
    // real layout), and generateBoard returns fresh cell objects — those
    // flags are gone. The counter must die with them or the mine counter
    // reads totalMines - N for the whole game; the full-cell re-render
    // clears any stale flag icons off the replaced cells (chaos re-renders
    // again after gimmicks apply; timed has no other full pass).
    state.flagCount = 0;
    updateAllCells();

    // Stamp the no-guess certificate from the accepted check — the
    // contract here runs from the player's ACTUAL first click. Chaos is
    // excluded: its modifiers are applied AFTER this loop without
    // re-verification, so the base-board check certifies nothing about
    // the board the player ends up on.
    if (state.gameMode === 'timed') {
      state.boardCertificate = certificateFromCheck(acceptedCheck);
      updateActiveGimmickBar();
    }

    // Timed mode: compute features + par for THIS board (same PAR_MODEL
    // as daily — timed boards are gimmick-free, so the gimmick terms are
    // simply zero). Powers the par-relative rating on the win modal and
    // the timed/{pushId} submission that will eventually feed the fit.
    if (state.gameMode === 'timed') {
      try {
        const tcheck = isBoardSolvable(state.board, state.rows, state.cols, row, col);
        cleanSolverArtifacts(state.board);
        state.timedFeatures = computeDailyFeatures(state, tcheck);
        // Mode indicator rides IN the feature vector, so submitted timed
        // rows carry it and the R refit reads it straight off features.
        state.timedFeatures.modeTimed = 1;
        state.timedPar = predictPar(state.timedFeatures);
      } catch (err) {
        state.timedFeatures = null;
        state.timedPar = 0;
        reportCaughtError('timed-par-compute', err);
      }
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
          if (!def) return '';
          const iconHtml = gimmickSpriteImgHTML(g, 'sprite-gimmick', def.name) || def.icon || '';
          return '<span class="chaos-mod-icon" title="' + def.name + '">' + iconHtml + '</span>';
        }).join('');
      }
      // Refresh all cells to show modifier indicators
      updateAllCells();
      renderWallOverlays();
    }

    state.firstClick = false;
    state.status = 'playing';
    startTimer();

  } else if (state.status === 'idle' && (state.gameMode === 'daily' || state.gameMode === 'weekly'
      || state.gameMode === 'normal' || state.coastlinePractice)) {
    // Daily / weekly / challenge / coastline: the board is FROZEN. It
    // never mutates, so a daily's players all play the identical layout
    // and the submitted features always describe the board that was
    // actually played. The marked start cell is the certified safe entry;
    // a first click that ignores it and lands on a mine is on the player,
    // by design (decided 2026-06-12) — on daily/weekly it falls through
    // to the bomb-hit strike path below, on the challenge ladder it is a
    // classic loss (lifelines apply, never strikes — the C250 ruling).
    state.status = 'playing';
    startTimer();

    // Weekly: commit the attempt on first click. Without this, a player
    // could hit a mine (which doesn't end the game — just adds 10s and
    // re-fogs), smash the smiley, and get a fresh attempt for today —
    // bypassing the bomb-time-penalty mechanic. Marking on first click
    // means the slot is consumed the moment the player commits to a
    // play, regardless of whether they reset, hit bombs, or finish.
    // Idempotent — re-marking the same day is a no-op on Firebase.
    if (state.gameMode === 'weekly' && state.weeklySeed != null && state.weeklyDay != null
        && !isTestEnvironment()) {
      markWeeklyDayAttempted(state.weeklySeed, state.weeklyDay);
      if (!state.cachedWeeklyDayAttempts) state.cachedWeeklyDayAttempts = {};
      state.cachedWeeklyDayAttempts[state.weeklyDay] = true;
    }

    // Modifier intro: full card only for modifiers the player hasn't met
    // yet (mark them seen), and a single compact recap line for ones they
    // already know. No popup at all when everything on the board is
    // already familiar — the persistent active-modifier bar already
    // reminds them. The recap line is daily/weekly-only: on the ladder a
    // known modifier appears level after level, and a recap on every one
    // of them would be noise (the old challenge engine never recapped
    // either — first encounters only).
    if (state.activeGimmicks.length > 0 && !isModifierPopupDisabled()) {
      const recapWanted = state.gameMode === 'daily' || state.gameMode === 'weekly';
      const unseenDefs = [];
      const seenDefs = [];
      for (const g of state.activeGimmicks) {
        const def = getGimmickDef(g);
        if (!def) continue;
        const tagged = { ...def, _key: g };
        if (hasSeenGimmick(g)) {
          if (recapWanted) seenDefs.push(tagged);
        } else {
          markGimmickSeen(g);
          unseenDefs.push(tagged);
        }
      }
      if (unseenDefs.length > 0) {
        showGimmickIntros(unseenDefs, seenDefs);
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
      // handleWin is async (name gate) — label the rejection path so a
      // failure lands in errors/{uid} with a stable site tag instead of
      // an anonymous unhandledrejection.
      if (checkWin(state.board)) handleWin().catch(err => reportCaughtError('handle-win', err));
      return;
    }
    // Lifeline: passive save from mine death
    if (tryLifeline(row, col)) return;
    // Daily / weekly: bomb hit re-fogs and adds 10s instead of ending.
    // Without weekly here, a bomb hit drops the player to the loss
    // screen mid-attempt — and weekly forfeits that day's slot.
    if (mineIsStrike()) {
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
  revealWormholePairs(newlyRevealed);

  updateCells(newlyRevealed);
  updateHeader();
  updateCellsRemaining();

  // Activate pressure plate timers on newly revealed pressure plates
  for (const cell of newlyRevealed) {
    if (cell.isPressurePlate && !cell.plateDisarmed) {
      startPressurePlateTimer(cell);
    }
  }

  // Hatch any worm eggs the reveal uncovered (pair/cascade cells are
  // already folded into the batch by revealWormholePairs above)
  hatchWormEggs(newlyRevealed);

  if (checkWin(state.board)) handleWin().catch(err => reportCaughtError('handle-win', err));
}

// ── Pressure Plate Timer ────────────────────────────────

const activePlates = new Map(); // cell -> timerId

// Re-arm timers on revealed, undisarmed plates after a save restore.
// startPressurePlateTimer was only ever called from the live reveal
// path, so a resumed game showed armed plates with no timer at all
// (and they never detonated). Fresh estimate from the current board -
// resuming resets the countdown, the lenient direction.
export function rearmPlateTimers() {
  if (!state.board || state.status !== 'playing') return;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = state.board[r][c];
      if (cell.isPressurePlate && !cell.plateDisarmed && cell.isRevealed) {
        if (cell.row == null) { cell.row = r; cell.col = c; }
        if (!activePlates.has(cell)) startPressurePlateTimer(cell);
      }
    }
  }
}

// Teardown for every path that LEAVES the board without starting a new
// game (issue #192): showTitleScreen (Home button) and switchMode both
// call this, because neither changes state.status — the tick's own
// `status !== 'playing'` guard never fires on those paths, and the
// deadline is raw wall-clock, so an orphaned plate detonated on the
// title screen (loss recorded, save cleared, the explaining modal
// unrenderable inside the hidden #app) or mid-way through whatever game
// was loaded next. Also the safety net for winLossHandler's
// handleDailyBombHit refog path. Re-arming on resume is
// rearmPlateTimers' job, with a fresh countdown — the lenient direction.
export function clearAllPlateTimers() {
  for (const id of activePlates.values()) clearInterval(id);
  activePlates.clear();
}

// Test-only visibility into the module-private interval map, so the
// lifecycle regression tests (test/plateTimerLifecycle.test.mjs) can
// assert teardown actually happened rather than inferring it from
// side effects that take seconds to fire.
export function countActivePlateTimers() {
  return activePlates.size;
}

function startPressurePlateTimer(cell) {
  // Idempotent: a doubly-armed plate would stack a second interval the
  // Map overwrite then leaks forever. Whatever path calls this twice
  // (reveal + rearm + chord), only the first arms.
  if (activePlates.has(cell)) return;
  let cellEl = boardEl.children[cell.row * state.cols + cell.col];
  if (!cellEl) return;

  cellEl.classList.add('plate-active');

  // Add timer bar
  const timerBar = document.createElement('div');
  timerBar.className = 'plate-timer';
  cellEl.appendChild(timerBar);

  // Par-calibrated timer: Pass-A-resolvable work at the classic
  // per-step rate, plus each target needing subset/tank reasoning
  // billed at the par model's fitted tier price (plateSeconds).
  const est = estimatePlateMovesToDisarm(state.board, cell.row, cell.col);
  const dynamicTime = plateSeconds(est);
  cell.plateTimer = dynamicTime;
  let remaining = dynamicTime;
  const startTime = Date.now();

  const tick = setInterval(() => {
    if (state.status !== 'playing') {
      clearInterval(tick);
      activePlates.delete(cell);
      return;
    }
    // Identity guard (issue #192): this interval must only ever act on the
    // board its cell belongs to. If the live board no longer holds THIS
    // cell object at these coords — a mode switch resumed a different
    // game, a new board replaced this one — the plate is an orphan and
    // self-destructs instead of detonating someone else's game. The
    // teardown calls in newGame/switchMode/showTitleScreen should make
    // this unreachable; it exists so no future caller has to remember.
    if (state.board?.[cell.row]?.[cell.col] !== cell) {
      clearInterval(tick);
      activePlates.delete(cell);
      return;
    }

    // Self-heal: any board re-render (updateAllCells, a magnet pull, a
    // theme change) rebuilds the cell element and silently destroys the
    // bar while this interval keeps ticking - the deadline must never
    // run invisibly. Re-attach to the live element when that happens.
    const liveEl = boardEl.children[cell.row * state.cols + cell.col];
    if (liveEl && liveEl !== cellEl) {
      cellEl = liveEl;
    }
    if (cellEl && !cellEl.contains(timerBar)) {
      cellEl.classList.add('plate-active');
      cellEl.appendChild(timerBar);
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
      import('../ui/toastManager.js').then(m => m.showToast('Plate disarmed!', 1200, 'uiSuccess'));
      return;
    }

    if (remaining <= 0) {
      clearInterval(tick);
      activePlates.delete(cell);
      // Plate detonates! Try lifeline first, then game over
      if (tryLifeline(cell.row, cell.col)) return;
      handleLoss(cell.row, cell.col);
    }
  }, 200);

  activePlates.set(cell, tick);
}

function checkPlateDisarmed(cell) {
  // Disarmed when all non-mine adjacent cells are revealed. Reads the same
  // demand region the par estimator prices (plateDisarmCells), so the
  // countdown can never be timed for a different job than this one, and a
  // plate on a tiling polls the cells it actually touches.
  const rows = state.board.length;
  const cols = state.board[0].length;
  for (const ni of plateDisarmCells(state.board, rows, cols, cell.row, cell.col)) {
    const n = cellAt(state.board, cols, ni);
    if (!n.isMine && !n.isRevealed) return false;
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
      m.showToast('Unlock neighbors first!', 1500, 'modLocked');
    });
    return;
  }

  const wasFlagged = cell.isFlagged;
  cell.isFlagged = !cell.isFlagged;
  state.flagCount += cell.isFlagged ? 1 : -1;
  recordPlayerAction(cell.isFlagged ? 'f' : 'u', row, col);
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
  // Strike cells are defused-bomb markers, not numbered safe cells.
  // Chord-revealing from them can cascade into a neighboring
  // unrevealed mine and fire another handleDailyBombHit — the
  // "click an already-exploded mine for more penalty" footgun.
  // The re-fog after each bomb hit already keeps mines hidden, but
  // a stale chord-tap on a strike cell while a neighbor's still
  // exposed (e.g., during animation, or a player who flagged the
  // wrong neighbor) would still cascade. Block it here unconditionally.
  const cellHere = state.board[row]?.[col];
  if (cellHere && cellHere.isStrike) return;
  const now = Date.now();
  if (now - _lastInputTime < 50) return;
  _lastInputTime = now;
  const result = chordReveal(state.board, row, col);
  if (!result || !result.revealed) return;
  recordPlayerAction('c', row, col);

  state.revealedCount += result.revealed.filter(c => !c.isMine).length;

  // A chord can expose MORE than one mine (two wrong flags around a
  // satisfied number — chordReveal keeps revealing past the first mine).
  // Daily/weekly charge EVERY exposed mine as its own strike (the intel is
  // real, so the price is too — each stays revealed as a strike marker and
  // gets its own marginal info-value + ramped base). Challenge/timed/chaos
  // keep the re-fog: one lifeline/loss on the first mine, the rest go back
  // under the fog so a survived chord never grants free intel (the
  // 2026-07-10 audit's original fix, still the right economy where a
  // revealed mine means death rather than a priced strike).
  const isStrikeMode = mineIsStrike();
  let primaryMine = null;
  let chordStrikes = null;
  if (result.hitMine) {
    if (isStrikeMode) {
      chordStrikes = result.revealed.filter(c => c.isMine);
    } else {
      primaryMine = unrevealChordMines(result.revealed);
    }
  }

  // Wormhole: revealing one side reveals the paired cell too
  revealWormholePairs(result.revealed);

  // Strike marking must precede the paint: handleDailyBombHit
  // synchronously prices and stamps isStrike on every chord mine, so
  // updateCells below renders them as strike markers, never as bare mines.
  if (chordStrikes && chordStrikes.length > 0) {
    handleDailyBombHit(
      chordStrikes[0].row, chordStrikes[0].col,
      chordStrikes.slice(1).map(c => ({ row: c.row, col: c.col })),
    );
  }

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

  // Activate plates revealed BY THE CHORD - chording is a separate
  // reveal path that never ran the plate-activation loop, so chord-
  // revealed plates sat armed with no timer and never detonated.
  if (!result.hitMine) {
    for (const c of result.revealed) {
      if (c.isPressurePlate && !c.plateDisarmed && !c.isMine) {
        startPressurePlateTimer(c);
      }
    }
  }

  // Hatch chord-revealed worm eggs. Deliberately NOT gated on hitMine:
  // a daily/weekly strike-chord keeps its safe reveals on the board, and
  // the hatch filter skips mines and re-fogged cells on its own.
  hatchWormEggs(result.revealed);

  if (result.hitMine && primaryMine) {
    // Challenge/timed/chaos: every chord-exposed mine was un-revealed
    // above; only the primary proceeds through the lifeline/loss flow.
    if (tryLifeline(primaryMine.row, primaryMine.col)) {
      // Lifeline saved — continue playing
    } else {
      primaryMine.isRevealed = true;
      handleLoss(primaryMine.row, primaryMine.col);
    }
  } else if (!result.hitMine && checkWin(state.board)) {
    handleWin().catch(err => reportCaughtError('handle-win', err));
  }
  // Daily/weekly chord-strike wins are detected by finishBombHit (the
  // strike flow's teardown): a chord can reveal the board's last safe
  // cells in the same gesture that struck the mine, and no later action
  // exists to run win detection.
}
