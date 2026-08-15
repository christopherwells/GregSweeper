// Evict unplayed boards from over-target corners of the match library, by
// TOMBSTONE: the slot keeps its position, the payload goes.
//
//   node scripts/evict-match-surplus.mjs [--dry-run]
//
// WHY (his ruling 2026-08-15): the burst runs left 16,156 unplayed boards
// above their corners' targets, 92.5 MB and 53% of the library, three
// quarters of it in stacked-modifier corners whose hosts already see the
// most boards. Unplayed surplus is not just storage: the deal picks
// uniformly among eligible boards, so surplus DILUTES the repeated measures
// the par fit pools by seed. Trimming concentrates future plays on fewer
// boards, which is the fit's gain, and the arity-scaled targets stop the
// surplus regrowing.
//
// WHY TOMBSTONES AND NEVER COMPACTION: `page:idx` is the seen-cycle key on
// every player's device. An evicted board's slot is replaced with
// `{ evicted: true, seed }`, so every survivor keeps its exact page and
// index, seen records stay valid verbatim, and no epoch reset is spent. A
// dangling seen key is inert by construction (pickMatchBoards intersects
// seen with the ELIGIBLE rows, and a stub never becomes a row). The seed
// stays on the stub for audit, and the payload survives in git history, so
// the eviction is reversible in principle.
//
// WHAT IS NEVER EVICTED. Played boards (their seeds pool fit rows across
// hosts, and the played fetch failing therefore ABORTS the run rather than
// treating the library as unplayed); below-target corners; and enough
// unplayed depth to fill each corner to cornerTotalTarget(played, arity),
// the same line generation aims at, chosen for FEATURE DIVERSITY (greedy
// max-min distance in the topup's standardized feature space) because the
// mission steering scores on feature vectors and a diverse residue keeps
// every study findable.
//
// In-flight matches are immune: a match node and a save carry their dealt
// boards whole, never a library reference.
//
// Rerunnable: stubs stay stubs, counts are of survivors, and a corner at
// target is left alone.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { matchCornerKey } from '../src/logic/matchRules.js';
import { matchRowKey } from '../src/logic/matchCodes.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { OUT_DIR, writeMatchIndexFiles, matchPageNames } from './match-index-files.mjs';
import { cornerTotalTarget, arityOfKey, featureSpace } from './topup-match-library.mjs';

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const DRY = process.argv.includes('--dry-run');

const live = (b) => b && !b.evicted;
const cornerOf = (b) => matchCornerKey({
  shape: b.spec.shape, mods: (b.spec.gimmicks || []),
  par: b.par, mines: b.spec.mines, cells: b.spec.cells,
}).join('|');

/** Squared distance, early-exit against a running best. */
function dist2(a, b, best = Infinity) {
  let d = 0;
  for (let i = 0; i < a.length; i++) { const t = a[i] - b[i]; d += t * t; if (d >= best) return d; }
  return d;
}

/**
 * Pick `keepN` of `candidates` (index list) for maximum spread: greedy
 * max-min distance against the growing keep set, seeded with `anchors`
 * (the played boards' vectors). With no anchors, the first keeper is the
 * candidate farthest from the corner's centroid, so the extremes survive.
 */
export function pickDiverse(vectors, candidates, anchors, keepN) {
  if (keepN <= 0) return [];
  if (candidates.length <= keepN) return candidates.slice();
  const kept = [];
  const keptVecs = anchors.slice();
  if (keptVecs.length === 0) {
    const dim = vectors[candidates[0]].length;
    const centroid = new Array(dim).fill(0);
    for (const c of candidates) for (let i = 0; i < dim; i++) centroid[i] += vectors[c][i];
    for (let i = 0; i < dim; i++) centroid[i] /= candidates.length;
    let best = -1, bestD = -1;
    for (const c of candidates) {
      const d = dist2(vectors[c], centroid);
      if (d > bestD) { bestD = d; best = c; }
    }
    kept.push(best);
    keptVecs.push(vectors[best]);
  }
  const remaining = new Set(candidates.filter((c) => !kept.includes(c)));
  while (kept.length < keepN && remaining.size) {
    let best = -1, bestMin = -1;
    for (const c of remaining) {
      let min = Infinity;
      for (const v of keptVecs) { min = Math.min(min, dist2(vectors[c], v, min)); if (min === 0) break; }
      if (min > bestMin) { bestMin = min; best = c; }
    }
    kept.push(best);
    keptVecs.push(vectors[best]);
    remaining.delete(best);
  }
  return kept;
}

async function fetchPlayed() {
  const r = await fetch(`${DB_BASE}/dailyMeta.json?shallow=true`);
  if (!r.ok) throw new Error(`played-set fetch failed (HTTP ${r.status})`);
  const keys = Object.keys((await r.json()) || {});
  return new Set(keys.filter((k) => k.startsWith('match_')));
}

async function main() {
  // ABORT rather than degrade: with an empty played set every board reads
  // unplayed and the one hard rule (played boards are never evicted) loses
  // its ground truth.
  const played = await fetchPlayed();
  if (played.size === 0) throw new Error('played set came back empty; refusing to evict against no ground truth');

  const names = matchPageNames();
  const pages = names.map((n) => JSON.parse(readFileSync(new URL(n, OUT_DIR), 'utf8')));
  const all = [];   // { b, page, idx }
  pages.forEach((pg, p) => pg.boards.forEach((b, i) => { if (live(b)) all.push({ b, page: p, idx: i }); }));

  const space = featureSpace(all.map((x) => x.b));
  const vec = all.map((x) => space.keys.map((k) => ((Number((x.b.features || {})[k]) || 0) - space.mean[k]) / space.sd[k]));

  const corners = new Map();  // key -> number[] indices into `all`
  all.forEach((x, i) => {
    const k = cornerOf(x.b);
    if (!corners.has(k)) corners.set(k, []);
    corners.get(k).push(i);
  });

  let evicted = 0, bytes = 0, cornersTrimmed = 0;
  const dirtyPages = new Set();
  for (const [key, idxs] of corners) {
    const playedIdx = idxs.filter((i) => played.has(matchRowKey(all[i].b.seed)));
    const unplayedIdx = idxs.filter((i) => !played.has(matchRowKey(all[i].b.seed)));
    const target = cornerTotalTarget(playedIdx.length, arityOfKey(key));
    if (idxs.length <= target) continue;
    const keepN = Math.max(0, target - playedIdx.length);
    const keepSet = new Set(pickDiverse(vec, unplayedIdx, playedIdx.map((i) => vec[i]), keepN));
    cornersTrimmed++;
    for (const i of unplayedIdx) {
      if (keepSet.has(i)) continue;
      const { b, page, idx } = all[i];
      bytes += JSON.stringify(b).length;
      pages[page].boards[idx] = { evicted: true, seed: b.seed };
      dirtyPages.add(page);
      evicted++;
    }
  }

  if (!DRY) {
    for (const p of dirtyPages) {
      writeFileSync(new URL(names[p], OUT_DIR), JSON.stringify(pages[p]));
    }
  }
  const written = writeMatchIndexFiles(pages.map((pg) => pg.boards), modelFingerprint(), { dry: DRY });
  console.log(`evict-match-surplus: ${evicted} unplayed board(s) tombstoned`
    + ` (${(bytes / 1048576).toFixed(1)} MB) over ${cornersTrimmed} corner(s), ${dirtyPages.size} page(s) rewritten;`
    + ` ${written.boards} dealable board(s) remain in ${written.corners} corner(s)`
    + ` (played set ${played.size}${DRY ? '; dry run, nothing written' : ''})`);
}

const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) {
  main().catch((err) => { console.error('evict-match-surplus failed:', err.message); process.exit(1); });
}
