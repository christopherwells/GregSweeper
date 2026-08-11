// ── Greg's Journal, the in-app notebook surface ──────────────────────
// Depth over breadth (the 2026-07-12 reframe): ONE deep card for the
// active experiment (hypothesis, composed notebook entry, uncertainty
// sparkline, dated lab log), a CONCLUSIONS LEDGER of closed studies as
// one-line past-tense findings that expand on tap, one QUEUE line from
// the coverage list, and the full parameter picture behind a single
// "full ledger" link. In-between studies have no cards here, they stay
// reachable through the table and their ?report= pages. Every word
// comes from the pure journalProse/journalFindings derivations over the
// SHIPPED modelHistory.json, the same honesty contract as gregVoice:
// nothing renders that the fit didn't produce, and the bad days
// (widened estimates, rejected fits, lost hunches) publish like any
// other. Lazy-loaded from the More sheet row in main.js.

import { $ } from './domHelpers.js';
import { planJournalScreen } from '../logic/journalProse.js';
import { applyJournalRewrite, REWRITE_ARTIFACT_PATH } from '../logic/journalRewrite.js';
import { loadExperimentTarget, getExperimentMeta } from '../logic/experimentDesign.js';
import { buildStudyCard, chipFor, el, metaSummaryLine } from './journalCard.js';
import { showToast } from './toastManager.js';

function _shareFeedback(outcome) {
  if (outcome === 'copied') showToast('Link copied. Paste it to a friend.');
  else if (outcome === 'failed') showToast('Couldn’t share the link.', 3000, 'uiWarning');
}

function _sectionRow(item, rewrite) {
  const details = el('details', 'journal-ledger-row');
  const summary = el('summary', 'journal-ledger-summary');
  summary.appendChild(el('span', 'journal-ledger-line', item.line));
  summary.appendChild(chipFor(item.study, item.state));
  details.appendChild(summary);
  // The expansion is pre-composed (the whole screen shares one prose
  // session, so the collision rule holds even across cards the player
  // hasn't opened yet), and the nightly rewrite applies to it under
  // the same hash-or-beats guard as the hero. No header, the one-liner
  // already names it.
  details.appendChild(buildStudyCard(item.study, applyJournalRewrite(item.entry, rewrite, item.study.feature), {
    head: false,
    className: 'journal-ledger-body',
    onShareFallback: _shareFeedback,
  }));
  return details;
}

// One titled section of rows (his three-bucket spec, 2026-08-11).
// Returns null when there is nothing to put in it, so an empty section
// never renders a lonely header.
function _rowSection(title, rows, rewrite, className) {
  if (!rows || rows.length === 0) return null;
  const section = el('section', `journal-conclusions${className ? ` ${className}` : ''}`);
  section.appendChild(el('h3', 'journal-section-title', title));
  for (const item of rows) section.appendChild(_sectionRow(item, rewrite));
  return section;
}

function _fullLedger(table) {
  const details = el('details', 'journal-full-ledger');
  details.appendChild(el('summary', 'journal-ledger-summary', 'The full ledger: every number I track'));
  const tbl = el('table', 'journal-table');
  const head = el('tr');
  for (const h of ['Feature', 'Effect', 'Range']) head.appendChild(el('th', null, h));
  tbl.appendChild(head);
  for (const r of table) {
    const tr = el('tr');
    const featureCell = el('td', null, r.label);
    // The basis reads INLINE after the name (his 2026-08-11 note: a
    // second row per feature wastes height), only on the rows whose
    // basis differs from the table's stated ten-tile default.
    if (r.per) featureCell.appendChild(el('span', 'journal-table-per', ` · ${r.per}`));
    tr.appendChild(featureCell);
    tr.appendChild(el('td', null, r.effect));
    tr.appendChild(el('td', null, r.range));
    tbl.appendChild(tr);
  }
  details.appendChild(tbl);
  details.appendChild(el('p', 'journal-table-note',
    'Each row shows what ten more of the feature would add to a solve, with the band the model would bet on. Rows that measure differently say their own basis under the name. Greg re-fits these every night.'));
  return details;
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
  let rewrite = null;
  try {
    // The rewrite artifact is optional polish: its fetch failure must
    // never take the notes down with it, hence the per-fetch catch.
    [history, rewrite] = await Promise.all([
      fetch('./src/logic/modelHistory.json').then(r => (r.ok ? r.json() : null)),
      fetch(`./${REWRITE_ARTIFACT_PATH}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
      loadExperimentTarget(),
    ]);
  } catch { /* handled below, the empty state renders */ }

  const screen = Array.isArray(history) && history.length > 0
    ? planJournalScreen(history, getExperimentMeta())
    : null;
  body.textContent = '';
  if (!screen) {
    body.appendChild(el('p', 'journal-empty',
      'Greg’s notes aren’t available right now. They ship with the game, so try again once you’re back online.'));
    return;
  }

  body.appendChild(el('p', 'journal-intro', screen.intro));

  if (screen.meta && !screen.meta.fitOk) {
    body.appendChild(el('p', 'journal-fit-warning',
      'Last night’s fit failed my quality bar, so I kept the previous model.'));
  }

  // ── Collecting data ── the live section: the active experiment's
  // deep card leads it, every other ONGOING study follows as a row,
  // and the queue line closes it (what Greg wants data on next). The
  // hero's header claims only what the live target IS, never that
  // today's board includes it: boards generate days ahead under
  // earlier targets (the 2026-06-10 field-note drift class).
  if (screen.active || screen.collecting.length > 0 || screen.queue) {
    const collectingSection = el('section', 'journal-conclusions journal-collecting');
    collectingSection.appendChild(el('h3', 'journal-section-title', 'Collecting data'));
    if (screen.active) {
      // The nightly AI rewrite replaces a beat-assembled entry ONLY
      // when the shipped artifact hashes to the exact entry this
      // client just composed and re-clears the honesty rails;
      // otherwise the beats render byte for byte (journalRewrite.js
      // owns the guards). Same rule on every section row below.
      const activeEntry = applyJournalRewrite(
        screen.active.entry, rewrite, screen.active.study.feature,
      );
      collectingSection.appendChild(buildStudyCard(screen.active.study, activeEntry, {
        className: 'journal-open',
        title: `Now studying: ${screen.active.study.label}`,
        log: screen.active.log,
        onShareFallback: _shareFeedback,
      }));
      // Boards precompute nights ahead, so the daily card's field note
      // and this study routinely name different questions; saying so
      // here is what keeps that from reading as a contradiction (his
      // question, 2026-08-11: a worm-tiles study while the daily said
      // threes vs mine density).
      collectingSection.appendChild(el('p', 'journal-active-note',
        'Boards are built nights ahead, so today’s puzzle may serve an earlier question than the one Greg is on now.'));
    }
    for (const item of screen.collecting) collectingSection.appendChild(_sectionRow(item, rewrite));
    if (screen.queue) {
      collectingSection.appendChild(el('p', 'journal-queue', screen.queue.text));
    }
    body.appendChild(collectingSection);
  }

  // ── Need to revisit ── the alarm surface: parked numbers that
  // drifted and ranges that widened, capped in the pure layer.
  const revisitSection = _rowSection('Need to revisit', screen.revisit, rewrite, 'journal-revisit');
  if (revisitSection) body.appendChild(revisitSection);

  // The one population exhibit. It needs Firebase and the player's own
  // history, so it lands a beat after the notes rather than holding
  // them up, and it returns null whenever nothing honest can be drawn.
  const heatmapSlot = el('div', 'journal-heatmap-slot');
  body.appendChild(heatmapSlot);
  import('./journalHeatmap.js')
    .then(m => m.buildHeatmapExhibit())
    .then(card => { if (card) heatmapSlot.appendChild(card); })
    .catch(() => { /* the notebook reads fine without it */ });

  const closedSection = _rowSection('Closed for now', screen.closed, rewrite, 'journal-closed');
  if (closedSection) body.appendChild(closedSection);

  if (screen.table.length > 0) {
    body.appendChild(_fullLedger(screen.table));
  }

  if (screen.unnamedCount > 0) {
    body.appendChild(el('p', 'journal-unnamed',
      `There ${screen.unnamedCount === 1 ? 'is also 1 early experiment' : `are also ${screen.unnamedCount} early experiments`} I never gave a name.`));
  }

  if (screen.meta) {
    body.appendChild(metaSummaryLine(screen.meta));
  }
}
