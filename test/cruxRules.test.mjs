// cruxes/{date} rules structure contract. The crux teaser is precomputed at
// generation and world-readable so the ?crux= share route works logged-out.
// The payload shape must stay pinned: a plain daily date key (never the
// weekly suffix), the required teaser fields, the server-sentinel timestamp,
// and a strict $other catch-all so no unvalidated field can ride in.
// Companion to test/cruxExtract.test.mjs.
//
// REGRESSION (issue #206): this block used to grant `auth != null &&
// !data.exists()` — anonymous, write-once — with NO client writer behind it.
// The rule for the family is that the anonymous write-once form is granted
// only where a real first-client fallback writer exists; this one was cloned
// from dailyMeta, which has one, and cruxes does not. Measured live at the
// time of the fix: 56 past dates carried a canonical board and no crux, each
// permanently claimable by anyone who minted an anonymous session, on a
// world-readable path the share route renders verbatim under the GregSweeper
// masthead. Both legitimate writers also authenticated anonymously, so
// neither could ever replace a node someone else had taken.
//
// Run: node --test test/cruxRules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;
const srcOf = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('REGRESSION: cruxes is world-readable and writable by NOBODY', () => {
  const node = rules.cruxes;
  assert.ok(node, 'cruxes block missing');
  assert.equal(node['.read'], true, 'the teaser route reads logged-out — must be public');
  assert.equal(node.$date?.['.write'], false,
    'no client may write a crux: the only writers are service-account scripts');

  // The sibling this was corrected to match, so the pair cannot drift apart.
  assert.equal(rules.boardHeatmap?.$date?.['.write'], false,
    'boardHeatmap is the precedent — a node with no client writer grants no client write');

  const dateRe = node.$date?.['.validate'];
  assert.ok(dateRe.includes('\\d{4}-\\d{2}-\\d{2}'), 'must validate a YYYY-MM-DD key');
  assert.ok(!dateRe.includes('weekly_first'),
    'crux date key is daily-only (the teaser never shows weekly)');
});

test('the nodes that DO grant an anonymous write still have a client writer', () => {
  // The question that should have been asked of cruxes when it was cloned.
  // Each of these is legitimate; the assertion names the writer so a
  // future reader can check the claim rather than trust the lineage.
  const src = srcOf('../src/firebase/dailyBoardSync.js')
    + srcOf('../src/firebase/weeklyBoardSync.js')
    + srcOf('../src/firebase/firebaseLeaderboard.js')
    + srcOf('../src/firebase/firebaseMatch.js');
  for (const [node, writer] of [
    ['dailyBoard', 'saveDailyBoard'],
    ['weeklyBoard', 'saveWeeklyBoard'],
    ['dailyMeta', 'dailyMeta'],
    // A match node is the SANCTIONED case, not an exception to it: the host
    // is a real first-client writer, and there is no service account behind
    // this path at all. The write-once form is what makes the boards frozen
    // from the moment anyone can join them.
    ['matches', 'createMatch'],
    ['matchCodes', 'createMatch'],
  ]) {
    // Resolve the node's wildcard by NAME rather than guessing it: the
    // original pair of `?? rules[node]?.['$date']` was the same lookup twice,
    // so weeklyBoard (keyed $weekStart) silently resolved to undefined and
    // was never actually checked against its writer.
    const wildcard = Object.keys(rules[node] || {}).find((k) => k.startsWith('$'));
    assert.ok(wildcard, `${node} has no wildcard child — this check is inert`);
    const w = rules[node][wildcard]['.write'];
    if (w === false) continue;   // tightened since; nothing to justify
    assert.ok(w, `${node}/${wildcard} has no write rule — this check is inert`);
    assert.match(src, new RegExp(writer),
      `${node} grants a client write, so ${writer} must exist to use it`);
  }
});

test('the match node write is write-ONCE and host-only, like every board node', () => {
  // The grant's whole safety argument: it can be taken exactly once, by the
  // player who names themselves host. After that the node's own write is
  // false and only the per-uid player slots remain writable.
  const w = rules.matches?.$matchId?.['.write'];
  assert.match(w, /!data\.exists\(\)/, 'a match node must be write-once');
  assert.match(w, /newData\.child\('host'\)\.val\(\) === auth\.uid/,
    'and its creator must be the host it names');
});

test('no client module writes a crux', () => {
  // The other half of the grant's justification, from the client side: if a
  // fallback writer ever appears, the rule and this test have to be revisited
  // together rather than one of them quietly winning.
  const root = new URL('../src/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));

  // READS are fine and expected — loadCrux is what the share route uses. Only
  // a write verb applied to a cruxes ref is the thing the rules now refuse.
  const write = /ref\([^)]*cruxes[^)]*\)\s*\.\s*(set|update|push|remove|transaction)\s*\(/;
  let readers = 0;
  for (const rel of files) {
    const src = readFileSync(new URL(rel, root), 'utf8');
    if (/ref\([^)]*cruxes/.test(src)) readers++;
    assert.ok(!write.test(src),
      `src/${rel} WRITES cruxes — the rules refuse it, so this cannot work`);
  }
  // Non-vacuity: the scan must be finding the cruxes refs at all, or it is
  // asserting nothing. loadCrux is the one legitimate reader.
  assert.ok(readers >= 1, 'the scan found no cruxes ref anywhere — the pattern has gone stale');
});

test('the crux writers use the service account, and only for the crux', () => {
  const shared = srcOf('../scripts/crux-write.mjs');
  assert.match(shared, /access_token=/, 'a service-account token goes in access_token, not auth');
  assert.match(shared, /cruxExists/,
    'a service account bypasses the rules, so write-once has to be re-established by hand');

  const pre = srcOf('../scripts/precompute-daily-board.mjs');
  assert.match(pre, /mintCruxToken\(\{ required: false \}\)/,
    'the nightly must fail SOFT on the crux — a missing secret may never cost the day its board');
  // The board and the meta keep the anonymous write-once path they have a
  // fallback writer for. That narrowness is the whole risk argument.
  assert.match(pre, /dailyBoard\/\$\{date\}\.json\?auth=/, 'the board write stays anonymous');
  assert.match(pre, /dailyMeta\/\$\{date\}\.json\?auth=/, 'and so does the meta write');

  assert.match(srcOf('../scripts/backfill-cruxes.mjs'), /mintCruxToken\(\{ required: true \}\)/,
    'the backfill does nothing but cruxes, so a missing secret must fail loudly');
});

test('cruxes.$date: required teaser fields are pinned', () => {
  const v = rules.cruxes?.$date?.['.validate'];
  for (const field of ['rows', 'cols', 'cells', 'answer', 'sources', 'tier', 'writtenAt']) {
    assert.ok(v.includes(`'${field}'`), `${field} must be a required child`);
  }
});

test('cruxes.$date: tier bounded 1..3, answer is an {r,c} pair', () => {
  const node = rules.cruxes?.$date;
  assert.ok(node.tier?.['.validate']?.includes('>= 1 && newData.val() <= 3'),
    'tier must be a 1..3 technique level');
  const ans = node.answer;
  assert.ok(ans?.['.validate']?.includes("'r'") && ans['.validate'].includes("'c'"),
    'answer must require r and c');
  assert.equal(ans?.$other?.['.validate'], false, 'answer must reject extra keys');
});

test('cruxes.$date: walls is an optional, whitelisted field', () => {
  const node = rules.cruxes?.$date;
  assert.ok(node.walls, 'walls must be whitelisted (the strict $other:false would reject it otherwise)');
  assert.ok(!node['.validate'].includes("'walls'"),
    'walls stays optional — boards without walls omit it');
});

test('cruxes.$date: server-sentinel timestamp + strict whitelist', () => {
  const node = rules.cruxes?.$date;
  assert.equal(node.writtenAt?.['.validate'], 'newData.val() === now',
    'writtenAt must be the ServerValue.TIMESTAMP sentinel only');
  assert.equal(node.$other?.['.validate'], false,
    'strict $other catch-all must survive so no unvalidated field rides in');
});
