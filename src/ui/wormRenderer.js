// ── Worm Tiles overlay renderer ─────────────────────────
// Draws the live worms (state.worms) as a board-anchored sibling overlay,
// the renderWallOverlays pattern: a `.worm-overlay-container` appended to
// #board's parent, absolutely positioned from live cell rects, so it
// survives updateCell's wholesale content rebuilds and rides board
// scroll/zoom. z-index 4 puts segments above revealed cell faces (fx-on
// z-2) and walls (z-3) but far below labels (z-900) and modals.
//
// Segment elements are REUSED across ticks (keyed by worm object identity)
// so the CSS left/top transition tweens the crawl; a rebuild-per-tick would
// teleport. pointer-events stays none — a covered cell is fully clickable
// and chordable, the worm only delays what you can read.
//
// One canonical worm design for every theme (theme variants are a later
// pass); colors ride the --worm-* tokens in global.css.

import { state } from '../state/gameState.js';
import { boardEl } from './domHelpers.js';
import { wormOverlayLayout } from '../logic/worms.js';

const BURROW_ANIM_MS = 400;
const HATCH_ANIM_MS = 500;

// worm object -> its segment divs, in segment order. Worm objects are
// stable identities across ticks (mutated in place), so the map holds
// until a worm burrows (removed with a fade) or the game tears down.
const _wormEls = new Map();

export function renderWormOverlays() {
  const board = boardEl.parentElement;
  if (!board) return;
  let overlay = board.querySelector('.worm-overlay-container');
  const worms = state.worms || [];

  // Fade out elements whose worm burrowed (or was cleared). A full
  // teardown (no worms left) removes the container after the fade.
  for (const [worm, els] of _wormEls) {
    if (!worms.includes(worm)) {
      for (const el of els) {
        el.classList.add('worm-burrow');
        setTimeout(() => el.remove(), BURROW_ANIM_MS);
      }
      _wormEls.delete(worm);
    }
  }
  if (worms.length === 0) {
    if (overlay) setTimeout(() => {
      if (overlay.childElementCount === 0) overlay.remove();
    }, BURROW_ANIM_MS + 50);
    return;
  }

  if (!overlay) {
    board.style.position = 'relative';
    overlay = document.createElement('div');
    overlay.className = 'worm-overlay-container';
    board.appendChild(overlay);
  }

  // Cell rect relative to the board parent — same math as renderWallOverlays
  const boardRect = boardEl.getBoundingClientRect();
  const boardX = boardEl.offsetLeft;
  const boardY = boardEl.offsetTop;
  const cellRect = (r, c) => {
    const el = boardEl.children[r * state.cols + c];
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left - boardRect.left + boardX,
      top: rect.top - boardRect.top + boardY,
      width: rect.width,
      height: rect.height,
    };
  };

  // Create missing element sets (new hatches get the egg-crack pop)
  for (const worm of worms) {
    if (_wormEls.has(worm)) continue;
    const els = worm.segments.map((seg, i) => {
      const el = document.createElement('div');
      el.className = i === 0 ? 'worm-segment worm-head worm-hatch' : 'worm-segment worm-hatch';
      overlay.appendChild(el);
      setTimeout(() => el.classList.remove('worm-hatch'), HATCH_ANIM_MS);
      return el;
    });
    _wormEls.set(worm, els);
  }

  // Position every segment from the pure layout
  for (const item of wormOverlayLayout(worms, cellRect)) {
    const els = _wormEls.get(worms[item.wormIndex]);
    const el = els && els[item.segIndex];
    if (!el) continue;
    el.style.left = item.left + 'px';
    el.style.top = item.top + 'px';
    el.style.width = item.width + 'px';
    el.style.height = item.height + 'px';
  }
}
