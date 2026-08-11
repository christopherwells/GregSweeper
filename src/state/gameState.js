// ── Game State ──────────────────────────────────────────

export const state = {
  board: [],
  rows: 10,
  cols: 10,
  totalMines: 10,
  status: 'idle',       // idle | playing | won | lost | expired (date-anchored game lapsed at midnight ET)
  firstClick: true,
  flagCount: 0,
  revealedCount: 0,
  elapsedTime: 0,
  preciseTime: 0,    // precise time in seconds with tenths (e.g., 45.3)
  timerId: null,
  timeLimit: 0,         // countdown seconds for timed mode (0 = no limit)

  currentLevel: 1,
  gameMode: 'normal',   // normal | timed | daily | weekly | chaos
  dailySeed: null,
  // The effective RNG seed for the day's board generation. On normal
  // days this equals dailySeed (the YYYY-MM-DD date). On adaptive-
  // experiment days (see experimentDesign.js) it's a ":trialN" variant
  // chosen deterministically to push a targeted feature. Using a
  // separate field keeps dailySeed meaningful as the date identifier
  // (for Firebase keys, leaderboard joins, local storage lookups) while
  // letting all RNG creation during play route through the trial seed.
  dailyRngSeed: null,
  dailyBombHits: 0,
  // Per-hit log for today's daily: every bomb hit push-appends
  // { t: elapsedSeconds, row, col } so the backend can reconstruct the
  // player's effective solve path. A board with N bomb-defuses is a
  // different puzzle than the nominal one (free information revealed),
  // so a clean par fit needs to either exclude those plays or model
  // the bomb-adjusted path.
  dailyBombHitEvents: [],
  // Player click timeline for the CURRENT game: { t: elapsedSeconds,
  // r, c, a } with a = 'r' reveal | 'f' flag | 'u' unflag | 'c' chord.
  // The ground truth for honest player-grounded claims (receipts that
  // grade the player's ACTUAL clicks instead of narrating the solver's
  // canonical order, the skill-feat detections, the future
  // click-to-technique attribution question). Reset in newGame; capped
  // so a marathon session can't bloat the auto-persisted save.
  clickTimeline: [],
  // Lens invocations this game: { t: elapsedSeconds, kind } with kind =
  // 'flag-warning' | 'region'. Submitted with daily scores so the
  // nightly par fit can EXCLUDE hinted plays, hints change completion
  // times, and an uninstrumented hint system would quietly corrupt the
  // model the whole game stands on.
  // The no-guess certificate for the CURRENT board: { clicks, tier }.
  // clicks is the certifying solver run's totalClicks (entry click +
  // provable reveals); tier is the hardest technique on that path
  // (0/1 counting and subsets, 2 case-by-case enumeration, 3 liar
  // reasoning). Stamped from the bestStart full-solve check on daily /
  // weekly and from the accepted generation check on challenge / timed.
  // Null in chaos and on any board the solver did not certify, the
  // Certified chip just doesn't render rather than overclaim.
  boardCertificate: null,
  // Timed mode: par + feature vector for the CURRENT board, computed at
  // generation from the same PAR_MODEL as daily (timed boards are
  // gimmick-free, so gimmick terms are zero). Powers the par-relative
  // rating on the timed win modal and the timed/{pushId} submission.
  timedPar: 0,
  timedFeatures: null,
  dailyPar: 0,       // predicted time in seconds, predictPar(dailyFeatures)
  dailyMoves: 0,     // solver totalClicks for pace calculation
  dailyFeatures: null, // full feature vector from computeDailyFeatures, used for par breakdown, Firebase meta upload, and the R refit training set
  isDailyPractice: false, // set when the URL carries ?seed=<custom>: play a custom-seed board but skip streak/completion/history side effects. Submissions still go to Firebase (under the custom seed path) so the session still tags a uid.
  isArchivePlay: false, // set when a PAST daily is replayed from the calendar: keeps the caller-set date, requires the canonical (no local-gen), never touches streak/completion, never persists, and submits to dailyArchive/ instead of daily/. See archiveEligibility.js + the Daily Archive section of CLAUDE.md.
  _archiveRaw: null, // { date, raw }, the past board the calendar fetched, handed to newGame so it doesn't refetch or pollute canonicalDailyBoard (today's stash).
  // The weekly's counterpart: a PAST week's canonical replayed from the "Past
  // weeklies" list. Keeps the caller-set weekStart, requires the canonical (no
  // local-gen, a regenerated past week would be a board nobody played),
  // consumes no daily attempt, never persists, and records nothing: no
  // leaderboard row, no first-attempt fit row, no week streak. The week it
  // belongs to is over and its record is already written.
  isWeeklyArchive: false,
  _weeklyArchiveRaw: null, // { weekStart, raw }

  powerUps: { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 },
  shieldActive: false,
  scanMode: false,
  xrayMode: false,
  magnetMode: false,
  usedPowerUps: false,  // track for purist achievement
  suggestedMove: null,  // post-death analysis: {row, col} or null

  shaking: false,
  showParticles: false,
  theme: 'classic',
  hitMine: null,  // {row, col} of the mine that killed you
  zoomLevel: 100,  // percentage (50-200)
  checkpoint: 1,   // last checkpoint level (every 5 levels)
  flagMode: false, // flag-mode toggle for mobile
  dirtyCells: new Set(), // track changed cells for targeted updates

  // Gimmicks (challenge mode)
  activeGimmicks: [],    // ['mystery', 'walls', ...]
  gimmickData: {},       // per-gimmick applied data
  mineShiftTimerId: null,
  // The shifter's cadence {interval, count} for THIS board. Game state rather
  // than a module variable in timerManager, so the restart memory dies with
  // the game that rolled the modifier, a paused Chaos round used to leave its
  // cadence behind and resume it on whatever game was loaded next, including a
  // canonical Daily (issue #238).
  mineShiftPlan: null,
  worms: [],             // live hatched worms [{segments, movesLeft, nextMoveMs}]
  wormTimerId: null,     // worm-crawl heartbeat interval id
  wormEvents: [],        // hatch log [{t, r, c, len, life, pace, moves, tEnd?}], submitted with scores
  // Test-build ?level= playtest runs: no stats, no progression, no
  // challenge save slot, no power-up earns (/test/ shares this origin's
  // localStorage with prod, so a playtest jump must never pollute it)
  isLevelPractice: false,
  // Test-env ?level=N&board=I: pick this bin index from the level's library
  // file instead of rolling the seen-cycle (deterministic e2e venues).
  // Practice-lane-only by construction; cleared wherever isLevelPractice is.
  climbBoardIndex: null,
  // Project Coastline (test-only, ?coastline=1): a frozen Archimedean-tiling
  // board played as an isLevelPractice run (records nothing). The flag routes
  // newGame's generation + revealCell's frozen first-click path onto the tiling
  // without introducing a new gameMode. UNREACHABLE in production, the deep
  // link is isTestEnvironment()-gated (mirrors ?level=).
  coastlinePractice: false,
  coastlineSeed: null,   // seed for the tiling board (stable across reloads)
  coastlineGimmicks: null, // modifier list to place on the tiling test board
  coastlineType: null,   // which tiling: '4.8.8' (default) or 'hex' (6.6.6)
  // Feature vector + par for the tiling board. Nothing submits them (a
  // coastline run records nothing); they exist so the par chain is exercised
  // and visible on a non-rectangular board. Kept in their OWN slots rather
  // than borrowing timedFeatures/timedPar, which come with a submission contract.
  coastlineFeatures: null,
  coastlinePar: 0,

  // Challenge 250 (the authored ladder). The level's spec re-derives from
  // currentLevel (challengeSpecForLevel) so it is never persisted; the
  // board SEED is the draw's identity, worm traits and the features'
  // wormLoad both key on it, so it must ride the save with the board.
  // Par/features are display + validation aids (challenge never submits
  // to the par fit).
  challengeSpec: null,
  challengeBoardSeed: null,
  challengeFeatures: null,
  challengePar: 0,
  inputLocked: false,    // true during cascade/chord animations

  // Chaos mode (roguelike runs)
  chaosRound: 0,          // current board number in the run (1-based)
  chaosModifiers: [],     // modifiers rolled for current board
  chaosTotalTime: 0,      // cumulative time across all boards in the run

  // Keyboard navigation
  focusedRow: 0,
  focusedCol: 0,

  // ── Startup-gate state ──────────────────────────────
  // Set by runStartupGate() in main.js before any board renders.
  // Without these, daily mode could fall through to local generation
  // on a Firebase cold-load race and produce a divergent board.
  //
  // codeVersion: the running SW's CACHE_NAME (e.g. 'gregsweeper-v1.5.31'),
  // populated via postMessage handshake. Used as forensic provenance
  // when writing canonical boards. Null until the SW responds.
  //
  // canonicalDailyBoard: { date, raw }, the canonical board for today
  // pre-fetched at boot. newGame() uses this verbatim instead of doing
  // its own loadDailyBoard call, so by construction every device on
  // the same ET date plays the same layout. Null when offline or when
  // today's canonical hasn't been written yet (first visitor of the day).
  //
  // canonicalWeeklyBoard: { weekStart, raw }, same idea but for the
  // weekly puzzle. One canonical board per ET week (Monday → Sunday),
  // pre-fetched at boot so the Weekly card opens without a round-trip.
  //
  // firebaseReady: true once the Firebase SDK has initialized and we
  // can call db.ref(). Read by score-submission and other Firebase-
  // dependent paths to gate behavior cleanly instead of hitting null.
  codeVersion: null,
  canonicalDailyBoard: null,
  canonicalWeeklyBoard: null,
  firebaseReady: false,

  // ── Weekly mode (per-attempt) ───────────────────────
  // The weekly puzzle is one board per ET week, with up to 7 attempts
  // (one per day Mon, Sun). All players see the same board for the
  // whole week; the leaderboard records each player's best time and
  // a per-day map. The first attempt a player makes on the week's
  // board doubles as par-model fit data (honest first encounter); days
  // 2-7 are speedruns and stay out of the fit.
  weeklySeed: null,                // 'YYYY-MM-DD' Monday in ET
  weeklyDay: null,                 // 0..6, which day's attempt is in progress
  weeklyRngSeed: null,             // canonical's resolved seed (e.g. '2026-05-04:trial1')
  weeklyBombHits: 0,               // for current attempt
  weeklyBombHitEvents: [],         // [{t, row, col}, ...] for current attempt
  weeklyDayTimes: {},              // {0: 45.2, 3: 50.1, ...} from Firebase on mode entry
  weeklyDayBombHits: {},           // {0: 1, 3: 0, ...} per-day strike counts from Firebase
  weeklyFeatures: null,            // computed at canonical resolve, used for the first-attempt fit-data submit
  cachedWeeklyDayAttempts: {},     // {0: true, 3: true} from Firebase at startup so the gate is sync
  cachedWeeklyAttemptsWeek: null,  // weekStart the cache above belongs to; lets a long-open session detect a week rollover and re-seed

  // ── Idle-pause state ─────────────────────────────────
  // Auto-pause the timer after 60s (timerManager's IDLE_PAUSE_MS) without
  // user input so a player who walks away doesn't bleed seconds into
  // their daily/weekly time.
  // `lastInteractionTime` is a Date.now() millis stamp, refreshed on
  // any pointerdown/keydown/throttled-pointermove. `idlePaused` flips
  // true when the gap exceeds the threshold and the overlay is showing.
  lastInteractionTime: 0,
  idlePaused: false,

  // True while a blocking popup (modifier intro, bomb-hit explainer)
  // has paused the timer. Resume paths (visibilitychange, idle
  // interaction) must NOT restart the clock while this is set, or the
  // timer ticks behind the modal, e.g. tab away during the bomb-hit
  // explainer and back resumes it mid-read. Cleared only when the popup
  // itself closes and explicitly resumes.
  modalPaused: false,
};

// Record one player action on the click timeline. t mirrors the
// bombHitEvents convention (clean wall-clock seconds, 1 decimal).
// Capped: drop-oldest beyond 2000 entries so a pathological session
// can't bloat the auto-persisted save, a full 14x14 game is ~200-400
// actions, so the cap never bites in real play.
const CLICK_TIMELINE_CAP = 2000;
export function recordPlayerAction(action, row, col) {
  if (!Array.isArray(state.clickTimeline)) state.clickTimeline = [];
  state.clickTimeline.push({
    t: Math.round((state.elapsedTime || 0) * 10) / 10,
    r: row, c: col, a: action,
  });
  if (state.clickTimeline.length > CLICK_TIMELINE_CAP) {
    state.clickTimeline.splice(0, state.clickTimeline.length - CLICK_TIMELINE_CAP);
  }
}

// Record one Lens invocation (same wall-clock convention as the click
// timeline). Tiny payload, hard cap as a safety net.

// Clear the ?coastline= tiling-practice routing flags. One source of truth for
// the reset because forgetting to clear ONE of these on a real-game entry
// routes newGame into the tiling branch (or records a test board): exactly the
// bug that shipped when coastlineType was added to switchMode but not to the
// checkpoint-selector entry path. Called from every path that leaves coastline
// practice for a real mode (switchMode + the checkpoint selector, which bypasses
// switchMode).
export function clearCoastlinePractice() {
  state.coastlinePractice = false;
  state.coastlineSeed = null;
  state.coastlineGimmicks = null;
  state.coastlineType = null;
  state.coastlineFeatures = null;
  state.coastlinePar = 0;
  // Par Lab rides the coastline-practice lane; leaving the lane for a real
  // mode must drop its per-board spec too, or the next practice entry would
  // rebuild a lab board (and the lab HUD would record a run it never issued).
  state.parLab = null;
  state.parLabSpec = null;
  state.parLabAttempt = 0;
  // The lab HUD is DOM the UI layer created; tearing it down here keeps
  // "leaving the lane" a single call site. typeof-guarded because this
  // module is otherwise DOM-free and its headless tests import it bare.
  if (typeof document !== 'undefined') document.getElementById('parlab-hud')?.remove();
}

// True when a board's modifiers were resolved during PRE-generation
// (daily/weekly canonical boards, coastline tiling boards, and, since the
// Challenge 250 engine, challenge ladder boards, whose specs author their
// modifiers and whose layouts are drawn frozen at newGame) rather than on
// the first click (timed / chaos). newGame's per-game reset must NOT wipe
// activeGimmicks for these, or the active-modifier bar renders empty on a
// board that plainly has modifiers.
export function modifiersPreResolved(gameMode, coastlinePractice) {
  return gameMode === 'daily' || gameMode === 'weekly' || gameMode === 'normal' || !!coastlinePractice;
}

// Does the CURRENT run own the save slot its mode writes to?
//
// Three lanes borrow another mode's name without owning its slot: an archive
// daily and a past-weekly replay run as 'daily' / 'weekly', and a ?level= or
// coastline practice run as 'normal'. Each shares the live mode's storage key,
// so neither may write to it, and, the half that was missing, neither may
// CLEAR it. handleWin ended with an unguarded clearGameState(state.gameMode),
// so winning a past daily deleted the in-progress real daily: the player's
// reveals went, and the board came back with a zeroed clock in the one mode
// where a manual restart is deliberately impossible (issue #247).
//
// Pure over the three flags so both ends of the slot, persistGameState and
// the win/loss clears, ask one question and cannot drift apart again.
export function ownsSaveSlot(s) {
  const run = s || {};
  return !run.isArchivePlay && !run.isWeeklyArchive && !run.isLevelPractice;
}

// Total bomb-hit penalty (seconds) accrued in the CURRENT daily/weekly
// attempt, derived from the per-hit event log. Single source of truth so
// the live timer, the final precise time, and the score submission all
// agree. Derived from events (not a separate accumulator) so it survives
// the daily auto-save/restore for free, the events are persisted.
// Only one mode's events are populated at a time; summing both is safe.
export function getActiveBombPenaltyTotal() {
  let sum = 0;
  const events = [
    ...(state.dailyBombHitEvents || []),
    ...(state.weeklyBombHitEvents || []),
  ];
  for (const e of events) {
    if (e && typeof e.penalty === 'number') sum += e.penalty;
  }
  return Math.round(sum * 10) / 10;
}

// The number the LCD clock shows mid-game, capped at the LCD's three
// digits. elapsedTime is PURE wall-clock (tick-driven); the daily/weekly
// bomb penalty is held separately in the hit-event log and added here, so
// the displayed time jumps by the penalty on a hit without mutating the
// wall-clock counter (which would double-count on auto-save/restore).
// Lives here, not in timerManager, because EVERY writer of the timer
// display (timerManager's tick, headerRenderer's updateHeader) must render
// this same value: an inlined bare-elapsedTime copy in headerRenderer used
// to overwrite the penalized display on every reveal, flashing the clock
// between penalized and raw time until the next tick (fixed 2026-07-04).
export function getDisplayTime() {
  return Math.min(Math.floor(state.elapsedTime + getActiveBombPenaltyTotal()), 999);
}

// ── Encouragement Lines ────────────────────────────────
// Shown on loss screens. Unified pool, was three near-identical
// variants ("you got this", "almost had it") plus a couple of weird
// outliers ("the board fears your return"). Pool below favors honest
// over chipper; "the right cell was a 50-50, you guessed wrong" reads
// more grounded than "shake it off."
export const ENCOURAGEMENT_LINES = [
  'One more.',
  'Tomorrow\'s daily is a fresh board.',
  'That one was a thinker.',
  'Not every number plays fair. Try again.',
  'Shake it off. Next board\'s yours.',
  'Close. Pull at the corner next time.',
  'Mines hide. You find. Eventually.',
  'New board, new chance.',
  'The good news: there\'s another puzzle.',
  'Skill is reps. This was a rep.',
];

export function getRevealedCells() {
  const cells = [];
  for (const row of state.board) {
    for (const cell of row) {
      if (cell.isRevealed) cells.push(cell);
    }
  }
  return cells;
}
