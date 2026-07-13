// ── Journal card — the shared study-card builder ──────────────────────
// One DOM builder for a study's deep card (header + hypothesis + the
// composed notebook entry + sparkline + optional lab log + meta line +
// share), used by BOTH the in-app journal modal (journalView) and the
// logged-out ?report= page (journalReport) so the two surfaces can
// never drift apart. The prose arrives pre-composed from
// src/logic/journalProse.js — this module only lays it out.

import { formatShortDate } from '../logic/journalFindings.js';
import { planStudyFigures } from '../logic/journalProse.js';
import { renderStudyFigure } from './journalFigure.js';
import { PROD_SITE_BASE } from '../config.js';

// Chip labels for the verdict kinds — single-sourced here so the modal
// cards, the ledger rows, and the share page can never disagree on a
// name.
export const VERDICT_CHIPS = {
  settling: 'Closing in',
  widened: 'Widened',
  resting: 'Resting',
  open: 'Still open',
  early: 'Just started',
};

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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

export function chipFor(study) {
  return el('span', `journal-chip journal-chip-${study.verdict.kind}`, VERDICT_CHIPS[study.verdict.kind] || '');
}

// A "Share this finding" button; `onFallback(outcome)` handles the
// non-share-sheet outcomes ('copied' | 'failed').
export function makeShareButton(study, className, onFallback) {
  const btn = el('button', className, 'Share this finding');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    const outcome = await shareFindingLink(study);
    if (outcome === 'copied' || outcome === 'failed') onFallback(outcome, btn);
  });
  return btn;
}

function _metaLine(study) {
  // A fresh target can reach the active card before its first stamped
  // study day exists — "Studied 0 days" under "Now studying" would read
  // as a contradiction.
  if (!study.studyDayCount) {
    return el('p', 'journal-card-meta', 'No study days on the books yet');
  }
  let metaLine = `Studied ${study.studyDayCount} day${study.studyDayCount !== 1 ? 's' : ''}`;
  if (study.firstStudied) {
    metaLine += study.firstStudied === study.lastStudied
      ? ` · ${formatShortDate(study.firstStudied)}`
      : ` · ${formatShortDate(study.firstStudied)} to ${formatShortDate(study.lastStudied)}`;
  }
  if (study.allBackfilled) metaLine += ' · from Greg’s early calibration days';
  return el('p', 'journal-card-meta', metaLine);
}

// The journal-level meta line ("Greg re-checks the numbers every night ·
// N solves from M players · last updated D") — one builder for the
// in-app modal footer and the report page so the two surfaces can never
// state different meta facts. `meta` is buildJournal's meta object.
export function metaSummaryLine(meta, className = 'journal-meta') {
  const bits = ['Greg re-checks the numbers every night'];
  // "solves", mode-neutral: n_scores counts the daily fit's rows (daily
  // completions + weekly firsts) — NOT the Timed mode, whose
  // win-censored runs feed a separate model and are excluded here.
  if (meta?.totalRuns != null && meta?.nPlayers != null) {
    bits.push(`${meta.totalRuns} solves from ${meta.nPlayers} players`);
  }
  if (meta?.lastRefitDate) bits.push(`last updated ${formatShortDate(meta.lastRefitDate)}`);
  return el('p', className, bits.join(' · '));
}

/**
 * Build a study's deep card. `entry` is the composeEntry result (may be
 * null for a bare card). Options:
 *   head        — render the label + chip header (default true)
 *   title       — override the header text (e.g. "Now studying: compass")
 *   log         — labLog entries to render as the dated lab log
 *   onShareFallback — enables the share button; receives (outcome, btn)
 */
export function buildStudyCard(study, entry, opts = {}) {
  const card = el('article', `journal-card${opts.className ? ` ${opts.className}` : ''}`);

  if (opts.head !== false) {
    const head = el('div', 'journal-card-head');
    head.appendChild(el('h3', null, opts.title || capitalize(study.label)));
    head.appendChild(chipFor(study));
    card.appendChild(head);
  }

  // The italic hypothesis epigraph renders only when the composed entry
  // does NOT already carry the hunch through its arc beat ("I wrote
  // that…") — otherwise the card would print the premise twice in a row.
  if (study.hypothesis && !entry?.arcSpoken) {
    card.appendChild(el('p', 'journal-hypothesis', study.hypothesis));
  }
  if (entry?.text) card.appendChild(el('p', 'journal-entry', entry.text));

  // 1-2 figures per card, planned deterministically in the pure layer
  // (type, point shape, caption all rotate by feature + latest fit).
  for (const spec of planStudyFigures(study)) {
    const drawn = renderStudyFigure(study, spec);
    if (!drawn) continue;
    const fig = el('div', 'journal-fig');
    fig.appendChild(drawn);
    if (spec.caption) fig.appendChild(el('span', 'journal-fig-caption', spec.caption));
    card.appendChild(fig);
  }

  if (Array.isArray(opts.log) && opts.log.length > 0) {
    const logBlock = el('div', 'journal-lablog');
    logBlock.appendChild(el('h4', 'journal-lablog-title', 'Lab log'));
    for (const e of opts.log) logBlock.appendChild(el('p', 'journal-log-line', e.text));
    card.appendChild(logBlock);
  }

  card.appendChild(_metaLine(study));

  if (opts.onShareFallback) {
    card.appendChild(makeShareButton(study, 'journal-share-btn', opts.onShareFallback));
  }

  return card;
}
