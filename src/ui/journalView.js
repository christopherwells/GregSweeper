// ── Greg's Journal — the in-app findings surface ──────────────────────
// The nightly experiment's public notebook: the live open study, one
// card per named study (hypothesis → verdict → current estimate →
// uncertainty sparkline), and the model's meta line. Every number comes
// from the pure journalFindings derivation over the SHIPPED
// modelHistory.json — the same honesty contract as gregVoice: nothing
// renders that the fit didn't produce, and the bad days (widened
// estimates, rejected fits) publish like any other. Lazy-loaded from
// the More sheet row in main.js.

import { $ } from './domHelpers.js';
import { buildJournal, estimateLine } from '../logic/journalFindings.js';
import { loadExperimentTarget, getExperimentMeta } from '../logic/experimentDesign.js';
import { renderStudySparkline, formatShortDate } from './journalFigure.js';

const VERDICT_CHIPS = {
  settling: 'Settling',
  widened: 'Widened',
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

function _studyCard(study) {
  const card = el('article', 'journal-card');

  const head = el('div', 'journal-card-head');
  head.appendChild(el('h3', null, capitalize(study.label)));
  head.appendChild(el('span', `journal-chip journal-chip-${study.verdict.kind}`, VERDICT_CHIPS[study.verdict.kind] || ''));
  card.appendChild(head);

  card.appendChild(el('p', 'journal-hypothesis', study.hypothesis));
  card.appendChild(el('p', `journal-verdict journal-verdict-${study.verdict.kind}`, study.verdict.copy));

  const estimate = estimateLine(study);
  if (estimate) card.appendChild(el('p', 'journal-estimate', estimate));

  const spark = renderStudySparkline(study);
  if (spark) {
    const fig = el('div', 'journal-fig');
    fig.appendChild(spark);
    fig.appendChild(el('span', 'journal-fig-caption', 'Greg’s uncertainty, night by night (100% = where this era began)'));
    card.appendChild(fig);
  }

  let metaLine = `Studied ${study.studyDayCount} day${study.studyDayCount !== 1 ? 's' : ''}`;
  if (study.firstStudied) {
    metaLine += study.firstStudied === study.lastStudied
      ? ` · ${formatShortDate(study.firstStudied)}`
      : ` · ${formatShortDate(study.firstStudied)} – ${formatShortDate(study.lastStudied)}`;
  }
  if (study.allBackfilled) metaLine += ' · from the bootstrap era';
  card.appendChild(el('p', 'journal-card-meta', metaLine));

  return card;
}

// Fill #journal-body. The modal shell is static HTML (index.html) and
// is opened by main.js before this runs, so the player sees the frame
// immediately and the notes land a beat later.
export async function renderJournalModal() {
  const body = $('#journal-body');
  if (!body) return;
  body.textContent = '';
  body.appendChild(el('p', 'journal-loading', 'Reading Greg’s notes…'));

  let history = null;
  try {
    [history] = await Promise.all([
      fetch('./src/logic/modelHistory.json').then(r => (r.ok ? r.json() : null)),
      loadExperimentTarget(),
    ]);
  } catch { /* handled below — the empty state renders */ }

  if (!Array.isArray(history) || history.length === 0) {
    body.textContent = '';
    body.appendChild(el('p', 'journal-empty',
      'Greg’s notes aren’t available right now. They ship with the game — try again once you’re back online.'));
    return;
  }

  const journal = buildJournal(history, getExperimentMeta());
  body.textContent = '';

  body.appendChild(el('p', 'journal-intro',
    'Every daily board is part of a live experiment: each night the par model refits itself on real solves, '
    + 'then picks tomorrow’s board to answer whatever it’s least sure about. These are the study notes — bad days included.'));

  if (journal.meta && !journal.meta.fitOk) {
    body.appendChild(el('p', 'journal-fit-warning',
      'Last night’s fit failed Greg’s quality bar, so the previous model is still in charge.'));
  }

  if (journal.open) {
    const open = el('section', 'journal-open');
    open.appendChild(el('h3', null, `Now studying: ${journal.open.label}`));
    open.appendChild(el('p', 'journal-hypothesis', journal.open.hypothesis));
    // Careful: this card describes the refit's LIVE priority, which is
    // NOT today's board — boards are generated days ahead under earlier
    // targets, and most are coverage missions besides (the 2026-06-10
    // field-note drift class). The note must claim only what the live
    // target actually is: what the model wants data on next.
    open.appendChild(el('p', 'journal-open-note', 'Where the model most wants data right now.'));
    body.appendChild(open);
  }

  for (const study of journal.studies) {
    body.appendChild(_studyCard(study));
  }

  if (journal.unnamedCount > 0) {
    body.appendChild(el('p', 'journal-unnamed',
      `…plus ${journal.unnamedCount} early experiment${journal.unnamedCount !== 1 ? 's' : ''} that never earned a name.`));
  }

  if (journal.meta) {
    const bits = ['Model refit nightly'];
    // "solves", mode-neutral: n_scores counts the daily fit's rows
    // (daily completions + weekly firsts) — NOT the Timed mode, whose
    // win-censored runs feed a separate model and are excluded here.
    if (journal.meta.totalRuns != null && journal.meta.nPlayers != null) {
      bits.push(`${journal.meta.totalRuns} solves from ${journal.meta.nPlayers} players`);
    }
    if (journal.meta.lastRefitDate) bits.push(`last fit ${formatShortDate(journal.meta.lastRefitDate)}`);
    body.appendChild(el('p', 'journal-meta', bits.join(' · ')));
  }
}
