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
  timerId: null,
  timeLimit: 0,         // countdown seconds for timed mode (0 = no limit)

  currentLevel: 1,
  gameMode: 'daily',    // normal | timed | skillTrainer | daily
  dailySeed: null,
  dailyBombHits: 0,

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
