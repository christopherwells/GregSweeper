// Write src/logic/challengePool.js from the search cache.
//
// Splits the two tables at their markers and leaves everything else in the
// file alone, so the module's own documentation is not something this script
// has to reproduce. The markers are load-bearing: patching between anchors is
// the same discipline the R refit uses on difficulty.js, and for the same
// reason — a regenerated table must never be able to eat the prose around it.
//
//   node scripts/write-challenge-pool.mjs            # both tables
//   node scripts/write-challenge-pool.mjs --dry-run
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

const ladder = emit('ladder');
const endless = emit('endless');
let src = fs.readFileSync(POOL_PATH, 'utf8');
src = splice(src, 'POOL', ladder);
src = splice(src, 'ENDLESS', endless);

const count = (s) => (s.match(/^  E\(/gm) || []).length;
console.log(`ladder pool ${count(ladder)} entries, endless pool ${count(endless)} entries`);
if (DRY) { console.log('(dry run, nothing written)'); process.exit(0); }
fs.writeFileSync(POOL_PATH, src);
console.log(`wrote ${path.relative(process.cwd(), POOL_PATH)}`);
