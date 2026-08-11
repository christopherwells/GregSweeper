// ── Greg's Journal, the nightly AI rewrite ───────────────────────────
// The beat-assembled notebook entries read stitched (his report,
// 2026-08-11: "the sentences seem so disjunct... rewritten into a
// coherent paragraph"), because composeEntry's pools are independent
// one-sentence beats by design (the collision and honesty rails made
// them so). Coherence between sentences is exactly what the pools
// cannot provide, so ONCE PER NIGHT the refit workflow sends the active
// study's composed entry plus its fact object to a small model on
// GitHub Models (scripts/rewrite-journal-entry.mjs) and ships the
// polished paragraph as DATA in src/logic/journalRewrite.json. Clients
// render the shipped string verbatim; nothing model-shaped ever runs on
// a device, so every device shows the same prose.
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

export const REWRITE_FORMAT = 'journal-rewrite-v1';

// One artifact, overwritten nightly; the UI fetches './' + this.
export const REWRITE_ARTIFACT_PATH = 'src/logic/journalRewrite.json';

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
    // No invented numbers: every digit run must trace to a fact.
    ...digitViolations(text, facts),
  );

  // No dropped numbers: the entry's content IS its numbers, so every
  // digit run in the source must survive into the rewrite.
  const kept = new Set(digitRuns(text));
  for (const run of new Set(digitRuns(sourceText))) {
    if (!kept.has(run)) out.push(`source digit "${run}" was dropped`);
  }
  return out;
}

/**
 * Swap a shipped rewrite into a composed entry, or return the entry
 * unchanged. `entryFeature` is the feature of the study THIS entry
 * describes; the artifact applies only when (a) it names that same
 * feature, (b) its sourceHash equals the hash of the text THIS client
 * composed (same data, same code, same beats), and (c) the paragraph
 * still clears the validator against this client's own facts.
 * arcSpoken is re-detected on the new text so the hypothesis epigraph
 * keeps its never-print-the-premise-twice rule.
 */
export function applyJournalRewrite(entry, artifact, entryFeature) {
  if (!entry || typeof entry.text !== 'string') return entry;
  if (!artifact || typeof artifact !== 'object') return entry;
  if (artifact.format !== REWRITE_FORMAT) return entry;
  if (typeof entryFeature !== 'string' || artifact.feature !== entryFeature) return entry;
  if (typeof artifact.paragraph !== 'string') return entry;
  if (artifact.sourceHash !== hashStr(entry.text)) return entry;
  if (rewriteViolations(artifact.paragraph, entry.text, entry.facts).length > 0) return entry;
  return {
    ...entry,
    text: artifact.paragraph,
    rewritten: true,
    arcSpoken: QUOTE_FRAME.test(artifact.paragraph),
  };
}

/**
 * Assemble the artifact the nightly script writes. `extra` carries
 * provenance the pure layer has no business computing (model id,
 * generatedAt); nothing deterministic may ever read it.
 */
export function buildRewriteArtifact({ feature, date, entryText, paragraph, extra = {} }) {
  return {
    format: REWRITE_FORMAT,
    feature,
    date,
    sourceHash: hashStr(entryText),
    paragraph,
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
  'Keep every number, percent sign, and date from the notes exactly as written. Do not add, drop, round, or recompute any number.',
  'State nothing the notes do not state. No new claims, no new dates, no new events, no mechanisms the notes do not give.',
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

export function buildRewritePrompt({ entryText, facts, label, hypothesis }) {
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
  if (hypothesis) lines.push(`The written hypothesis on file: ${hypothesis}`);
  lines.push(`Fact object (every number in your paragraph must appear among these values): ${JSON.stringify(facts)}`);
  lines.push(`The notes to rewrite:\n${entryText}`);
  return { system, user: lines.join('\n\n') };
}
