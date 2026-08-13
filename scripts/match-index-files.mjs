// Write the match library's index files: one summary, one shard per shape.
//
// ONE WRITER, TWO CALLERS, for the same reason matchIndexRow is one function:
// build-match-library.mjs writes the files from scratch and
// reprice-match-library.mjs rewrites them nightly, and an index whose two
// producers drift is an index that says different things depending on which
// one ran last. The row FORMAT already lived in matchRules.js; this is the
// FILE layout, which is a script-side concern (the client only reads).
//
// WHY THE SPLIT (the depth blocker). Every client used to fetch
// match-index.json whole, once for the setup sheet's live counts and again at
// deal time: 349 KB / 71 KB gzipped over 2,759 boards, one row per board. His
// depth target is ~100 boards per (shape x modifier x length x mines), which
// is 819,000 boards and a 21 MB gzipped index, so the index was the thing
// standing between the library and any real depth. The page files were
// already sharded by shape and fetched on demand; only this was monolithic.
//
// The two readers want different things, and one of them is small:
//
//   match-summary.json  answers "how many boards fit these rules" for the
//     setup sheet, as a count per CORNER (shape x modifier set x time band x
//     density band). Corner count tracks the library's VARIETY, not its
//     depth: 347 corners at 2,759 boards and still 347 at 819,000, because a
//     deeper corner moves a number rather than adding a row. It also carries
//     the file-level metadata every consumer needs (model fingerprint, board
//     and page counts, the shard list).
//
//   match-index-<shape>.json  carries the deal's rows, so a deal fetches only
//     the shapes its rules can reach. Row format is unchanged and still
//     written through matchIndexRow, so parseMatchIndex reads a shard exactly
//     as it read the old whole-library file.
//
// match-index.json is DELETED when these are written. Nothing reads it after
// this change, and leaving it would mean the nightly re-price keeps a second
// copy of every row in step forever, which is the payload the split exists to
// stop paying. It is not precached by the service worker (the library is
// runtime-cached), so no shipped client can be left asking for it.

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import {
  matchIndexRow, matchIndexFeatureKeys, matchShardFile, buildMatchCorners, parseMatchIndex,
} from '../src/logic/matchRules.js';

export const OUT_DIR = new URL('./data/match-library/', import.meta.url);
export const SUMMARY_FILE = new URL('match-summary.json', OUT_DIR);
export const LEGACY_INDEX_FILE = new URL('match-index.json', OUT_DIR);
export const matchPageFile = (p) => new URL(`match-${String(p).padStart(3, '0')}.json`, OUT_DIR);
export const matchShardFileUrl = (shape) => new URL(matchShardFile(shape), OUT_DIR);

/**
 * Write match-summary.json and the per-shape shards from the paged boards.
 *
 * `pages` is an array of board arrays, indexed by page number, exactly as
 * both callers already hold them.
 *
 * @returns {{boards: number, pages: number, shards: object, corners: number}}
 */
export function writeMatchIndexFiles(pages, fp, { dry = false } = {}) {
  // The feature header is derived from the boards themselves, so a new
  // feature key reaches the index with no edit here (matchRules.js).
  const featureKeys = matchIndexFeatureKeys(pages.flat());
  const rows = [];
  pages.forEach((page, p) => {
    page.forEach((b, i) => rows.push(matchIndexRow(p, i, b, featureKeys)));
  });

  // Corners are counted from the PARSED rows rather than from the boards, so
  // the summary and the shards are answering out of the same numbers. A
  // corner derived from the richer board objects could disagree with what a
  // client sees after a round trip through the row format, and the count the
  // sheet shows would then be a count of something the deal cannot reach.
  const parsed = parseMatchIndex({ featureKeys, rows });
  if (!parsed) throw new Error('the rows this run just wrote do not parse back');
  const corners = buildMatchCorners(parsed);

  const byShape = new Map();
  for (let i = 0; i < parsed.length; i++) {
    if (!byShape.has(parsed[i].shape)) byShape.set(parsed[i].shape, []);
    byShape.get(parsed[i].shape).push(rows[i]);
  }
  const shards = {};
  for (const [shape, shapeRows] of byShape) shards[shape] = shapeRows.length;

  const summary = {
    parModel: fp,
    boards: rows.length,
    pages: pages.length,
    counts: pages.map((p) => p.length),
    shards,
    corners,
  };

  if (!dry) {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const [shape, shapeRows] of byShape) {
      writeFileSync(matchShardFileUrl(shape),
        JSON.stringify({ parModel: fp, shape, featureKeys, rows: shapeRows }));
    }
    writeFileSync(SUMMARY_FILE, JSON.stringify(summary));
    if (existsSync(LEGACY_INDEX_FILE)) rmSync(LEGACY_INDEX_FILE);
  }
  return { boards: rows.length, pages: pages.length, shards, corners: corners.length };
}
