// ── Par Lab HUD + session driver (test-only surface) ─────────────────────
//
// The interactive half of src/logic/parLab.js: a fixed strip above the game
// showing battery progress and the current board's spec, plus the controls
// that drive the session (next board / skip / copy results). The board
// itself plays through the ordinary coastline-practice machinery, frozen,
// certified, isLevelPractice, records nothing to real progression, with
// gameActions reading `state.parLabSpec` for the per-board config.
//
// Recording is LOCAL (localStorage, namespaced) and exports as JSON from the
// copy button: these rows feed a one-time offline prior-seeding analysis,
// never the nightly refit, and test builds never write Firebase anyway.
//
// The HUD's DOM is created here at runtime rather than living in index.html:
// the lab is unreachable in production (the ?parlab= gate is in main.js's
// test-env derivation), so production HTML carries no trace of it.

import { state, getActiveBombPenaltyTotal } from '../state/gameState.js';
import { newGame } from '../game/gameActions.js';
import { showToast } from './toastManager.js';
import { safeGet, safeSet } from '../storage/storageAdapter.js';
import { tilingLabel, CLASSIC_SHAPE_LABEL } from '../logic/coastlineLink.js';
import { pushParLabRow } from '../firebase/parLabSync.js';
import {
  PAR_LAB_BATTERY, nextParLabBoard, attemptCountFor, labProgress,
  buildParLabRow, appendParLabRow, exportParLab, redoParLabBoard,
} from '../logic/parLab.js';

const STORE_KEY = 'gregsweeper_parlab_v1';

// ── Firebase outbox flush ────────────────────────────────────────────────
// The local log is the source of truth AND the outbox: any row without an
// fbKey has not landed on the parLab/ node yet. Flushed opportunistically
// on every lab entry and result, a failed push (offline, no auth session,
// rules not yet live) just stays queued for the next flush. Sequential and
// single-flight so two triggers can't double-push the same rows.
let _flushing = false;

async function flushUnsynced() {
  if (_flushing) return;
  _flushing = true;
  try {
    let rows = loadRows();
    let dirty = false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].fbKey) continue;
      const { fbKey, ...bare } = rows[i];
      const key = await pushParLabRow(bare);
      if (!key) break; // whatever blocked this one blocks the rest too
      rows = rows.map((r, j) => (j === i ? { ...r, fbKey: key } : r));
      dirty = true;
    }
    if (dirty) { saveRows(rows); renderHud(); }
  } finally {
    _flushing = false;
  }
}

function loadRows() {
  try {
    const raw = safeGet(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch { return []; }
}

function saveRows(rows) {
  try { safeSet(STORE_KEY, JSON.stringify({ rows })); } catch { /* storage full/blocked, the HUD still shows the session */ }
}

function specLabel(spec) {
  const shape = spec.shape === 'rect'
    ? `${CLASSIC_SHAPE_LABEL} ${spec.rows}×${spec.cols}`
    : tilingLabel(spec.shape);
  const cells = spec.shape === 'rect' ? spec.rows * spec.cols : null;
  const mods = spec.gimmicks && spec.gimmicks.length ? ` · ${spec.gimmicks.join('+')}` : '';
  const warm = spec.warmup ? ' · warm-up' : '';
  return `${shape}${cells ? ` (${cells} cells)` : ''} · ${spec.mines} mines${mods}${warm}`;
}

// ── HUD ──────────────────────────────────────────────────────────────────

let _hud = null;

function ensureHud() {
  if (_hud) return _hud;
  _hud = document.createElement('div');
  _hud.id = 'parlab-hud';
  _hud.innerHTML = `
    <div id="parlab-line"></div>
    <div id="parlab-status"></div>
    <div id="parlab-actions">
      <button id="parlab-next" type="button"></button>
      <button id="parlab-skip" type="button">Skip board</button>
      <button id="parlab-copy" type="button">Copy results</button>
    </div>`;
  document.body.appendChild(_hud);
  _hud.querySelector('#parlab-next').addEventListener('click', _advance);
  _hud.querySelector('#parlab-skip').addEventListener('click', _skip);
  _hud.querySelector('#parlab-copy').addEventListener('click', _copy);
  return _hud;
}

function renderHud() {
  const hud = ensureHud();
  const rows = loadRows();
  const prog = labProgress(rows);
  const lab = state.parLab;
  const line = hud.querySelector('#parlab-line');
  const status = hud.querySelector('#parlab-status');
  const nextBtn = hud.querySelector('#parlab-next');
  const skipBtn = hud.querySelector('#parlab-skip');

  const synced = rows.filter((r) => r.fbKey).length;
  const syncNote = rows.length ? ` · synced ${synced}/${rows.length}` : '';

  if (prog.complete) {
    line.textContent = `Par Lab · battery complete · ${prog.total}/${prog.total} boards${syncNote}`;
    status.textContent = synced === rows.length
      ? 'Every row is on the server. Thank you, Greg thanks you too.'
      : 'Some rows are still queued — they upload next visit, or use Copy results.';
    nextBtn.classList.add('hidden');
    skipBtn.classList.add('hidden');
    return;
  }
  const spec = lab?.spec;
  if (!spec) return;
  line.textContent = `Par Lab · board ${prog.resolved + 1}/${prog.total} · chunk ${spec.chunk} · ${specLabel(spec)}${syncNote}`;

  if (!lab.recorded) {
    status.textContent = lab.attempt > 0
      ? `Fresh layout, attempt ${lab.attempt + 1} — the lost board is logged; this one starts clean.`
      : 'Play it through. The result records itself.';
    nextBtn.classList.add('hidden');
    skipBtn.classList.remove('hidden');
  } else {
    const penaltyNote = lab.lastPenalty > 0 ? `, ${lab.lastPenalty}s of it strike penalties` : '';
    status.textContent = lab.lastResult
      ? `Recorded: win in ${lab.lastTime}s${penaltyNote}${lab.lastPar ? ` (par ${lab.lastPar}s)` : ''}.`
      : `Recorded: loss at ${lab.lastTime}s. Retry gets a FRESH layout of the same spec.`;
    nextBtn.textContent = lab.lastResult ? 'Next board ▸' : 'Retry (fresh board) ▸';
    nextBtn.classList.remove('hidden');
    skipBtn.classList.toggle('hidden', lab.lastResult === true);
  }
}

// ── Session driver ───────────────────────────────────────────────────────

async function launchSpec(spec) {
  const rows = loadRows();
  state.parLab = {
    spec,
    attempt: attemptCountFor(rows, spec.id),
    recorded: false,
    lastResult: null,
  };
  state.parLabSpec = spec;
  state.parLabAttempt = state.parLab.attempt;
  await newGame();
  renderHud();
}

async function _advance() {
  const spec = nextParLabBoard(loadRows());
  if (!spec) { state.parLab = null; state.parLabSpec = null; renderHud(); return; }
  await launchSpec(spec);
}

async function _skip() {
  const lab = state.parLab;
  if (!lab?.spec) return;
  const rows = loadRows();
  const row = buildParLabRow(lab.spec, lab.attempt, 'skip', { seq: rows.length + 1 });
  saveRows(appendParLabRow(rows, row) || rows);
  showToast(`Skipped ${lab.spec.id}.`, 2000);
  flushUnsynced();
  await _advance();
}

function _copy() {
  const json = exportParLab(loadRows());
  const done = () => showToast('Par Lab results copied — paste them into the analysis.', 3000);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(json).then(done, () => showToast('Copy failed — clipboard blocked.', 3000));
  } else {
    console.log('parlab export:', json);
    showToast('Clipboard unavailable — results printed to the console.', 4000);
  }
}

/**
 * Void a played board and re-issue it with a fresh layout (main.js
 * ?parlabRedo= branch, the escape hatch for a contaminated row, e.g. a
 * deliberately mine-popped run). Accepts the board's battery number or its
 * id. The voiding syncs as an 'invalid' tombstone; the analysis drops the
 * original server row on sight of it.
 */
export function performParLabRedo(idOrSeq) {
  const result = redoParLabBoard(loadRows(), idOrSeq);
  if (!result) {
    showToast(`Nothing to redo for board ${idOrSeq} — no resolved run found.`, 4000);
    return false;
  }
  saveRows(result.rows);
  flushUnsynced();
  showToast(`Board ${result.spec.seq} (${result.spec.id}) voided — it will re-issue with a fresh layout.`, 5000);
  return true;
}

/**
 * Entry point (main.js ?parlab= branch). Resumes at the first unresolved
 * board, so closing the tab mid-battery costs nothing.
 */
export async function startParLab() {
  ensureHud();
  flushUnsynced(); // rows queued from an earlier visit (offline, pre-rules)
  const spec = nextParLabBoard(loadRows());
  if (!spec) { state.parLab = null; renderHud(); return; }
  await launchSpec(spec);
}

/**
 * Result hook, called by winLossHandler at the end of handleWin/handleLoss
 * whenever state.parLab is active. Appends exactly one row per (id,
 * attempt): a replay of an already-recorded layout (the gameover modal's
 * own Play Again) is deliberately NOT a measurement and is dropped by the
 * storage-level guard.
 */
export function onParLabResult(won) {
  const lab = state.parLab;
  if (!lab?.spec) return;
  const rows = loadRows();
  // The DAILY time convention (his report, 2026-08-02: strike penalties
  // must count against the time): preciseTime is what stopTimer committed,
  // wall clock WITH the strike penalties folded in, the same number a
  // daily submits and the win modal shows. penaltySec rides alongside so
  // the fit can subtract back to pure play time.
  const timeSec = Math.round((state.preciseTime || state.elapsedTime || 0) * 10) / 10;
  const penaltySec = getActiveBombPenaltyTotal();
  if (!lab.recorded) {
    const row = buildParLabRow(lab.spec, lab.attempt, won ? 'win' : 'loss', {
      timeSec,
      penaltySec,
      features: state.coastlineFeatures,
      par: state.coastlinePar,
      wormEvents: state.wormEvents,
      // Lab mines are daily-style strikes; the events land in the daily
      // per-attempt log (reset by every newGame) and ride the row so the
      // fit can price them exactly as the refit prices daily strikes.
      bombHits: state.dailyBombHits || 0,
      bombHitEvents: state.dailyBombHitEvents,
      seq: rows.length + 1,
    });
    const appended = appendParLabRow(rows, row);
    if (appended) saveRows(appended);
    flushUnsynced();
  }
  lab.recorded = true;
  lab.lastResult = won;
  lab.lastTime = timeSec;
  lab.lastPenalty = penaltySec;
  lab.lastPar = state.coastlinePar > 0 ? Math.round(state.coastlinePar) : 0;
  // The challenge modal's Next Level button is meaningless here (a lab board
  // has no level to advance to), so it is hidden for this render; the HUD owns the
  // session flow. Play Again stays: replaying a seen layout is fine for
  // fun, and the recording guard keeps it out of the data.
  document.getElementById('gameover-nextlevel')?.classList.add('hidden');
  renderHud();
}
