// The Challenge setup sheet: the mode's entry, the way the checkpoint
// selector is the Climb's.
//
// Every control is built from LIVE data rather than an authored list, so
// the sheet can never offer something the game cannot deliver: shape and
// modifier chips come from the player's Climb unlocks (matchUnlocks, read
// off the library's own introduction schedule), and the supply line under
// them counts the match library's index rows through the same filter the
// deal uses (boardMatchesRules). A corner with no boards says so before
// the player taps Start, instead of shortening the match afterwards.
//
// Styling follows the vocabulary the app already has (the four theme traps
// in global.css): chips are the `.timed-tab` selected idiom (accent BORDER
// plus glow, never white-on-accent, which fails on about a dozen themes),
// the shape chip draws its patch from real lattice geometry via
// shapePatchSVG, modifier chips are icon-only with the inspected name
// riding a readout slot (his design-sheet ruling), and density is spoken
// as "~1 in 4" (his ruling: the decimals mean nothing to a player).

import { $, $$ } from './domHelpers.js';
import { showModal, hideModal } from './modalManager.js';
import { showModalFromTitle, closeModalAndReturn, setReturnToTitle } from './titleScreen.js';
import { hideTitleScreen } from './titleScreen.js';
import { launchMatch, resumeMatch } from '../game/modeManager.js';
import { canResumeMode } from '../game/gamePersistence.js';
import { loadStats, loadGameState } from '../storage/statsStorage.js';
import { fetchMatchCorners, fetchClimbMatchCorners } from '../game/matchDeal.js';
import { shapePatchSVG } from '../logic/shapeIntro.js';
import { tilingLabel, CLASSIC_SHAPE_LABEL } from '../logic/coastlineLink.js';
import { getGimmickDefs } from '../logic/gimmicks.js';
import { gimmickSpriteImgHTML, uiSpriteImgHTML } from './spriteLoader.js';
import {
  MATCH_BOARD_MIN, MATCH_BOARD_MAX, MATCH_TIME_BANDS, MATCH_DENSITY_BANDS,
  MATCH_DIFFICULTY_BANDS,
  matchUnlocks, matchUnlockLevel, defaultMatchRules, sanitizeMatchRules,
  countEligibleCorners,
} from '../logic/matchRules.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

const RULES_KEY = 'minesweeper_match_rules';

// The sheet's live working copy, and the summary's corner counts behind the
// supply line. Both are session state, not storage: the rules PERSIST (a
// player who likes hexes should not rebuild that every time), the counts do
// not. COUNTS rather than rows, because a count is all this surface renders,
// and the corner summary does not grow with the library's depth the way a
// row-per-board index does (see the split's note in matchRules.js).
let _rules = null;
let _corners = null;
let _climbCorners = null;

function loadSavedRules() {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveRules(rules) {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); } catch { /* private browsing */ }
}

function currentUnlocks() {
  const stats = loadStats();
  return matchUnlocks(stats.modeStats?.challenge?.maxLevelReached || 1);
}

const shapeLabelOf = (s) => (s === 'rect' ? CLASSIC_SHAPE_LABEL : tilingLabel(s));

// A chip: the theme-proof selected state, an accent border plus the glow
// over the hidden-cell fill, never a fixed foreground on a themed accent.
function chipHTML(key, inner, selected, title) {
  return `<button type="button" class="match-chip${selected ? ' active' : ''}"`
    + ` data-key="${key}" aria-pressed="${selected ? 'true' : 'false'}"`
    + ` title="${title}">${inner}</button>`;
}

function renderShapes() {
  const el = $('#match-shapes');
  if (!el) return;
  const unlocks = currentUnlocks();
  const all = ['rect', 'hex', '4.8.8', 'cairo', 'rhombille', 'floret', 'deltoidal'];
  el.innerHTML = all.map((s) => {
    const label = shapeLabelOf(s);
    const unlocked = unlocks.shapes.includes(s);
    if (!unlocked) {
      const at = matchUnlockLevel('shape', s);
      return `<button type="button" class="match-chip match-chip-locked" disabled`
        + ` title="Reach Climb Level ${at} to play ${label} here">`
        + `<span class="match-chip-art">${shapePatchSVG(s, 30)}</span>`
        + `<span class="match-chip-label">Level ${at}</span></button>`;
    }
    const art = `<span class="match-chip-art">${shapePatchSVG(s, 30)}</span>`
      + `<span class="match-chip-label">${label}</span>`;
    return chipHTML(s, art, _rules.shapes.includes(s), label);
  }).join('');
}

function renderMods() {
  const el = $('#match-mods');
  if (!el) return;
  const unlocks = currentUnlocks();
  const defs = getGimmickDefs();
  // The library's introduction order, so the row reads the way a player
  // met them rather than in registry order.
  const all = ['walls', 'liar', 'mystery', 'sonar', 'wormhole', 'mirror', 'locked', 'compass', 'worm'];
  el.innerHTML = all.map((g) => {
    const def = defs[g];
    if (!def) return '';
    const icon = gimmickSpriteImgHTML(g, 'sprite-gimmick', def.name) || def.icon || '';
    if (!unlocks.mods.includes(g)) {
      const at = matchUnlockLevel('mod', g);
      return `<button type="button" class="match-chip match-chip-icon match-chip-locked" disabled`
        + ` title="Reach Climb Level ${at} to play ${def.name} here">`
        + `<span class="match-chip-art">${icon}</span></button>`;
    }
    return `<button type="button" class="match-chip match-chip-icon`
      + `${_rules.mods.includes(g) ? ' active' : ''}" data-key="${g}"`
      + ` aria-pressed="${_rules.mods.includes(g) ? 'true' : 'false'}"`
      + ` title="${def.name}"><span class="match-chip-art">${icon}</span></button>`;
  }).join('');
  renderModReadout(null);
}

// The inspected modifier's name rides the readout slot (his call), so the
// icon row stays a row of icons. With nothing inspected it reports the
// count, which is the other thing a player wants from that line.
function renderModReadout(name) {
  const el = $('#match-mod-readout');
  if (!el) return;
  if (name) { el.textContent = name; return; }
  const n = _rules.mods.length;
  el.textContent = n === 0
    ? 'Plain boards only'
    : `${n} modifier${n === 1 ? '' : 's'} allowed`;
}

function renderBands() {
  const timeEl = $('#match-time');
  if (timeEl) {
    timeEl.innerHTML = [{ key: 'any', label: 'Any' }, ...MATCH_TIME_BANDS]
      .map((b) => chipHTML(b.key, `<span class="match-chip-label">${b.label}</span>`,
        _rules.time === b.key, b.label)).join('');
  }
  const densEl = $('#match-density');
  if (densEl) {
    // Plain language, never a decimal: the phrases are what the bands MEAN
    // at their midpoints, which is the only reading a player needs.
    const phrases = { sparse: '~1 in 8', standard: '~1 in 5', dense: '~1 in 3' };
    densEl.innerHTML = [{ key: 'any', label: 'Any' }, ...MATCH_DENSITY_BANDS]
      .map((b) => chipHTML(b.key,
        `<span class="match-chip-label">${b.label}</span>`
        + (phrases[b.key] ? `<span class="match-chip-sub">${phrases[b.key]}</span>` : ''),
        _rules.density === b.key, b.label)).join('');
  }
  const diffEl = $('#match-difficulty');
  if (diffEl) {
    // Thinking per cell, anchored to the Climb's own ramp (his labels).
    // The sub speaks in Climb terms because that is the pace a player has
    // already felt, never in seconds per cell, which nobody plays in.
    const phrases = { gentle: 'early Climb', standard: 'the middle ramp', mean: 'upper blocks' };
    diffEl.innerHTML = [{ key: 'any', label: 'Any' }, ...MATCH_DIFFICULTY_BANDS]
      .map((b) => chipHTML(b.key,
        `<span class="match-chip-label">${b.label}</span>`
        + (phrases[b.key] ? `<span class="match-chip-sub">${phrases[b.key]}</span>` : ''),
        (_rules.difficulty || 'any') === b.key, b.label)).join('');
  }
  const scrollEl = $('#match-scroll');
  if (scrollEl) {
    // The marathon opt-in (his phrase: "ok with scrolling boards"). Two
    // chips, not a checkbox, so the row speaks the sheet's own language.
    // Off is the default and today's behavior; Allow widens the deal to
    // oversized boards the camera scrolls, it never requires them.
    scrollEl.innerHTML = [
      { key: 'off', label: 'Off', sub: 'fits the screen', on: false },
      { key: 'on', label: 'Allow', sub: 'boards past the screen edge', on: true },
    ].map((b) => chipHTML(b.key,
      `<span class="match-chip-label">${b.label}</span>`
      + `<span class="match-chip-sub">${b.sub}</span>`,
      (_rules.scroll === true) === b.on, b.label)).join('');
  }
}

function renderCount() {
  const el = $('#match-count-value');
  if (el) el.textContent = String(_rules.count);
  for (const btn of $$('#match-count .match-step-btn')) {
    const step = Number(btn.dataset.step);
    btn.disabled = step < 0
      ? _rules.count <= MATCH_BOARD_MIN
      : _rules.count >= MATCH_BOARD_MAX;
  }
}

// The supply line, and the sheet's whole honesty: it counts the LIBRARY
// through the deal's own filter, so an empty corner is visible before the
// tap rather than as a short match afterwards. Rows unavailable (offline,
// first visit) is its own message, never a zero.
function renderSupply() {
  const el = $('#match-supply');
  // ── Help Greg ──────────────────────────────────────────────────────
  // His idea (2026-08-18): fill the sheet with what the model is short of, so
  // a player who wants to can work the frontier. Steering already does this
  // for at most floor(N/5) slots so a run never feels forced; this is the
  // player ASKING for the whole run to count, which belongs in the rules.
  //
  // It deliberately sets SHAPES and MODIFIERS only. Setting a density band to
  // chase the primary target would re-introduce the confound experimentDesign
  // refuses on purpose (isObservationalTarget): the digit shares are measured
  // on every board, and chasing one deepens the density correlation that is
  // the reason that study is stuck.
  const helpBtn = $('#match-help-greg');
  if (helpBtn) {
    helpBtn.addEventListener('click', async () => {
      const note = $('#match-help-note');
      helpBtn.disabled = true;
      try {
        const [{ loadExperimentTarget }, steering] = await Promise.all([
          import('../logic/experimentDesign.js'),
          import('../logic/matchSteering.js'),
        ]);
        // The list is empty until the night's target is fetched, and a button
        // that silently proposed nothing would read as broken.
        await loadExperimentTarget();
        const plan = steering.helpGregRules(steering.currentSteerMissions(), currentUnlocks());
        if (!plan) {
          if (note) note.textContent = 'Greg has what he needs right now. Any run helps.';
          return;
        }
        if (plan.shapes.length) _rules.shapes = plan.shapes.slice();
        if (plan.mods.length) _rules.mods = plan.mods.slice();
        saveRules(_rules);
        renderAll();
        if (note) {
          const shapeText = plan.shapeNames.map(shapeLabelOf).join(', ');
          const defs = getGimmickDefs();
          const modText = plan.modNames.map((m) => (defs[m] && defs[m].name) || m).join(', ');
          const parts = [];
          if (shapeText) parts.push(shapeText);
          if (modText) parts.push(modText);
          note.textContent = `Greg has the least data on ${parts.join(' with ')}. `
            + 'Change anything you like.';
        }
      } catch {
        if (note) note.textContent = 'Could not reach the notes just now.';
      } finally {
        helpBtn.disabled = false;
      }
    });
  }

  const startBtn = $('#match-start');
  if (!el) return;
  if (!_corners) {
    el.textContent = 'Checking which boards fit…';
    if (startBtn) startBtn.disabled = true;
    return;
  }
  // Both shelves: the match library plus the harvest's Climb index. The
  // second summary is null-soft, so a client that could not fetch it counts
  // the first shelf alone.
  const n = countEligibleCorners(_corners, _rules)
    + (_climbCorners ? countEligibleCorners(_climbCorners, _rules) : 0);
  if (n === 0) {
    el.innerHTML = `<span class="match-supply-empty">No boards fit these rules yet.`
      + ` Try another shape or length.</span>`;
  } else if (n < _rules.count) {
    el.innerHTML = `<span class="match-supply-empty">Only ${n} board${n === 1 ? '' : 's'}`
      + ` fit these rules, so the run will be ${n} long.</span>`;
  } else {
    el.textContent = `${n} boards fit these rules.`;
  }
  if (startBtn) startBtn.disabled = n === 0;
}

function renderAll() {
  renderCount();
  renderShapes();
  renderMods();
  renderBands();
  renderSupply();
}

function renderResume() {
  const el = $('#match-resume');
  if (!el) return;
  const saved = loadGameState('match');
  const resumable = !!(saved && saved.match) && canResumeMode('match');
  if (!resumable) { el.classList.add('hidden'); return; }
  const at = (saved.match.current || 0) + 1;
  const of = saved.match.entries.length;
  el.classList.remove('hidden');
  el.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'checkpoint-resume-btn';
  btn.innerHTML = `<span class="resume-icon">${uiSpriteImgHTML('uiReplay', 'ui-icon')}</span>`
    + `<span class="resume-label">Resume run<br>`
    + `<span class="resume-level">Board ${at} of ${of}</span></span>`;
  btn.addEventListener('click', () => {
    hideModal('match-setup-modal');
    setReturnToTitle(false);
    hideTitleScreen();
    resumeMatch();
  });
  el.appendChild(btn);
}

// One delegated listener per group, bound once at import: the chip markup
// re-renders on every change, so per-button listeners would leak.
let _wired = false;
function wire() {
  if (_wired) return;
  _wired = true;

  const countEl = $('#match-count');
  if (countEl) {
    countEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.match-step-btn');
      if (!btn) return;
      const next = _rules.count + Number(btn.dataset.step);
      _rules.count = Math.min(MATCH_BOARD_MAX, Math.max(MATCH_BOARD_MIN, next));
      saveRules(_rules);
      renderCount();
      renderSupply();
    });
  }

  // Shapes and modifiers are multi-select, and a shape group may never
  // empty (a match must have at least one shape to draw from); an empty
  // MODIFIER set is meaningful on its own, it means plain boards.
  const shapesEl = $('#match-shapes');
  if (shapesEl) {
    shapesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.match-chip');
      if (!btn || btn.disabled) return;
      const key = btn.dataset.key;
      const on = _rules.shapes.includes(key);
      if (on && _rules.shapes.length === 1) return;
      _rules.shapes = on ? _rules.shapes.filter((s) => s !== key) : [..._rules.shapes, key];
      saveRules(_rules);
      renderShapes();
      renderSupply();
    });
  }

  const modsEl = $('#match-mods');
  if (modsEl) {
    modsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.match-chip');
      if (!btn || btn.disabled) return;
      const key = btn.dataset.key;
      const on = _rules.mods.includes(key);
      _rules.mods = on ? _rules.mods.filter((m) => m !== key) : [..._rules.mods, key];
      saveRules(_rules);
      renderMods();
      renderSupply();
    });
    // Inspecting a chip names it in the readout, so the icons stay icons.
    modsEl.addEventListener('pointerover', (e) => {
      const btn = e.target.closest('.match-chip');
      if (btn && btn.title) renderModReadout(btn.title);
    });
    modsEl.addEventListener('pointerleave', () => renderModReadout(null));
  }

  for (const [id, field] of [['#match-time', 'time'], ['#match-density', 'density'],
    ['#match-difficulty', 'difficulty']]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.match-chip');
      if (!btn || btn.disabled) return;
      _rules[field] = btn.dataset.key;
      saveRules(_rules);
      renderBands();
      renderSupply();
    });
  }

  // The scroll opt-in is a BOOLEAN on the rules, so it gets its own handler
  // rather than a row in the string-keyed loop above.
  const scrollEl = $('#match-scroll');
  if (scrollEl) {
    scrollEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.match-chip');
      if (!btn || btn.disabled) return;
      _rules.scroll = btn.dataset.key === 'on';
      saveRules(_rules);
      renderBands();
      renderSupply();
    });
  }

  const startBtn = $('#match-start');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      hideModal('match-setup-modal');
      setReturnToTitle(false);
      hideTitleScreen();
      launchMatch(_rules);
    });
  }

  // The two shared routes. Both leave the sheet's rules exactly as they are:
  // the invite DEALS under them (the boards are frozen before anyone can
  // join), while joining reads nothing from the sheet at all, since a joined
  // match plays the host's rules.
  const inviteBtn = $('#match-invite-btn');
  if (inviteBtn) {
    inviteBtn.addEventListener('click', async () => {
      hideModal('match-setup-modal');
      const m = await import('./matchLobby.js');
      m.createSharedMatch(_rules);
    });
  }
  const joinBtn = $('#match-join-btn');
  if (joinBtn) {
    joinBtn.addEventListener('click', async () => {
      hideModal('match-setup-modal');
      const m = await import('./matchLobby.js');
      m.openMatchJoin('');
    });
  }

  const modal = $('#match-setup-modal');
  if (modal) {
    modal.querySelector('.modal-close')?.addEventListener('click',
      () => closeModalAndReturn('match-setup-modal'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModalAndReturn('match-setup-modal');
    });
  }
}

/**
 * Open the sheet from the title screen's Challenge card, or from a
 * leaderboard Challenge button, which passes the friend to invite once a
 * match is created plus the tab to land on. The friend is re-set or cleared
 * on EVERY open, so a sheet visit that never creates a match cannot leave a
 * name behind for an unrelated later one.
 */
export function openMatchSetup({ challengeFriend = null, tab = null } = {}) {
  wire();
  const unlocks = currentUnlocks();
  // Re-sanitized against the CURRENT unlocks every open, so a saved rule
  // set from before a Climb unlock (or after a progression reset) can
  // never offer something the player has not met.
  _rules = sanitizeMatchRules(loadSavedRules() || defaultMatchRules(unlocks), unlocks);
  renderResume();
  renderAll();
  showModalFromTitle('match-setup-modal');
  // Invites and matches you are already in, fetched after the sheet paints so
  // a slow network never delays the controls. Stays hidden when empty.
  import('./matchLobby.js')
    .then((m) => {
      m.setChallengeFriend(challengeFriend);
      if (tab) m.showMatchTab(tab);
      m.renderMatchReview();
    })
    .catch((err) => reportCaughtError('match-review-open', err));
  // The summary arrives after the sheet paints; the supply line says so
  // while it is in flight and never shows a zero it has not measured.
  fetchMatchCorners().then((corners) => {
    _corners = corners;
    renderSupply();
  }).catch((err) => {
    reportCaughtError('match-summary-fetch', err);
    _corners = null;
    renderSupply();
  });
  fetchClimbMatchCorners().then((corners) => {
    _climbCorners = corners;
    renderSupply();
  }).catch(() => { _climbCorners = null; });
}
