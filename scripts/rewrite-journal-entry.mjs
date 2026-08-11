// Rewrite tonight's journal entry into one coherent paragraph.
//
//   node scripts/rewrite-journal-entry.mjs [--dry-run] [--fixture <file>] [--out <path>]
//
// Runs in the refit workflow AFTER the R fit and the library steps and
// BEFORE the commit step, so the polished paragraph lands in the same
// nightly commit as the model that produced the entry it rewrites. It
// composes the active study's entry from the working tree's
// modelHistory.json + experimentTarget.json (the exact planJournalScreen
// path the client runs), sends the beats plus the fact object to a
// chat-completions endpoint, validates the draft against the shared
// writing rails (src/logic/proseRails.js via journalRewrite.js), and
// writes src/logic/journalRewrite.json. Clients render that paragraph
// verbatim only when its sourceHash matches the entry they themselves
// composed, so a stale or absent artifact means the beat assembly
// renders instead; nothing is ever blocked on this script.
//
// THE PROVIDER IS AN ENV VAR, because the original plan's provider is
// gone: GitHub Models (free inference on the workflow's own
// GITHUB_TOKEN) was fully retired on 2026-07-30, and every hosted
// successor wants a new vendor, a new secret, or a Copilot seat this
// account does not hold. The refit workflow therefore serves a small
// open-weight model ON ITS OWN RUNNER through llama.cpp's
// OpenAI-compatible llama-server (no vendor, no key, model file in the
// Actions cache) and points this script at localhost. Swapping to a
// hosted model later is three env values, no code:
//
//   JOURNAL_REWRITE_URL    chat-completions endpoint
//                          (default http://127.0.0.1:8085/v1/chat/completions)
//   JOURNAL_REWRITE_MODEL  model id to request (default "journal-local")
//   JOURNAL_REWRITE_TOKEN  bearer token, omitted when unset (the local
//                          server wants none). e.g. Anthropic's
//                          OpenAI-compatible endpoint
//                          https://api.anthropic.com/v1/chat/completions
//                          with model claude-haiku-4-5 and an API key
//                          from a repo secret.
//
// EXIT CODES ARE A CONTRACT with the workflow's tail check:
//   exit 0 — the artifact was written, OR tonight is a designed no-op
//            (entry too short to need a rewrite, no active study, a
//            hosted provider rate-limited, draft failed validation
//            twice). The journal falls back to the beat assembly on
//            those nights, which is the feature working as specified.
//   exit 1 — the MACHINERY broke: unreadable inputs, an auth failure
//            (401/403), a bad request or model id (400/404/422), a
//            LOCAL server that answered its health check and then
//            dropped the connection, or an unexpected crash. The
//            workflow step is continue-on-error, and a tail step
//            reddens the run with the remedy named, the reprice
//            pattern.
//
// --dry-run composes and prints the prompt without calling the API.
// --fixture <file> reads the "model output" from a local text file, so
// the whole write path can run offline (the send-push.mjs idiom).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planJournalScreen } from '../src/logic/journalProse.js';
import {
  MIN_SOURCE_CHARS, REWRITE_ARTIFACT_PATH,
  buildRewriteArtifact, buildRewritePrompt, normalizeModelOutput, rewriteViolations,
} from '../src/logic/journalRewrite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const API_URL = process.env.JOURNAL_REWRITE_URL || 'http://127.0.0.1:8085/v1/chat/completions';
const MODEL = process.env.JOURNAL_REWRITE_MODEL || 'journal-local';
const TOKEN = process.env.JOURNAL_REWRITE_TOKEN || null;
// Sampling freedom, measured on the 2026-08-11 bake-off: cold (0.3)
// made small models copy the notes nearly verbatim, hot (0.7) made
// them stitch conclusions the notes never drew, and the middle kept
// the rewrite real while staying faithful. The validator, not the
// temperature, protects the facts either way.
const TEMPERATURE = Number(process.env.JOURNAL_REWRITE_TEMP || 0.4);
const LOCAL_SERVER = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API_URL);
// A 4-vCPU runner generates a paragraph from a 4-8B model in one to two
// minutes; the bound is for a hung socket, not a slow token.
const FETCH_TIMEOUT_MS = 300000;
// One draft, then one revision with the violations named. Two model
// calls at most; past that the beat assembly stands for the night.
const MAX_DRAFTS = 2;

const _argv = process.argv.slice(2);
const DRY_RUN = _argv.includes('--dry-run');
function _flagVal(flag) { const i = _argv.indexOf(flag); return i >= 0 ? _argv[i + 1] : null; }
const FIXTURE = _flagVal('--fixture');
const OUT_PATH = _flagVal('--out') || join(ROOT, REWRITE_ARTIFACT_PATH);

class HardFailure extends Error {}

function readRepoJson(rel) {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  } catch (err) {
    throw new HardFailure(`cannot read ${rel}: ${err.message}`);
  }
}

// One API call with a bounded number of transport retries. On a HOSTED
// provider, transient trouble (429, 5xx, network) returns null after
// the retries so the night degrades softly; on the LOCAL server the
// workflow health-checked moments earlier, the same trouble means the
// server died and throws hard so the run reddens with the cause named.
// Auth-shaped (401/403) and request-shaped (400/404/422) statuses are
// misconfiguration and always throw hard.
async function fetchCompletion(messages) {
  let lastTrouble = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      res = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: MODEL, messages, temperature: TEMPERATURE }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      lastTrouble = `transport error: ${err.message}`;
      console.log(`  ${lastTrouble} (attempt ${attempt})`);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new HardFailure(`${res.status} from ${API_URL}: set JOURNAL_REWRITE_TOKEN for this provider. ${await res.text().catch(() => '')}`);
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      throw new HardFailure(`the provider rejected the request (${res.status}) for model "${MODEL}": ${await res.text().catch(() => '')}`);
    }
    if (res.status === 429 || res.status >= 500) {
      lastTrouble = `status ${res.status}`;
      console.log(`  provider ${res.status} (attempt ${attempt}); ${attempt < 2 ? 'retrying' : 'done retrying'}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 15000));
      continue;
    }
    if (!res.ok) throw new HardFailure(`unexpected status ${res.status} from ${API_URL}`);
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.choices)) {
      throw new HardFailure('the provider returned 200 with an unrecognized response shape');
    }
    const content = data.choices[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      console.log(`  empty completion (finish_reason: ${data.choices[0]?.finish_reason ?? 'unknown'})`);
      return null;
    }
    return content;
  }
  if (LOCAL_SERVER) {
    throw new HardFailure(`the local llama-server passed its health check and then failed both calls (${lastTrouble})`);
  }
  return null;
}

async function main() {
  const history = readRepoJson('src/logic/modelHistory.json');
  const meta = readRepoJson('src/logic/experimentTarget.json');

  const screen = planJournalScreen(history, meta);
  if (!screen?.active?.entry?.text) {
    console.log('No active study entry tonight; nothing to rewrite. The journal renders as usual.');
    return;
  }
  const { study, entry } = screen.active;
  const date = screen.meta?.lastRefitDate ?? null;
  console.log(`Active study: ${study.feature} (${study.label ?? 'unnamed'}), entry ${entry.text.length} chars, latest fit ${date}`);
  console.log(`Source beats:\n  ${entry.text}`);

  if (entry.text.length < MIN_SOURCE_CHARS) {
    console.log(`Entry is under ${MIN_SOURCE_CHARS} chars; short entries read fine unrewritten. Skipping tonight.`);
    return;
  }

  const prompt = buildRewritePrompt({
    entryText: entry.text,
    facts: entry.facts,
    label: study.label,
  });
  if (DRY_RUN) {
    console.log('--dry-run: prompt follows, no API call.\n');
    console.log(`[system]\n${prompt.system}\n`);
    console.log(`[user]\n${prompt.user}`);
    return;
  }

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  let paragraph = null;
  for (let draft = 1; draft <= MAX_DRAFTS && paragraph === null; draft++) {
    let raw;
    if (FIXTURE) {
      raw = readFileSync(FIXTURE, 'utf8');
    } else {
      raw = await fetchCompletion(messages);
      if (raw === null) {
        console.log('No completion tonight; the beat assembly stands.');
        return;
      }
    }
    const candidate = normalizeModelOutput(raw);
    const violations = rewriteViolations(candidate, entry.text, entry.facts);
    if (violations.length === 0) {
      paragraph = candidate;
      break;
    }
    console.log(`Draft ${draft} failed validation:\n  ${violations.join('\n  ')}`);
    if (FIXTURE) return; // a fixture gets one shot; rejection is the test's answer
    messages.push(
      { role: 'assistant', content: candidate },
      {
        role: 'user',
        content: 'That draft broke these rules:\n'
          + violations.map(v => `- ${v}`).join('\n')
          + '\nRewrite the notes again. Obey every rule this time, and return only the paragraph.',
      },
    );
  }
  if (paragraph === null) {
    console.log(`No draft cleared the validator in ${MAX_DRAFTS} tries; the beat assembly stands tonight.`);
    return;
  }

  const artifact = buildRewriteArtifact({
    feature: study.feature,
    date,
    entryText: entry.text,
    paragraph,
    extra: { model: FIXTURE ? 'fixture' : MODEL, generatedAt: new Date().toISOString() },
  });
  writeFileSync(OUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Accepted paragraph (${paragraph.length} chars):\n  ${paragraph}`);
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(err => {
  if (err instanceof HardFailure) {
    console.error(`::error::journal rewrite machinery failure: ${err.message}`);
  } else {
    console.error('::error::journal rewrite crashed unexpectedly:');
    console.error(err);
  }
  process.exitCode = 1;
});
