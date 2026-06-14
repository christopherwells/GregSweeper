// ── The crux teaser: yesterday's hardest step, as a share card ──
// A standalone, logged-out, zero-write view reached by ?crux=YYYY-MM-DD
// (default: yesterday ET). It shows a precomputed "find the safe square"
// mini-puzzle of a past daily's crux — the first step plain counting
// could not reach — then points the visitor at today's board.
//
// The puzzle and its sentence come from cruxes/{date}, materialized by
// the same cruxExtract the win receipt uses, so the teaser can never
// claim a square the engine could not prove. Showing it never touches
// the live board: the route refuses today and later (see main.js), and
// the date is only ever yesterday-or-earlier here.

import { loadCrux } from '../firebase/dailyBoardSync.js';
import { CRUX_VIEWED_KEY_PREFIX } from '../logic/archiveEligibility.js';
import { safeSet } from '../storage/storageAdapter.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';

// Human date label ("Sat, Jun 13") from a YYYY-MM-DD string, anchored at
// local noon so it never slips a day across a timezone boundary.
function _label(date) {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function _ctaHref() {
  // Drop ?crux= and push to the daily; a brand-new visitor onboards first.
  return `${location.pathname}?mode=daily`;
}

/**
 * Fetch the date's crux and render the teaser. Safe to call logged-out;
 * a missing crux renders the graceful fallback.
 */
export async function showCruxTeaser(date) {
  let payload = null;
  try {
    payload = await loadCrux(date);
  } catch (err) {
    reportCaughtError('crux-teaser-load', err);
  }
  renderCruxTeaser(date, payload);
}

/**
 * Render the teaser for `date` from an already-fetched payload (or null
 * for the fallback). Split out from showCruxTeaser so it can be driven
 * with a fixture in tests without a Firebase round-trip.
 */
export function renderCruxTeaser(date, payload) {
  // Viewing a date's crux marks it: a later archive replay of THIS date
  // is dropped from the par fit (a previewed answer changes the time).
  try { safeSet(CRUX_VIEWED_KEY_PREFIX + date, '1'); } catch { /* storage off — fine */ }

  const titleScreen = document.getElementById('title-screen');
  const app = document.getElementById('app');
  if (titleScreen) titleScreen.classList.add('hidden');
  if (app) app.classList.add('hidden');

  const root = document.getElementById('crux-teaser');
  if (!root) return;
  root.classList.remove('hidden');

  if (!payload || !Array.isArray(payload.cells) || !payload.answer) {
    root.innerHTML = `
      <div class="crux-teaser-card">
        <div class="crux-teaser-brand">
          <img class="crux-greg" src="assets/sprites/idle.png" alt="Greg" draggable="false" onerror="this.remove()">
          <div>
            <div class="crux-teaser-logo">GregSweeper</div>
            <div class="crux-teaser-tagline">No guesses. Ever.</div>
          </div>
        </div>
        <p class="crux-teaser-prompt">No teaser for ${_label(date)}, but every board is proven solvable before you play it.</p>
        <div class="crux-teaser-actions"><a class="action-btn primary" href="${_ctaHref()}">Play today's board</a></div>
      </div>`;
    return;
  }

  const promptText = 'One of these squares is provably safe. Tap the one you can prove.';
  root.innerHTML = `
    <div class="crux-teaser-card">
      <div class="crux-teaser-brand">
        <img class="crux-greg" src="assets/sprites/idle.png" alt="Greg" draggable="false" onerror="this.remove()">
        <div>
          <div class="crux-teaser-logo">GregSweeper</div>
          <div class="crux-teaser-tagline">No guesses. Ever.</div>
        </div>
      </div>
      <p class="crux-teaser-date">${_label(date)} · the board's hardest step</p>
      <p class="crux-teaser-prompt" id="crux-teaser-prompt">${promptText}</p>
      <div class="crux-board" id="crux-board" role="group" aria-label="Find the safe square"></div>
      <p class="crux-coach" id="crux-coach" aria-live="polite"></p>
      <div class="crux-teaser-actions">
        <a class="action-btn primary crux-cta hidden" id="crux-play-cta" href="${_ctaHref()}">Play today's board</a>
      </div>
    </div>`;

  const boardEl = document.getElementById('crux-board');
  const coachEl = document.getElementById('crux-coach');
  const promptEl = document.getElementById('crux-teaser-prompt');
  const ctaEl = document.getElementById('crux-play-cta');

  const key = (r, c) => `${r},${c}`;
  const revealed = new Map();
  for (const cell of payload.cells) revealed.set(key(cell.r, cell.c), cell.n);
  const srcCells = [];

  boardEl.style.gridTemplateColumns = `repeat(${payload.cols}, 1fr)`;
  const srcSet = new Set((payload.sources || []).map(s => key(s.r, s.c)));

  for (let r = 0; r < payload.rows; r++) {
    for (let c = 0; c < payload.cols; c++) {
      const div = document.createElement('div');
      div.className = 'crux-cell';
      const k = key(r, c);
      if (revealed.has(k)) {
        const n = revealed.get(k);
        div.classList.add('revealed');
        if (n > 0) { div.textContent = String(n); div.dataset.num = String(n); }
      } else {
        // 'crux-fog', not 'hidden' — the global .hidden is display:none.
        div.classList.add('crux-fog');
        div.setAttribute('role', 'button');
        div.tabIndex = 0;
        div.dataset.r = String(r);
        div.dataset.c = String(c);
      }
      if (srcSet.has(k)) srcCells.push(div);
      boardEl.appendChild(div);
    }
  }

  const pulseSources = () => {
    for (const el of srcCells) {
      el.classList.remove('crux-pulse');
      // reflow so the animation can re-trigger on repeated misses
      void el.offsetWidth;
      el.classList.add('crux-pulse');
    }
  };

  let solved = false;
  let misses = 0;
  const onTap = (r, c, div) => {
    if (solved) return;
    if (r === payload.answer.r && c === payload.answer.c) {
      solved = true;
      div.classList.remove('crux-fog');
      div.classList.add('revealed', 'crux-found');
      div.removeAttribute('role');
      div.tabIndex = -1;
      div.textContent = '✓';
      if (promptEl) promptEl.textContent = 'Proven safe. No guess needed.';
      if (coachEl) coachEl.textContent = payload.sentence || 'The clues around it settle this square.';
      pulseSources();
      if (ctaEl) ctaEl.classList.remove('hidden');
    } else {
      misses++;
      div.classList.add('crux-bounce');
      setTimeout(() => div.classList.remove('crux-bounce'), 320);
      pulseSources();
      if (coachEl) {
        coachEl.textContent = misses === 1 && payload.sentenceSocratic
          ? payload.sentenceSocratic
          : 'Not that one. The glowing clues point to the square you can prove.';
      }
    }
  };

  boardEl.addEventListener('click', (e) => {
    const div = e.target.closest('.crux-cell.crux-fog');
    if (!div) return;
    onTap(Number(div.dataset.r), Number(div.dataset.c), div);
  });
  boardEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const div = e.target.closest('.crux-cell.crux-fog');
    if (!div) return;
    e.preventDefault();
    onTap(Number(div.dataset.r), Number(div.dataset.c), div);
  });
}
