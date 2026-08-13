// Write src/logic/challengePool.js from the search cache.
//
// Splits the two tables at their markers and leaves everything else in the
// file alone, so the module's own documentation is not something this script
// has to reproduce. The markers are load-bearing: patching between anchors is
// the same discipline the R refit uses on difficulty.js, and for the same
// reason — a regenerated table must never be able to eat the prose around it.
//
//   node scripts/write-challenge-pool.mjs            # both tables
//   node scripts/write-challenge-pool.mjs --only endless
//   node scripts/write-challenge-pool.mjs --dry-run
//
// RE-EMIT ONE TABLE, NOT BOTH, when only one of them has a defect. The two
// pools are emitted by the same function over the same cache but they answer
// different questions, and a re-emit is not free: every face the emitter
// stops shipping is a face the climb library above it has to re-bin, and
// every new face needs a capture before the nightly re-price can run at all.
// So a fix aimed at the endless pool should cost the endless pool.
//
// That is not hypothetical. The 2026-08-13 slice-quota fix was aimed at the
// endless table, where a shape whose whole price range sits in one slice was
// capped at an eighth of its allowance and rhombille came out holding one
// entry. Re-emitting BOTH tables took the ladder from 400 entries to 590 as
// a side effect, which broke three tests that pin real properties of the
// ladder's composition, for a defect the ladder does not have.
//
// ASSERT BEFORE YOU REPLACE. A str.replace with no assertion silently does
// nothing, which has cost this project a dead break-test and a missing import
// in one sitting; both markers are checked before either is written.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_PATH = path.join(__dirname, '..', 'src', 'logic', 'challengePool.js');
const SEARCH = path.join(__dirname, 'search-endless-specs.mjs');
const DRY = process.argv.includes('--dry-run');

const TABLES = { ladder: 'POOL', endless: 'ENDLESS' };
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
if (ONLY && !TABLES[ONLY]) {
  console.error(`--only takes one of: ${Object.keys(TABLES).join(', ')}`);
  process.exit(1);
}
const WANTED = ONLY ? [ONLY] : Object.keys(TABLES);

function emit(which) {
  const out = execFileSync(process.execPath, [SEARCH, '--emit', which], { encoding: 'utf8' });
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith('export const'));
  const end = lines.findIndex((l) => l.trim() === ']);');
  if (start < 0 || end < 0) throw new Error(`could not parse --emit ${which} output`);
  return lines.slice(start, end + 1).join('\n');
}

function splice(src, name, body) {
  const open = `// ${name}:START`;
  const close = `// ${name}:END`;
  const i = src.indexOf(open);
  const j = src.indexOf(close);
  if (i < 0 || j < 0) throw new Error(`${name} markers missing from challengePool.js`);
  const head = src.slice(0, src.indexOf('\n', i) + 1);
  return head + body + '\n' + src.slice(j);
}

// Both markers are still CHECKED even when only one table is rewritten: the
// assert-before-you-replace discipline is about the file being the shape this
// script expects, not about which half of it is being touched today.
let src = fs.readFileSync(POOL_PATH, 'utf8');
for (const marker of Object.values(TABLES)) {
  if (src.indexOf(`// ${marker}:START`) < 0 || src.indexOf(`// ${marker}:END`) < 0) {
    throw new Error(`${marker} markers missing from challengePool.js`);
  }
}

const count = (s) => (s.match(/^  E\(/gm) || []).length;
for (const which of WANTED) {
  const body = emit(which);
  src = splice(src, TABLES[which], body);
  console.log(`${which} pool ${count(body)} entries`);
}
for (const which of Object.keys(TABLES)) {
  if (!WANTED.includes(which)) console.log(`${which} pool left as committed (--only ${ONLY})`);
}
if (DRY) { console.log('(dry run, nothing written)'); process.exit(0); }
fs.writeFileSync(POOL_PATH, src);
console.log(`wrote ${path.relative(process.cwd(), POOL_PATH)}`);
