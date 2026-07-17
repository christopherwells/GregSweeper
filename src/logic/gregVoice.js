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
  wormCellCount: 'worm tiles',
  zeroClusterCount: 'open areas',
  searchMoves: 'search reasoning',
  patternMoves: 'pattern reasoning',
  totalMines: 'mine density',
  cellCount: 'board size',
};

export function featureName(feature) {
  return FEATURE_NAMES[feature] || null;
}

// Greg's working hypothesis per feature — the falsifiable, plain-language
// framing of WHY the model studies it. Structural claims only, never
// numbers: the number arrives later, in a verdict backed by the fitted
// posterior. Each line is a mechanism plus what the data will decide.
const FEATURE_HYPOTHESIS = {
  lockedCellCount: 'Locked cells make you wait for information you would normally have. Waiting should cost time. The boards will tell me how much.',
  sonarCellCount: 'A sonar reading covers a wide area but names no cell. I suspect it helps less than it looks like it should.',
  compassCellCount: 'A compass points at danger without counting it. I can’t yet tell whether players read it fast or stop to puzzle over it.',
  mirrorPairCount: 'Mirrored numbers lie about location, not amount. Players who spot the pair should lose almost no time. Should.',
  liarCellCount: 'A liar is off by one, and one wrong number can poison a whole corner. Or players just route around it. The data decides.',
  mysteryCellCount: 'A mystery cell hides its number entirely. Missing information has a price; I’m measuring it.',
  wormholePairCount: 'Wormhole numbers count two places at once. Splitting one number across the board should slow the reading down.',
  wallEdgeCount: 'Walls cut neighbors apart, so every number near one means less than it looks. Small effect or large? Not sure yet.',
  wormCellCount: 'A worm covers numbers you have already read, then moves on. Nothing is lost, only delayed. I suspect good memory makes it nearly free.',
  zeroClusterCount: 'Big open areas clear themselves. More of them should mean faster boards. The question is how much faster.',
  searchMoves: 'Some deductions need real search, not pattern reading. Those moves should be the expensive ones.',
  patternMoves: 'Pattern reads are practiced moves. They should cost seconds, not tens of seconds.',
  totalMines: 'More mines, more flags, more careful steps. The steady cost of density is the backbone of the model.',
  cellCount: 'Bigger boards take longer. Obvious, but pinning the exact rate is what everything else is measured against.',
};

// The hypothesis line for a feature. Named features get their bespoke
// claim; a studied-but-unnamed feature (the refit can target measures
// the voice layer has no plain words for yet) gets an honest generic —
// never the raw code name, never a fabricated mechanism.
export function featureHypothesis(feature) {
  if (typeof feature !== 'string' || !feature) return null;
  if (FEATURE_HYPOTHESIS[feature]) return FEATURE_HYPOTHESIS[feature];
  const name = featureName(feature);
  if (name) {
    return `I think ${name} changes how long a board takes. The data will tighten my estimate, or show there is nothing there.`;
  }
  return 'An experimental board measure. I’m still working out whether it matters at all.';
}

// Shared honesty primitive: what did an uncertainty (posterior SD) do
// between two fits? Both the leaderboard's yesterday note (day-to-day,
// ±2% verbal tier) and the Journal's study verdicts (era start-to-now,
// higher bar) classify through this ONE function so the two surfaces
// can never disagree about what "tightened" means. Positive deltaPct =
// tightened (less spread), negative = widened.
export function classifySdDelta(sdPrev, sdCur, thresholdPct = 2) {
  if (!(sdPrev > 0) || !(sdCur > 0)) return { kind: 'invalid', deltaPct: 0 };
  const deltaPct = Math.round(((sdPrev - sdCur) / sdPrev) * 100);
  if (deltaPct >= thresholdPct) return { kind: 'tightened', deltaPct };
  if (deltaPct <= -thresholdPct) return { kind: 'widened', deltaPct };
  return { kind: 'flat', deltaPct };
}

// The morning line: why today's board exists. `mission` is the
// getMissionForSeed result ({ target, isPrimary, ... }). Returns null
// when there is nothing honest to say (unknown feature, no mission).
export function fieldNoteLine(mission) {
  if (!mission || typeof mission.target !== 'string') return null;
  const name = featureName(mission.target);
  if (!name) return null;
  return mission.isPrimary
    ? `Greg: today probes ${name}, my widest uncertainty`
    : `Greg: today is a ${name} study. My model wants more data there`;
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
  worm: 'worm tiles',
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
    return 'Greg: yesterday’s fit failed my quality bar, so I kept the previous model';
  }

  const runs = (cur.n_scores || 0) - (prev.n_scores || 0);
  if (runs <= 0) {
    return 'Greg: nobody fed the model yesterday. Today’s runs count double';
  }

  // What yesterday's target estimate did. prev.target is the feature
  // yesterday's board was probing.
  const target = prev.target;
  const name = featureName(target);
  const sdPrev = prev.candidates.find(c => c.feature === target)?.sd;
  const sdCur = cur.candidates.find(c => c.feature === target)?.sd;
  const delta = classifySdDelta(sdPrev, sdCur);
  if (!name || delta.kind === 'invalid') {
    return `Greg: ${runs} run${runs !== 1 ? 's' : ''} landed in the model yesterday`;
  }
  if (delta.kind === 'tightened') {
    return `Greg: yesterday’s ${runs} run${runs !== 1 ? 's' : ''} tightened my ${name} estimate by ${delta.deltaPct}%`;
  }
  if (delta.kind === 'widened') {
    return `Greg: yesterday WIDENED my ${name} estimate by ${Math.abs(delta.deltaPct)}%. More spread, not less. Science.`;
  }
  return `Greg: yesterday’s ${runs} run${runs !== 1 ? 's' : ''} barely moved my ${name} estimate`;
}

// The Lab File line: the player's par, itemized. `details` is the per-uid
// { k, bombSeconds } split from handicaps.json (emitted by the refit). The
// pace term is board-scaled — `gregPar × (k - 1)` — so the line stays in
// seconds and additive-looking even though skill is a multiplicative ratio,
// and it sums to personalPar (`gregPar × k + bombSeconds`). Returns null
// without details; we never fabricate a decomposition the pipeline didn't ship.
export function labFileLine(gregPar, details) {
  if (!details || typeof details.k !== 'number' || typeof details.bombSeconds !== 'number') return null;
  if (typeof gregPar !== 'number' || gregPar <= 0) return null;
  const paceSeconds = gregPar * (details.k - 1);
  const bomb = details.bombSeconds;
  const total = Math.round((gregPar + paceSeconds + bomb) * 10) / 10;
  const fmt = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}s`;
  const parts = [`Greg ${gregPar.toFixed(1)}s`, `your pace ${fmt(paceSeconds)}`];
  if (bomb !== 0) parts.push(`bombs ${fmt(bomb)}`);
  return `Your par ${total.toFixed(1)}s = ${parts.join(' ')}`;
}
