// ── Greg's Journal, the prose engine ─────────────────────────────────
// Pure, node-tested. Turns the journalFindings derivations into notebook
// entries: a deep card for the active experiment (with a dated lab log
// from consecutive refit-row diffs), one-line past-tense conclusions for
// the closed studies, a queue line from the coverage list, and the full
// parameter table. No DOM, no fetch, journalView/journalReport render
// what this module composes.
//
// HOW AN ENTRY IS BUILT. Every study gets a NARRATIVE STATE computed
// from its data (verdict, hypothesis lean, band class, idle drift). Each
// state owns 2-3 SKELETONS (beat orderings) assigned deterministically
// by feature hash, and every beat draws a phrasing from a seeded pool
// rotated by feature+date (the DAILY_BODIES pattern), same data in,
// same prose out, on every device. A shared per-screen session enforces
// the hard rule that no two entries visible together share a skeleton
// or a closer.
//
// WRITING RAILS (each mechanized in test/journalProse.test.mjs where a
// test can hold it):
//  - Greg's plain first person. ZERO em-dashes (and no en-dash ranges;
//    dates join with "to").
//  - At most ONE hedge word per sentence; every line carries a fact or
//    a stance, never a pure connective.
//  - Greg never states a number, date, or event the input facts don't
//    carry, every digit sequence in rendered prose must exist in the
//    entry's fact object (counts up to twenty render as words via
//    countWord, honest by construction).
//  - Day counts render as "study day N" / "N study days", never a bare
//    "Day N" a reader could mistake for calendar days.
//  - Never claim player BEHAVIOR from a band. A pool line may only
//    mention players inside a quoted hypothesis ("I wrote that…").
//  - Nothing ties a finding to TODAY'S BOARD (boards generate days
//    ahead under earlier targets, the fieldnote-drift class). The
//    queue line frames only what Greg wants data on next.
//  - Sentences whose subject is data, an estimate, a band, or the
//    model use MEASUREMENT VERBS (narrowed, widened, moved, held,
//    landed, reads, runs, settled, registered, resolved). Greg's
//    stances can be colorful; the verbs describing numbers cannot
//    (Christopher's ruling 2026-07-12: no "the model ate", "breathes
//    easier", "wandered", invented meters or needles).
//  - COMPLETE SENTENCES only (Christopher's ruling 2026-07-12: "It's
//    not even complete sentences"). Every sentence has a subject
//    and a finite verb, or is a true imperative. The two sanctioned
//    notations are the lab log's "Jul 12." datelines and the ledger's
//    "Closed May 30." / "Parked Jun 8." file stamps, both from his own
//    spec examples. Telegraphic fragments ("Just width.", "Honest
//    ink.") are banned; the finite-verb guard test enforces it.
//  - Verdicts and estimates stay windowed to live-era (non-retro) fits;
//    everything here reads through journalFindings, which enforces it.

import { featureName, classifySdDelta } from './gregVoice.js';
import { hashString } from './seededRandom.js';
import {
  SCALE_EPOCHS, dedupeHistory, deriveStudyForFeature, buildJournal,
  estimateSummary, estimateLine, estimateUnit, formatShortDate, fmtPct, parameterTable,
} from './journalFindings.js';

export const MAX_LOG_ENTRIES = 6;

// Below ~1% per unit, an effect is a rounding error on a real solve,
// the bar that separates "a real cost" from "about 0%" when a
// hypothesis is graded. Display-only; the fit itself never rounds.
export const NEGLIGIBLE_PCT = 1;

// ── Deterministic machinery ───────────────────────────────────────────

// The repo's one string hash (seededRandom's djb2), coerced unsigned so
// it can index a pool. Stable across sessions and devices; the only
// source of variety in the whole module (no Date.now, no Math.random,
// cross-client determinism depends on it).
export function hashStr(s) {
  return hashString(s) >>> 0;
}

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

// Small counts read as words in notebook prose ("nineteen study days");
// larger ones stay digits and are covered by the digit-honesty test.
export function countWord(n) {
  return Number.isInteger(n) && n >= 0 && n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n);
}

// {token} substitution. A capitalized token ({Label}) capitalizes the
// value. Unresolvable tokens are left in place so _renderable can veto
// the line, a template must never ship with a hole in it.
function tpl(str, facts) {
  return str.replace(/\{([A-Za-z]+)\}/g, (m, key) => {
    const lower = key.charAt(0).toLowerCase() + key.slice(1);
    const v = facts[lower];
    if (v === null || v === undefined) return m;
    const s = String(v);
    return key.charAt(0) === key.charAt(0).toUpperCase()
      ? s.charAt(0).toUpperCase() + s.slice(1)
      : s;
  });
}

function _renderable(str, facts) {
  return !/\{[A-Za-z]+\}/.test(tpl(str, facts));
}

// Per-screen collision tracker: skeleton indices per state, plus the
// closer/ledger templates already spoken. Two entries on one screen
// must never share either (the hard rule); when a pool is exhausted the
// pick wraps rather than going silent.
export function newSession() {
  return { skeletons: new Map(), lines: new Set() };
}

// Deterministic pool pick: start at hash(seed), take the first variant
// whose tokens all resolve and (when a used-set is given) that no other
// entry on this screen has spoken.
function pickLine(pool, seed, facts, usedSet = null) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const start = hashStr(seed) % pool.length;
  let fallback = null;
  for (let i = 0; i < pool.length; i++) {
    const cand = pool[(start + i) % pool.length];
    if (!_renderable(cand, facts)) continue;
    if (fallback === null) fallback = cand;
    if (usedSet && usedSet.has(cand)) continue;
    if (usedSet) usedSet.add(cand);
    return tpl(cand, facts);
  }
  return fallback === null ? null : tpl(fallback, facts);
}

// ── Hypothesis arcs (bespoke, per feature) ────────────────────────────
// Each feature's written hunch crossed with what the data did. `lean`
// grades the band against the hypothesis:
//   cost    , the file predicts a real positive cost
//   zero    , the file predicts almost no cost (mirrors' "Should")
//   faster  , the file predicts a time refund (open areas)
//   size    , the file asks how big; any clean answer settles it
//   fork    , the file offers two outcomes; either clean band answers
//   question, a mechanism question no band sign can settle (compass)
// The lines are keyed by BAND CLASS (pos/zero/neg) with `out` for an
// ambiguous band, so a fork can speak differently per door. Player
// mentions live only inside quoted hypotheses ("I wrote that…").
const ARCS = {
  lockedCellCount: {
    lean: 'cost',
    pos: 'I wrote that waiting should cost time. It does, and the ledger now says how much.',
    zero: 'I wrote that waiting should cost time. The ledger read it back at about 0%.',
    out: 'Waiting costs something. Pinning down how much is the part that keeps taking boards.',
  },
  sonarCellCount: {
    lean: 'cost',
    pos: 'I suspected from the start that a sonar reading helps less than it looks. The data keep agreeing with me.',
    zero: 'I suspected a sonar reading helps less than it looks. The ledger reads even lower: it barely costs anything at all.',
    out: 'I still can’t tell whether the wide reading pays for itself. The file stays open.',
  },
  compassCellCount: {
    lean: 'question',
    out: 'I wrote that I couldn’t tell whether players read the arrow fast or stop to puzzle over it. So far, neither can the model.',
  },
  mirrorPairCount: {
    lean: 'zero',
    pos: 'In this file I wrote that a player who spots the pair should lose almost no time. The top of the range does not read as almost no time. The Should is on notice.',
    zero: 'I wrote that a player who spots the pair should lose almost no time. So far the data let the Should stand.',
    out: 'The Should in my notes is unproven either way. I keep reading the range and it refuses to settle.',
  },
  liarCellCount: {
    lean: 'fork',
    pos: 'My note gave the data two doors: poison, or a rounding error. It picked poison. A wrong number costs real time.',
    zero: 'My note gave the data two doors: poison, or a rounding error. It picked the second. A liar barely moves the clock.',
    out: 'Two doors in my note, poison or a rounding error. The data hasn’t picked one yet.',
  },
  mysteryCellCount: {
    lean: 'cost',
    pos: 'I wrote that missing information has a price. It does, and now I know the rate.',
    zero: 'I wrote that missing information has a price. I measured it, and the price is close to free.',
    out: 'The price of a hidden number is still in dispute. Measurement continues.',
  },
  wormholePairCount: {
    lean: 'cost',
    pos: 'I predicted that splitting one number across two places would slow the reading down. It does.',
    zero: 'I predicted that splitting one number across two places would slow the reading down. The boards talked me out of it.',
    out: 'Split numbers should cost reading time. The ledger hasn’t signed off on that sentence yet.',
  },
  wallEdgeCount: {
    lean: 'size',
    pos: 'My note asked whether the wall discount is small or large. Large enough to bill for, it turns out.',
    zero: 'My note asked whether the wall discount is small or large. The answer came back small, nearly 0% in fact.',
    out: 'Small or large is the whole question in this file, and the file hasn’t answered it.',
  },
  zeroClusterCount: {
    lean: 'faster',
    neg: 'I wrote that open areas should pay time back. They do.',
    zero: 'I wrote that open areas should pay time back. The refund is close to 0%.',
    pos: 'I wrote that open areas should pay time back. The ledger disagrees with the sign, which is worth losing sleep over.',
    out: 'The refund per open area is still an open entry.',
  },
  searchMoves: {
    lean: 'cost',
    pos: 'I wrote that the search moves should be the expensive ones. They are.',
    zero: 'I wrote that the search moves should be the expensive ones. The bill came back smaller than my sentence did.',
    out: 'Expensive or not is still unsettled, one board at a time.',
  },
  patternMoves: {
    lean: 'cost',
    pos: 'I wrote that a practiced read should cost seconds, not tens of seconds. The data agree: the effect is real and small.',
    zero: 'I wrote that a practiced read should cost seconds, not tens of seconds. It barely even costs the seconds.',
    out: 'Practiced reads should be cheap. How cheap is the part I’m still counting.',
  },
  totalMines: {
    lean: 'cost',
    pos: 'The steady cost of density holds up the whole model, and it keeps holding.',
    zero: 'A density coefficient near zero would mean my model is broken. I’d rebuild before I believed it.',
    out: 'The backbone number is drifting, and that gets my attention before anything else does.',
  },
  cellCount: {
    lean: 'cost',
    pos: 'Bigger boards run longer, and the rate is pinned. That’s all I ever asked of this file.',
    zero: 'If board size stopped costing time I’d suspect the clock before the boards.',
    out: 'The size rate drifts a little with every refit. Everything else is measured against it, so I watch it.',
  },
  // ── The arithmetic-load arc (clue-digit shares) ──
  // The pos lines carry proper conviction about the MEASUREMENT and honest
  // doubt about the CAUSE: a digit share is correlational, so a real cost can
  // still be the boards a digit rides on rather than the digit itself. Greg
  // reports the number with a straight face and flags what it cannot yet prove.
  clueShare2: {
    lean: 'zero',
    pos: 'I wrote that a two should read almost as fast as a one. The range puts it a little above that, and I cannot yet split the twos from the boards they sit on.',
    zero: 'I wrote that a two should read almost as fast as a one. The boards let that stand, give or take a rounding error.',
    out: 'Whether a two costs more than a one is the whole question here. The boards have not answered it yet.',
  },
  clueShare3: {
    lean: 'cost',
    pos: 'I predicted that boards leaning on threes would cost more than their size alone, and they do. Whether it is the threes doing the work or the harder boards they ride on, I cannot yet say.',
    zero: 'I predicted that threes would cost more than size alone. The ledger read the charge back as a rounding error.',
    out: 'The threes might cost real time, or barely any. That question is still open.',
  },
  clueShare4: {
    lean: 'size',
    pos: 'My note asked how big the four costs, not whether it exists. The range settled on a real number, and telling the fours apart from the boards around them is the next job.',
    zero: 'My note asked how big the four costs, not whether it exists. The answer landed at a rounding error.',
    out: 'How big the four costs is the open question in this file. The boards have not sized it yet.',
  },
  clueShare5plus: {
    lean: 'zero',
    pos: 'I wrote that a high number is nearly all mines and resolves fast, so it should barely cost. The range reads higher than that, and I want far more of these boards before I trust it.',
    zero: 'I wrote that a high number is nearly all mines and resolves fast. The data agree, and the cost lands at a rounding error.',
    out: 'The high numbers are rare, so their cost is slow to pin down. The file stays open while I gather them.',
  },
};

// A studied feature with no bespoke file yet, honest generic, never a
// fabricated mechanism.
const ARC_GENERIC = {
  lean: 'size',
  pos: 'My note on this one was a question mark. The data answered with a real cost.',
  zero: 'My note on this one was a question mark. The data came back at about 0%.',
  neg: 'My note on this one was a question mark. The data answered with a small refund.',
  out: 'This file is mostly a question mark, and the data hasn’t answered it yet.',
};

function _arcFor(feature) {
  return ARCS[feature] || ARC_GENERIC;
}

// ── Narrative state ───────────────────────────────────────────────────

// The ±1 SD band in percent space, graded for prose:
//   neg, the whole band is a refund
//   zero, the band includes 0% and tops out below a rounding error
//   pos, a real cost the band stands behind (a proven sub-1% effect is
//         still pos: calling a band that EXCLUDES zero "about 0%"
//         would contradict the estimate sentence on the same card)
//   ambiguous, straddles zero with a real top end; can't say
export function bandClass(est) {
  if (!est) return 'none';
  if (est.hi <= 0) return 'neg';
  if (est.lo > 0) return 'pos';
  // The negligible bar is a judgment about the PER-UNIT effect, so it
  // scales with the estimate: under the per-ten-tiles voice (2026-08-11)
  // the same tiny per-tile coefficient reads ten-ish times larger, and
  // classifying that against the per-unit bar would flip a study from
  // "zero" to "ambiguous" with nothing about the model having moved.
  // Exact on the log scale, like the scaling itself.
  const bar = (Math.pow(1 + NEGLIGIBLE_PCT / 100, est.scale || 1) - 1) * 100;
  if (est.hi < bar) return 'zero';
  return 'ambiguous';
}

// What the band did to the hypothesis: sided / against / answered
// (size and fork files count any clean answer) / out.
export function resolutionFor(study) {
  const { lean } = _arcFor(study?.feature);
  const band = bandClass(estimateSummary(study));
  if (band === 'none' || band === 'ambiguous' || lean === 'question') return 'out';
  switch (lean) {
    case 'cost': return band === 'pos' ? 'sided' : 'against';
    case 'zero': return band === 'zero' ? 'sided' : band === 'pos' ? 'against' : 'out';
    // A faster-lean's zero band (lo <= 0, tiny top) can hide a real
    // refund below its floor, only a whole-band refund sides with the
    // hypothesis, only a proven cost contradicts it.
    case 'faster': return band === 'neg' ? 'sided' : band === 'pos' ? 'against' : 'out';
    case 'size': return 'answered';
    case 'fork': return band === 'neg' ? 'out' : 'answered';
    default: return 'out';
  }
}

// Drift check for a parked study: did the point estimate leave the band
// it was parked with? The reference fit is the last LIVE fit at or
// before the close date (live-era rail: retrodictions never feed a
// claim); a study closed before the era started measures from the
// era's first fit instead, and the prose names the reference date
// either way so nothing is ambiguous. Null = no drift claim. Two
// renderability gates on top of the statistical one: the story needs
// both endpoints non-negative (a signed-drift sentence would put a
// minus on a player surface; no live feature has a negative mean, and a
// missed narration is honest where a false one never is) and the two
// figures must DIFFER once rounded for display ("read about 3%… reads
// about 3% now" would assert movement and then show identical numbers).
export function driftSinceClose(study) {
  const live = (study?.trajectory || []).filter(p => p && p.retro !== true);
  if (live.length < 2) return null;
  let ref = null;
  if (study.lastStudied) {
    for (const p of live) {
      if (p.date <= study.lastStudied) ref = p;
    }
  }
  if (!ref) ref = live[0];
  const last = live[live.length - 1];
  if (ref.date === last.date) return null;
  if (!(ref.sd > 0) || Math.abs(last.mean - ref.mean) <= ref.sd) return null;
  const pctOf = (m) => (Math.exp(m) - 1) * 100;
  const refPct = pctOf(ref.mean);
  const nowPct = pctOf(last.mean);
  if (refPct < 0 || nowPct < 0) return null;
  if (fmtPct(refPct) === fmtPct(nowPct)) return null;
  return { refDate: ref.date, refMean: ref.mean, nowDate: last.date, nowMean: last.mean };
}

// One state per study. The layer ABOVE classifyVerdict: the verdict
// stays the single honesty primitive (and the chip), the state only
// picks which story shape tells it.
export function narrativeState(study, ctx = {}) {
  const kind = study?.verdict?.kind || 'early';
  if (kind === 'early') return 'early';
  if (ctx.revalidation === true && ctx.activeFeature === study.feature) return 'revalidation';
  const res = resolutionFor(study);
  if (kind === 'resting') {
    if (driftSinceClose(study)) return 'reopened';
    if (res === 'against') return 'closed-lost';
    if (res === 'sided' || res === 'answered') return 'closed-won';
    return 'resting';
  }
  if (kind === 'widened') return 'anomaly';
  return res === 'out' ? 'active-unresolved' : 'grind';
}

// ── Facts ─────────────────────────────────────────────────────────────
// Everything a template may cite, pre-rendered. The digit-honesty test
// reads this object back: any digit sequence in the prose must appear
// among these values.
export function buildFacts(study, ctx = {}) {
  const est = estimateSummary(study);
  const live = (study?.trajectory || []).filter(p => p && p.retro !== true);
  const drift = driftSinceClose(study);
  // Drift lines quote the same per-N-units scale as the estimate, or the
  // sentence would pair a per-ten unit phrase with a per-one percent.
  const pctOfMean = (m) => fmtPct((Math.exp(m * (est?.scale || 1)) - 1) * 100);
  const days = study?.studyDayCount ?? 0;
  // A band whose ends round to the same figure must not render "6% to
  // 6%": nulling lo/hi makes every {lo}/{hi} template unresolvable, so
  // pickLine skips them and the beat falls back to the canonical
  // estimateLine (which has its own equal-ends form).
  let lo = est ? fmtPct(Math.max(0, est.lo)) : null;
  let hi = est ? fmtPct(est.hi) : null;
  if (lo !== null && lo === hi) {
    lo = null;
    hi = null;
  }
  return {
    feature: study?.feature ?? null,
    label: study?.label ?? null,
    // The unit phrase carries the per-ten scale when the estimate does
    // ("ten sonar cells"), so every "per {unit}" template stays honest at
    // either scale without knowing which one it got.
    unit: estimateUnit(study) ?? study?.unit ?? null,
    // "per pair", not "per wormhole pair", for lines whose header
    // already names the feature (the conclusions ledger). Scaled the same
    // way: "per ten pairs" when the estimate is quoted per ten.
    unitShort: study?.unit
      ? (est?.scale === 10 ? `ten ${study.unit.split(' ').pop()}s` : study.unit.split(' ').pop())
      : null,
    days,
    daysWord: days > 0 ? countWord(days) : null,
    first: study?.firstStudied ? formatShortDate(study.firstStudied) : null,
    last: study?.lastStudied ? formatShortDate(study.lastStudied) : null,
    closedDate: study?.lastStudied ? formatShortDate(study.lastStudied) : null,
    windowStart: live.length > 0 ? formatShortDate(live[0].date) : null,
    asOf: est?.asOf ?? study?.lastStudied ?? null,
    pct: est ? fmtPct(est.pct) : null,
    pctAbs: est ? fmtPct(Math.abs(est.pct)) : null,
    lo,
    hi,
    deltaPct: typeof study?.verdict?.deltaPct === 'number' ? Math.abs(study.verdict.deltaPct) : null,
    verdictKind: study?.verdict?.kind ?? 'early',
    refDate: drift ? formatShortDate(drift.refDate) : null,
    refPct: drift ? pctOfMean(drift.refMean) : null,
    nowPct: drift ? pctOfMean(drift.nowMean) : null,
  };
}

// ── Pools ─────────────────────────────────────────────────────────────

const OPENERS = {
  'active-unresolved': [
    '{DaysWord} study days on {label}, and the question in my note is still standing.',
    'The {label} file stays open on purpose.',
    '{DaysWord} study days in, and the {label} estimate still won’t resolve.',
    'The {label} question is still where I left it: open.',
    'Some files close themselves. The {label} file is not one of them.',
  ],
  grind: [
    '{DaysWord} study days on {label}, and the answer is the same every time.',
    'The {label} file reads the same almost every night I open it.',
    '{DaysWord} study days in, {label} keeps telling me the same thing.',
    'The {label} numbers have stopped surprising me. I keep checking anyway.',
    'Every fresh look at {label} gives the same reading.',
  ],
  anomaly: [
    'The {label} file is doing the thing measurement is not supposed to do.',
    'The {label} band is widening when it should be narrowing.',
    'I opened the {label} file expecting progress and found the opposite.',
    'The {label} numbers moved the wrong way, and I want that on the record.',
    'More data went into the {label} file and the uncertainty went up.',
  ],
  'closed-won': [
    'The {label} case is closed.',
    'For the record, the {label} file is settled.',
    'I closed the {label} file on {closedDate}.',
    'The {label} question got its answer.',
    'One more file goes in the done drawer: {label}.',
  ],
  'closed-lost': [
    'For the record, the {label} case is closed and my hunch lost.',
    'The {label} file is closed. The data and I disagreed, and the data won.',
    'Score one for the boards: the {label} file closed against me.',
    'I had a hunch about {label}. The boards had other plans.',
    'The {label} file closes with my prediction face-down.',
  ],
  resting: [
    'The {label} file is parked, not finished.',
    'I set the {label} file down on {closedDate}.',
    '{Label} rests while the boards go where the doubt is.',
    'The {label} file can sit for now.',
    'Nothing urgent is left in the {label} numbers, so they rest.',
  ],
  reopened: [
    'I closed the {label} file and it moved while I wasn’t looking.',
    'Back into the {label} file: the number I left there isn’t the number I found.',
    'A closed file should stay where I left it. The {label} numbers didn’t.',
  ],
  revalidation: [
    'I haven’t checked {label} in a while. Today I make sure what I found still holds.',
    'Old findings get re-tested in this lab. {Label} is up.',
    'A finding is only as good as its last re-check. {Label} gets one now.',
  ],
  early: [
    'The {label} file barely has ink in it.',
    'The {label} file is new, and it’s too soon for numbers.',
    'The {label} study just opened, and I don’t publish guesses.',
    'The {label} file is mostly blank pages.',
  ],
};

// Why boards keep arriving, active card only. The returning pool needs
// a real history of study days behind "keeps coming back"; a fresh
// target gets the honest present-tense version.
const CHOOSER_RETURNING = [
  'The nightly refit points its boards at whatever I’m least sure about, and it keeps coming back to this file.',
  'I spend boards where the doubt is widest, and lately that is here.',
  'My doubt list still ranks this file near the top, so I keep sending boards.',
];
const CHOOSER_FRESH = [
  'The nightly refit points its boards at whatever I’m least sure about. Right now, that’s this.',
  'The uncertainty budget goes where the doubt is, and this file just made the list.',
];

// Estimate phrasings beyond the canonical estimateLine (which is always
// variant 0 at pick time, so the two surfaces can never diverge on the
// ruled sentence forms).
const ESTIMATE_POS = [
  'My current read: about {pct}% per {unit}, likely between {lo}% and {hi}%.',
  'The cost comes to about {pct}% per {unit}. The band runs {lo}% to {hi}%.',
  'The estimate stands at about {pct}% per {unit}, between {lo}% and {hi}%.',
  'The model puts it at about {pct}% per {unit}, inside {lo}% to {hi}%.',
  'The cost per {unit} runs about {pct}%, with a floor around {lo}% and a ceiling around {hi}%.',
];
const ESTIMATE_ZERO = [
  'The effect sits somewhere between 0% and about {hi}% per {unit}.',
  'Per {unit}, the cost reads as somewhere between 0% and about {hi}%.',
  'Call it somewhere between 0% and about {hi}% per {unit}.',
  'The charge per {unit} reads between 0% and about {hi}%.',
  'The cost lies between 0% and about {hi}% per {unit}, which is thin either way.',
];

// The band beat's variant 0 is always study.verdict.copy, the shared
// canonical sentence classifyVerdict already tests for honesty, so the
// ruled verdict phrasings stay live and single-sourced; these pools
// only add rotation on top.
const BAND_SETTLING = [
  'The range has narrowed {deltaPct}% since {windowStart}.',
  'Uncertainty is down {deltaPct}% since {windowStart}.',
  'The band is {deltaPct}% narrower than it was on {windowStart}.',
];
const BAND_WIDENED = [
  'More plays came in and my uncertainty went up, by about {deltaPct}%. That’s backwards from how measurement is supposed to go.',
  'The range is {deltaPct}% wider than when this window opened on {windowStart}. I publish those numbers too.',
  'Since {windowStart} the band has grown {deltaPct}%. I noted it in ink.',
  'The spread has grown {deltaPct}% since {windowStart}, and I wrote it down anyway.',
];
const BAND_OPEN = [
  'The band has barely moved since {windowStart}.',
  'The range has not moved.',
  'Night after night, the width stays the same.',
  'The width on {windowStart} is roughly the width now.',
  'There’s no drama in the band. The width just holds.',
];

// "Study days" wording is load-bearing: a study day is a day the
// experiment aimed at this feature, not a calendar day since it opened.
const WINDOW = [
  'The study covered {daysWord} study days, {first} to {last}.',
  'The study ran {daysWord} study days, {first} to {last}.',
  'The books show {daysWord} study days, {first} to {last}.',
];
const WINDOW_SINGLE = [
  'This file has one study day, {first}. Most of the data arrived on ordinary boards.',
  'The study amounts to a single study day, {first}, plus every board that happened to carry one.',
];

const IDLE = [
  'I haven’t touched the study since {closedDate} because there’s nothing left to squeeze.',
  'The experiment hasn’t aimed at it since {closedDate}.',
  'The file has sat quiet since {closedDate}.',
  'Not a single aimed board has gone its way since {closedDate}.',
];

const DRIFT = [
  'On {refDate} this file read about {refPct}% per {unit}. It reads about {nowPct}% now.',
  'The parked estimate moved: about {refPct}% per {unit} on {refDate}, about {nowPct}% now.',
];

const EARLY_NOTE = [
  'What my note says stands untested for now.',
  'The hypothesis is on the page. The evidence isn’t yet.',
  'The numbers will come once the boards do.',
];

// Closers, per state. The grind pool splits on resolution because "an
// answer that flatters my hunch" is a lie when the data are siding
// against it.
const GRIND_CLOSERS_SIDED = [
  'A stubborn answer that flatters my hunch is exactly the kind I double-check.',
  'You’d think I’d enjoy being right. Mostly I keep checking.',
  'The estimate settled. The reason didn’t.',
  'At some point stubborn becomes settled. This one isn’t there yet.',
];
const GRIND_CLOSERS_OTHER = [
  'The estimate settled. The reason didn’t.',
  'Consistency isn’t proof, but it does pay the rent.',
  'The same answer came back again, and I’m listening.',
  'A steady no is still information.',
];
const CLOSERS = {
  'active-unresolved': [
    'A case that won’t close gets the next board.',
    'There’s no clever move here, just patience.',
    'It always comes back to more boards.',
    'The file stays open, and so does the question.',
    'The next board might be the one that settles it.',
    'I can wait. More boards arrive every night.',
  ],
  grind: GRIND_CLOSERS_SIDED, // resolved per-entry in _closerPool
  anomaly: [
    'I haven’t retracted the hypothesis. But it’s on notice.',
    'Backwards results get front-page space in this notebook.',
    'When the data surprise me, I take better notes.',
    'Wider is still an answer. It’s just not the one I ordered.',
    'Instruments drift. So do estimates. The notebook is the record.',
  ],
  'closed-won': [
    'Closed files make room for open ones.',
    'I’ll take a clean answer over a flattering one any day.',
    'Into the ledger it goes.',
    'The best files are the ones I can stop writing in.',
  ],
  'closed-lost': [
    'A hunch that dies cleanly teaches more than one that limps along.',
    'The notebook keeps the losses. They’re what make the wins worth reading.',
    'I wanted an effect. I got an answer. The answer outranks the want.',
    'The data owe me nothing. That’s what makes it worth asking.',
  ],
  resting: [
    'The file is parked, not forgotten.',
    'The boards go where the doubt is. Right now that isn’t here.',
    'Good enough to leave alone is its own kind of finding.',
    'Sleeping files still count as science.',
  ],
  reopened: [
    'A number that moves while nobody feeds it has my full attention.',
    'I don’t like surprises in closed drawers.',
    'Closed is supposed to be a state, not a mood.',
  ],
  revalidation: [
    'Findings that can’t survive a re-check aren’t findings.',
    'If it holds, I’ll say so. If it doesn’t, I’ll say that louder.',
    'Findings that dodge re-checks turn into folklore.',
  ],
  early: [
    'Ask me again after a few more boards.',
    'Boards come first, then numbers, then opinions.',
    'The notebook comes after the data, always in that order.',
    'Every thick file in this notebook started thin.',
  ],
};

function _closerPool(state, resolution) {
  if (state === 'grind') return resolution === 'sided' ? GRIND_CLOSERS_SIDED : GRIND_CLOSERS_OTHER;
  return CLOSERS[state] || [];
}

// Conclusions-ledger one-liners: past tense, anchored to the close
// date, deliberately still. The header already names the feature, so
// these use {unitShort} ("per pair", not "per wormhole pair"). Today's
// live data parks FOUR zero-band studies at once, so that pool carries
// the most variants, the same-screen dedup needs the headroom.
const LEDGER_ZERO = [
  '{Label} cost between 0% and about {hi}% per {unitShort}. Closed {closedDate}.',
  '{Label} barely registered: somewhere between 0% and about {hi}% per {unitShort}. Closed {closedDate}.',
  '{Label} landed near 0%, probably no more than about {hi}% per {unitShort}. Closed {closedDate}.',
  '{Label} never showed a real cost: 0% to about {hi}% per {unitShort}. Closed {closedDate}.',
  'The {label} bill came to between 0% and about {hi}% per {unitShort}. Closed {closedDate}.',
  '{Label} carried no real charge, 0% to about {hi}% per {unitShort}. Closed {closedDate}.',
];
const LEDGER_POS = [
  '{Label} cost real time, about {pct}% per {unitShort}. Closed {closedDate}.',
  '{Label} settled at about {pct}% per {unitShort}. Closed {closedDate}.',
  '{Label} carried a real cost, about {pct}% per {unitShort}. Closed {closedDate}.',
];
// Parked = the model moved on with the question still ambiguous (the
// band straddles zero), so these lines use the honest straddling form,
// never a bare signed point estimate, which could put a fake negative
// on the ledger.
const LEDGER_PARKED = [
  '{Label} still reads between 0% and about {hi}% per {unitShort}. Parked {closedDate}.',
  '{Label} sits somewhere between 0% and about {hi}% per {unitShort}, steady enough to set down. Parked {closedDate}.',
  '{Label} never picked a side: 0% to about {hi}% per {unitShort}. Parked {closedDate}.',
];
// A drifted (reopened) study must not misattribute the CURRENT value to
// the close, its line cites both figures against {refDate}, the actual
// reference fit's date (the last live fit at the close, or the era
// start for a study parked before the era began; driftSinceClose picks
// it, so date and figure always agree).
const LEDGER_REOPENED = [
  'On {refDate} the parked {label} file read about {refPct}% per {unitShort}. It reads {nowPct}% now. I’m watching it.',
  'The parked {label} file has moved: about {refPct}% per {unitShort} on {refDate}, about {nowPct}% now. I’m watching it.',
];
const LEDGER_NEG = [
  '{Label} came back as a small refund, about {pctAbs}% per {unitShort} in your favor. Closed {closedDate}.',
];

// The queue: what Greg wants data on next, never a claim about
// today's board. A closed target can still top the coverage list (the
// board mix keeps starved features fed); those get their own honest
// phrasing.
const QUEUE_OPEN = [
  'Next up is {label}. I have only {nBoardsWord} {boardsNoun} so far, and I want more.',
  'Next on the wish list is {label}. That file has {nBoardsWord} {boardsNoun}, and thin files bother me.',
  'I want more {label} boards. {NBoardsWord} is not a sample size, it’s an anecdote.',
  'The thin file next in line is {label}, at {nBoardsWord} {boardsNoun}.',
];
const QUEUE_CLOSED = [
  'The {label} file is closed, but only {nBoardsWord} {boardsNoun} on record, so the mix keeps feeding it anyway.',
  'Even a closed file gets boards: the {label} file has {nBoardsWord}, and balance matters.',
  'Closed or not, the {label} file is thin at {nBoardsWord} {boardsNoun}, so boards still come its way.',
];

// Lab-log datelines, one pool per outcome class.
const LOG_TIGHTENED = [
  '{RunsWord} {runsNoun} landed. The range narrowed {delta}%.',
  '{RunsWord} {runsNoun} came in, and the band tightened {delta}%.',
  'It was a good night: {runsWord} {runsNoun} landed and the range came down {delta}%.',
  '{RunsWord} {runsNoun} landed and left the band {delta}% narrower. I’ll take it.',
  'The model fit {runsWord} {runsNoun}, and the spread came down {delta}%.',
  '{RunsWord} {runsNoun} landed and the spread shrank {delta}%.',
  'Uncertainty fell {delta}% on {runsWord} {runsNoun}.',
  'The range fell {delta}% on {runsWord} {runsNoun}. That’s progress you can measure.',
];
const LOG_WIDENED = [
  '{RunsWord} {runsNoun} landed and the range got {delta}% wider. I noted it.',
  '{RunsWord} {runsNoun} came in and the spread grew {delta}%. The backwards nights get written down too.',
  'The band grew {delta}% on {runsWord} new {runsNoun}. I don’t hide those.',
  '{RunsWord} {runsNoun} landed and brought more spread, not less: the band is {delta}% wider.',
  'The spread rose {delta}% after {runsWord} {runsNoun}. I recorded it all the same.',
  '{RunsWord} {runsNoun} landed and the range is wider by {delta}%. That’s science, unfortunately.',
  '{RunsWord} {runsNoun} landed and the spread grew {delta}%. It goes down in honest ink.',
  'Uncertainty rose {delta}% after {runsWord} {runsNoun}. It goes in the log like everything else.',
];
const LOG_FLAT = [
  '{RunsWord} {runsNoun} landed. The range didn’t blink.',
  '{RunsWord} {runsNoun} landed with no movement. Patience is part of the method.',
  '{RunsWord} more {runsNoun} arrived and the band held its width.',
  'The math stayed quiet: {runsWord} {runsNoun} landed and nothing moved.',
  '{RunsWord} {runsNoun} came in. The estimate held.',
  '{RunsWord} {runsNoun} landed. The interval stayed where it was.',
  '{RunsWord} {runsNoun} arrived with no measurable change.',
  'The range held, and the new {runsNoun} went into the file.',
];
// Runs landed but this feature had no range on record for the night
// (its first appearance in the fit, or a malformed row), say only what
// is true, never "the range didn't blink" about a range that wasn't
// measured.
const LOG_RUNS_PLAIN = [
  '{RunsWord} {runsNoun} landed in the model.',
  '{RunsWord} {runsNoun} came in overnight.',
  '{RunsWord} {runsNoun} went into the dataset.',
  'I counted and filed {runsWord} {runsNoun}.',
];
const LOG_SWITCHED = [
  'The experiment came back to this file.',
  'The chooser picked this file again, so I’m back on the case.',
  'This file drew the assignment again.',
  'A new assignment came in for the same old question.',
  'The chooser aimed boards here again.',
];
const LOG_SWITCHED_FIRST = [
  'The chooser opened this file.',
  'This file drew its first assignment.',
];
const LOG_REJECTED = [
  'The fit failed my quality bar. I kept the previous model.',
  'Diagnostics said no, so nothing changed.',
  'The numbers didn’t converge cleanly. Last night’s model stands.',
  'Convergence was bad and nothing updated. The previous model stays in place.',
];
const LOG_QUIET = [
  'No new runs arrived. The file is where I left it.',
  'No one played, so I have nothing new to write.',
  'Zero runs landed. Even instruments get days off.',
  'No runs arrived tonight. The numbers hold.',
];

// Every pool line, for the guard tests (em-dash, hedge, first-person,
// mechanism, day-count rails run over the raw templates).
export function allProseLines() {
  const arcs = [...Object.values(ARCS), ARC_GENERIC]
    .flatMap(a => ['pos', 'zero', 'neg', 'out'].map(k => a[k]).filter(Boolean));
  return [
    ...Object.values(OPENERS).flat(),
    ...CHOOSER_RETURNING, ...CHOOSER_FRESH,
    ...ESTIMATE_POS, ...ESTIMATE_ZERO,
    ...BAND_SETTLING, ...BAND_WIDENED, ...BAND_OPEN,
    ...WINDOW, ...WINDOW_SINGLE, ...IDLE, ...DRIFT, ...EARLY_NOTE,
    ...GRIND_CLOSERS_SIDED, ...GRIND_CLOSERS_OTHER,
    ...Object.values(CLOSERS).flat(),
    ...LEDGER_ZERO, ...LEDGER_POS, ...LEDGER_PARKED, ...LEDGER_REOPENED, ...LEDGER_NEG,
    ...QUEUE_OPEN, ...QUEUE_CLOSED,
    ...LOG_TIGHTENED, ...LOG_WIDENED, ...LOG_FLAT, ...LOG_RUNS_PLAIN,
    ...LOG_SWITCHED, ...LOG_SWITCHED_FIRST, ...LOG_REJECTED, ...LOG_QUIET,
    ...arcs,
  ];
}

// ── Skeletons ─────────────────────────────────────────────────────────
// Beat orderings per state. Variant choice is hash(feature) with a
// session bump, so the same study always opens the same way until a
// same-state neighbor forces the next shape.
const SKELETONS = {
  'active-unresolved': [
    ['opener', 'chooser', 'estimate', 'band', 'arc'],
    ['opener', 'arc', 'estimate', 'band'],
    ['opener', 'estimate', 'arc', 'band'],
  ],
  grind: [
    ['opener', 'estimate', 'band', 'arc'],
    ['opener', 'arc', 'estimate', 'band'],
    ['opener', 'band', 'estimate', 'arc'],
  ],
  anomaly: [
    ['opener', 'band', 'estimate', 'arc'],
    ['opener', 'arc', 'band', 'estimate'],
    ['opener', 'estimate', 'band', 'arc'],
  ],
  'closed-won': [
    ['opener', 'window', 'arc', 'estimate', 'idle'],
    ['opener', 'arc', 'window', 'estimate'],
    ['opener', 'estimate', 'window', 'arc'],
  ],
  'closed-lost': [
    ['opener', 'window', 'arc', 'estimate', 'idle'],
    ['opener', 'arc', 'window', 'estimate'],
    ['opener', 'estimate', 'window', 'arc'],
  ],
  resting: [
    ['opener', 'estimate', 'idle'],
    ['opener', 'idle', 'estimate', 'arc'],
    ['opener', 'arc', 'estimate'],
  ],
  reopened: [
    ['opener', 'drift', 'estimate'],
    ['opener', 'estimate', 'drift'],
    ['opener', 'drift', 'estimate', 'arc'],
  ],
  revalidation: [
    ['opener', 'estimate', 'band'],
    ['opener', 'band', 'estimate', 'arc'],
    ['opener', 'arc', 'estimate', 'band'],
  ],
  early: [
    ['opener'],
    ['opener', 'earlyNote'],
  ],
};

function _chooseSkeleton(state, feature, session) {
  const variants = SKELETONS[state];
  let used = session.skeletons.get(state);
  if (!used) {
    used = new Set();
    session.skeletons.set(state, used);
  }
  const start = hashStr(feature) % variants.length;
  for (let i = 0; i < variants.length; i++) {
    const idx = (start + i) % variants.length;
    if (!used.has(idx)) {
      used.add(idx);
      return { idx, beats: variants[idx] };
    }
  }
  return { idx: start, beats: variants[start] };
}

function _renderBeat(beat, state, study, facts, seed, ctx) {
  switch (beat) {
    case 'opener':
      return pickLine(OPENERS[state], `${seed}|open`, facts);
    case 'chooser': {
      if (ctx.activeFeature !== study.feature) return null;
      const pool = facts.days >= 3 ? CHOOSER_RETURNING : CHOOSER_FRESH;
      return pickLine(pool, `${seed}|chooser`, facts);
    }
    case 'estimate': {
      const canonical = estimateLine(study);
      if (!canonical) return null;
      const band = bandClass(estimateSummary(study));
      // The canonical ruled sentence is always variant 0. Rotation only
      // happens on the two CLEAN band classes; an ambiguous band and a
      // whole-band refund each keep their one honest form (the rotated
      // pools cite {pct}, which for a straddling band could put a fake
      // negative or an unearned confidence on the card).
      if (band === 'pos') return pickLine([canonical, ...ESTIMATE_POS], `${seed}|est`, facts);
      if (band === 'zero') return pickLine([canonical, ...ESTIMATE_ZERO], `${seed}|est`, facts);
      return canonical;
    }
    case 'band': {
      const kind = facts.verdictKind;
      // Variant 0 is the classifyVerdict sentence itself, the shared
      // canonical honesty copy stays live and single-sourced.
      const canonical = typeof study?.verdict?.copy === 'string' ? [study.verdict.copy] : [];
      if (kind === 'settling') return pickLine([...canonical, ...BAND_SETTLING], `${seed}|band`, facts);
      if (kind === 'widened') return pickLine([...canonical, ...BAND_WIDENED], `${seed}|band`, facts);
      if (kind === 'open') return pickLine([...canonical, ...BAND_OPEN], `${seed}|band`, facts);
      return null;
    }
    case 'arc': {
      const arc = _arcFor(study.feature);
      const res = resolutionFor(study);
      const key = res === 'out' ? 'out' : bandClass(estimateSummary(study));
      // A bespoke file missing a line for this band class falls back to
      // ITS OWN honest 'out' line, never to the generic "my note was a
      // question mark", which would fabricate what the note said.
      const line = arc[key] || arc.out || ARC_GENERIC[key] || ARC_GENERIC.out;
      return line && _renderable(line, facts) ? tpl(line, facts) : null;
    }
    case 'window': {
      if (facts.days <= 0 || !facts.first || !facts.last) return null;
      const pool = facts.days === 1 ? WINDOW_SINGLE : WINDOW;
      return pickLine(pool, `${seed}|window`, facts);
    }
    case 'idle': {
      // The resting verdict's canonical sentence ("sure enough to spend
      // my boards elsewhere") is true for every parked/closed study and
      // rides as variant 0, keeping classifyVerdict's copy live.
      const canonical = facts.verdictKind === 'resting' && typeof study?.verdict?.copy === 'string'
        ? [study.verdict.copy] : [];
      return pickLine([...canonical, ...IDLE], `${seed}|idle`, facts);
    }
    case 'drift':
      return pickLine(DRIFT, `${seed}|drift`, facts);
    case 'earlyNote':
      return pickLine(EARLY_NOTE, `${seed}|earlyNote`, facts);
    default:
      return null;
  }
}

// ── Entries ───────────────────────────────────────────────────────────

/**
 * One notebook entry for a study. Deterministic: same study data, same
 * ctx, same prose. The session (shared across every entry composed for
 * one screen) enforces skeleton and closer distinctness.
 * Returns { state, skeleton, text, facts }.
 */
export function composeEntry(study, ctx = {}, session = newSession()) {
  const state = narrativeState(study, ctx);
  const facts = buildFacts(study, ctx);
  const seed = `${study.feature}|${facts.asOf || ''}`;
  const skel = _chooseSkeleton(state, study.feature, session);
  const parts = [];
  let arcSpoken = false;
  for (const beat of skel.beats) {
    const s = _renderBeat(beat, state, study, facts, seed, ctx);
    if (s) {
      parts.push(s);
      // arcSpoken = the entry QUOTES the written hunch, not merely that
      // an arc beat rendered: many 'out' arc lines carry no hypothesis
      // content, and hiding the epigraph for those would leave the card
      // with no premise at all.
      if (beat === 'arc' && /(I wrote|my note|I predicted|I suspected|The Should)/i.test(s)) {
        arcSpoken = true;
      }
    }
  }
  const closer = pickLine(_closerPool(state, resolutionFor(study)), `${seed}|closer`, facts, session.lines);
  if (closer) parts.push(closer);
  // arcSpoken tells the card whether the entry already speaks the
  // written hunch ("I wrote that…"), the separate hypothesis epigraph
  // hides then, so the file's premise is never printed twice in a row.
  return { state, skeleton: `${state}:${skel.idx}`, text: parts.join(' '), facts, arcSpoken };
}

/**
 * The conclusions-ledger one-liner for a closed study: past tense,
 * anchored to the close date. A reopened study appends its watch note.
 */
export function conclusionLine(study, state, session = newSession()) {
  const facts = buildFacts(study);
  // A reopened study's current estimate must not read as the closed
  // finding, its line cites the parked figure AND the current one.
  if (state === 'reopened') {
    const line = pickLine(LEDGER_REOPENED, `${study.feature}|ledger`, facts, session.lines);
    if (line) return line;
  }
  const band = bandClass(estimateSummary(study));
  let pool;
  if (band === 'neg') pool = LEDGER_NEG;
  else if (band === 'zero') pool = LEDGER_ZERO;
  else if (band === 'pos') pool = LEDGER_POS;
  else pool = LEDGER_PARKED;
  return pickLine(pool, `${study.feature}|ledger`, facts, session.lines);
}

/**
 * The queue line: the most board-starved named feature on the coverage
 * list, excluding the active target. "What I want data on next" framing
 * only, never a claim about today's board.
 */
export function queueLine(coverageTargets, activeFeature, studies) {
  const list = Array.isArray(coverageTargets) ? coverageTargets : [];
  for (const c of list) {
    if (!c || typeof c.feature !== 'string' || c.feature === activeFeature) continue;
    if (typeof c.n_boards !== 'number' || !Number.isFinite(c.n_boards)) continue;
    const label = featureName(c.feature);
    if (!label) continue;
    const closed = Array.isArray(studies)
      && studies.some(s => s?.feature === c.feature && s?.verdict?.kind === 'resting');
    const facts = {
      label,
      nBoards: c.n_boards,
      nBoardsWord: countWord(c.n_boards),
      boardsNoun: c.n_boards === 1 ? 'board' : 'boards',
    };
    const text = pickLine(closed ? QUEUE_CLOSED : QUEUE_OPEN, `queue|${c.feature}|${c.n_boards}`, facts);
    if (text) return { feature: c.feature, text, facts };
  }
  return null;
}

// ── Figures ───────────────────────────────────────────────────────────
// A scientist scribbles more than one kind of figure. Each card plans
// its own figures deterministically (feature + latest-fit date), so the
// mix shifts day to day and card to card without ever disagreeing with
// the data: every figure type draws only what the derivations already
// prove, and captions explain each one in plain words.
//   sd-trend     , the uncertainty sparkline (the original figure)
//   estimate-band, the estimate itself over the live era, with the
//                   ±1 SD band shaded (live fits only: retrodicted
//                   means echo their priors and never feed a claim)
//   band-strip   , the CURRENT estimate as one labeled range bar
// Roughly a third of cards sketch a second, different figure. sd-trend
// also rotates its point shape; 'none' (a bare line with hover-only
// points) is excluded whenever the series carries retrodicted points,
// because the dimmed dot IS the retro disclosure.

export const FIGURE_TYPES = ['sd-trend', 'estimate-band', 'band-strip'];
const DOT_SHAPES = ['circle', 'square', 'diamond', 'tick'];

// Captions are framing copy about the figure (third person allowed,
// like the sparkline caption always was); each pool rotates with the
// same seed discipline as the prose. No digits, a caption explains,
// the figure carries the numbers.
const FIGURE_CAPTIONS = {
  'sd-trend': [
    'This line tracks Greg’s uncertainty, night by night. A falling line means he’s homing in.',
    'The line shows how sure Greg is, fit by fit. Lower means surer.',
    'The uncertainty in this file is plotted over time. Down is progress.',
  ],
  'estimate-band': [
    'This is the estimate itself, night by night. The shaded band is the spread Greg would bet on.',
    'The line shows where the estimate has moved since the current model began. The shading is the honest spread.',
    'This is the running read on the effect. The band around the line is Greg’s uncertainty.',
  ],
  'band-strip': [
    'This bar shows the latest read as one range. The mark is Greg’s best single guess.',
    'The bar shows where the cost per {unit} most likely sits, as of the latest fit.',
    'One bar carries the whole claim: the band is what the model would bet on today.',
  ],
};

// Every caption line, for the guard tests (dash and digit rails; unlike
// entry prose, captions may name Greg in the third person).
export function allFigureCaptions() {
  return Object.values(FIGURE_CAPTIONS).flat();
}

/**
 * Plan the figures for a study's card: 1-2 specs of
 * { type, dotShape (sd-trend only), caption }, deterministic by
 * feature + latest-fit date. Empty when no figure has enough data.
 */
export function planStudyFigures(study) {
  const est = estimateSummary(study);
  const t = Array.isArray(study?.trajectory) ? study.trajectory : [];
  const live = t.filter(p => p && p.retro !== true);
  const eligible = [];
  if (t.length >= 2) eligible.push('sd-trend');
  if (live.length >= 2 && est) eligible.push('estimate-band');
  if (est && est.hi > 0 && study?.unit) eligible.push('band-strip');
  if (eligible.length === 0) return [];

  const facts = buildFacts(study);
  const seed = `${study.feature}|${facts.asOf || ''}|fig`;
  const chosen = [eligible[hashStr(seed) % eligible.length]];
  if (eligible.length > 1 && hashStr(`${seed}|second`) % 3 === 0) {
    const rest = eligible.filter(f => f !== chosen[0]);
    chosen.push(rest[hashStr(`${seed}|pick2`) % rest.length]);
  }

  const hasRetro = t.some(p => p && p.retro === true);
  const dotPool = hasRetro ? DOT_SHAPES : [...DOT_SHAPES, 'none'];
  return chosen.map((type, i) => ({
    type,
    dotShape: type === 'sd-trend' ? dotPool[hashStr(`${seed}|dot${i}`) % dotPool.length] : null,
    caption: pickLine(FIGURE_CAPTIONS[type], `${seed}|cap${i}`, facts),
  }));
}

// ── Lab log ───────────────────────────────────────────────────────────

function _sdFor(row, feature) {
  const entry = (row.candidates || []).find(c => c && c.feature === feature);
  return entry && entry.sd > 0 ? entry.sd : null;
}

/**
 * Dated lab-log entries for a feature, derived from consecutive
 * LIVE-ERA refit-row diffs, newest first, notable days only: runs
 * landed (with the band's ±2% move class), the target switching to
 * this feature, or a rejected fit. A quiet day renders only when it is
 * the latest entry, so the log always opens on the current state of
 * play. Each entry: { date, text, facts }.
 */
export function labLog(history, feature, { max = MAX_LOG_ENTRIES } = {}) {
  const epoch = SCALE_EPOCHS[SCALE_EPOCHS.length - 1];
  const all = dedupeHistory(history);
  // "First assignment" is a claim about the WHOLE history, a feature
  // studied since April must not read as new just because the log's
  // number diffs are windowed to the live era.
  const firstTargeted = all.find(r => r.target === feature)?.date ?? null;
  const rows = all.filter(r => r.date >= epoch);
  const out = [];
  for (let i = rows.length - 1; i >= 1 && out.length < max; i--) {
    const cur = rows[i];
    const prev = rows[i - 1];
    const runs = Math.max(0, (cur.n_scores || 0) - (prev.n_scores || 0));
    const rejected = cur.method !== 'brms-ranef';
    const switched = cur.target === feature && prev.target !== feature;
    const isLatest = i === rows.length - 1;
    if (!rejected && !switched && runs === 0 && !isLatest) continue;

    const dateLabel = formatShortDate(cur.date);
    const facts = {
      date: dateLabel,
      runs,
      runsWord: countWord(runs),
      runsNoun: runs === 1 ? 'run' : 'runs',
      delta: null,
    };
    const seed = `${feature}|${cur.date}`;
    const parts = [];
    if (switched) {
      const pool = cur.date === firstTargeted ? LOG_SWITCHED_FIRST : LOG_SWITCHED;
      parts.push(pickLine(pool, `${seed}|sw`, facts));
    }
    if (rejected) {
      parts.push(pickLine(LOG_REJECTED, `${seed}|rej`, facts));
    } else if (runs > 0) {
      const move = classifySdDelta(_sdFor(prev, feature), _sdFor(cur, feature), 2);
      if (move.kind === 'invalid') {
        // No range on record for this feature that night (its first
        // appearance in the fit), claim only the runs, never a
        // "didn't blink" about a range that wasn't measured.
        parts.push(pickLine(LOG_RUNS_PLAIN, `${seed}|runs`, facts));
      } else {
        facts.delta = Math.abs(move.deltaPct);
        const pool = move.kind === 'tightened' ? LOG_TIGHTENED
          : move.kind === 'widened' ? LOG_WIDENED : LOG_FLAT;
        parts.push(pickLine(pool, `${seed}|runs`, facts));
      }
    } else if (isLatest && !switched) {
      parts.push(pickLine(LOG_QUIET, `${seed}|quiet`, facts));
    }
    const body = parts.filter(Boolean).join(' ');
    if (body) out.push({ date: cur.date, text: `${dateLabel}. ${body}`, facts });
  }
  return out;
}

// ── Screen planner ────────────────────────────────────────────────────

/**
 * Everything the notebook surfaces render, composed in one pass with a
 * shared session (the collision rule holds across the whole screen):
 *  - active: the live experiment's deep card (entry + lab log)
 *  - ledger: closed studies as one-liners with pre-composed expansions
 *  - queue:  the coverage line
 *  - table:  the full parameter table (every named feature)
 * `meta` is the experimentTarget.json object (may be null offline; the
 * latest refit row's target stands in, same pipeline, one run behind
 * at worst).
 */
// The active experiment: the live target when it has a plain name, else
// the latest refit row's target (derivable from shipped data alone,
// the logged-out report page passes meta = null and lands one nightly
// run behind at worst). Shared by the in-app planner and journalReport
// so the two surfaces resolve "active" identically.
export function activeFeatureFrom(history, meta = null) {
  if (typeof meta?.target === 'string' && featureName(meta.target)) return meta.target;
  const rows = dedupeHistory(history);
  const last = rows[rows.length - 1];
  if (typeof last?.target === 'string' && featureName(last.target)) return last.target;
  return null;
}

// The modal's intro line, framing copy about Greg (third person by the
// voice ruling), rotated by the latest refit date so the door itself
// doesn't go stale.
const INTROS = [
  'Greg times every solve and uses the results to work out what actually makes a board hard. '
  + 'This is his notebook: the experiment he’s running now, and the files he’s closed. '
  + 'The days that didn’t go his way are in here too.',
  'Every solve you finish feeds Greg’s nightly model of what makes a board hard. '
  + 'These are his working notes: one live experiment, a shelf of closed files, '
  + 'and the results that went against him, published all the same.',
  'Greg runs one experiment at a time and keeps the notes public. '
  + 'The live file is up top; the closed cases sit below it, wins and losses alike.',
];

export function planJournalScreen(history, meta = null) {
  const rows = dedupeHistory(history);
  if (rows.length === 0) return null;
  const journal = buildJournal(history, meta);
  const session = newSession();
  const intro = INTROS[hashStr(`intro|${rows[rows.length - 1].date}`) % INTROS.length];

  const activeFeature = activeFeatureFrom(history, meta);
  const ctx = { activeFeature, revalidation: meta?.reason === 'revalidation' };

  let active = null;
  if (activeFeature) {
    const study = journal.studies.find(s => s.feature === activeFeature)
      || deriveStudyForFeature(history, activeFeature);
    if (study) {
      active = {
        study,
        entry: composeEntry(study, ctx, session),
        log: labLog(history, activeFeature),
      };
    }
  }

  const ledger = journal.studies
    .filter(s => s.feature !== activeFeature && s.verdict.kind === 'resting')
    .sort((a, b) => (b.lastStudied || '').localeCompare(a.lastStudied || ''))
    .map(s => {
      const entry = composeEntry(s, ctx, session);
      return { study: s, state: entry.state, line: conclusionLine(s, entry.state, session), entry };
    });

  return {
    intro,
    active,
    ledger,
    queue: queueLine(meta?.coverage_targets, activeFeature, journal.studies),
    table: parameterTable(history),
    unnamedCount: journal.unnamedCount,
    meta: journal.meta,
  };
}
