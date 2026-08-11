// Greg's Journal — the nightly AI rewrite (2026-08-11). The honesty
// rails flip from generator constraints to an OUTPUT VALIDATOR here:
// a model's paragraph ships only when every digit traces to the fact
// object, every source digit survives, and the 2026-07-12 voice rules
// hold. The validator, the hash keying, and the client-side re-check
// are all under test, plus the invariant that makes the fallback safe:
// every entry the beat engine composes passes its own validator, so a
// rejected or stale rewrite always has an honest stand-in.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const {
  REWRITE_FORMAT, REWRITE_ARTIFACT_PATH, MIN_SOURCE_CHARS,
  normalizeModelOutput, rewriteViolations, applyJournalRewrite,
  buildRewriteArtifact, buildRewritePrompt,
} = await import('../src/logic/journalRewrite.js');
const { composeEntry, newSession, planJournalScreen, hashStr } = await import('../src/logic/journalProse.js');
const { dashViolations } = await import('../src/logic/proseRails.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EM = '—';
const EN = '–';

// A study whose composed entry is long and digit-bearing (the settling
// sonar shape from the prose tests).
function mkStudy(over = {}) {
  const latest = over.latest ?? { date: '2026-08-02', mean: 0.0428, sd: 0.0203 };
  return {
    id: 'sonarCellCount',
    feature: 'sonarCellCount',
    label: 'sonar',
    unit: 'sonar cell',
    hypothesis: 'placeholder',
    firstStudied: '2026-07-02',
    lastStudied: '2026-08-01',
    studyDayCount: 19,
    allBackfilled: false,
    trajectory: [
      { date: '2026-07-02', mean: 0.043, sd: 0.025, retro: false },
      latest,
    ],
    latest,
    daysIdle: 1,
    cvRank: 1,
    cvCount: 10,
    verdict: { kind: 'settling', deltaPct: 19, copy: 'I’m closing in: my range for this has narrowed 19% since Jul 2.' },
    ...over,
  };
}

function entryFor(study, ctx = { activeFeature: study.feature }) {
  return composeEntry(study, ctx, newSession());
}

// A paragraph that rewrites `entry` legitimately: the entry's own text
// (the identity rewrite). By construction it keeps every digit and
// every rail, so it isolates the machinery under test from prose
// quality.
function identityArtifact(study, entry, extra = {}) {
  return buildRewriteArtifact({
    feature: study.feature,
    date: '2026-08-02',
    entryText: entry.text,
    paragraph: entry.text,
    extra,
  });
}

// ── The validator ─────────────────────────────────────────────────────

test('every composed entry passes its own validator (the fallback is always publishable)', () => {
  const states = [
    mkStudy({}),
    mkStudy({
      feature: 'wormholePairCount', label: 'wormholes', unit: 'wormhole pair',
      verdict: { kind: 'resting', deltaPct: null, copy: 'I’m sure enough about this one to spend my boards elsewhere.' },
      lastStudied: '2026-05-30', studyDayCount: 6, firstStudied: '2026-04-29',
      latest: { date: '2026-08-02', mean: 0.0015, sd: 0.0018 },
      trajectory: [
        { date: '2026-07-02', mean: 0.0015, sd: 0.0018, retro: false },
        { date: '2026-08-02', mean: 0.0015, sd: 0.0018, retro: false },
      ],
    }),
    mkStudy({
      feature: 'mirrorPairCount', label: 'mirrors', unit: 'mirror pair',
      verdict: { kind: 'widened', deltaPct: -46, copy: 'My range got 46% WIDER. More plays brought less certainty. That’s a real finding too: this one is messier than I thought.' },
      latest: { date: '2026-08-02', mean: 0.0249, sd: 0.0158 },
    }),
  ];
  for (const study of states) {
    const entry = entryFor(study);
    const v = rewriteViolations(entry.text, entry.text, entry.facts);
    assert.deepEqual(v, [], `${study.feature}: the composed entry fails its own validator: ${v.join(' | ')}`);
  }
});

test('validator: each rail rejects, and names its reason', () => {
  const study = mkStudy({});
  const entry = entryFor(study);
  const src = entry.text;
  const facts = entry.facts;
  const base = src; // a known-good paragraph to mutate

  const cases = [
    ['invented digit', `${base} The cost lands at 7%.`, /digit "7" has no source fact/],
    ['em-dash', base.replace('. ', `${EM} `), /em-dash/],
    ['en-dash', base.replace('. ', `${EN} `), /en-dash/],
    ['hedge stack', `${base} It likely seems settled.`, /hedge stack/],
    ['player claim', `${base} Players route around it.`, /player-behavior claim/],
    ['today link', `${base} Today’s board tests this.`, /today.s board/i],
    ['bare day count', `${base} Day 3 was quiet.`, /bare day-count/],
    ['third person', `${base} Greg checked the file.`, /third-person Greg/],
    ['markup', `${base} **Important.**`, /markup character/],
    ['multi-line', `${base}\nSecond paragraph.`, /not a single paragraph/],
    ['nothing-as-number', `${base} The cost is almost nothing.`, /0%, not "nothing"/],
    ['imprecise verb', `${base} The estimate wandered.`, /imprecise verb/],
    ['template hole', `${base} The {label} file stays open.`, /unresolved template hole/],
  ];
  for (const [name, text, re] of cases) {
    const v = rewriteViolations(text, src, facts);
    assert.ok(v.length > 0, `${name}: expected a violation`);
    assert.ok(v.some(x => re.test(x)), `${name}: expected ${re}, got: ${v.join(' | ')}`);
  }

  // Dropped source digit: strip one number the source states.
  const firstDigit = (src.match(/\d+(?:\.\d+)?/g) || [])[0];
  assert.ok(firstDigit, 'the fixture entry states at least one number');
  const dropped = src.replaceAll(firstDigit, 'some');
  const v = rewriteViolations(dropped, src, facts);
  assert.ok(v.some(x => x.includes(`source digit "${firstDigit}" was dropped`)),
    `expected a dropped-digit violation, got: ${v.join(' | ')}`);

  // Length bounds.
  assert.ok(rewriteViolations('Too short.', src, facts).some(x => /too short/.test(x)));
  const long = `${base} ${'The range held. '.repeat(40)}`;
  assert.ok(rewriteViolations(long, src, facts).some(x => /too long/.test(x)));

  // Degenerate inputs.
  assert.deepEqual(rewriteViolations('', src, facts), ['empty output']);
  assert.deepEqual(rewriteViolations(null, src, facts), ['empty output']);
  assert.deepEqual(rewriteViolations(base, '', facts), ['no source entry']);
});

test('normalizeModelOutput: fences, wrapping quotes, and newlines collapse; inner content survives', () => {
  assert.equal(normalizeModelOutput('```\nA line.\nAnother.\n```'), 'A line. Another.');
  assert.equal(normalizeModelOutput('"A quoted answer."'), 'A quoted answer.');
  assert.equal(normalizeModelOutput('“Curly quoted.”'), 'Curly quoted.');
  assert.equal(normalizeModelOutput('  spaced\n\nout  '), 'spaced out');
  // A quote inside the paragraph is not a wrapping pair.
  assert.equal(normalizeModelOutput('He said "no" plainly.'), 'He said "no" plainly.');
  assert.equal(normalizeModelOutput(42), '');
});

// ── Keying and the client-side re-check ───────────────────────────────

test('applyJournalRewrite: a matching, valid artifact swaps the text and re-detects arcSpoken', () => {
  const study = mkStudy({});
  const entry = entryFor(study);
  const artifact = identityArtifact(study, entry, { model: 'test', generatedAt: 'x' });
  const swapped = applyJournalRewrite(entry, artifact, study.feature);
  assert.notEqual(swapped, entry, 'a valid artifact produces a new entry object');
  assert.equal(swapped.text, entry.text);
  assert.equal(swapped.rewritten, true);
  assert.equal(swapped.state, entry.state, 'everything but the text and flags is preserved');
  assert.deepEqual(swapped.facts, entry.facts);
  // arcSpoken follows the PARAGRAPH: identity text keeps the entry's own
  // quote-frame reality.
  assert.equal(swapped.arcSpoken, /(I wrote|my note|I predicted|I suspected|The Should)/i.test(entry.text));

  // Determinism: applying twice gives the same result.
  assert.deepEqual(applyJournalRewrite(entry, artifact, study.feature), swapped);
});

test('applyJournalRewrite: every mismatch falls back to the beats unchanged', () => {
  const study = mkStudy({});
  const entry = entryFor(study);
  const good = identityArtifact(study, entry);

  // Stale artifact: built for a DIFFERENT composed entry (yesterday's
  // data). The nightly refit moves the entry; the hash disarms the
  // artifact on every client.
  const yesterday = entryFor(mkStudy({ latest: { date: '2026-08-01', mean: 0.0431, sd: 0.0215 } }));
  const stale = buildRewriteArtifact({
    feature: study.feature, date: '2026-08-01',
    entryText: yesterday.text, paragraph: yesterday.text,
  });
  assert.notEqual(hashStr(yesterday.text), hashStr(entry.text), 'the fixture really did change the entry');
  assert.equal(applyJournalRewrite(entry, stale, study.feature), entry);

  // Feature mismatch (an artifact about another study).
  assert.equal(applyJournalRewrite(entry, { ...good, feature: 'liarCellCount' }, study.feature), entry);
  assert.equal(applyJournalRewrite(entry, good, 'liarCellCount'), entry);

  // Unknown format, missing paragraph, junk artifacts.
  assert.equal(applyJournalRewrite(entry, { ...good, format: 'journal-rewrite-v0' }, study.feature), entry);
  assert.equal(applyJournalRewrite(entry, { ...good, paragraph: null }, study.feature), entry);
  assert.equal(applyJournalRewrite(entry, null, study.feature), entry);
  assert.equal(applyJournalRewrite(entry, 'nonsense', study.feature), entry);

  // REGRESSION: the client re-validates. A TAMPERED paragraph with a
  // correct hash and feature (an invented number spliced into the
  // shipped file) must still fall back — the validator is the last rail
  // between the artifact and the card.
  const tampered = { ...good, paragraph: `${entry.text} The real cost is 99%.` };
  assert.equal(applyJournalRewrite(entry, tampered, study.feature), entry);

  // And the entry itself is never mutated by any of this.
  assert.equal(entry.rewritten, undefined);
});

// ── The prompt ────────────────────────────────────────────────────────

test('buildRewritePrompt: facts, source, hypothesis, and the verb rulings all reach the model', () => {
  const study = mkStudy({ hypothesis: 'A sonar reading covers a wide area but names no cell.' });
  const entry = entryFor(study);
  const prompt = buildRewritePrompt({
    entryText: entry.text, facts: entry.facts, label: study.label, hypothesis: study.hypothesis,
  });
  assert.equal(typeof prompt.system, 'string');
  assert.equal(typeof prompt.user, 'string');
  assert.ok(prompt.user.includes(entry.text), 'the source beats are the material');
  assert.ok(prompt.user.includes(JSON.stringify(entry.facts)), 'the fact object rides along');
  assert.ok(prompt.user.includes(study.hypothesis), 'the written hypothesis is context');
  // The rulings are stated: dashes, data-plural, players, today's board.
  assert.match(prompt.system, /em dash/i);
  assert.match(prompt.system, /data show/i);
  assert.match(prompt.system, /players/i);
  assert.match(prompt.system, /today’s board/i);
  assert.match(prompt.system, /study day/);
  // The prompt itself obeys the dash rule it states.
  assert.deepEqual(dashViolations(prompt.system + prompt.user), []);
});

// ── The shipped artifact and the script glue ──────────────────────────

test('the committed artifact parses, and when fresh it clears the validator', () => {
  const artifact = JSON.parse(readFileSync(join(ROOT, REWRITE_ARTIFACT_PATH), 'utf8'));
  assert.equal(artifact.format, REWRITE_FORMAT);
  assert.equal(typeof artifact.feature, 'string');
  assert.equal(typeof artifact.sourceHash, 'number');
  assert.equal(typeof artifact.paragraph, 'string');

  // The refit writes modelHistory.json and this artifact in ONE commit,
  // so in-repo they are normally in sync; a human PR that changes the
  // compose output legitimately strands the artifact until the next
  // nightly (the hash guard hides it), so staleness is NOT a failure —
  // but a FRESH artifact that fails validation would ship a broken
  // paragraph tonight, and that is.
  const history = JSON.parse(readFileSync(join(ROOT, 'src/logic/modelHistory.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(ROOT, 'src/logic/experimentTarget.json'), 'utf8'));
  const screen = planJournalScreen(history, meta);
  const entry = screen?.active?.entry;
  if (!entry || hashStr(entry.text) !== artifact.sourceHash) return; // stale: disarmed by design
  const v = rewriteViolations(artifact.paragraph, entry.text, entry.facts);
  assert.deepEqual(v, [], `the shipped artifact fails its own rails: ${v.join(' | ')}`);
  const swapped = applyJournalRewrite(entry, artifact, screen.active.study.feature);
  assert.equal(swapped.text, artifact.paragraph, 'a fresh artifact actually renders');
});

test('script end to end (--fixture): composes the same entry, validates, writes the artifact', (t) => {
  const history = JSON.parse(readFileSync(join(ROOT, 'src/logic/modelHistory.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(ROOT, 'src/logic/experimentTarget.json'), 'utf8'));
  const screen = planJournalScreen(history, meta);
  const entry = screen?.active?.entry;
  if (!entry || entry.text.length < MIN_SOURCE_CHARS) {
    t.skip('tonight’s real entry is too short for the rewrite path; nothing to exercise');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'journal-rewrite-'));
  const fixture = join(dir, 'fixture.txt');
  const out = join(dir, 'artifact.json');
  // The identity rewrite as the "model output": passes every rail, so
  // the run must WRITE. A failing fixture must NOT write.
  writeFileSync(fixture, entry.text);
  const log = execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'rewrite-journal-entry.mjs'), '--fixture', fixture, '--out', out,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.match(log, /Wrote /);
  const artifact = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(artifact.format, REWRITE_FORMAT);
  assert.equal(artifact.feature, screen.active.study.feature);
  assert.equal(artifact.sourceHash, hashStr(entry.text), 'the script composed the exact entry this test composed');
  assert.equal(artifact.model, 'fixture');
  const swapped = applyJournalRewrite(entry, artifact, screen.active.study.feature);
  assert.equal(swapped.rewritten, true);

  const badFixture = join(dir, 'bad.txt');
  writeFileSync(badFixture, `${entry.text} The extra cost is 42%.`);
  const badOut = join(dir, 'bad-artifact.json');
  const badLog = execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'rewrite-journal-entry.mjs'), '--fixture', badFixture, '--out', badOut,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.match(badLog, /failed validation/);
  assert.throws(() => readFileSync(badOut), 'a rejected draft writes nothing');
});

test('the artifact JSON is SW-precached beside modelHistory.json', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.ok(sw.includes(`'./${REWRITE_ARTIFACT_PATH}'`),
    'sw.js ASSETS must list the rewrite artifact, or a fresh install 404s at precache');
});
