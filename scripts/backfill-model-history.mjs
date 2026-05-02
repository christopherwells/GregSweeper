// Back-generate src/logic/modelHistory.json from git history + Firebase
// data. Run once when the per-refit emit was first added so the timeline
// starts populated rather than empty. Idempotent: re-running rewrites
// the file from scratch — preserves nothing in-place, so don't run after
// new refits unless you want to re-derive everything.
//
// What we have in git for each historical refit:
//   - PAR_MODEL coefficients (src/logic/difficulty.js between markers)
//   - secPerBombHit, modelFitN, nPlayers, method, diagnostics (handicaps.json)
//   - target + candidate CV table (experimentTarget.json)
//
// What we DON'T have, and have to compute:
//   - RMSE and bias of the fit. The actual residuals weren't stored.
//     We approximate by applying the historical PAR_MODEL to every score
//     submitted before that refit's commit timestamp, then computing
//     residuals = (time - bombCoef * bombHits) - predicted_par. This is
//     close to what the fit itself would have produced — possibly off
//     by a few percent because the fit's actual filtering threshold
//     (MIN_PLAYS_FOR_FIT_INCLUSION) was applied per-user, while we
//     just take all available data.
//
// Usage: node scripts/backfill-model-history.mjs

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FIREBASE_DB = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const HISTORY_PATH = 'src/logic/modelHistory.json';

// ── Git helpers ─────────────────────────────────────────

function getRefitCommits() {
  const out = execSync(
    'git log --all --pretty=format:"%H|%aI|%s" -- src/logic/experimentTarget.json',
    { encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .map(line => {
      const [sha, isoDate, ...rest] = line.split('|');
      return { sha, date: isoDate, msg: rest.join('|') };
    })
    .filter(c => c.msg && c.msg.startsWith('refit PAR_MODEL'))
    .reverse(); // oldest first
}

function readAtCommit(sha, path) {
  try {
    return execSync(`git show ${sha}:${path}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// Parse PAR_MODEL block out of difficulty.js. Doesn't eval — just
// regex-extracts each field. Defaults missing fields to 0 so old commits
// without nonZeroSafeCellCount / zeroClusterCount still parse.
const PAR_FIELDS = [
  'intercept',
  'secPerPassAMove',
  'secPerCanonicalSubsetMove',
  'secPerGenericSubsetMove',
  'secPerAdvancedLogicMove',
  'secPerDisjunctiveMove',
  'secPerCell',
  'secPerMineFlag',
  'secPerWallEdge',
  'secPerMysteryCell',
  'secPerLiarCell',
  'secPerLockedCell',
  'secPerWormholePair',
  'secPerMirrorPair',
  'secPerSonarCell',
  'secPerCompassCell',
  'secPerNonZeroSafeCell',
  'secPerZeroCluster',
];

function parseParModel(jsSource) {
  // The block lives between `PAR_MODEL = {` and the matching closing
  // brace + semicolon. Non-greedy match handles the structured layout
  // the refit script writes (newlines + comments inside).
  const block = jsSource.match(/PAR_MODEL\s*=\s*\{([\s\S]*?)\}\s*;/);
  if (!block) return null;
  const body = block[1];
  const m = {};
  for (const f of PAR_FIELDS) {
    const re = new RegExp(`${f}\\s*:\\s*(-?[0-9.]+)`);
    const match = body.match(re);
    m[f] = match ? parseFloat(match[1]) : 0;
  }
  return m;
}

function applyParModel(features, m) {
  return (
    m.intercept +
    (features.passAMoves           || 0) * m.secPerPassAMove +
    (features.canonicalSubsetMoves || 0) * m.secPerCanonicalSubsetMove +
    (features.genericSubsetMoves   || 0) * m.secPerGenericSubsetMove +
    (features.advancedLogicMoves   || 0) * m.secPerAdvancedLogicMove +
    (features.disjunctiveMoves     || 0) * m.secPerDisjunctiveMove +
    (features.cellCount            || 0) * m.secPerCell +
    (features.totalMines           || 0) * m.secPerMineFlag +
    (features.wallEdgeCount        || 0) * m.secPerWallEdge +
    (features.mysteryCellCount     || 0) * m.secPerMysteryCell +
    (features.liarCellCount        || 0) * m.secPerLiarCell +
    (features.lockedCellCount      || 0) * m.secPerLockedCell +
    (features.wormholePairCount    || 0) * m.secPerWormholePair +
    (features.mirrorPairCount      || 0) * m.secPerMirrorPair +
    (features.sonarCellCount       || 0) * m.secPerSonarCell +
    (features.compassCellCount     || 0) * m.secPerCompassCell +
    (features.nonZeroSafeCellCount || 0) * m.secPerNonZeroSafeCell +
    (features.zeroClusterCount     || 0) * m.secPerZeroCluster
  );
}

// ── Firebase helpers ────────────────────────────────────

async function fetchJson(path) {
  const r = await fetch(`${FIREBASE_DB}${path}`);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

// ── Main ────────────────────────────────────────────────

(async () => {
  const commits = getRefitCommits();
  console.log(`Found ${commits.length} refit commits`);

  console.log('Fetching daily scores + dailyMeta from Firebase…');
  const [allDaily, allMeta] = await Promise.all([
    fetchJson('/daily.json'),
    fetchJson('/dailyMeta.json'),
  ]);

  // Flatten scores. Skip any without features in dailyMeta — we can't
  // compute predicted par without them, so they'd be silently dropped
  // either way, and the count is more useful when explicit.
  const scores = [];
  let droppedNoMeta = 0;
  for (const [date, byPush] of Object.entries(allDaily || {})) {
    if (!byPush || typeof byPush !== 'object') continue;
    const features = allMeta?.[date]?.features;
    for (const [, score] of Object.entries(byPush)) {
      if (!score || typeof score !== 'object') continue;
      if (typeof score.time !== 'number') continue;
      if (!features) { droppedNoMeta++; continue; }
      scores.push({
        date,
        time: score.time,
        bombHits: score.bombHits || 0,
        timestamp: score.timestamp || 0,
        uid: score.uid || 'unknown',
        features,
      });
    }
  }
  console.log(`  Loaded ${scores.length} scores (${droppedNoMeta} dropped: no dailyMeta)`);

  // For each refit commit, recompute RMSE/bias on the data available
  // before its commit time, using its coefficients.
  const rows = [];
  for (const c of commits) {
    const commitMs = new Date(c.date).getTime();

    const diffJs = readAtCommit(c.sha, 'src/logic/difficulty.js');
    if (!diffJs) {
      console.log(`  ${c.sha.slice(0, 7)}: no difficulty.js, skipping`);
      continue;
    }
    const parModel = parseParModel(diffJs);
    if (!parModel) {
      console.log(`  ${c.sha.slice(0, 7)}: couldn't parse PAR_MODEL, skipping`);
      continue;
    }

    const handicapsJson = readAtCommit(c.sha, 'src/logic/handicaps.json');
    let handicaps = {};
    try { handicaps = handicapsJson ? JSON.parse(handicapsJson) : {}; } catch {}
    const bombCoef = handicaps.secPerBombHit || 0;
    const method = handicaps.method || 'unknown';
    const diagNote = handicaps.diagnostics || null;
    const nEligibleMeta = handicaps.nPlayers || 0;

    const targetJson = readAtCommit(c.sha, 'src/logic/experimentTarget.json');
    let target = {};
    try { target = targetJson ? JSON.parse(targetJson) : {}; } catch {}
    const chosenTarget = target.target || null;
    const candidates = Array.isArray(target.candidates) ? target.candidates : [];

    // Eligible data at commit time. The actual fit had a per-user
    // threshold (MIN_PLAYS_FOR_FIT_INCLUSION) that we don't enforce
    // here because we don't have the play-count snapshot at that
    // moment — using all scores gives a slightly fuller residual set
    // than the fit saw. Close enough for trend purposes.
    const fitData = scores.filter(s => s.timestamp > 0 && s.timestamp < commitMs);

    let rmse = null, bias = null;
    if (fitData.length > 0) {
      let sum = 0, sumSq = 0;
      for (const s of fitData) {
        const predClean = applyParModel(s.features, parModel);
        const cleanTime = s.time - bombCoef * s.bombHits;
        const r = cleanTime - predClean;
        sum += r;
        sumSq += r * r;
      }
      const n = fitData.length;
      rmse = Math.sqrt(sumSq / n);
      bias = sum / n;
    }

    const datesUsed = new Set(fitData.map(s => s.date));
    const playersUsed = new Set(fitData.map(s => s.uid));

    rows.push({
      date: c.date.slice(0, 10),
      updatedAt: c.date.replace(/\.\d+/, ''), // strip sub-second precision
      method,
      n_scores: fitData.length,
      n_dates: datesUsed.size,
      n_players: playersUsed.size,
      n_eligible: nEligibleMeta,
      rmse: rmse == null ? null : Math.round(rmse * 100) / 100,
      bias: bias == null ? null : Math.round(bias * 100) / 100,
      diagnostics: diagNote,
      target: chosenTarget,
      candidates,
      backfilled: true, // flag rows produced by this script vs live emits
    });

    console.log(`  ${c.sha.slice(0, 7)} ${c.date.slice(0, 10)}: N=${fitData.length}, RMSE=${rmse?.toFixed(2) ?? 'NA'}s, bias=${bias?.toFixed(2) ?? 'NA'}s, target=${chosenTarget}`);
  }

  // Merge with any existing live-emit rows. Live rows are authoritative
  // (they used df_fit, the eligible-user filtered data the actual fit
  // saw); backfilled rows are an approximation against all scores. So
  // when both exist for the SAME REFIT EVENT, keep the live row and
  // drop the backfilled one. We identify "same event" by timestamp
  // closeness (within DEDUP_WINDOW_MS) rather than date alone, so
  // multiple commits on the same date that don't have live rows still
  // get backfilled normally.
  let existing = [];
  try {
    const txt = readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) existing = parsed;
  } catch {}

  const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const liveRows = existing.filter(r => r && !r.backfilled && r.updatedAt);
  const liveTimes = liveRows.map(r => new Date(r.updatedAt).getTime());
  const backfillNoDup = rows.filter(r => {
    const t = new Date(r.updatedAt).getTime();
    return !liveTimes.some(lt => Math.abs(lt - t) < DEDUP_WINDOW_MS);
  });

  // Dedupe leftover identicals by updatedAt (defense in depth).
  const seen = new Set(backfillNoDup.map(r => r.updatedAt));
  const merged = [...backfillNoDup];
  for (const r of existing) {
    if (r && r.updatedAt && !seen.has(r.updatedAt)) {
      merged.push(r);
      seen.add(r.updatedAt);
    }
  }
  merged.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));

  writeFileSync(HISTORY_PATH, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Wrote ${HISTORY_PATH} — ${merged.length} rows total (${rows.length} backfilled, ${merged.length - rows.length} live)`);
})().catch(err => {
  console.error('backfill failed:', err);
  process.exit(1);
});
