// Write the HARVEST index: the Climb library's boards, indexed in
// match-corner terms so the Challenge deal can draw from both shelves.
//
// His rulings (2026-08-16): the two libraries are one shelf for Challenge;
// seen-sets stay separate; and NOTHING transfers between the modes, so this
// script only READS the Climb files and writes its own index beside them.
// The layout is the match split's own: one summary whose corner tuples feed
// countEligibleCorners, one cmx- shard per corner in climbIndexRow format.
//
// REGENERATED WHOLE, nightly, AFTER the Climb re-bin and fill: the re-bin
// moves boards between files, so every locator in here is only as fresh as
// the files it was derived from. That is why rows carry file, index AND
// seed, why the deal treats a seed mismatch as a missing board, and why the
// match seen-cycle keys harvest boards by seed. Stale cmx- shards from a
// previous build are DELETED before writing: a corner the re-bin emptied
// must stop being fetchable, or the summary and the shards disagree.
//
//   node scripts/climb-match-index.mjs [--dry-run]

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchIndexFeatureKeys, climbIndexRow, matchCornerKey, matchShardFile,
  buildMatchCorners, CLIMB_SHARD_PREFIX,
} from '../src/logic/matchRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'data', 'climb-library');
const DRY = process.argv.includes('--dry-run');

const BOARD_FILE_RE = /^(?:level|endless)-\d+\.json$/;

export function harvestBoards(dir = DIR) {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!BOARD_FILE_RE.test(f)) continue;
    let data;
    try { data = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const boards = Array.isArray(data) ? data : (data.boards || []);
    const stem = f.replace(/\.json$/, '');
    boards.forEach((b, idx) => {
      if (!b || b.evicted || !b.seed || !b.payload) return;
      if (!b.spec || !b.spec.shape || !Number.isFinite(b.spec.cells)
        || !Number.isFinite(b.spec.mines) || !(b.par > 0)) return;
      out.push({ file: stem, idx, entry: b });
    });
  }
  return out;
}

function main() {
  const found = harvestBoards();
  const featureKeys = matchIndexFeatureKeys(found.map((x) => x.entry));
  const flat = found.map(({ entry }) => ({
    shape: entry.spec.shape,
    mods: (entry.spec.gimmicks || []).slice().sort(),
    par: entry.par,
    mines: entry.spec.mines,
    cells: entry.spec.cells,
  }));

  const shards = new Map();
  found.forEach(({ file, idx, entry }, i) => {
    const [shape, mods, time, density] = matchCornerKey(flat[i]);
    const name = matchShardFile(shape, time, density, mods, CLIMB_SHARD_PREFIX);
    if (!shards.has(name)) shards.set(name, []);
    shards.get(name).push(climbIndexRow(file, idx, entry, featureKeys));
  });

  const stale = readdirSync(DIR)
    .filter((f) => f.startsWith(`${CLIMB_SHARD_PREFIX}-`) && f.endsWith('.json') && !shards.has(f));
  if (!DRY) {
    for (const f of stale) unlinkSync(path.join(DIR, f));
    for (const [name, rows] of shards) {
      writeFileSync(path.join(DIR, name), JSON.stringify({ featureKeys, rows }));
    }
    writeFileSync(path.join(DIR, 'climb-match-summary.json'), JSON.stringify({
      boards: found.length,
      corners: buildMatchCorners(flat),
    }));
  }
  console.log(`climb-match-index: ${found.length} boards in ${shards.size} corners`
    + `${stale.length ? `; ${stale.length} stale shard(s) removed` : ''}${DRY ? ' (dry run)' : ''}`);
}

main();
