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

import { loadCrux, loadDailyBoard, deserializeBoard } from '../firebase/dailyBoardSync.js';
import { extractCrux } from '../logic/cruxExtract.js';
import { findDeducibleFrontier } from '../logic/boardSolver.js';
import { CRUX_VIEWED_KEY_PREFIX } from '../logic/archiveEligibility.js';
import { safeSet } from '../storage/storageAdapter.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import { spriteImgHTML } from './spriteLoader.js';

// Rebuild a plain board (numbers + walls, no mine layout) from a crux
// payload, so findDeducibleFrontier can recompute EVERYTHING the shown
// clues force — every safe square and every mine. The teaser shows the
// player the full reach of the proof, not a single answer.
function _boardFromPayload(payload) {
  const board = [];
  for (let r = 0; r < payload.rows; r++) {
    const row = [];
    for (let c = 0; c < payload.cols; c++) {
      row.push({
        row: r, col: c, isMine: false, isRevealed: false, isFlagged: false,
        adjacentMines: 0, displayedMines: 0,
        isMystery: false, isLiar: false, isLocked: false,
        isWormhole: false, isSonar: false, isCompass: false,
      });
    }
    board.push(row);
  }
  for (const cell of payload.cells) {
    const b = board[cell.r] && board[cell.r][cell.c];
    if (b) { b.isRevealed = true; b.adjacentMines = cell.n; b.displayedMines = cell.n; }
  }
  if (Array.isArray(payload.walls) && payload.walls.length) {
    board._wallEdges = new Set(payload.walls);
  }
  return board;
}

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

// Draw the board's walls over the mini grid: a bar in the gap of each
// walled edge, midway between the two cells (the same idea as the game's
// renderWallOverlays, adapted to the teaser's own grid). Without this the
// numbers — which are computed wall-aware — wouldn't reconcile with what
// the player can count. Cells must already be laid out: reading
// offsetWidth forces the layout this needs.
function _renderMiniWalls(boardEl, walls, cols) {
  if (!Array.isArray(walls) || walls.length === 0) return;
  boardEl.style.position = 'relative';
  const at = (r, c) => boardEl.children[r * cols + c];
  for (const key of walls) {
    const m = /^(\d+),(\d+)-(\d+),(\d+)$/.exec(key);
    if (!m) continue;
    const r1 = +m[1], c1 = +m[2], r2 = +m[3], c2 = +m[4];
    const e1 = at(r1, c1), e2 = at(r2, c2);
    if (!e1 || !e2) continue;
    const line = document.createElement('div');
    line.className = 'crux-wall';
    if (r1 === r2) {
      // Vertical wall between two columns: a bar in the gap, full cell height.
      const left = c1 < c2 ? e1 : e2;
      const right = c1 < c2 ? e2 : e1;
      const x = (left.offsetLeft + left.offsetWidth + right.offsetLeft) / 2;
      line.style.left = (x - 1.5) + 'px';
      line.style.top = e1.offsetTop + 'px';
      line.style.width = '3px';
      line.style.height = e1.offsetHeight + 'px';
    } else {
      // Horizontal wall between two rows: a bar in the gap, full cell width.
      const top = r1 < r2 ? e1 : e2;
      const bot = r1 < r2 ? e2 : e1;
      const y = (top.offsetTop + top.offsetHeight + bot.offsetTop) / 2;
      line.style.left = e1.offsetLeft + 'px';
      line.style.top = (y - 1.5) + 'px';
      line.style.width = e1.offsetWidth + 'px';
      line.style.height = '3px';
    }
    boardEl.appendChild(line);
  }
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
  // No crux node has two honest causes: the board was a BREATHER (every
  // square fell to plain counting, so there's no harder step to show), or
  // its crux just couldn't be cropped to a mini (the rare liar case). Tell
  // them apart by solving the canonical here — extractCrux === null means
  // breather — so a breather day reads as intentional, not broken. (A
  // crux that exists but didn't crop keeps the plain fallback; we never
  // call such a board a breather.)
  let breather = false;
  if (!payload) {
    try {
      const raw = await loadDailyBoard(date);
      if (raw) {
        const { board, rows, cols } = deserializeBoard(raw);
        breather = extractCrux(board, rows, cols) === null;
      }
    } catch { /* leave breather false — the generic fallback still fits */ }
  }
  renderCruxTeaser(date, payload, breather);
}

// Plain-language name for the hardest deduction tier on the board (matches
// the win receipt's vocabulary). Board-level, never about one square.
const TIER_PHRASE = {
  1: 'comparing two clues',
  2: 'weighing a whole region at once',
  3: 'seeing through a liar',
};

/**
 * Render the teaser for `date` from an already-fetched payload (or null
 * for the fallback). Split out from showCruxTeaser so it can be driven
 * with a fixture in tests without a Firebase round-trip.
 */
export function renderCruxTeaser(date, payload, breather = false) {
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
          ${spriteImgHTML('smiley', 'crux-greg', 'Greg')}
          <div>
            <div class="crux-teaser-logo">GregSweeper</div>
            <div class="crux-teaser-tagline">No guesses. Ever.</div>
          </div>
        </div>
        <p class="crux-teaser-prompt">${breather
          ? `${_label(date)} was a breather: every square fell to plain counting, no harder step to show. Every board is still proven solvable before you play it.`
          : `No teaser for ${_label(date)}, but every board is proven solvable before you play it.`}</p>
        <div class="crux-teaser-actions"><a class="action-btn primary" href="${_ctaHref()}">Play today's board</a></div>
      </div>`;
    return;
  }

  // Recompute the FULL reach of the proof from the shown numbers: every
  // square the clues force safe, and every forced mine. This is the whole
  // pitch — not "find the one safe cell" (a real position has many), but
  // "look how much is provable without a single guess".
  const board = _boardFromPayload(payload);
  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const key = (r, c) => `${r},${c}`;
  const safeKeys = new Set(frontier.safe.map(s => key(s.row, s.col)));
  const mineKeys = new Set(frontier.mines.map(m => key(m.row, m.col)));
  const totalSafe = safeKeys.size;
  const totalMines = mineKeys.size;
  // The hardest single deduction the SHOWN puzzle needs (board-level, not
  // about any one square) — replaces the old per-cell "this square" line,
  // which had no referent once the teaser stopped featuring one answer.
  const tiers = [...frontier.safe, ...frontier.mines].map(x => x.tier);
  const maxTier = tiers.length ? Math.max(...tiers) : 0;

  const minesClause = totalMines > 0
    ? ` and <strong>${totalMines}</strong> ${totalMines === 1 ? 'a mine' : 'mines'}`
    : '';
  const promptText = `No guessing needed. Greg can prove <strong>${totalSafe}</strong> ${totalSafe === 1 ? 'square' : 'squares'} safe${minesClause} here. Tap the safe ones.`;

  root.innerHTML = `
    <div class="crux-teaser-card">
      <div class="crux-teaser-brand">
        ${spriteImgHTML('smiley', 'crux-greg', 'Greg')}
        <div>
          <div class="crux-teaser-logo">GregSweeper</div>
          <div class="crux-teaser-tagline">No guesses. Ever.</div>
        </div>
      </div>
      <p class="crux-teaser-date">${_label(date)} · what Greg can prove</p>
      <p class="crux-teaser-prompt" id="crux-teaser-prompt">${promptText}</p>
      <div class="crux-board" id="crux-board" role="group" aria-label="Find the provably safe squares"></div>
      <p class="crux-progress" id="crux-progress">0 / ${totalSafe} safe found</p>
      <p class="crux-coach" id="crux-coach" aria-live="polite"></p>
      <div class="crux-teaser-actions">
        <button type="button" class="crux-reveal-all" id="crux-reveal-all">Show me all of them</button>
        <a class="action-btn primary crux-cta hidden" id="crux-play-cta" href="${_ctaHref()}">Play today's board</a>
        <button type="button" class="crux-reveal-all" id="crux-copy-link">Copy challenge link</button>
      </div>
    </div>`;

  const boardEl = document.getElementById('crux-board');
  const coachEl = document.getElementById('crux-coach');
  const promptEl = document.getElementById('crux-teaser-prompt');
  const progressEl = document.getElementById('crux-progress');
  const ctaEl = document.getElementById('crux-play-cta');
  const revealAllBtn = document.getElementById('crux-reveal-all');
  const copyBtn = document.getElementById('crux-copy-link');

  // Anyone viewing a crux can re-share it — the prod link for THIS date, so
  // a link copied from /test/ still points at the public page.
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const link = `https://christopherwells.github.io/GregSweeper/?crux=${date}`;
    const flash = () => { copyBtn.textContent = 'Link copied'; setTimeout(() => { copyBtn.textContent = 'Copy challenge link'; }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(flash, flash);
    else flash();
  });

  const revealed = new Map();
  for (const cell of payload.cells) revealed.set(key(cell.r, cell.c), cell.n);
  const cellEls = new Map(); // "r,c" -> div, for the reveal-all sweep

  boardEl.style.gridTemplateColumns = `repeat(${payload.cols}, 1fr)`;
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
        cellEls.set(k, div);
      }
      boardEl.appendChild(div);
    }
  }
  // Walls (if any) ride over the laid-out grid.
  _renderMiniWalls(boardEl, payload.walls, payload.cols);

  let found = 0;
  let done = false;

  const markSafe = (div) => {
    div.classList.remove('crux-fog');
    div.classList.add('revealed', 'crux-found');
    div.textContent = '✓';
    div.removeAttribute('role');
    div.tabIndex = -1;
  };
  const markMine = (div) => {
    div.classList.remove('crux-fog');
    div.classList.add('crux-mine');
    div.innerHTML = spriteImgHTML('flag', 'crux-marker-img', 'flagged mine');
    div.removeAttribute('role');
    div.tabIndex = -1;
  };

  const finish = () => {
    if (done) return;
    done = true;
    // Light up the full proof: every remaining safe square and every mine.
    for (const [k, div] of cellEls) {
      if (div.classList.contains('crux-found') || div.classList.contains('crux-mine')) continue;
      if (safeKeys.has(k)) markSafe(div);
      else if (mineKeys.has(k)) markMine(div);
    }
    if (promptEl) {
      promptEl.textContent = totalMines > 0
        ? `Greg proved every one: ${totalSafe} safe and ${totalMines} ${totalMines === 1 ? 'mine' : 'mines'}, no guessing.`
        : `All ${totalSafe} safe ${totalSafe === 1 ? 'square' : 'squares'}, proven not guessed.`;
    }
    if (coachEl) {
      const phrase = TIER_PHRASE[maxTier];
      coachEl.textContent = phrase ? `The hardest of these needed ${phrase}.` : '';
    }
    if (progressEl) progressEl.textContent = `${totalSafe} / ${totalSafe} safe found`;
    if (revealAllBtn) revealAllBtn.classList.add('hidden');
    if (ctaEl) ctaEl.classList.remove('hidden');
  };

  const bounce = (div, msg) => {
    div.classList.add('crux-bounce');
    setTimeout(() => div.classList.remove('crux-bounce'), 320);
    if (coachEl) coachEl.textContent = msg;
  };

  // Left tap / Enter OPENS a square you can prove SAFE. Right-click or
  // long-press FLAGS a square you can prove is a MINE. Both gate on the
  // proof, like the Gym and the real game: you never open a mine or flag a
  // safe square. Completion is opening every safe square; flags are a bonus.
  const onReveal = (r, c, div) => {
    if (done) return;
    const k = key(r, c);
    if (safeKeys.has(k)) {
      markSafe(div);
      found++;
      if (progressEl) progressEl.textContent = `${found} / ${totalSafe} safe found`;
      if (coachEl) coachEl.textContent = 'Proven safe.';
      if (found >= totalSafe) finish();
    } else if (mineKeys.has(k)) {
      bounce(div, 'That one is a mine. Long-press or right-click to flag it, never open it.');
    } else {
      bounce(div, "The numbers don't force this one. Take the squares they do.");
    }
  };

  const onFlag = (r, c, div) => {
    if (done) return;
    const k = key(r, c);
    if (mineKeys.has(k)) {
      markMine(div);
      if (coachEl) coachEl.textContent = 'A forced mine. Flagged, never guessed.';
    } else if (safeKeys.has(k)) {
      bounce(div, 'That one is provably safe. Open it instead.');
    } else {
      bounce(div, 'Nothing here forces a mine. Flag only what the numbers pin down.');
    }
  };

  // Long-press (touch) is the flag gesture; lpFired swallows the synthetic
  // click that follows so it does not also try to open the square.
  let lpTimer = null;
  let lpFired = false;

  boardEl.addEventListener('click', (e) => {
    if (lpFired) { lpFired = false; return; }
    const div = e.target.closest('.crux-cell.crux-fog');
    if (!div) return;
    onReveal(Number(div.dataset.r), Number(div.dataset.c), div);
  });
  boardEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const div = e.target.closest('.crux-cell.crux-fog');
    if (!div) return;
    e.preventDefault();
    onReveal(Number(div.dataset.r), Number(div.dataset.c), div);
  });
  boardEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const div = e.target.closest('.crux-cell.crux-fog');
    if (!div) return;
    onFlag(Number(div.dataset.r), Number(div.dataset.c), div);
  });
  boardEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // mouse flags via right-click
    const div = e.target.closest('.crux-cell.crux-fog');
    if (!div) return;
    lpTimer = setTimeout(() => {
      lpFired = true;
      onFlag(Number(div.dataset.r), Number(div.dataset.c), div);
    }, 450);
  });
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  boardEl.addEventListener('pointerup', cancelLp);
  boardEl.addEventListener('pointerleave', cancelLp);
  boardEl.addEventListener('pointercancel', cancelLp);
  if (revealAllBtn) revealAllBtn.addEventListener('click', finish);
}
