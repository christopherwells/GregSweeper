// ── Greg's voice ───────────────────────────────────────
// The meta-layer made legible: Greg is the resident scientist, and the
// few sentences he speaks are TRUE statements backed by the live
// pipeline — the adaptive experiment design (why today's board exists)
// and the nightly Bayesian refit (what yesterday's runs did to the
// model). Hard rules:
//   - Greg never says a number the engine cannot prove.
//   - The bad days speak too: a widened estimate, a rejected fit, or a
//     day nobody played all get their own honest line — a Greg who only
//     reports good news is a mascot, not a scientist.
//   - Voice budget: at most one Greg line per surface, and each surface
//     renders once per session.
// Pure functions over experimentTarget / modelHistory data — node-testable.

// Plain-English names for the model's push-able features.
const FEATURE_NAMES = {
  lockedCellCount: 'locked cells',
  sonarCellCount: 'sonar',
  compassCellCount: 'compass',
  mirrorPairCount: 'mirrors',
  liarCellCount: 'liar cells',
  mysteryCellCount: 'mystery cells',
  wormholePairCount: 'wormholes',
  wallEdgeCount: 'walls',
  zeroClusterCount: 'open areas',
  searchMoves: 'search reasoning',
  patternMoves: 'pattern reasoning',
  totalMines: 'mine density',
  cellCount: 'board size',
};

export function featureName(feature) {
  return FEATURE_NAMES[feature] || null;
}

// The morning line: why today's board exists. `mission` is the
// getMissionForSeed result ({ target, isPrimary, ... }). Returns null
// when there is nothing honest to say (unknown feature, no mission).
export function fieldNoteLine(mission) {
  if (!mission || typeof mission.target !== 'string') return null;
  const name = featureName(mission.target);
  if (!name) return null;
  return mission.isPrimary
    ? `Greg: today probes ${name} — my widest uncertainty`
    : `Greg: today is a ${name} study — my model wants more data there`;
}

// Gimmick ids (board.activeGimmicks) → the same plain-English names.
const GIMMICK_NAMES = {
  wormhole: 'wormholes',
  mirror: 'mirrors',
  liar: 'liar cells',
  mystery: 'mystery cells',
  locked: 'locked cells',
  walls: 'walls',
  sonar: 'sonar',
  compass: 'compass',
};

// Field note derived from the CANONICAL BOARD itself — the only source
// that cannot drift. Boards are pre-generated up to 7 days ahead
// against THAT day's experimentTarget.json, and the nightly refit
// reorders the coverage list, so re-deriving the mission from the
// CURRENT file via the seed's slot index names the wrong gimmick
// (2026-06-10: board carried wormholes, note said compass).
// Preference order:
//   1. The mission stamped into the payload at generation
//      (missionTarget/missionIsPrimary — boards written after this fix).
//   2. The board's actual activeGimmicks, in the neutral framing (we
//      know WHAT is on the board, not why it was chosen).
//   3. Nothing — a gimmick-free board gets no note rather than a vague one.
export function fieldNoteFromBoard(raw) {
  if (!raw) return null;
  if (typeof raw.missionTarget === 'string') {
    const line = fieldNoteLine({ target: raw.missionTarget, isPrimary: raw.missionIsPrimary === true });
    if (line) return line;
  }
  const gimmicks = Array.isArray(raw.activeGimmicks) ? raw.activeGimmicks : [];
  const names = gimmicks.map(g => GIMMICK_NAMES[g]).filter(Boolean);
  if (names.length === 0) return null;
  return `Greg: today is a ${names.join(' + ')} study`;
}

// The closed loop: what yesterday's runs did to the model. `history` is
// the modelHistory.json array (per-refit rows with n_scores, method,
// target, and the per-feature posterior mean/sd table). All four honesty
// branches are first-class: tightened / widened / barely-moved /
// fit-rejected / nobody-played. Returns null when there is not enough
// history to say anything true.
export function yesterdayNote(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const cur = history[history.length - 1];
  const prev = history[history.length - 2];
  if (!cur || !prev || !Array.isArray(cur.candidates) || !Array.isArray(prev.candidates)) return null;

  // The refit kept the previous model because diagnostics failed.
  if (cur.method && cur.method !== 'brms-ranef') {
    return 'Greg: yesterday’s fit failed my quality bar — I kept the previous model';
  }

  const runs = (cur.n_scores || 0) - (prev.n_scores || 0);
  if (runs <= 0) {
    return 'Greg: nobody fed the model yesterday — today’s runs count double';
  }

  // What yesterday's target estimate did. prev.target is the feature
  // yesterday's board was probing.
  const target = prev.target;
  const name = featureName(target);
  const sdPrev = prev.candidates.find(c => c.feature === target)?.sd;
  const sdCur = cur.candidates.find(c => c.feature === target)?.sd;
  if (!name || !(sdPrev > 0) || !(sdCur > 0)) {
    return `Greg: ${runs} run${runs !== 1 ? 's' : ''} landed in the model yesterday`;
  }
  const deltaPct = Math.round(((sdPrev - sdCur) / sdPrev) * 100);
  if (deltaPct >= 2) {
    return `Greg: yesterday’s ${runs} run${runs !== 1 ? 's' : ''} tightened my ${name} estimate by ${deltaPct}%`;
  }
  if (deltaPct <= -2) {
    return `Greg: yesterday WIDENED my ${name} estimate by ${Math.abs(deltaPct)}% — more spread, not less. Science.`;
  }
  return `Greg: yesterday’s ${runs} run${runs !== 1 ? 's' : ''} barely moved my ${name} estimate`;
}

// The Lab File line: the player's par, itemized. `details` is the
// per-uid { clean, bomb } split from handicaps.json v2 (emitted by the
// refit alongside the summed handicap). Returns null without details —
// the un-itemized "Your par" line stays as-is; we never fabricate a
// decomposition the pipeline didn't ship.
export function labFileLine(gregPar, details) {
  if (!details || typeof details.clean !== 'number' || typeof details.bomb !== 'number') return null;
  if (typeof gregPar !== 'number' || gregPar <= 0) return null;
  const total = Math.round((gregPar + details.clean + details.bomb) * 10) / 10;
  const fmt = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}s`;
  const parts = [`Greg ${gregPar.toFixed(1)}s`, `your pace ${fmt(details.clean)}`];
  if (details.bomb !== 0) parts.push(`bombs ${fmt(details.bomb)}`);
  return `Your par ${total.toFixed(1)}s = ${parts.join(' ')}`;
}
