// Remove every stored rect board a phone cannot show, from both libraries.
//
//   node scripts/evict-unfit-rect-boards.mjs [--dry-run]
//
// WHY. `BOARD_WIDTH_CAP` capped COLUMNS and nothing capped rows, so rect specs
// aimed at nothing vertically while the lattices were held to
// `boardFitsPhone`. Two heights are in play and the gap is where those boards
// landed: the renderer sizes cells to 70vh (502px at the reference) and a
// phone showing its own URL bar and toolbar displays 462px. Measured on the
// shipped Climb library, 299 of 767 rect boards stood 1.1 to 1.6 cells taller
// than the visible area, which is his report ("one cell too long, maybe 2") to
// within a cell. The cap also moved 12 -> 11 (his ruling), which retires the
// widest boards on top of that.
//
// `rectFitsPhone` in boardFit.js is the single rule; this script is only the
// one-time sweep that applies it to what is already stored. New generation is
// gated at the source.
//
// HIS RULING: DELETE AND RENUMBER, rather than hide the boards behind an index
// filter. That reclaims the disk and leaves no unreachable rows, at the cost
// below.
//
// THE COST, AND WHAT IS DONE ABOUT IT. Deleting shifts every later board's
// position, and two seen-cycles are keyed by POSITION:
//
//   - the match library's, by `page:idx`
//   - the Climb ENDLESS library's, by page
//
// Left alone those records would survive and point at DIFFERENT boards, so a
// player's no-repeat history would quietly start lying. So both are RESET
// through an epoch marker, the same mechanism `challengeSeenEpoch` already
// uses: a client clears the affected set once, on next load. A reset record is
// honest where a stale one is not, and the moment to spend it is now, with ~70
// match boards played across everyone.
//
// The Climb's LEVEL bins need none of this: they key their seen-cycle by SEED,
// which renumbering does not touch.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rectFitsPhone } from '../src/logic/boardFit.js';
import { packPayload } from '../src/logic/boardPack.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import {
  OUT_DIR as MATCH_DIR, matchPageNames, matchPageFile, writeMatchIndexFiles,
} from './match-index-files.mjs';

const CLIMB_DIR = new URL('./data/climb-library/', import.meta.url);
const DRY = process.argv.includes('--dry-run');
const PAGE_SIZE = 16;

/** A stored board's dims, whichever way its spec spells them. */
function dimsOf(board) {
  const sp = (board && board.spec) || {};
  const rows = sp.rows ?? sp.M;
  const cols = sp.cols ?? sp.N;
  return { shape: sp.shape, rows, cols };
}

/** Keep every non-rect board; keep a rect board only if a phone can show it. */
export function boardIsFit(board) {
  const { shape, rows, cols } = dimsOf(board);
  if (shape !== 'rect') return true;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return true;
  return rectFitsPhone(rows, cols);
}

function sweepClimb() {
  const names = readdirSync(CLIMB_DIR).filter((f) => /^(level-\d+|endless-\d+)\.json$/.test(f)).sort();
  let removed = 0;
  let kept = 0;
  // Split out for the epoch verdict: level bins key their seen-cycles by
  // SEED, so an eviction there owes nothing, while the endless pages are
  // position-keyed and any removal from one stales every device's cycle.
  let endlessRemoved = 0;
  const emptied = [];
  for (const name of names) {
    const url = new URL(name, CLIMB_DIR);
    const file = JSON.parse(readFileSync(url, 'utf8'));
    const before = (file.boards || []).length;
    const after = (file.boards || []).filter(boardIsFit);
    removed += before - after.length;
    if (name.startsWith('endless-')) endlessRemoved += before - after.length;
    kept += after.length;
    if (after.length !== before) {
      file.boards = after;
      if (after.length === 0) emptied.push(name);
      if (!DRY) writeFileSync(url, JSON.stringify(file));
    }
  }
  // The endless index carries PER-PAGE COUNTS, which the deal reads to weigh
  // pages without fetching them. Evicting from a page changes those counts, so
  // an index left alone describes a library that no longer exists and the deal
  // weighs against boards that are gone.
  const endlessNames = readdirSync(CLIMB_DIR)
    .filter((f) => /^endless-\d+\.json$/.test(f)).sort();
  const counts = endlessNames.map((f) => (JSON.parse(readFileSync(new URL(f, CLIMB_DIR), 'utf8')).boards || []).length);
  const idxUrl = new URL('endless-index.json', CLIMB_DIR);
  const idx = JSON.parse(readFileSync(idxUrl, 'utf8'));
  const rebuilt = {
    ...idx,
    boards: counts.reduce((a, b) => a + b, 0),
    pages: counts.length,
    counts,
  };
  if (!DRY) writeFileSync(idxUrl, JSON.stringify(rebuilt));
  return { removed, kept, emptied, endlessRemoved, endlessBoards: rebuilt.boards };
}

function sweepMatch() {
  const names = matchPageNames();
  const keep = [];
  let removed = 0;
  for (const name of names) {
    for (const b of JSON.parse(readFileSync(new URL(name, MATCH_DIR), 'utf8')).boards) {
      if (boardIsFit(b)) keep.push(b); else removed++;
    }
  }
  // NOTHING EVICTED means NOTHING CHANGES. The repage below renumbers every
  // surviving board's page:idx, the seen-cycle key on every device, a cost
  // his ruling accepts only when a deletion forces it. The #350 sweep (a
  // Climb-only eviction) reached here with removed = 0 and rewrote 1,627
  // match pages as pure churn, which would have invalidated every player's
  // no-repeat memory for nothing; the write was reverted before commit and
  // this guard is what makes the mistake unrepeatable.
  if (removed === 0) {
    return { removed, kept: keep.length, pagesBefore: names.length, pagesAfter: names.length, corners: null };
  }
  // Re-paged from scratch, which is the renumbering his ruling accepts. Order
  // is PRESERVED (the surviving boards stay in their original sequence) so the
  // churn is the minimum the deletion forces, rather than a re-sort on top.
  const pages = [];
  for (let i = 0; i < keep.length; i += PAGE_SIZE) pages.push(keep.slice(i, i + PAGE_SIZE));
  const fp = modelFingerprint();
  if (!DRY) {
    pages.forEach((boards, p) => {
      const packed = boards.map((b) => (b && b.payload ? { ...b, payload: packPayload(b.payload) } : b));
      writeFileSync(matchPageFile(p), JSON.stringify({ page: p, parModel: fp, boards: packed }));
    });
    // Pages beyond the new count are stale files, not empty ones: leaving them
    // would have matchPageNames read boards that no index knows about.
    for (const name of names.slice(pages.length)) unlinkSync(new URL(name, MATCH_DIR));
  }
  const written = writeMatchIndexFiles(pages, fp, { dry: DRY });
  return { removed, kept: keep.length, pagesBefore: names.length, pagesAfter: pages.length, corners: written.corners };
}

function main() {
  const climb = sweepClimb();
  console.log(`climb-library: ${climb.removed} board(s) evicted, ${climb.kept} kept`
    + (climb.emptied.length ? `; ${climb.emptied.length} file(s) now EMPTY: ${climb.emptied.slice(0, 6).join(', ')}` : ''));
  const match = sweepMatch();
  console.log(`match-library: ${match.removed} board(s) evicted, ${match.kept} kept;`
    + (match.corners === null ? ' untouched (nothing to evict)'
      : ` pages ${match.pagesBefore} -> ${match.pagesAfter}, ${match.corners} corners indexed`));
  console.log(DRY ? '(dry run: nothing written)'
    : match.removed === 0 && climb.endlessRemoved === 0
      ? 'No match or endless positions moved; no seen epoch is owed (Climb level bins key by seed).'
      : 'BUMP THE SEEN EPOCH: match and endless seen-cycles are position-keyed and are now stale.');
}

const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) main();
