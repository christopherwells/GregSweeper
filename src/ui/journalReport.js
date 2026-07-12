// ── The journal report: one finding, as a logged-out share page ──────
// Reached by ?report=<feature> (a study id — the model feature key).
// Mirrors the ?crux= route exactly: main.js init() branches here BEFORE
// the startup gate, so there is no game init and the page works logged
// out. modelHistory.json is a static bundle asset (SW-precached), so
// the fetch needs no auth and survives offline once cached. An unknown
// or missing id falls back to the journal index (every published
// finding), never an error page — and the raw id is never echoed into
// the DOM (no jargon, no injection surface).
//
// Everything shown derives from the same pure journalFindings functions
// the in-app journal uses, so this page can never claim something the
// notebook wouldn't. Deliberately NO claim tying the finding to today's
// board: boards generate days ahead under earlier targets (the
// 2026-06-10 field-note drift class), so the CTA sells the daily on the
// no-guess contract, never on "today's board tests this".

import {
  buildJournal, findingById, estimateLine, retroCaption, formatShortDate,
} from '../logic/journalFindings.js';
import { renderStudySparkline } from './journalFigure.js';
import { spriteImgHTML } from './spriteLoader.js';
import { PROD_SITE_BASE } from '../config.js';

// Chip labels for the verdict kinds. journalView imports these too, so
// the in-app cards and the share page can never disagree on a name.
export const VERDICT_CHIPS = {
  settling: 'Closing in',
  widened: 'Widened',
  resting: 'Resting',
  open: 'Still open',
  early: 'Just started',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function _ctaHref() {
  // Drop ?report= and push to the daily; a brand-new visitor onboards first.
  return `${location.pathname}?mode=daily`;
}

// Share (or copy) a finding's public link — the same Web Share /
// clipboard flow as the crux challenge button, with the hardcoded prod
// base so a link copied from /test/ still points at the public site.
// Returns 'shared' | 'dismissed' | 'copied' | 'failed'; callers own the
// feedback (toast in-app, button flash on the standalone page).
export async function shareFindingLink(study) {
  const url = `${PROD_SITE_BASE}?report=${encodeURIComponent(study.feature)}`;
  const shareData = {
    title: 'GregSweeper',
    text: `Greg measures what actually makes a minesweeper board hard. His notes on ${study.label}:`,
    url,
  };
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    try {
      await navigator.share(shareData);
      return 'shared';
    } catch {
      return 'dismissed'; // user closed the sheet — stay quiet
    }
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
  } catch { /* clipboard unavailable — fall through */ }
  return 'failed';
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

// The honest context line under a finding: how much data stands behind
// the notebook, and when it last changed. Same facts as the in-app
// journal's meta line.
function _metaLine(journal) {
  const bits = ['Greg re-checks the numbers every night'];
  if (journal?.meta?.totalRuns != null && journal?.meta?.nPlayers != null) {
    bits.push(`${journal.meta.totalRuns} solves from ${journal.meta.nPlayers} players`);
  }
  if (journal?.meta?.lastRefitDate) bits.push(`last updated ${formatShortDate(journal.meta.lastRefitDate)}`);
  return el('p', 'journal-meta journal-report-meta', bits.join(' · '));
}

function _actions(study) {
  const wrap = el('div', 'crux-teaser-actions');
  if (study) {
    const share = el('button', 'crux-reveal-all', 'Share this finding');
    share.type = 'button';
    share.addEventListener('click', async () => {
      const outcome = await shareFindingLink(study);
      if (outcome === 'copied' || outcome === 'failed') {
        share.textContent = outcome === 'copied' ? 'Link copied' : 'Couldn’t copy the link';
        setTimeout(() => { share.textContent = 'Share this finding'; }, 2000);
      }
    });
    wrap.appendChild(share);
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

function _studyArticle(study) {
  const article = el('article', 'journal-card journal-report-study');
  const head = el('div', 'journal-card-head');
  head.appendChild(el('h3', null, capitalize(study.label)));
  head.appendChild(el('span', `journal-chip journal-chip-${study.verdict.kind}`, VERDICT_CHIPS[study.verdict.kind] || ''));
  article.appendChild(head);

  article.appendChild(el('p', 'journal-hypothesis', study.hypothesis));
  article.appendChild(el('p', `journal-verdict journal-verdict-${study.verdict.kind}`, study.verdict.copy));

  const estimate = estimateLine(study);
  if (estimate) article.appendChild(el('p', 'journal-estimate', estimate));

  const spark = renderStudySparkline(study);
  if (spark) {
    const fig = el('div', 'journal-fig');
    fig.appendChild(spark);
    fig.appendChild(el('span', 'journal-fig-caption', 'Greg’s uncertainty, night by night. A falling line means he’s homing in.'));
    const retro = retroCaption(study);
    if (retro) fig.appendChild(el('span', 'journal-fig-caption', retro));
    article.appendChild(fig);
  }

  let metaLine = `Studied ${study.studyDayCount} day${study.studyDayCount !== 1 ? 's' : ''}`;
  if (study.firstStudied) {
    metaLine += study.firstStudied === study.lastStudied
      ? ` · ${formatShortDate(study.firstStudied)}`
      : ` · ${formatShortDate(study.firstStudied)} to ${formatShortDate(study.lastStudied)}`;
  }
  if (study.allBackfilled) metaLine += ' · from Greg’s early calibration days';
  article.appendChild(el('p', 'journal-card-meta', metaLine));

  return article;
}

function _renderFinding(card, study, journal) {
  card.appendChild(el('p', 'crux-teaser-date journal-report-kicker', 'From Greg’s Journal, the nightly experiment’s notebook'));
  card.appendChild(_studyArticle(study));
  card.appendChild(_metaLine(journal));
  card.appendChild(_actions(study));
}

function _renderIndex(card, journal, unknownId) {
  card.appendChild(el('p', 'crux-teaser-date journal-report-kicker', 'Greg’s Journal · the nightly experiment’s notebook'));
  if (unknownId) {
    // Never echo the raw id — no jargon, no injection surface.
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
  try {
    history = await fetch('./src/logic/modelHistory.json').then(r => (r.ok ? r.json() : null));
  } catch { /* handled below — the offline state renders */ }
  renderJournalReport(featureId, history);
}

/**
 * Render the report for `featureId` from already-fetched history (or
 * null for the offline state). Split from showJournalReport so tests
 * can drive it with a fixture, mirroring renderCruxTeaser.
 */
export function renderJournalReport(featureId, history) {
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
    _renderFinding(card, study, journal);
  } else {
    _renderIndex(card, journal, typeof featureId === 'string' && featureId.length > 0);
  }
  root.appendChild(card);
}
