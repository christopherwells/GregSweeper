// ── Greg's Journal, the nightly AI rewrite ───────────────────────────
// The beat-assembled notebook entries read stitched (his report,
// 2026-08-11: "the sentences seem so disjunct... rewritten into a
// coherent paragraph"), because composeEntry's pools are independent
// one-sentence beats by design (the collision and honesty rails made
// them so). Coherence between sentences is exactly what the pools
// cannot provide, so EACH NIGHT the refit workflow composes the whole
// journal screen, sends every rendered entry (the active hero and each
// section row's expansion) with its fact object to a local model
// (scripts/rewrite-journal-entry.mjs), and ships the polished
// paragraphs as DATA in src/logic/journalRewrite.json, a per-feature
// map. The script keeps any paragraph whose source entry is unchanged
// (no new completion spent), and a nightly cap bounds the rest, so the
// steady-state cost stays about one completion a night. Clients render
// the shipped strings verbatim; nothing model-shaped ever runs on a
// device, so every device shows the same prose.
//
// THE HONESTY RAILS FLIP FROM GENERATOR CONSTRAINTS TO AN OUTPUT
// VALIDATOR here: every digit in the paragraph must exist in the fact
// object AND every digit in the source must survive into the paragraph
// (no invented numbers, no dropped ones), zero em/en dashes, the hedge
// cap, the player-claim ban, the today's-board ban, and length bounds.
// The checks are the SAME predicates the pool tests run
// (src/logic/proseRails.js, one copy); the finite-verb lexicon is the
// one rail deliberately not applied, because it is curated to the
// pools' closed vocabulary and open-vocabulary prose legitimately uses
// verbs outside it (a false reject here would silently retire the
// feature, one fallback night at a time).
//
// A failing or absent output is never an error surface: the artifact
// only replaces the entry when its sourceHash matches the entry the
// client itself composed (so a stale artifact, an older cached bundle,
// or a divergent compose falls back to the beat assembly byte for
// byte), and the paragraph is re-validated ON THE CLIENT before it
// renders. The journal can never be blocked or made dishonest by a bad
// model night.

import { hashStr } from './journalProse.js';
import {
  QUOTE_FRAME,
  dashViolations, dayCountViolations, digitRuns, digitViolations,
  fieldnoteViolations, hedgeViolations, impreciseVerbViolations,
  nothingAsNumberViolations, playerClaimViolations,
  templateHoleViolations, thirdPersonViolations,
} from './proseRails.js';

// v2 (2026-08-11, same day as v1): the rewrite covers EVERY rendered
// entry, not just the active hero, so the artifact is a per-feature
// map {entries: {feature: {sourceHash, paragraph}}}. A v1 artifact in
// a stale cache fails the format check and the beats render, the same
// fallback as every other mismatch.
export const REWRITE_FORMAT = 'journal-rewrite-v2';

// One artifact, overwritten nightly; the UI fetches './' + this.
export const REWRITE_ARTIFACT_PATH = 'src/logic/journalRewrite.json';

// Completions attempted per night. Closed and resting entries barely
// change, so after the first night or two the carry-forward keeps
// nearly everything and a typical night rewrites zero to two entries;
// the cap only bites when a refit moves many studies at once, and the
// leftovers converge on the following nights.
export const REWRITE_NIGHTLY_CAP = 6;

// An entry below this length is one or two beats and reads fine as it
// is; rewriting it would force the model to pad (the length floor would
// demand more text than the source contains). The script skips those
// nights entirely.
export const MIN_SOURCE_CHARS = 200;

// Length bounds relative to the source: a rewrite is the same material
// in better order, so it lands near the source's length. Below the
// floor the model dropped content; above the cap it padded or rambled.
export const LENGTH_FLOOR_FACTOR = 0.55;
export const LENGTH_CAP_FACTOR = 1.6;

// Markdown or markup in the output means the model answered as a
// formatter, not as Greg; textContent rendering makes markup harmless
// but it would read as literal junk on the card.
const MARKUP = /[<>*#`_|]/;

/**
 * Normalize a raw model completion into candidate paragraph text:
 * strip code fences and one pair of wrapping quotes, collapse every
 * whitespace run (newlines included) to a single space. Deterministic
 * and minimal; anything beyond this is the model's problem, not ours.
 */
export function normalizeModelOutput(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  const pairs = [['"', '"'], ['“', '”']];
  for (const [open, close] of pairs) {
    if (s.startsWith(open) && s.endsWith(close) && s.length > 2) {
      s = s.slice(open.length, s.length - close.length);
      break;
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The validator: every reason `text` may not ship as the rewrite of
 * `sourceText` under `facts`. Empty array = publishable. Pure; the
 * nightly script, the client re-check, and the tests all call this one
 * function.
 */
export function rewriteViolations(text, sourceText, facts) {
  if (typeof text !== 'string' || text.trim().length === 0) return ['empty output'];
  if (typeof sourceText !== 'string' || sourceText.length === 0) return ['no source entry'];
  const out = [];

  if (/\n/.test(text)) out.push('not a single paragraph');
  if (MARKUP.test(text)) out.push('markup character in output');

  const floor = Math.max(80, Math.round(sourceText.length * LENGTH_FLOOR_FACTOR));
  const cap = Math.max(400, Math.round(sourceText.length * LENGTH_CAP_FACTOR));
  if (text.length < floor) out.push(`too short (${text.length} chars, floor ${floor})`);
  if (text.length > cap) out.push(`too long (${text.length} chars, cap ${cap})`);

  out.push(
    ...dashViolations(text),
    ...thirdPersonViolations(text),
    ...fieldnoteViolations(text),
    ...dayCountViolations(text),
    ...templateHoleViolations(text),
    ...nothingAsNumberViolations(text),
    ...impreciseVerbViolations(text),
    ...playerClaimViolations(text),
    ...hedgeViolations(text),
    // Belt: no digit without a fact behind it (the composed source
    // guarantees source digits ⊆ facts, so this can only fire on a
    // tampered artifact whose sourceText was forged along with it).
    ...digitViolations(text, facts),
  );

  // The rewrite's digit SET equals the source's, both directions. No
  // dropped numbers (the entry's content IS its numbers), and no
  // imported ones either: fact-object values the notes never cited are
  // NOT material, and given them, a model built "the range has not
  // moved since the first data point on April 27" out of the study-day
  // fields, digit-honest against the facts and false against the entry
  // (the 2026-08-11 compass draft).
  const kept = new Set(digitRuns(text));
  const sourceRuns = new Set(digitRuns(sourceText));
  for (const run of sourceRuns) {
    if (!kept.has(run)) out.push(`source digit "${run}" was dropped`);
  }
  for (const run of kept) {
    if (!sourceRuns.has(run)) out.push(`digit "${run}" is not in the notes`);
  }

  // No added inference. Every fabrication the 2026-08-11 bake-off
  // produced was the model stitching CONCLUSIONS between faithful
  // sentences ("which supports my suspicion", "indicating a steady
  // no", "held this cost consistently", and, once the section rows
  // joined, "I opted for the latter", an agency flip: the DATA picked
  // that door), which no per-fact rail can see. Mechanically: an
  // inference marker may appear in the rewrite only where the notes
  // themselves use it, so a source that says "because" keeps its
  // because and a rewrite can never introduce one.
  for (const marker of INFERENCE_MARKERS) {
    if (marker.test(text) && !marker.test(sourceText)) {
      out.push(`added inference ("${String(text.match(marker)?.[0])}") the notes do not state`);
    }
  }

  // No jargon: the model feature key is not prose and never renders on
  // a player surface. The prompt withholds it; this rail is the
  // backstop (it leaked verbatim, "the wormholePairCount numbers", the
  // first time the fact object included it).
  if (facts && typeof facts.feature === 'string' && facts.feature.length > 0
    && text.toLowerCase().includes(facts.feature.toLowerCase())
    && (typeof facts.label !== 'string' || facts.feature.toLowerCase() !== facts.label.toLowerCase())) {
    out.push(`raw feature key "${facts.feature}" in prose`);
  }
  return out;
}

// Word-boundary, stem-tolerant forms of the inference vocabulary a
// rewrite may not introduce. prove/proves/proved/proving is written out
// so "provide" stays legal; "mean(s) that" is phrase-bound so "which
// means" and "this means" are both caught. The "I opted/chose/decided"
// family is the agency flip: the notes credit the data with every
// verdict, and a first-person choice the notes never made reassigns it
// to Greg.
const INFERENCE_MARKERS = [
  /\bsupport\w*/i, /\bconfirm\w*/i, /\bindicat\w*/i, /\bimpl(?:y|ies|ied|ying)\b/i,
  /\bsuggest\w*/i, /\bprov(?:e|es|ed|ing)\b/i, /\brefut\w*/i, /\bcontradict\w*/i,
  /\bconsistent\w*/i, /\bdemonstrat\w*/i, /\bbecause\b/i, /\btherefore\b/i,
  /\bmeans? that\b/i, /\bwhich means\b/i, /\bthis means\b/i,
  /\bI opted\b/i, /\bI chose\b/i, /\bI decided\b/i, /\bI concluded\b/i, /\bI lean(?:ed)?\b/i,
  // Explanation glue: four straight mystery-entry drafts fused "one
  // study day" with "the data arrived on ordinary boards" into a causal
  // claim the notes never make ("meaning the estimate is based on a
  // single aimed study day"). The pools never use either phrase, so the
  // source-conditional ban costs faithful drafts nothing.
  /\bmeaning\b/i, /\bbased on\b/i,
];

/** The artifact's record for one feature, or null. Total on junk. */
export function rewriteEntryFor(artifact, feature) {
  if (!artifact || typeof artifact !== 'object') return null;
  if (artifact.format !== REWRITE_FORMAT) return null;
  if (!artifact.entries || typeof artifact.entries !== 'object') return null;
  const rec = artifact.entries[feature];
  return rec && typeof rec === 'object' ? rec : null;
}

/**
 * Swap a shipped rewrite into a composed entry, or return the entry
 * unchanged. `entryFeature` is the feature of the study THIS entry
 * describes; the artifact's record applies only when (a) one exists
 * for that feature, (b) its sourceHash equals the hash of the text
 * THIS client composed (same data, same code, same beats), and (c) the
 * paragraph still clears the validator against this client's own
 * facts. arcSpoken is re-detected on the new text so the hypothesis
 * epigraph keeps its never-print-the-premise-twice rule.
 */
export function applyJournalRewrite(entry, artifact, entryFeature) {
  if (!entry || typeof entry.text !== 'string') return entry;
  if (typeof entryFeature !== 'string') return entry;
  const rec = rewriteEntryFor(artifact, entryFeature);
  if (!rec || typeof rec.paragraph !== 'string') return entry;
  if (rec.sourceHash !== hashStr(entry.text)) return entry;
  if (rewriteViolations(rec.paragraph, entry.text, entry.facts).length > 0) return entry;
  return {
    ...entry,
    text: rec.paragraph,
    rewritten: true,
    arcSpoken: QUOTE_FRAME.test(rec.paragraph),
  };
}

/**
 * Every rewrite target on a planned screen, in VISIBILITY order: the
 * hero first, then the revisit rows (the alarm surface), then closed,
 * then collecting. The nightly cap trims from the tail, so the entries
 * a player is most likely to read are rewritten first.
 */
export function visibleRewriteTargets(screen) {
  const out = [];
  if (screen?.active?.entry?.text) {
    out.push({ feature: screen.active.study.feature, entry: screen.active.entry });
  }
  for (const key of ['revisit', 'closed', 'collecting']) {
    for (const item of Array.isArray(screen?.[key]) ? screen[key] : []) {
      if (item?.study?.feature && item?.entry?.text) {
        out.push({ feature: item.study.feature, entry: item.entry });
      }
    }
  }
  return out;
}

/**
 * Split a screen's targets into paragraphs to KEEP from the previous
 * artifact (hash still matches and the old paragraph still validates,
 * so no completion is spent) and entries left TO DO tonight, capped.
 * Anything past the cap waits for the next night; short entries skip
 * entirely (they read fine as beats).
 */
export function planRewriteWork(screen, oldArtifact, { cap = REWRITE_NIGHTLY_CAP } = {}) {
  const keep = {};
  const todo = [];
  let skippedShort = 0;
  let deferred = 0;
  for (const t of visibleRewriteTargets(screen)) {
    if (t.entry.text.length < MIN_SOURCE_CHARS) {
      skippedShort++;
      continue;
    }
    const prev = rewriteEntryFor(oldArtifact, t.feature);
    if (prev && typeof prev.paragraph === 'string'
      && prev.sourceHash === hashStr(t.entry.text)
      && rewriteViolations(prev.paragraph, t.entry.text, t.entry.facts).length === 0) {
      keep[t.feature] = { sourceHash: prev.sourceHash, paragraph: prev.paragraph };
    } else if (todo.length < cap) {
      todo.push(t);
    } else {
      deferred++;
    }
  }
  return { keep, todo, skippedShort, deferred };
}

/** One accepted paragraph as the artifact's per-feature record. */
export function buildRewriteEntry(entryText, paragraph) {
  return { sourceHash: hashStr(entryText), paragraph };
}

/**
 * Assemble the artifact the nightly script writes. `entries` maps
 * feature to buildRewriteEntry records; `extra` carries provenance the
 * pure layer has no business computing (model id, generatedAt);
 * nothing deterministic may ever read it.
 */
export function buildRewriteArtifact({ date, entries, extra = {} }) {
  return {
    format: REWRITE_FORMAT,
    date,
    entries,
    ...extra,
  };
}

// ── The prompt ────────────────────────────────────────────────────────
// The facts and the composed beats are the WHOLE source of truth: the
// model reorders and connects, it never adds. The 2026-08-11 verb
// rulings are stated outright, and the validator enforces the
// mechanical half of every rule below, so a draft that breaks a rule is
// discarded, never shipped.

const PROMPT_RULES = [
  'Write ONE paragraph of plain text. No headings, no lists, no markdown, no quotation marks around the whole answer.',
  'Actually rewrite. Do not copy the notes sentence for sentence, and do not just splice them with commas or semicolons. Reorder the ideas into a story: what I asked, what the data read, where the estimate stands, what I make of it. Tie sentences together with connectives (so, but, and, after, which, that answer).',
  'Keep every number, percent sign, and date from the notes exactly as written. Do not add, drop, round, or recompute any number, and use ONLY the numbers and dates the notes use.',
  'State nothing the notes do not state. No new claims, no new dates, no new events, no mechanisms the notes do not give.',
  'Draw no new conclusions. Never say the data support, confirm, contradict, or refute the hypothesis unless the notes say so themselves; connect sentences without adding logic between them. Any verdict belongs to the data, never to a choice the writer made.',
  'Keep every number attached to what the notes attach it to. Do not tie an estimate to a date, a day, or an event unless the notes tie them in the same sentence, and do not explain one fact with another: two facts the notes state side by side stay side by side.',
  'First person only. The writer never refers to himself by name or in the third person.',
  'Never use the em dash or the en dash. Use commas, periods, or parentheses instead.',
  'At most one hedging word (like "likely" or "seems") per sentence.',
  'Complete sentences only, in a plain scientific register. No exclamation points, no drama.',
  'Data are plural: "the data show", "the data agree", never "the data shows".',
  'Use measurement verbs for numbers and estimates: narrowed, widened, moved, held, landed, reads, settled. Do not describe a number or a range with body verbs, emotion verbs, or invented instruments.',
  'Mention players only when quoting the written hypothesis (inside phrases like "I wrote that..."). Never claim what players do from the measurements.',
  'Never mention today’s board or connect the finding to any particular day’s puzzle.',
  'Say "study day" for day counts, never a bare "day N".',
  'Keep the paragraph about the same length as the notes.',
];

// The hypothesis is DELIBERATELY not offered as material: when it was,
// the bake-off drafts recast it as a conclusion the data had reached
// ("which supports my suspicion that good memory makes it nearly
// free", about a study whose band showed a real cost), and a
// hypothesis absorbed into the paragraph also dodges the epigraph's
// arcSpoken duplication rule. The notes alone are the material.
export function buildRewritePrompt({ entryText, facts, label }) {
  const system = 'You edit the field notebook of Greg, a fictional green-crab field scientist who '
    + 'measures what makes minesweeper boards hard. He writes in plain first person, dry and '
    + 'precise, a working scientist’s register. You will receive his shorthand notes for one '
    + 'study: separate sentences assembled from templates, correct in every fact but stitched '
    + 'in flow. Rewrite them as ONE coherent paragraph in the same voice, connecting the ideas '
    + 'in a natural order. You are an editor, not an author: every fact, number, and stance '
    + 'must come from the notes.\n\nHard rules:\n'
    + PROMPT_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')
    + '\n\nReturn only the rewritten paragraph.';
  const lines = [];
  if (label) lines.push(`Study: ${label}`);
  // NO fact object in the prompt. It was offered at first as a
  // checking aid, and every fabrication it enabled outweighed it: the
  // raw feature key rendered verbatim ("the wormholePairCount
  // numbers"), and unused fact dates kept surfacing as invented
  // chronology ("since the first data point on April 27"). Under the
  // digit-set rail the notes are the ONLY legitimate number surface,
  // so the model reads exactly what it may cite and nothing else.
  // `facts` stays in the signature for the validator's use downstream.
  void facts;
  lines.push(`The notes to rewrite:\n${entryText}`);
  return { system, user: lines.join('\n\n') };
}
