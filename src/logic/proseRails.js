// ── The journal's writing rails, as pure predicates ──────────────────
// ONE copy of Christopher's writing rulings (the 2026-07-12 voice rules,
// the 2026-08-11 verb rulings), shared by every consumer that must
// never drift: the pool guard tests (test/journalProse.test.mjs), the
// nightly AI-rewrite validator (journalRewrite.js, called by
// scripts/rewrite-journal-entry.mjs), and the client-side re-check
// before a shipped paragraph renders. The rails lived inline in the
// test file until the rewrite needed them at runtime; two copies of a
// rail is how a test and a validator drift apart, so the checks moved
// here and the test now imports them.
//
// Every function returns a list of violation strings (empty = clean).
// Nothing here throws, asserts, or reads the DOM; consumers decide what
// a violation costs (a test failure, a discarded model output).
//
// Browser note: this module SHIPS (journalView imports it through
// journalRewrite), so no regex lookbehind anywhere. The test file's
// original `(?<!study )` and `(?<=[.?!])` patterns are re-expressed as
// plain scans; older Safari parses the whole module or the journal
// never loads. The dash characters under test appear only as \u escapes
// so the source itself stays free of them.

// Hedge words, at most ONE per sentence (hedge stacking reads as fake).
// /g so match() returns every hit; use hedgesIn(), never .test(), on
// this regex (a /g regex's lastIndex makes .test() stateful).
const HEDGES = /\b(might|maybe|probably|perhaps|possibly|likely|seems?|appears?|suspect(?:ed)?|presumably|I think|I guess)\b/gi;

export function hedgesIn(sentence) {
  return String(sentence).match(HEDGES) || [];
}

// "Nothing" as a stand-in for the number is banned: the bound is 0%
// (Christopher's ruling, 2026-07-12). Ordinary uses ("nothing left to
// squeeze") stay legal; these are the quantity phrasings.
export const NOTHING_AS_NUMBER = /\b(between nothing|nothing to about|nothing at all|almost nothing|nearly nothing|nothing much)\b/i;

// Sentences describing data, estimates, bands, or the model use
// measurement verbs (Christopher's ruling, 2026-07-12: "Scientists
// don't write with such imprecise verbs"). This list pins the exact
// phrasings the verb audit removed, body and emotion verbs on numbers,
// and invented instruments, so they can't creep back in.
export const IMPRECISE_VERBS = /(\bate\b|breathe|frown|wiggle|wander|wobbl|firmed up|\bmeter\b|needle|for the pot|keeps the desk|math keeps|pushing back|sat still|range came in|band came in|changed hands|shrug|grew doubt|misbehav|doubt lives|stands in the hallway)/i;

// The quote frames under which a hypothesis (and therefore a player
// mention) may appear: the entry quotes the written hunch rather than
// asserting behavior. Also what composeEntry's arcSpoken flag keys on.
export const QUOTE_FRAME = /(I wrote|my note|I predicted|I suspected|The Should)/i;

// Complete sentences only (Christopher's ruling 2026-07-12: "It's not
// even complete sentences"). A sentence passes with a finite verb in it
// or as a true imperative; the two sanctioned notations are the lab
// log's datelines and the ledger's Closed/Parked file stamps, both from
// his own spec examples. (lint:allow — this file is rails code and verb
// LEXICONS; adjacent words in a word list read as noun-verb pairs to the
// prose hook, and none of them are prose.) The verb lexicon is curated to the pools'
// closed vocabulary, so this rail is for the POOLS: open-vocabulary
// text (a model's rewrite) legitimately uses verbs outside it, which is
// why the rewrite validator deliberately does not call it.
export const FINITE_VERBS = new Set(('is are was were be been am has have had do does did will would can could should must might '
  + 'stays stayed stay stands stand stood sits sit holds hold held reads read runs run ran comes come came goes go went '
  + 'gets get got keeps keep kept lands land landed left leaves moves move moved narrows narrowed widens widened widening '
  + 'tightens tightened grew grow grows shrank falls fall fell rises rise rose settles settle settled closes close closed opens open opened '
  + 'picks pick picked drew draws draw takes take took puts put says say said tells tell telling told asks ask asked '
  + 'answers answer answered wrote writes write written predicted suspected measures measure measured knows know knew '
  + 'wants want wanted watches watch waits wait publishes publish hides hide counts count counted costs cost carried '
  + 'carries carry registered registers register showed shows show shown failed fails fail arrives arrive arrived brought '
  + 'brings bring feeds feed fed filed files file aims aim aimed drifts drift drifting resolves resolve rests rest '
  + 'remembers remember matters matter bothers bother refuses refuse budge budged pinned pins pin surprises surprise '
  + 'survives survive teaches teach taught turns turn turned dies die died limps limp outranks outrank owes owe makes '
  + 'make made means mean meant pays pay paid spends spend spent thought think thinks checks check checked ranking ranks '
  + 'rank ranked listening listened ordered orders order dodges dodge talked talks talk signed slows slow helps help '
  + 'helped looks look looked started starts start stopped stops stop found finds find blinks blink blinked points point '
  + 'pointed converges converge converged updated update updates amounts amount covers cover covered tracks track tracked '
  + 'plotted bets bet lets let seems seem becomes become became needs need needed works work worked disagrees disagree '
  + 'disagreed agrees agree agreed sides side sided siding loses lose lost enjoys enjoy ate eats eat wonder wonders call '
  + 'calls called wins win won lies lie lay figures figure figured happens happen happened wishes wish wished doubles '
  + 'double squeeze squeezed bills bill billed notes note noted records record recorded adds add added gives give gave '
  + 'given continues continue continued').split(' ').map(w => w.toLowerCase()));

export const CONTRACTION_VERB = /(\b\w+’(s|re|ll|d|ve|m)\b|n’t\b|’s\b)/;
export const NOTATION = /^((Closed|Parked) (\{closedDate\}|[A-Z][a-z]{2} \d{1,2})|[A-Z][a-z]{2} \d{1,2})$/;

// Sentence boundaries: whitespace directly after . ? or !, the same
// rule as the original lookbehind split (a decimal like 3.5 has no
// whitespace after its period, so it never splits).
export function splitSentences(text) {
  const s = String(text);
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if ((s[i] === '.' || s[i] === '?' || s[i] === '!') && i + 1 < s.length && /\s/.test(s[i + 1])) {
      out.push(s.slice(start, i + 1));
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      start = j;
      i = j - 1;
    }
  }
  if (start < s.length) {
    const tail = s.slice(start);
    if (tail.trim()) out.push(tail);
  }
  return out;
}

export function digitRuns(s) {
  return String(s).match(/\d+(?:\.\d+)?/g) || [];
}

// Every digit run a fact object can vouch for. The digit-honesty rail:
// any digit sequence in rendered prose must appear among these values.
export function allowedDigitRuns(facts) {
  const allowed = new Set();
  for (const v of Object.values(facts || {})) {
    if (v === null || v === undefined) continue;
    for (const run of digitRuns(v)) allowed.add(run);
  }
  return allowed;
}

export function digitViolations(text, facts) {
  const allowed = allowedDigitRuns(facts);
  const out = [];
  for (const run of digitRuns(text)) {
    if (!allowed.has(run)) out.push(`digit "${run}" has no source fact`);
  }
  return out;
}

export function hedgeViolations(text) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    const hedges = hedgesIn(sentence);
    if (hedges.length > 1) out.push(`hedge stack (${hedges.join(', ')}) in: "${sentence}"`);
  }
  return out;
}

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

export function dashViolations(text) {
  const out = [];
  if (String(text).includes(EM_DASH)) out.push('em-dash');
  if (String(text).includes(EN_DASH)) out.push('en-dash');
  return out;
}

// Day counts must be study days; a bare "Day N" reads as calendar days.
// Lookbehind-free form of the original negative-lookbehind pattern.
export function dayCountViolations(text) {
  const s = String(text);
  const re = /\bday\s+\d/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const before = s.slice(Math.max(0, m.index - 6), m.index);
    if (!/study $/i.test(before)) return ['bare day-count (say "study day N")'];
  }
  return [];
}

// Nothing ties a finding to TODAY'S BOARD (boards generate days ahead
// under earlier targets, the fieldnote-drift class).
export function fieldnoteViolations(text) {
  return /today.s board/i.test(text) ? ['claim about today’s board'] : [];
}

export function templateHoleViolations(text) {
  return /\{[A-Za-z]+\}/.test(text) ? ['unresolved template hole'] : [];
}

export function nothingAsNumberViolations(text) {
  return NOTHING_AS_NUMBER.test(text) ? ['say 0%, not "nothing"'] : [];
}

export function impreciseVerbViolations(text) {
  const m = String(text).match(IMPRECISE_VERBS);
  return m ? [`imprecise verb on a measurement ("${m[0]}")`] : [];
}

// Greg writes in the first person and never names himself in the third
// (framing copy like captions is exempt and does not call this).
export function thirdPersonViolations(text) {
  return /\bGreg\b/.test(text) ? ['third-person Greg in first-person prose'] : [];
}

// Player behavior is never claimed from a band: a sentence may mention
// players only while quoting the written hypothesis.
export function playerClaimViolations(text) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    if (/\bplayers?\b/i.test(sentence) && !QUOTE_FRAME.test(sentence)) {
      out.push(`player-behavior claim outside a quoted hypothesis: "${sentence}"`);
    }
  }
  return out;
}

// The finite-verb rail (pool text only, see FINITE_VERBS above).
export function incompleteSentences(text) {
  const out = [];
  for (const raw of splitSentences(text)) {
    const sentence = raw.replace(/[.?!…]+$/, '').trim();
    if (!sentence || NOTATION.test(sentence)) continue;
    if (CONTRACTION_VERB.test(sentence)) continue;
    const hasVerb = sentence.replace(/\{[A-Za-z]+\}/g, ' ')
      .toLowerCase().split(/[^a-z-]+/)
      .some(w => FINITE_VERBS.has(w));
    if (!hasVerb) out.push(`sentence without a finite verb: "${sentence}"`);
  }
  return out;
}

// ── Composed policies ─────────────────────────────────────────────────
// Which rails apply to which surface is a policy each consumer states
// once, here, in one file, so a difference between surfaces is a
// visible decision rather than drift.

// The pool guard: every raw template line in journalProse's pools.
export function checkPoolLine(line) {
  const out = [
    ...dashViolations(line),
    ...thirdPersonViolations(line),
    ...fieldnoteViolations(line),
    ...dayCountViolations(line),
    ...playerClaimViolations(line),
    ...hedgeViolations(line),
    ...nothingAsNumberViolations(line),
    ...impreciseVerbViolations(line),
    ...incompleteSentences(line),
  ];
  if (String(line).replace(/\{[A-Za-z]+\}/g, '').trim().length < 10) out.push('thin pool line');
  return out;
}

// Rendered prose (a composed entry, a ledger line, a log line): the
// original assertProseRails set, plus digit honesty when a fact object
// is supplied.
export function checkRenderedProse(text, facts = null) {
  const out = [
    ...dashViolations(text),
    ...fieldnoteViolations(text),
    ...dayCountViolations(text),
    ...templateHoleViolations(text),
    ...nothingAsNumberViolations(text),
    ...impreciseVerbViolations(text),
    ...incompleteSentences(text),
  ];
  if (facts) out.push(...digitViolations(text, facts));
  return out;
}
