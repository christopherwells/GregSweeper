// Diagnostics modal — ground-truth snapshot of what this device sees.
// Opened from Settings → Show Diagnostics. Renders the signed-in uid,
// Firebase connectivity, Firebase-vs-client join counts, loaded PAR_MODEL
// coefficients, loaded handicaps.json metadata, and the app version. Gives
// the user a screenshot-friendly surface to send over when a stats number
// looks wrong.

import { $ } from './domHelpers.js';
import { showModal } from './modalManager.js';
import { showToast } from './toastManager.js';
import { getUid } from '../firebase/firebaseProgress.js';
import {
  isFirebaseOnline, fetchUserDailyHistory, fetchAllDailyMeta,
} from '../firebase/firebaseLeaderboard.js';
import { PAR_MODEL } from '../logic/difficulty.js';
import { loadHandicaps, getHandicap, getHandicapsMeta } from '../logic/handicaps.js';

const UID_RETRY_MS = 1000;

export async function openDiagnosticsModal(currentVersion) {
  const body = $('#diagnostics-body');
  body.innerHTML = '<p class="diagnostics-loading">Gathering diagnostics…</p>';
  showModal('diagnostics-modal');

  const snapshot = await collectSnapshot(currentVersion);
  renderSnapshot(body, snapshot);
}

// ── Data gathering ────────────────────────────────────

async function collectSnapshot(currentVersion) {
  // Anonymous auth may still be in flight the first time the user lands
  // here — give it one retry before giving up.
  let uid = getUid();
  if (!uid) {
    await new Promise(r => setTimeout(r, UID_RETRY_MS));
    uid = getUid();
  }

  const firebaseOnline = isFirebaseOnline();

  // Load handicaps, Firebase history, and dailyMeta in parallel. Any of
  // them can be null / empty on a cold session or when Firebase is down;
  // renderSnapshot handles those cases.
  const [handicapsMap, history, metaByDate] = await Promise.all([
    loadHandicaps().then(m => m || {}),
    uid ? fetchUserDailyHistory(uid, 365) : Promise.resolve(null),
    fetchAllDailyMeta(),
  ]);

  // loadHandicaps has resolved, so getHandicapsMeta / getHandicap are safe.
  const handicapsMeta = getHandicapsMeta();
  const handicap = uid ? getHandicap(uid) : 0;
  const uidInHandicaps = !!(uid && uid in handicapsMap);

  const historyCount = Array.isArray(history) ? history.length : null;
  let withFeatures = null;
  let withoutFeatures = null;
  let missingFeatureDates = [];
  if (Array.isArray(history) && metaByDate) {
    const hits = history.filter(h => metaByDate[h.date]);
    withFeatures = hits.length;
    withoutFeatures = history.length - hits.length;
    missingFeatureDates = history
      .filter(h => !metaByDate[h.date])
      .map(h => h.date)
      .slice(0, 10);
  }

  return {
    version: currentVersion,
    timestamp: new Date().toISOString(),
    uid: uid || null,
    firebaseOnline,
    history: {
      historyCount,
      withFeatures,
      withoutFeatures,
      missingFeatureDates,
    },
    handicap: {
      value: handicap,
      uidInHandicaps,
    },
    handicapsMeta,
    handicapsMap,
    parModel: { ...PAR_MODEL },
    userAgent: navigator.userAgent,
  };
}

// ── Rendering ─────────────────────────────────────────

function renderSnapshot(body, snap) {
  body.innerHTML = '';

  // UID headline — biggest, selectable so Chris/Kate can tap to copy.
  body.appendChild(row({
    label: 'Your UID',
    value: snap.uid || '(not signed in yet)',
    cls: 'diagnostics-uid',
    warn: !snap.uid,
  }));

  body.appendChild(row({
    label: 'Firebase online',
    value: snap.firebaseOnline ? 'yes' : 'no',
    warn: !snap.firebaseOnline,
  }));

  // History summary
  const h = snap.history;
  const historyValue = h.historyCount === null
    ? 'unavailable (Firebase offline or auth not ready)'
    : `${h.historyCount} total`
      + (h.withFeatures !== null ? ` · ${h.withFeatures} with features · ${h.withoutFeatures} without` : '');
  body.appendChild(row({
    label: 'Daily history',
    value: historyValue,
    warn: h.withFeatures !== null && h.withFeatures < 3,
  }));

  if (h.withFeatures !== null && h.withFeatures < 3) {
    body.appendChild(note(
      `Stats page will show "Need 3+ plays" because only ${h.withFeatures} of your entries have matching dailyMeta features.`,
    ));
  }

  if (h.missingFeatureDates.length > 0) {
    body.appendChild(row({
      label: 'Missing-feature dates (first 10)',
      value: h.missingFeatureDates.join(', '),
      small: true,
    }));
  }

  // Handicap
  const sign = snap.handicap.value >= 0 ? '+' : '';
  const handicapStr = `${sign}${snap.handicap.value.toFixed(2)}s · uid ${snap.handicap.uidInHandicaps ? 'in' : 'NOT in'} handicaps.json`;
  body.appendChild(row({
    label: 'Your handicap',
    value: handicapStr,
    warn: snap.uid && !snap.handicap.uidInHandicaps,
  }));

  // handicaps.json meta
  const m = snap.handicapsMeta;
  body.appendChild(row({
    label: 'handicaps.json updated',
    value: m.updatedAt || '(missing)',
  }));
  body.appendChild(row({
    label: 'handicaps.json fit',
    value: `N=${m.modelFitN ?? '?'} · players=${m.nPlayers ?? '?'} · method=${m.method ?? '?'}`,
  }));

  // Full handicaps map (one line per uid)
  const mapEntries = Object.entries(snap.handicapsMap);
  if (mapEntries.length > 0) {
    const mapValue = mapEntries
      .map(([u, v]) => `${u === snap.uid ? '★ ' : '  '}${u.slice(0, 12)}… = ${(v >= 0 ? '+' : '') + v.toFixed(2)}s`)
      .join('\n');
    body.appendChild(row({
      label: 'All handicaps',
      value: mapValue,
      pre: true,
      small: true,
    }));
  }

  // PAR_MODEL — compact table. Format small coefficients with more decimals
  // so secPerCell = 0.02 doesn't round-trip through `0.02.toString()` and
  // look like "0.02" while secPerDisjunctiveMove = 10 renders as "10"; a
  // uniform 3-decimal format makes the whole column read cleanly.
  const parTable = document.createElement('pre');
  parTable.className = 'diagnostics-pre';
  parTable.textContent = Object.entries(snap.parModel)
    .map(([k, v]) => `${k.padEnd(26)} ${typeof v === 'number' ? v.toFixed(3) : v}`)
    .join('\n');
  body.appendChild(labeledBlock('PAR_MODEL (in-memory)', parTable));

  // Version + UA
  body.appendChild(row({ label: 'App version', value: snap.version }));
  body.appendChild(row({
    label: 'User agent',
    value: snap.userAgent,
    small: true,
  }));
  body.appendChild(row({
    label: 'Snapshot taken',
    value: snap.timestamp,
    small: true,
  }));

  // Copy button
  const actions = document.createElement('div');
  actions.className = 'diagnostics-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'clear-cache-btn';
  copyBtn.textContent = '📋 Copy diagnostics as JSON';
  copyBtn.addEventListener('click', () => {
    const json = JSON.stringify(snap, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json)
        .then(() => showToast('Copied ✓'))
        .catch(() => fallbackCopy(json));
    } else {
      fallbackCopy(json);
    }
  });
  actions.appendChild(copyBtn);
  body.appendChild(actions);
}

// ── Render helpers ────────────────────────────────────

function row({ label, value, cls = '', warn = false, small = false, pre = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'diagnostics-row' + (warn ? ' diagnostics-warn' : '') + (small ? ' diagnostics-small' : '');
  const labelEl = document.createElement('div');
  labelEl.className = 'diagnostics-label';
  labelEl.textContent = label;
  const valueEl = document.createElement(pre ? 'pre' : 'div');
  valueEl.className = 'diagnostics-value ' + cls;
  valueEl.textContent = value;
  wrap.appendChild(labelEl);
  wrap.appendChild(valueEl);
  return wrap;
}

function labeledBlock(label, node) {
  const wrap = document.createElement('div');
  wrap.className = 'diagnostics-row';
  const labelEl = document.createElement('div');
  labelEl.className = 'diagnostics-label';
  labelEl.textContent = label;
  wrap.appendChild(labelEl);
  wrap.appendChild(node);
  return wrap;
}

function note(text) {
  const n = document.createElement('p');
  n.className = 'diagnostics-note';
  n.textContent = text;
  return n;
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Copied ✓');
  } catch {
    showToast('Copy failed — long-press to select');
  }
  document.body.removeChild(ta);
}
