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
// teleport. pointer-events stays none, a covered cell is fully clickable
// and chordable, the worm only delays what you can read.
//
// One canonical worm design for every theme (theme variants are a later
// pass); colors ride the --worm-* tokens in global.css.

import { state } from '../state/gameState.js';
import { boardEl } from './domHelpers.js';
import { wormOverlayLayout, mixHex, wormSegmentSize, wormCellCenterUnitOffsets } from '../logic/worms.js';

const BURROW_ANIM_MS = 400;
const HATCH_ANIM_MS = 500;

// Per-worm coloring: each worm's tone (0..1, seeded per egg) interpolates
// between the theme's two endpoint tokens, brown to cream on the base
// design. A theme recolors its whole brood by overriding just the
// endpoints (--worm-tone-dark / --worm-tone-light); shading derives from
// the mixed base, so every tone self-shades consistently. Mixed in JS
// (not CSS color-mix): a var-dependent color-mix that an older engine
// rejects computes to NO background at all, an invisible worm, while
// this degrades to the stylesheet's static fallback gradient.
const TONE_DARK_FALLBACK = '#8f5b38';
const TONE_LIGHT_FALLBACK = '#eedcbc';
const SHADE_ANCHOR = '#4a2c18'; // deep soil brown, shading stays warm

function _toneEndpoints() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name, fallback) => {
    const v = (cs.getPropertyValue(name) || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  };
  return {
    dark: read('--worm-tone-dark', TONE_DARK_FALLBACK),
    light: read('--worm-tone-light', TONE_LIGHT_FALLBACK),
  };
}

function _paintWorm(els, tone, endpoints) {
  const base = mixHex(endpoints.dark, endpoints.light, tone);
  const shade = mixHex(base, SHADE_ANCHOR, 0.32);
  const headBase = mixHex(base, SHADE_ANCHOR, 0.14);
  for (let i = 0; i < els.length; i++) {
    const from = i === 0 ? headBase : base;
    els[i].style.background = `radial-gradient(circle at 35% 30%, ${from}, ${shade})`;
  }
}

// worm object -> its segment divs, in segment order. Worm objects are
// stable identities across ticks (mutated in place), so an entry stays
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

  // Cell rect relative to the board parent, same math as renderWallOverlays
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

  // Paint every worm its own tone. Re-derived on every render (a handful
  // of elements) so a mid-game theme switch recolors the brood from the
  // new theme's endpoints in the same refit that repositions them.
  const endpoints = _toneEndpoints();
  for (const worm of worms) {
    const els = _wormEls.get(worm);
    if (els) _paintWorm(els, typeof worm.tone === 'number' ? worm.tone : 0.5, endpoints);
  }

  // Position every segment from the pure layout. The segment DIAMETER is a
  // tested decision in worms.js (wormSegmentSize), its governing property is
  // that consecutive segments nearly touch, so the worm reads as a body rather
  // than a row of beads sliding.
  let uniformSize = null;
  let centerOffsetPx = null;
  if (state.board && state.board._cellPos) {
    const P = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 40;
    uniformSize = wormSegmentSize(P, state.board._tiling?.type || null);
    // Asymmetric cells (floret pentagons, deltoidal kites) draw their number
    // at the incircle center, not the box center, segments follow the same
    // point so the worm sits ON the number, not beside it.
    const offs = wormCellCenterUnitOffsets(state.board);
    if (offs) {
      centerOffsetPx = (r, c) => {
        const o = offs[r * state.cols + c];
        return o ? { dx: o.dx * P, dy: o.dy * P } : null;
      };
    }
  }
  for (const item of wormOverlayLayout(worms, cellRect, uniformSize, centerOffsetPx)) {
    const els = _wormEls.get(worms[item.wormIndex]);
    const el = els && els[item.segIndex];
    if (!el) continue;
    el.style.left = item.left + 'px';
    el.style.top = item.top + 'px';
    el.style.width = item.width + 'px';
    el.style.height = item.height + 'px';
  }
}
