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
  gameMode: 'normal',   // normal | timed | skillTrainer | daily | chaos
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
