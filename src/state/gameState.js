// ── Game State ──────────────────────────────────────────

export const state = {
  board: [],
  rows: 10,
  cols: 10,
  totalMines: 10,
  status: 'idle',       // idle | playing | won | lost
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
  dailyPar: 0,       // predicted time in seconds — predictPar(dailyFeatures)
  dailyMoves: 0,     // solver totalClicks for pace calculation
  dailyFeatures: null, // full feature vector from computeDailyFeatures — used for par breakdown, Firebase meta upload, and the R refit training set
  isDailyPractice: false, // set when the URL carries ?seed=<custom>: play a custom-seed board but skip streak/completion/history side effects. Submissions still go to Firebase (under the custom seed path) so the session still tags a uid.

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
  zoomLevel: 100,  // percentage (50–200)
  checkpoint: 1,   // last checkpoint level (every 5 levels)
  flagMode: false, // flag-mode toggle for mobile
  dirtyCells: new Set(), // track changed cells for targeted updates

  // Gimmicks (challenge mode)
  activeGimmicks: [],    // ['mystery', 'walls', ...]
  gimmickData: {},       // per-gimmick applied data
  mineShiftTimerId: null,
  inputLocked: false,    // true during cascade/chord animations

  // Chaos mode (roguelike runs)
  chaosRound: 0,          // current board number in the run (1-based)
  chaosModifiers: [],     // modifiers rolled for current board
  chaosTotalTime: 0,      // cumulative time across all boards in the run

  // Quick Play timer toggle
  timerHidden: false,     // true = hide timer LCD in Quick Play mode

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
  // canonicalDailyBoard: { date, raw } — the canonical board for today
  // pre-fetched at boot. newGame() uses this verbatim instead of doing
  // its own loadDailyBoard call, so by construction every device on
  // the same ET date plays the same layout. Null when offline or when
  // today's canonical hasn't been written yet (first visitor of the day).
  //
  // canonicalWeeklyBoard: { weekStart, raw } — same idea but for the
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
  // (one per day Mon–Sun). All players see the same board for the
  // whole week; the leaderboard records each player's best time and
  // a per-day map. The first attempt a player makes on the week's
  // board doubles as par-model fit data (honest first encounter); days
  // 2–7 are speedruns and stay out of the fit.
  weeklySeed: null,                // 'YYYY-MM-DD' Monday in ET
  weeklyDay: null,                 // 0..6, which day's attempt is in progress
  weeklyRngSeed: null,             // canonical's resolved seed (e.g. '2026-05-04:trial1')
  weeklyBombHits: 0,               // for current attempt
  weeklyBombHitEvents: [],         // [{t, row, col}, ...] for current attempt
  weeklyDayTimes: {},              // {0: 45.2, 3: 50.1, ...} from Firebase on mode entry
  weeklyDayBombHits: {},           // {0: 1, 3: 0, ...} per-day strike counts from Firebase
  weeklyFeatures: null,            // computed at canonical resolve, used for the first-attempt fit-data submit
  cachedWeeklyDayAttempts: {},     // {0: true, 3: true} from Firebase at startup so the gate is sync

  // ── Idle-pause state ─────────────────────────────────
  // Auto-pause the timer after 30s without user input so a player who
  // walks away doesn't bleed seconds into their daily/weekly time.
  // `lastInteractionTime` is a Date.now() millis stamp, refreshed on
  // any pointerdown/keydown/throttled-pointermove. `idlePaused` flips
  // true when the gap exceeds the threshold and the overlay is showing.
  lastInteractionTime: 0,
  idlePaused: false,
};

// ── Encouragement Lines ────────────────────────────────
export const ENCOURAGEMENT_LINES = [
  'You got this! Try again 💪',
  'Almost had it! One more try?',
  'Even the best stumble sometimes.',
  'Mines are sneaky — you\'ll get them!',
  'Shake it off and sweep again! 🧹',
  'Every loss makes you stronger.',
  'That mine came out of nowhere!',
  'Close one! Give it another shot.',
  'Keep sweeping — glory awaits! ⚔️',
  'The board fears your return.',
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
