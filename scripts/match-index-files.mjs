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

import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import {
  matchIndexRow, matchIndexFeatureKeys, matchShardFileForRow, buildMatchCorners, parseMatchIndex,
} from '../src/logic/matchRules.js';

export const OUT_DIR = new URL('./data/match-library/', import.meta.url);
export const SUMMARY_FILE = new URL('match-summary.json', OUT_DIR);
export const LEGACY_INDEX_FILE = new URL('match-index.json', OUT_DIR);
export const matchPageFile = (p) => new URL(`match-${String(p).padStart(3, '0')}.json`, OUT_DIR);

// PAGE FILES ARE NUMBERED, NOT PADDED TO A FIXED WIDTH. padStart(3) stops
// padding at 999, so page 1000 is `match-1000.json`, and the library crossed
// that on 2026-08-14. Two things broke at once and both were silent:
//
//   1. every reader filtered on `match-\d{3}\.json`, exactly three digits, so
//      183 pages written that run were invisible to the repricer, the topup
//      and the tests, while the summary counted them;
//   2. `.sort()` on filenames is LEXICOGRAPHIC, so `match-1000.json` sorts
//      before `match-892.json`, and every reader takes the array index as the
//      page number.
//
// Re-padding the old files to a wider name is NOT available: a board's
// `page:idx` is the seen-cycle key on every player's device, so a page that
// changes name resets somebody's no-repeat record. So the name stays as
// written and the ORDER is computed from the number inside it.
export const MATCH_PAGE_RE = /^match-(\d+)\.json$/;

/** Every page file in PAGE-NUMBER order, so the array index is the page. */
export function matchPageNames(dir = OUT_DIR) {
  return readdirSync(dir)
    .map((f) => { const m = MATCH_PAGE_RE.exec(f); return m ? { f, n: Number(m[1]) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.f);
}

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

  // ONE FILE PER CORNER, not per shape (his ruling 2026-08-14). The bucket a
  // row lands in comes from matchShardFileForRow, which reads matchCornerKey,
  // which is the same rule boardMatchesRules filters on. Deriving the filename
  // from the corner rather than composing it here is what stops the writer and
  // the deal ever disagreeing about where a row lives.
  const byShard = new Map();
  for (let i = 0; i < parsed.length; i++) {
    const file = matchShardFileForRow(parsed[i]);
    if (!byShard.has(file)) byShard.set(file, []);
    byShard.get(file).push(rows[i]);
  }
  // Kept keyed by SHAPE for the summary, because that is what the sheet's
  // supply line reads and it has no use for 900 per-corner counts; the corner
  // list right below already carries the fine grain.
  const shards = {};
  for (const p of parsed) shards[p.shape] = (shards[p.shape] || 0) + 1;

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
    for (const [file, shardRows] of byShard) {
      writeFileSync(new URL(file, OUT_DIR),
        JSON.stringify({ parModel: fp, featureKeys, rows: shardRows }));
    }
    writeFileSync(SUMMARY_FILE, JSON.stringify(summary));
    if (existsSync(LEGACY_INDEX_FILE)) rmSync(LEGACY_INDEX_FILE);
    // The per-SHAPE shards this replaces. Left behind they would be served
    // forever, stale from the first re-price, and a client that still asked
    // for one would deal boards priced under a model nobody runs any more.
    for (const f of readdirSync(OUT_DIR)) {
      if (/^match-index-.*\.json$/.test(f)) rmSync(new URL(f, OUT_DIR));
    }
    // And any CORNER SHARD whose corner no longer exists. A corner empties
    // when its last board leaves, which nothing did until boards started being
    // evicted; the file would otherwise outlive the corner and keep serving
    // rows for boards no page holds. Found by the library test after the
    // unfit-rect eviction: 917 shard files against 853 occupied corners.
    for (const f of readdirSync(OUT_DIR)) {
      if (/^mx-.+\.json$/.test(f) && !byShard.has(f)) rmSync(new URL(f, OUT_DIR));
    }
  }
  return {
    boards: rows.length, pages: pages.length, shards,
    corners: corners.length, shardFiles: byShard.size,
  };
}
