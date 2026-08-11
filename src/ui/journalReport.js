// ── The journal report: one finding, as a logged-out share page ──────
// Reached by ?report=<feature> (a study id, the model feature key).
// Mirrors the ?crux= route exactly: main.js init() branches here BEFORE
// the startup gate, so there is no game init and the page works logged
// out. modelHistory.json is a static bundle asset (SW-precached), so
// the fetch needs no auth and survives offline once cached. An unknown
// or missing id falls back to the journal index (every published
// finding), never an error page, and the raw id is never echoed into
// the DOM (no jargon, no injection surface).
//
// The finding renders through the SAME journalProse composition and
// journalCard builder the in-app notebook uses, so this page can never
// claim something the notebook wouldn't. The active experiment (read
// from the latest refit row, derivable from shipped data, no
// experimentTarget fetch needed) additionally carries its dated lab
// log. Deliberately NO claim tying the finding to today's board: boards
// generate days ahead under earlier targets (the 2026-06-10 field-note
// drift class), so the CTA sells the daily on the no-guess contract,
// never on "today's board tests this".

import { buildJournal, findingById } from '../logic/journalFindings.js';
import { composeEntry, labLog, newSession, activeFeatureFrom } from '../logic/journalProse.js';
import { applyJournalRewrite, REWRITE_ARTIFACT_PATH } from '../logic/journalRewrite.js';
import {
  VERDICT_CHIPS, buildStudyCard, makeShareButton, metaSummaryLine, capitalize, el,
} from './journalCard.js';
import { spriteImgHTML } from './spriteLoader.js';

function _ctaHref() {
  // Drop ?report= and push to the daily; a brand-new visitor onboards first.
  return `${location.pathname}?mode=daily`;
}

function _brandBlock() {
  const div = el('div', 'crux-teaser-brand');
  div.innerHTML = `${spriteImgHTML('smiley', 'crux-greg', 'Greg')}
    <div>
      <div class="crux-teaser-logo">GregSweeper</div>
      <div class="crux-teaser-tagline">No guesses. Ever.</div>
    </div>`;
  return div;
}

// The honest context line under a finding, the shared builder, so the
// report page and the in-app modal can never state different meta facts.
function _metaLine(journal) {
  return metaSummaryLine(journal?.meta, 'journal-meta journal-report-meta');
}

function _actions(study) {
  const wrap = el('div', 'crux-teaser-actions');
  if (study) {
    // The standalone page has no toast layer, so the fallback feedback
    // is a button flash.
    wrap.appendChild(makeShareButton(study, 'crux-reveal-all', (outcome, btn) => {
      btn.textContent = outcome === 'copied' ? 'Link copied' : 'Couldn’t copy the link';
      setTimeout(() => { btn.textContent = 'Share this finding'; }, 2000);
    }));
  }
  const cta = el('a', 'action-btn primary crux-cta', "Play today's board");
  cta.href = _ctaHref();
  wrap.appendChild(cta);
  if (study) {
    const all = el('a', 'crux-reveal-all journal-report-all', 'All of Greg’s findings');
    all.href = `${location.pathname}?report=`;
    wrap.appendChild(all);
  }
  return wrap;
}

function _renderFinding(card, study, journal, history, rewrite) {
  card.appendChild(el('p', 'crux-teaser-date journal-report-kicker', 'From Greg’s Journal, the nightly experiment’s notebook'));
  // The active experiment gets its lab log; closed and in-between
  // studies read as their settled entries. activeFeatureFrom is the
  // same resolver the in-app planner uses (meta is null here, no
  // experimentTarget fetch on the logged-out page, so this runs one
  // nightly cycle behind the in-app card at worst).
  const activeFeature = activeFeatureFrom(history, null);
  const entry = composeEntry(study, { activeFeature }, newSession());
  const log = study.feature === activeFeature ? labLog(history, study.feature) : null;
  // The nightly AI rewrite applies here exactly as in the notebook: only
  // when the artifact hashes to the entry this page just composed and
  // re-clears the honesty rails. On a revalidation night the in-app
  // entry differs from this page's (no experimentTarget here), so the
  // hash guard leaves this page on its beats; honest either way.
  card.appendChild(buildStudyCard(study, applyJournalRewrite(entry, rewrite, study.feature), {
    className: 'journal-report-study',
    log,
  }));
  card.appendChild(_metaLine(journal));
  card.appendChild(_actions(study));
}

function _renderIndex(card, journal, unknownId) {
  card.appendChild(el('p', 'crux-teaser-date journal-report-kicker', 'Greg’s Journal · the nightly experiment’s notebook'));
  if (unknownId) {
    // Never echo the raw id, no jargon, no injection surface.
    card.appendChild(el('p', 'crux-teaser-prompt', 'I don’t have a study by that name. Here is everything I’ve published.'));
  }
  card.appendChild(el('p', 'journal-intro journal-report-intro',
    'Greg times every solve and uses the results to work out what actually makes a board hard. '
    + 'These are his findings, including the days that didn’t go his way.'));

  const list = el('div', 'journal-report-index');
  for (const s of journal.studies) {
    const a = el('a', 'journal-report-row');
    a.href = `${location.pathname}?report=${encodeURIComponent(s.feature)}`;
    a.appendChild(el('span', 'journal-report-row-label', capitalize(s.label)));
    a.appendChild(el('span', `journal-chip journal-chip-${s.verdict.kind}`, VERDICT_CHIPS[s.verdict.kind] || ''));
    list.appendChild(a);
  }
  card.appendChild(list);
  card.appendChild(_metaLine(journal));
  card.appendChild(_actions(null));
}

/**
 * Fetch the shipped history and render the report. Safe to call logged
 * out; a failed fetch renders the graceful offline state.
 */
export async function showJournalReport(featureId) {
  let history = null;
  let rewrite = null;
  try {
    [history, rewrite] = await Promise.all([
      fetch('./src/logic/modelHistory.json').then(r => (r.ok ? r.json() : null)),
      fetch(`./${REWRITE_ARTIFACT_PATH}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  } catch { /* handled below, the offline state renders */ }
  renderJournalReport(featureId, history, rewrite);
}

/**
 * Render the report for `featureId` from already-fetched history (or
 * null for the offline state). Split from showJournalReport so tests
 * can drive it with a fixture, mirroring renderCruxTeaser.
 */
export function renderJournalReport(featureId, history, rewrite = null) {
  const titleScreen = document.getElementById('title-screen');
  const app = document.getElementById('app');
  if (titleScreen) titleScreen.classList.add('hidden');
  if (app) app.classList.add('hidden');

  const root = document.getElementById('journal-report');
  if (!root) return;
  root.classList.remove('hidden');
  root.textContent = '';

  const card = el('div', 'crux-teaser-card journal-report-card');
  card.appendChild(_brandBlock());

  if (!Array.isArray(history) || history.length === 0) {
    card.appendChild(el('p', 'crux-teaser-prompt',
      'Greg’s notes aren’t available right now. They ship with the game, so try again once you’re back online.'));
    card.appendChild(_actions(null));
    root.appendChild(card);
    return;
  }

  const study = findingById(history, featureId);
  const journal = buildJournal(history, null);
  if (study) {
    _renderFinding(card, study, journal, history, rewrite);
  } else {
    _renderIndex(card, journal, typeof featureId === 'string' && featureId.length > 0);
  }
  root.appendChild(card);
}
