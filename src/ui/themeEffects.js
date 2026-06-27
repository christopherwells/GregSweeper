/**
 * Theme Effects Engine — spawns dynamic DOM particles and ambient visuals per theme.
 * Called by themeManager when theme changes. Each theme registers an effect function
 * that creates/manages its own visual elements inside the board container.
 */

import { isSoftwareRendering, forceEffectsEnabled } from '../logic/deviceCapability.js';

let activeCleanup = null;
let effectContainer = null;
let titleSceneCleanup = null;
let titleSceneContainer = null;

// Themes whose ambient effect also plays behind the title-screen content (the
// sky worlds — currently nest). Most themes are board-only.
const TITLE_SCENE_THEMES = new Set(['nest', 'editorial']);

// The shared suppression gate: never run per-frame particles under reduced-
// motion or software compositing (cheap on a GPU, stutters on the CPU). `?fx=1`
// overrides the software gate for review; reduced-motion is never overridden.
function effectsSuppressed() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  if (isSoftwareRendering() && !forceEffectsEnabled()) return true;
  return false;
}

/** Remove all active effects and their DOM elements */
export function clearThemeEffects() {
  // Drop the occlusion-system flag (see global.css `#board.fx-on …`) so the
  // gap-seal + revealed/flag z-index lifts switch off when no effect is active.
  document.getElementById('board')?.classList.remove('fx-on');
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  if (effectContainer) {
    effectContainer.remove();
    effectContainer = null;
  }
}

/** Apply effects for the given theme name */
export function applyThemeEffects(themeName) {
  clearThemeEffects();

  if (effectsSuppressed()) return;

  const effectFn = THEME_EFFECTS[themeName];
  if (!effectFn) return;

  // Create overlay container inside #board
  const board = document.getElementById('board');
  if (!board) return;

  effectContainer = document.createElement('div');
  effectContainer.className = 'theme-fx';
  effectContainer.setAttribute('aria-hidden', 'true');
  board.appendChild(effectContainer);
  // Engage the occlusion system (gap-seal + z-index lifts) only now that a real
  // effect layer exists for this theme. Effect-less themes never get the class,
  // so their revealed cells render exactly as before.
  board.classList.add('fx-on');

  activeCleanup = effectFn(effectContainer, board);
}

/** Play the ambient effect behind the title-screen content, for themes that opt
 *  into TITLE_SCENE_THEMES (the sky worlds). Mounts ONLY while the title screen
 *  is actually on screen, and is torn down by clearTitleSceneEffects when the
 *  player leaves it — so particles never accumulate in a hidden host. Called
 *  from showTitleScreen + the theme-apply path in main.js. */
export function applyTitleSceneEffects(themeName) {
  clearTitleSceneEffects();
  if (!TITLE_SCENE_THEMES.has(themeName)) return;
  const host = document.getElementById('title-screen');
  if (!host || host.classList.contains('hidden')) return;
  // Solid cards + content lift apply whenever a theme dresses its title screen,
  // INCLUDING a static CSS backdrop (e.g. editorial's newspaper columns). So
  // this class is NOT gated by the particle gate below — otherwise a static
  // background would bleed through translucent cards on a software-compositing
  // browser (where the per-frame particles are off).
  host.classList.add('has-title-sky');
  if (effectsSuppressed()) return; // the per-frame PARTICLES are gated; the class above is not
  const effectFn = THEME_EFFECTS[themeName];
  if (!effectFn) return;
  titleSceneContainer = document.createElement('div');
  titleSceneContainer.className = 'theme-fx theme-fx-titlescene';
  titleSceneContainer.setAttribute('aria-hidden', 'true');
  host.appendChild(titleSceneContainer);
  titleSceneCleanup = effectFn(titleSceneContainer, host);
}

export function clearTitleSceneEffects() {
  if (titleSceneCleanup) { titleSceneCleanup(); titleSceneCleanup = null; }
  if (titleSceneContainer) { titleSceneContainer.remove(); titleSceneContainer = null; }
  document.getElementById('title-screen')?.classList.remove('has-title-sky');
}

// Utility helpers

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function spawn(container, opts = {}) {
  const el = document.createElement('div');
  el.className = 'fx-particle';
  const baseStyle = {
    position: 'absolute',
    pointerEvents: 'none',
    willChange: 'transform, opacity',
  };
  const merged = { ...baseStyle, ...opts.style };
  // Object.assign doesn't work for CSS custom properties (--fx-*)
  // Separate them and use setProperty instead
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith('--')) {
      el.style.setProperty(key, value);
    } else {
      el.style[key] = value;
    }
  }
  if (opts.text) el.textContent = opts.text;
  if (opts.html) el.innerHTML = opts.html;
  container.appendChild(el);
  return el;
}

function particleLoop(container, spawnFn, intervalMs) {
  const particles = new Set();
  let timer = null;
  let running = true;

  function tick() {
    if (!running) return;
    const p = spawnFn(container, particles);
    if (p) {
      particles.add(p);
      p.addEventListener('animationend', () => {
        p.remove();
        particles.delete(p);
      });
    }
    timer = setTimeout(tick, typeof intervalMs === 'function' ? intervalMs() : intervalMs);
  }

  timer = setTimeout(tick, rand(100, 500));

  return () => {
    running = false;
    clearTimeout(timer);
    particles.forEach(p => p.remove());
    particles.clear();
  };
}

function ambientGlow(container, opts) {
  const glow = document.createElement('div');
  glow.className = 'fx-ambient';
  Object.assign(glow.style, {
    position: 'absolute',
    inset: '-20%',
    pointerEvents: 'none',
    zIndex: '0',
    filter: `blur(${opts.blur || 20}px)`,
    ...opts.style,
  });
  container.appendChild(glow);
  return glow;
}

// Keyframe injection (once)

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const css = `
    /* Effects sit BETWEEN unrevealed cells (z-index 0) and revealed cells
       (z-index 2): they play over the unrevealed board + background gaps, but
       revealed cells render on top so their numbers/markers stay clean. */
    .theme-fx {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      overflow: hidden;
    }
    .fx-particle { z-index: 2; }
    .fx-ambient { z-index: 0; }
    /* On the title screen the sky sits BEHIND the cards (lifted to z-index 1 in
       the theme CSS), not between board cells. */
    .theme-fx-titlescene { z-index: 0; }

    @keyframes fxFall {
      0% { transform: translate(var(--fx-x0, 0px), var(--fx-y0, -20px)) rotate(var(--fx-r0, 0deg)) scale(var(--fx-s, 1)); opacity: 0; }
      5% { opacity: var(--fx-opacity, 0.6); }
      70% { transform: translate(var(--fx-x1, 20px), var(--fx-y1, 50%)) rotate(var(--fx-r1, 180deg)) scale(var(--fx-s, 1)); opacity: var(--fx-opacity, 0.45); }
      92% { opacity: var(--fx-opacity-end, 0.2); }
      100% { transform: translate(var(--fx-x2, 40px), var(--fx-y2, 110%)) rotate(var(--fx-r2, 360deg)) scale(var(--fx-s, 1)); opacity: 0; }
    }

    @keyframes fxRise {
      0% { transform: translate(var(--fx-x0, 0px), var(--fx-y0, 0px)) scale(var(--fx-s, 1)); opacity: 0; }
      8% { opacity: var(--fx-opacity, 0.7); }
      65% { transform: translate(var(--fx-x1, 5px), var(--fx-y1, -40%)) scale(var(--fx-s, 1)); opacity: var(--fx-opacity, 0.5); }
      92% { opacity: var(--fx-opacity-end, 0.15); }
      100% { transform: translate(var(--fx-x2, -5px), var(--fx-y2, -90%)) scale(var(--fx-s-end, 0.5)); opacity: 0; }
    }

    @keyframes fxTwinkle {
      0%, 100% { opacity: 0; transform: scale(0.5); }
      50% { opacity: var(--fx-opacity, 0.8); transform: scale(1); }
    }

    @keyframes fxDrift {
      0% { transform: translateX(var(--fx-x0, -30%)); opacity: var(--fx-opacity, 0.4); }
      50% { opacity: var(--fx-opacity, 0.7); }
      100% { transform: translateX(var(--fx-x2, 30%)); opacity: var(--fx-opacity, 0.4); }
    }

    @keyframes fxSweep {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(200%); }
    }

    @keyframes fxFloat {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(var(--fx-float-y, -8px)); }
    }

    /* Caustic light-net: the layer drifts diagonally while its cell
       pattern breathes — two of these at different scales/directions
       interfere into the wiggly light-on-sand look. */
    @keyframes fxCaustic {
      0%   { background-position: 0px 0px; transform: rotate(var(--fx-rot, 0deg)) scale(1); }
      50%  { transform: rotate(var(--fx-rot, 0deg)) scale(1.045); }
      100% { background-position: 160px 118px; transform: rotate(var(--fx-rot, 0deg)) scale(1); }
    }

    /* Split-flap module flutter: the top half flips down three times
       (cycling characters) then settles, while the module fades. */
    @keyframes fxFlapTop {
      0%, 28%, 56% { transform: rotateX(0deg); }
      14%, 42%, 70% { transform: rotateX(-72deg); }
      84%, 100% { transform: rotateX(0deg); }
    }
    @keyframes fxFlapFade {
      0% { opacity: 0; }
      12% { opacity: 0.9; }
      80% { opacity: 0.9; }
      100% { opacity: 0; }
    }

    /* Slow god-ray rotation for light-through-glass themes. */
    @keyframes fxBeams {
      0%   { transform: rotate(-4deg); opacity: 0.75; }
      50%  { transform: rotate(4deg); opacity: 1; }
      100% { transform: rotate(-4deg); opacity: 0.75; }
    }

    @keyframes fxScanDown {
      0% { transform: translateY(-100%); opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { transform: translateY(100%); opacity: 0; }
    }

    @keyframes fxGlitch {
      0%, 100% { transform: translate(0, 0); opacity: 0.6; }
      20% { transform: translate(-2px, 1px); opacity: 0.3; }
      40% { transform: translate(2px, -1px); opacity: 0.8; }
      60% { transform: translate(-1px, -2px); opacity: 0.4; }
      80% { transform: translate(1px, 2px); opacity: 0.7; }
    }

    /* Shooting star: a rotated streak that travels a long distance ALONG its
       own axis, so the bright leading head points the way it flies (no longer
       backwards) and it crosses far more of the board. --fx-ang/--fx-dist are
       set per-particle. */
    @keyframes fxShoot {
      0%   { transform: rotate(var(--fx-ang, 30deg)) translateX(0); opacity: 0; }
      12%  { opacity: 1; }
      82%  { opacity: 1; }
      100% { transform: rotate(var(--fx-ang, 30deg)) translateX(var(--fx-dist, 320px)); opacity: 0; }
    }

    /* A bird gliding across the board: horizontal travel with a gentle mid-flight
       bob. --fx-x0/x1/x2 give the path, --fx-dir flips the silhouette to face
       its heading. */
    @keyframes fxGlide {
      0%   { transform: translate(var(--fx-x0, 0px), 0) scaleX(var(--fx-dir, 1)); opacity: 0; }
      12%  { opacity: var(--fx-opacity, 0.75); }
      50%  { transform: translate(var(--fx-x1, 200px), var(--fx-bob, -10px)) scaleX(var(--fx-dir, 1)); }
      88%  { opacity: var(--fx-opacity, 0.75); }
      100% { transform: translate(var(--fx-x2, 400px), 0) scaleX(var(--fx-dir, 1)); opacity: 0; }
    }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

// Helper: falling particle factory

function fallingParticle(container, opts) {
  const boardH = container.parentElement?.clientHeight || 500;
  const size = rand(opts.sizeMin || 12, opts.sizeMax || 18);
  const startX = rand(5, 85);
  const swayX1 = rand(-30, 30);
  const swayX2 = rand(-50, 50);
  const duration = rand(opts.durationMin || 6, opts.durationMax || 10);

  // linear, not ease-in-out: easing applies per keyframe segment, so
  // ease-in-out parked every faller at the 70% (mid-board) keyframe.
  const el = spawn(container, {
    text: pick(opts.chars),
    style: {
      left: startX + '%',
      top: '0px',
      fontSize: size + 'px',
      lineHeight: '1',
      animation: `fxFall ${duration}s linear forwards`,
      '--fx-x0': '0px',
      '--fx-y0': '-20px',
      '--fx-x1': swayX1 + 'px',
      '--fx-y1': (boardH * 0.5) + 'px',
      '--fx-x2': swayX2 + 'px',
      '--fx-y2': (boardH + 30) + 'px',
      '--fx-r0': rand(0, 60) + 'deg',
      '--fx-r1': rand(100, 200) + 'deg',
      '--fx-r2': rand(300, 400) + 'deg',
      '--fx-opacity': String(opts.opacity || 0.5),
      '--fx-opacity-end': String(opts.opacityEnd || 0.25),
      '--fx-s': String(rand(opts.scaleMin || 0.8, opts.scaleMax || 1.2)),
    },
  });
  return el;
}

function risingParticle(container, opts) {
  const boardH = container.parentElement?.clientHeight || 500;
  const startX = rand(10, 90);
  const size = rand(opts.sizeMin || 3, opts.sizeMax || 6);
  const duration = rand(opts.durationMin || 4, opts.durationMax || 8);

  const el = spawn(container, {
    style: {
      left: startX + '%',
      bottom: '5%',
      width: size + 'px',
      height: size + 'px',
      borderRadius: '50%',
      background: opts.color || 'rgba(255,255,255,0.5)',
      boxShadow: opts.glow || 'none',
      animation: `fxRise ${duration}s ease-out forwards`,
      '--fx-x0': '0px',
      '--fx-y0': '0px',
      '--fx-x1': rand(-15, 15) + 'px',
      '--fx-y1': -(boardH * 0.4) + 'px',
      '--fx-x2': rand(-20, 20) + 'px',
      '--fx-y2': -(boardH * 0.9) + 'px',
      '--fx-opacity': String(opts.opacity || 0.6),
      '--fx-opacity-end': String(opts.opacityEnd || 0.2),
      '--fx-s': '1',
      '--fx-s-end': String(opts.scaleEnd || 0.3),
    },
  });
  return el;
}


// THEME EFFECT DEFINITIONS

const THEME_EFFECTS = {

  // Ocean: water caustics — two cellular light-nets drifting over each
  // other at different speeds, the wiggly pattern sunlight makes on sand
  // under moving waves — plus proper bubbles rising the full board with
  // a glassy highlight ring.
  ocean: (container) => {
    injectStyles();
    const net = (sizePx, alpha, dur, reverse, rot) => {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute', inset: '-25%', pointerEvents: 'none', zIndex: '0',
        // Thin bright ring with soft shoulders: closer to the sharp
        // filaments real caustics make than a wide glow band. Near-white
        // (desaturated) - sun through water is white light.
        backgroundImage:
          `radial-gradient(ellipse ${sizePx}px ${sizePx * 0.58}px at 50% 50%, transparent 60%, rgba(225,243,252,${alpha * 0.55}) 69%, rgba(232,246,253,${alpha}) 73%, rgba(225,243,252,${alpha * 0.45}) 77%, transparent 84%)`,
        backgroundSize: `${sizePx * 1.6}px ${sizePx * 1.18}px`,
        animation: `fxCaustic ${dur}s linear infinite${reverse ? ' reverse' : ''}`,
        mixBlendMode: 'screen',
      });
      el.style.setProperty('--fx-rot', rot + 'deg');
      container.appendChild(el);
      return el;
    };
    // Three scales, two directions, three grid angles: the moving
    // interference between offset nets is what reads as the wiggle.
    const a = net(38, 0.10, 13, false, 0);
    const b = net(60, 0.085, 21, true, 16);
    const c2 = net(92, 0.06, 31, false, -11);
    const bubbleCleanup = particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const s = rand(4, 10);
      return spawn(c, { style: {
        left: rand(5, 93) + '%', bottom: '-12px',
        width: s + 'px', height: s + 'px', borderRadius: '50%',
        background: 'radial-gradient(circle at 32% 30%, rgba(220,245,255,0.85) 0 18%, rgba(170,225,255,0.18) 45%, rgba(150,215,255,0.05) 70%)',
        border: '1px solid rgba(190,235,255,0.5)',
        animation: `fxRise ${rand(5, 10)}s ease-in forwards`,
        '--fx-x1': rand(-22, 22) + 'px', '--fx-y1': -(boardH * 0.55) + 'px',
        '--fx-x2': rand(-34, 34) + 'px', '--fx-y2': -(boardH + 24) + 'px',
        '--fx-opacity': String(rand(0.5, 0.8)), '--fx-opacity-end': '0.1',
        '--fx-s-end': String(rand(1.1, 1.5)),
      }});
    }, () => rand(550, 1400));
    return () => { a.remove(); b.remove(); c2.remove(); bubbleCleanup(); };
  },

  // Forest (L9): drifting leaves (the visible headline) + glowing fireflies
  forest: (container) => {
    injectStyles();
    // falling leaves — clearly readable motion, drifting + tumbling down
    const leafCleanup = particleLoop(container, (c) => {
      // Vector leaf: a pointed-oval (two round corners) with a center
      // vein, in autumn-to-green hues. No emoji glyphs.
      const boardH = c.parentElement?.clientHeight || 500;
      const s = rand(11, 18);
      const hue = pick(['96,150,70', '124,160,66', '150,120,46', '170,104,40']);
      return spawn(c, { style: {
        left: rand(4, 92) + '%', top: '0px',
        width: s + 'px', height: (s * 0.62) + 'px',
        borderRadius: '0 85% 0 85%',
        background: `linear-gradient(135deg, rgba(${hue},0.9), rgba(${hue},0.55))`,
        boxShadow: `inset 0 0 0 0.5px rgba(60,70,40,0.4)`,
        animation: `fxFall ${rand(5, 9)}s linear forwards`,
        '--fx-x1': rand(-34, 34) + 'px', '--fx-y1': (boardH * 0.5) + 'px',
        '--fx-x2': rand(-55, 55) + 'px', '--fx-y2': (boardH + 22) + 'px',
        '--fx-r0': rand(0, 70) + 'deg', '--fx-r1': rand(110, 200) + 'deg', '--fx-r2': rand(290, 400) + 'deg',
        '--fx-opacity': '0.8', '--fx-opacity-end': '0.2', '--fx-s': '1',
      }});
    }, () => rand(520, 1250));
    // brighter, larger fireflies that pulse and drift
    const fireflyCleanup = particleLoop(container, (c) => {
      const size = rand(3, 5);
      const el = spawn(c, { style: {
        left: rand(8, 92) + '%', top: rand(15, 85) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(216, 255, 130, 0.88)',
        boxShadow: '0 0 9px rgba(200, 255, 100, 0.75), 0 0 18px rgba(200, 255, 100, 0.35)',
        animation: `fxFloat ${rand(3, 6)}s ease-in-out forwards, fxTwinkle ${rand(2, 4)}s ease-in-out forwards`,
        '--fx-float-y': rand(-20, -42) + 'px', '--fx-opacity': String(rand(0.55, 0.9)),
      }});
      return el;
    }, () => rand(650, 1600));
    return () => { leafCleanup(); fireflyCleanup(); };
  },

  // Chalkboard: faint chalk dust drifting up off the slate.
  chalkboard: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const size = rand(1.5, 4);
      return spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(25, 95) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(240, 235, 224, 0.5)',
        boxShadow: '0 0 3px rgba(240, 235, 224, 0.3)',
        animation: `fxFloat ${rand(3, 6)}s ease-in-out forwards, fxTwinkle ${rand(2, 4)}s ease-in-out forwards`,
        '--fx-float-y': rand(-16, -36) + 'px', '--fx-opacity': String(rand(0.3, 0.6)),
      }});
    }, () => rand(420, 1100));
  },

  // Noir: pale dust drifting in the projector beam + a faint full-board film
  // grain flicker (the cinema look). Dust is sparse but visible; grain is subtle.
  noir: (container) => {
    injectStyles();
    // Subtle film-grain flicker over the whole board.
    const grain = document.createElement('div');
    Object.assign(grain.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '0',
      background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.018) 2px, rgba(255,255,255,0.018) 3px)',
      animation: 'fxGlitch 0.5s steps(2, end) infinite',
    });
    container.appendChild(grain);
    const dustCleanup = particleLoop(container, (c) => {
      const size = rand(2, 5);
      return spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(8, 92) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(238, 234, 222, 0.4)',
        boxShadow: '0 0 4px rgba(238, 234, 222, 0.25)',
        animation: `fxFloat ${rand(4, 8)}s ease-in-out forwards, fxTwinkle ${rand(3, 6)}s ease-in-out forwards`,
        '--fx-float-y': rand(-14, -32) + 'px', '--fx-opacity': String(rand(0.25, 0.5)),
      }});
    }, () => rand(600, 1600));
    return () => { grain.remove(); dustCleanup(); };
  },

  // Stained Glass: jewel light scattered across the panes + drifting colored
  // glow, as if the sun is moving behind the cathedral window.
  stainedglass: (container) => {
    injectStyles();
    // The sun behind the window: three soft beams raking down through
    // the panes, swaying very slowly. THE identity moment — light
    // through colored glass — visible at a glance, gentle over minutes.
    const beams = document.createElement('div');
    Object.assign(beams.style, {
      position: 'absolute', inset: '-25% -10%', pointerEvents: 'none', zIndex: '0',
      background:
        'linear-gradient(112deg, transparent 12%, rgba(255,240,200,0.10) 17%, rgba(255,240,200,0.02) 24%, transparent 28%, ' +
        'transparent 42%, rgba(200,120,255,0.09) 48%, rgba(200,120,255,0.02) 55%, transparent 59%, ' +
        'transparent 72%, rgba(255,150,150,0.08) 78%, rgba(255,150,150,0.02) 85%, transparent 89%)',
      transformOrigin: '50% -30%',
      animation: 'fxBeams 22s ease-in-out infinite',
    });
    container.appendChild(beams);
    ambientGlow(container, { blur: 30, style: {
      background: 'radial-gradient(ellipse 40% 45% at 26% 30%, rgba(120,60,200,0.12) 0%, transparent 55%), radial-gradient(ellipse 38% 40% at 74% 60%, rgba(200,50,70,0.10) 0%, transparent 55%), radial-gradient(ellipse 36% 38% at 50% 86%, rgba(60,140,200,0.10) 0%, transparent 55%)',
      animation: 'fxDrift 18s ease-in-out infinite alternate', '--fx-x0': '-5%', '--fx-x2': '5%',
    }});
    // Vector jewel glints (rotated squares with a glow), not text glyphs.
    const glintCleanup = particleLoop(container, (c) => {
      const colors = ['rgba(180,80,240,0.8)', 'rgba(240,80,110,0.8)', 'rgba(80,160,240,0.75)', 'rgba(80,200,140,0.7)', 'rgba(240,200,80,0.8)'];
      const col = pick(colors);
      const s = rand(4, 8);
      return spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        width: s + 'px', height: s + 'px',
        // Diamond via clip-path, not transform:rotate — fxTwinkle's
        // keyframes own the transform channel (scale) and would clobber
        // an inline rotation.
        clipPath: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
        background: col,
        filter: `drop-shadow(0 0 ${Math.round(s / 2) + 1}px ${col})`,
        animation: `fxTwinkle ${rand(1.6, 3.4)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.45, 0.75)),
      }});
    }, () => rand(500, 1300));
    return () => { beams.remove(); glintCleanup(); };
  },

  // Apothecary: a flickering candle glow in one corner + warm dust motes rising
  // through the candlelight.
  apothecary: (container) => {
    injectStyles();
    const glow = ambientGlow(container, { blur: 26, style: {
      inset: '-12%',
      background: 'radial-gradient(ellipse 50% 42% at 78% 20%, rgba(255,190,90,0.15) 0%, transparent 56%)',
    }});
    glow.animate(
      [{ opacity: 0.85 }, { opacity: 1 }, { opacity: 0.72 }, { opacity: 0.96 }, { opacity: 0.8 }],
      { duration: 1700, iterations: Infinity, easing: 'ease-in-out' }
    );
    // Dust hanging in the candlelight — slow lateral drift, soft and
    // round, NOT rising embers (the old fast rise read as fire flecks).
    const moteCleanup = particleLoop(container, (c) => {
      const s = rand(2.5, 5);
      return spawn(c, { style: {
        left: rand(8, 92) + '%', top: rand(10, 88) + '%',
        width: s + 'px', height: s + 'px', borderRadius: '50%',
        background: 'rgba(232,190,110,0.5)',
        boxShadow: '0 0 6px rgba(232,180,90,0.3)',
        animation: `fxFloat ${rand(6, 11)}s ease-in-out forwards, fxTwinkle ${rand(5, 9)}s ease-in-out forwards`,
        '--fx-float-y': rand(-8, -18) + 'px', '--fx-opacity': String(rand(0.3, 0.55)),
      }});
    }, () => rand(900, 2200));
    return () => { glow.remove(); moteCleanup(); };
  },

  // Split-Flap: the departures board UPDATES — every few seconds a row
  // of flap-glints ripples across the board left to right (the wave a
  // real Solari board makes when a flight changes), over the quiet
  // sparse clacks in between.
  splitflap: (container) => {
    injectStyles();
    // One Solari module: dark split housing + a top flap that cycles
    // (rotateX flutter via fxFlapTop) while the whole module fades in
    // and out. Used singly (idle clacks) and in rows (board updates).
    const moduleFlutter = (c, leftPct, topPct) => spawn(c, {
      html: '<span style="position:absolute;inset:0;border-radius:2.5px;' +
            'background:linear-gradient(180deg,#30303a 0 46%,#08080a 46% 54%,#1e1e24 54% 100%);' +
            'box-shadow:0 1px 3px rgba(0,0,0,0.5);"></span>' +
            '<span style="position:absolute;left:0;right:0;top:0;height:50%;border-radius:2.5px 2.5px 0 0;' +
            'background:linear-gradient(180deg,#42424e,#34343e);transform-origin:50% 100%;' +
            'animation:fxFlapTop 0.62s ease-in forwards;"></span>',
      style: {
        left: leftPct + '%', top: topPct + '%',
        width: '15px', height: '19px',
        perspective: '70px', transformStyle: 'preserve-3d',
        animation: 'fxFlapFade 0.8s linear forwards',
      },
    });
    const clackCleanup = particleLoop(container, (c) => {
      return moduleFlutter(c, rand(5, 90), rand(5, 88));
    }, () => rand(1200, 2800));
    const rippleCleanup = particleLoop(container, (c) => {
      // A row update sweeping left to right, like a flight changing.
      const y = rand(8, 84);
      for (let i = 1; i < 9; i++) {
        setTimeout(() => {
          const el = moduleFlutter(c, 3 + i * 11, y);
          el.addEventListener('animationend', () => el.remove());
        }, i * 70);
      }
      return moduleFlutter(c, 3, y);
    }, () => rand(4200, 8000));
    return () => { clackCleanup(); rippleCleanup(); };
  },

  // Circuit Board: indicator LEDs blinking + current pulses zipping along the
  // copper traces.
  circuitboard: (container) => {
    injectStyles();
    const ledCleanup = particleLoop(container, (c) => {
      const size = rand(2.5, 5);
      return spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: pick(['rgba(64,240,144,0.9)', 'rgba(64,200,240,0.85)', 'rgba(240,80,60,0.8)', 'rgba(240,200,64,0.85)']),
        boxShadow: '0 0 6px currentColor, 0 0 12px currentColor',
        animation: `fxTwinkle ${rand(0.5, 1.6)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.6, 0.95)),
      }});
    }, () => rand(280, 800));
    const pulseCleanup = particleLoop(container, (c) => {
      return spawn(c, { style: {
        left: '0', top: rand(8, 92) + '%',
        width: rand(20, 40) + 'px', height: '2px', borderRadius: '2px',
        background: 'linear-gradient(90deg, transparent, rgba(64,255,150,0.9), transparent)',
        boxShadow: '0 0 6px rgba(64,255,150,0.5)',
        transformOrigin: 'left center',
        animation: `fxShoot ${rand(0.7, 1.4)}s linear forwards`,
        '--fx-ang': '0deg', '--fx-dist': rand(180, 360) + 'px',
      }});
    }, () => rand(500, 1400));
    return () => { ledCleanup(); pulseCleanup(); };
  },

  // Candy (L12): a busy shower of sprinkles, hearts + sparkle pops
  candy: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const colors = ['255,64,129', '224,64,251', '124,77,255', '255,170,40', '64,210,140', '80,170,255'];
      const hue = pick(colors);
      const w = rand(7, 13);
      const el = spawn(c, { style: {
        left: rand(4, 96) + '%', top: rand(4, 96) + '%',
        width: w + 'px', height: (w * 0.38) + 'px',
        borderRadius: w + 'px',
        background: `linear-gradient(180deg, rgba(${hue},0.95), rgba(${hue},0.65))`,
        boxShadow: '0 1px 1px rgba(180,80,120,0.3)',
        animation: `fxTwinkle ${rand(1.4, 2.8)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.5, 0.85)),
      }});
      return el;
    }, () => rand(170, 470));
  },

  // Neon (L21): electric arcade \u2014 dense sparks, arc streaks, a CRT beam sweep
  neon: (container) => {
    injectStyles();
    // CRT scan beam sweeping down
    const scan = document.createElement('div');
    Object.assign(scan.style, {
      position: 'absolute', left: '0', width: '100%', height: '2px',
      background: 'linear-gradient(90deg, transparent, rgba(0,255,136,0.5), transparent)',
      boxShadow: '0 0 12px rgba(0,255,136,0.4)',
      animation: 'fxScanDown 3.5s linear infinite', pointerEvents: 'none', zIndex: '1',
    });
    container.appendChild(scan);
    const sparkCleanup = particleLoop(container, (c) => {
      // ~1 in 5 spawns is a horizontal electric arc instead of a spark
      if (Math.random() < 0.18) {
        return spawn(c, { style: {
          left: '0', top: rand(8, 92) + '%', width: '100%', height: rand(1, 2) + 'px',
          background: pick([
            'linear-gradient(90deg, transparent, rgba(0,255,136,0.5), rgba(0,204,255,0.3), transparent)',
            'linear-gradient(90deg, transparent, rgba(255,0,110,0.4), rgba(0,255,136,0.4), transparent)',
          ]),
          boxShadow: '0 0 8px rgba(0,255,136,0.3)',
          animation: `fxGlitch ${rand(0.2, 0.45)}s ease-in-out forwards`,
        }});
      }
      return spawn(c, { text: pick(['\u00B7', '\u2726', '\u00D7']), style: {
        left: rand(4, 96) + '%', top: rand(4, 96) + '%',
        fontSize: rand(7, 13) + 'px',
        color: pick(['rgba(0,255,136,0.85)', 'rgba(0,221,255,0.75)', 'rgba(255,0,110,0.6)']),
        textShadow: '0 0 8px currentColor, 0 0 14px currentColor',
        animation: `fxTwinkle ${rand(0.25, 0.7)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.6, 0.95)),
      }});
    }, () => rand(160, 480));
    return () => { scan.remove(); sparkCleanup(); };
  },


  // Aurora (L27): drifting colored light bands
  aurora: (container) => {
    injectStyles();
    const colors = ['rgba(0,229,160,0.15)', 'rgba(0,188,212,0.15)', 'rgba(179,136,255,0.12)', 'rgba(0,255,200,0.12)'];
    const bands = [];
    for (let i = 0; i < 3; i++) {
      const band = document.createElement('div');
      Object.assign(band.style, {
        position: 'absolute', top: rand(5, 40) + '%', left: '-20%', width: '140%', height: rand(20, 35) + '%',
        background: `linear-gradient(90deg, transparent, ${pick(colors)}, ${pick(colors)}, transparent)`,
        filter: 'blur(25px)', animation: `fxDrift ${rand(8, 14)}s ease-in-out infinite alternate`,
        '--fx-x0': rand(-20, -5) + '%', '--fx-x2': rand(5, 20) + '%',
        '--fx-opacity': String(rand(0.5, 0.9)), pointerEvents: 'none', zIndex: '0',
      });
      container.appendChild(band);
      bands.push(band);
    }
    return () => bands.forEach(b => b.remove());
  },

  // Sakura (L36): nighttime petals + floating lantern dots
  sakura: (container) => {
    injectStyles();
    const glowCleanup = particleLoop(container, (c) => {
      const size = rand(3, 6);
      const el = spawn(c, { style: {
        left: rand(10, 90) + '%', bottom: rand(5, 40) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(232,112,144,0.4)', boxShadow: '0 0 8px rgba(232,112,144,0.3)',
        animation: `fxTwinkle ${rand(3, 6)}s ease-in-out forwards`, '--fx-opacity': '0.5',
      }});
      return el;
    }, () => rand(1400, 3500));
    // Vector petals, not the cherry-blossom glyph: a single rounded petal shape
    // (teardrop via asymmetric border-radius) in layered pinks, tumbling
    // the full board height.
    const petalCleanup = particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const s = rand(8, 14);
      const pink = pick(['244,170,190', '240,150,176', '250,190,205']);
      return spawn(c, { style: {
        left: rand(4, 92) + '%', top: '0px',
        width: s + 'px', height: (s * 0.72) + 'px',
        borderRadius: '80% 8% 80% 8%',
        background: `linear-gradient(135deg, rgba(${pink},0.85), rgba(${pink},0.5))`,
        animation: `fxFall ${rand(8, 14)}s linear forwards`,
        '--fx-x1': rand(-40, 40) + 'px', '--fx-y1': (boardH * 0.5) + 'px',
        '--fx-x2': rand(-65, 65) + 'px', '--fx-y2': (boardH + 20) + 'px',
        '--fx-r0': rand(0, 70) + 'deg', '--fx-r1': rand(120, 220) + 'deg', '--fx-r2': rand(300, 420) + 'deg',
        '--fx-opacity': '0.7', '--fx-opacity-end': '0.15', '--fx-s': '1',
      }});
    }, () => rand(1100, 2400));
    return () => { glowCleanup(); petalCleanup(); };
  },

  // Galaxy (L40): dense twinkling star field + frequent shooting stars + nebula
  galaxy: (container) => {
    injectStyles();
    const stars = [];
    for (let i = 0; i < 28; i++) {
      const star = spawn(container, { text: pick(['\u00B7', '\u2726', '\u22C6', '.', '\u2727']), style: {
        left: rand(3, 97) + '%', top: rand(3, 97) + '%', fontSize: rand(6, 13) + 'px',
        color: pick(['rgba(255,255,255,0.75)', 'rgba(234,128,252,0.6)', 'rgba(130,177,255,0.6)', 'rgba(255,200,255,0.55)']),
        textShadow: '0 0 4px currentColor, 0 0 8px currentColor',
        animation: `fxTwinkle ${rand(1.8, 4.5)}s ease-in-out ${rand(0, 3)}s infinite`,
        '--fx-opacity': String(rand(0.4, 0.9)),
      }});
      stars.push(star);
    }
    ambientGlow(container, { blur: 22, style: {
      background: 'radial-gradient(ellipse 45% 45% at 28% 38%, rgba(208,80,255,0.10) 0%, transparent 55%), radial-gradient(ellipse 40% 38% at 72% 62%, rgba(130,177,255,0.08) 0%, transparent 55%), radial-gradient(ellipse 30% 30% at 55% 85%, rgba(255,90,200,0.06) 0%, transparent 55%)',
      animation: 'fxDrift 12s ease-in-out infinite alternate', '--fx-x0': '-6%', '--fx-x2': '6%',
    }});
    const shootCleanup = particleLoop(container, (c) => {
      const ang = rand(16, 46);            // travel angle (down-right)
      const dist = rand(220, 400);         // streak length
      const el = spawn(c, { style: {
        // Originate anywhere across the board (and a little off the top/left
        // edge) so the streaks aren't bunched into one corner — they all drift
        // down-right, so a left/top-biased spawn made them only ever appear in
        // the top-right after travelling. Full-spread spawn covers the board.
        left: rand(-12, 85) + '%', top: rand(-8, 82) + '%',
        width: rand(38, 70) + 'px', height: '2px', borderRadius: '2px',
        // bright head on the RIGHT (= leading edge), trail fading behind it
        background: 'linear-gradient(90deg, transparent, rgba(208,80,255,0.4), rgba(255,255,255,0.95))',
        boxShadow: '0 0 7px rgba(255,255,255,0.5)',
        transformOrigin: 'left center',
        animation: `fxShoot ${rand(0.9, 1.5)}s ease-in forwards`,
        '--fx-ang': ang + 'deg',
        '--fx-dist': dist + 'px',
      }});
      return el;
    }, () => rand(1100, 2800));
    return () => { stars.forEach(s => s.remove()); shootCleanup(); };
  },

  // Matrix (L86): dense falling code \u2014 trailing columns of katakana/binary
  // with a bright leading head and a masked fading tail (the real rain look).
  matrix: (container) => {
    injectStyles();
    const matrixChars = '01'.split('');
    const FS = 14; // column character size / pitch
    return particleLoop(container, (c) => {
      // Hard cap concurrent columns. This used to be uncapped at a 70-180ms
      // spawn rate, which steady-stated at ~40 columns — each a separately
      // composited maskImage + textShadow layer animating every frame. On a
      // large, high-DPI desktop board that tanked the frame rate (fine on a
      // small phone board). Capped + slower spawn + no per-column mask keeps
      // the rain readable while cutting the per-frame paint cost by ~3x.
      if (c.childElementCount >= 16) return null;
      const boardH = c.parentElement?.clientHeight || 500;
      const boardW = c.parentElement?.clientWidth || 500;
      const cols = Math.max(6, Math.floor(boardW / FS));
      const colX = Math.floor(rand(0, cols)) * FS;
      const len = Math.floor(rand(8, 18));
      const text = Array.from({ length: len }, () => pick(matrixChars)).join('\n');
      const dur = rand(2.6, 4.8);
      const el = spawn(c, {
        text,
        style: {
          left: colX + 'px', top: '0px', width: FS + 'px',
          fontFamily: 'monospace', fontSize: FS + 'px', lineHeight: '1',
          whiteSpace: 'pre', textAlign: 'center',
          color: 'rgba(140, 255, 165, 0.92)',
          textShadow: '0 0 4px rgba(0, 255, 90, 0.5)',
          // No maskImage: the column instead fades to nothing via the fxFall
          // opacity keyframe (--fx-opacity → --fx-opacity-end), which costs
          // nothing extra to composite. Trades the per-character tail for a
          // whole-column fade — still reads as falling code.
          animation: `fxFall ${dur}s linear forwards`,
          '--fx-x0': '0px', '--fx-y0': (-len * FS) + 'px',
          '--fx-x1': '0px', '--fx-y1': (boardH * 0.5) + 'px',
          '--fx-x2': '0px', '--fx-y2': (boardH + len * FS) + 'px',
          '--fx-r0': '0deg', '--fx-r1': '0deg', '--fx-r2': '0deg',
          '--fx-opacity': '0.92', '--fx-opacity-end': '0', '--fx-s': '1',
        },
      });
      return el;
    }, () => rand(190, 380));
  },

  // Inferno (L92): intense fire + sparks
  inferno: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 20, style: {
      background: 'radial-gradient(ellipse 80% 40% at 50% 100%, rgba(255,50,0,0.1) 0%, rgba(255,150,0,0.04) 40%, transparent 60%)',
      animation: 'fxFloat 3s ease-in-out infinite', '--fx-float-y': '6px',
    }});
    return particleLoop(container, (c) => {
      return risingParticle(c, {
        color: pick(['rgba(255,60,0,0.7)', 'rgba(255,180,0,0.6)', 'rgba(255,100,0,0.5)', 'rgba(255,220,50,0.4)']),
        glow: '0 0 8px rgba(255,80,0,0.5)', sizeMin: 2, sizeMax: 6,
        durationMin: 2, durationMax: 4, opacity: 0.7, opacityEnd: 0.1, scaleEnd: 0.15,
      });
    }, () => rand(210, 630));
  },

  // Synthwave (L94): retro grid + neon glow
  synthwave: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 20, style: {
      background: 'radial-gradient(ellipse 80% 30% at 50% 100%, rgba(255,0,200,0.06) 0%, rgba(0,200,255,0.03) 40%, transparent 60%)',
      animation: 'fxFloat 4s ease-in-out infinite alternate', '--fx-float-y': '4px',
    }});
    const lineCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { style: {
        left: '0', top: rand(10, 90) + '%', width: '100%', height: '1px',
        background: `linear-gradient(90deg, transparent, ${pick(['rgba(255,0,200,0.3)', 'rgba(0,200,255,0.3)'])}, transparent)`,
        animation: `fxTwinkle ${rand(1, 2)}s ease-in-out forwards`, '--fx-opacity': '0.5',
      }});
      return el;
    }, () => rand(1400, 3500));
    return lineCleanup;
  },

  // Supernova (L98): radial burst pulses + bright sparks
  supernova: (container) => {
    injectStyles();
    // Pulsing core glow
    ambientGlow(container, { blur: 25, style: {
      background: 'radial-gradient(circle at 50% 50%, rgba(255,120,20,0.12) 0%, rgba(255,60,0,0.04) 30%, transparent 55%)',
      animation: 'fxFloat 2.5s ease-in-out infinite', '--fx-float-y': '3px',
    }});
    // Radial burst rings that expand outward
    const burstCleanup = particleLoop(container, (c) => {
      const size = rand(8, 20);
      const el = spawn(c, { style: {
        left: rand(20, 80) + '%', top: rand(20, 80) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        border: '2px solid rgba(255,180,50,0.6)',
        background: 'transparent',
        boxShadow: '0 0 8px rgba(255,140,20,0.3)',
        animation: `fxTwinkle ${rand(0.8, 1.5)}s ease-out forwards`,
        '--fx-opacity': '0.7',
        transform: 'scale(1)',
      }});
      // Expand the ring
      el.animate([
        { transform: 'scale(1)', opacity: 0.7 },
        { transform: 'scale(3.5)', opacity: 0 },
      ], { duration: rand(800, 1500), easing: 'ease-out', fill: 'forwards' });
      return el;
    }, () => rand(600, 1800));
    // Bright sparks flying in all directions
    const sparkCleanup = particleLoop(container, (c) => {
      const angle = rand(0, 360);
      const dist = rand(30, 80);
      const el = spawn(c, { text: pick(['\u2726', '\u00B7']), style: {
        left: '50%', top: '50%', fontSize: rand(6, 11) + 'px',
        color: pick(['rgba(255,200,60,0.8)', 'rgba(255,140,40,0.7)', 'rgba(255,255,180,0.6)']),
        textShadow: '0 0 6px currentColor',
        animation: `fxTwinkle ${rand(0.4, 0.8)}s ease-out forwards`,
        '--fx-opacity': '0.8',
      }});
      el.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 0.8 },
        { transform: `translate(${Math.cos(angle)*dist}px,${Math.sin(angle)*dist}px) scale(0.3)`, opacity: 0 },
      ], { duration: rand(500, 1000), easing: 'ease-out', fill: 'forwards' });
      return el;
    }, () => rand(200, 600));
    return () => { burstCleanup(); sparkCleanup(); };
  },

  // Legendary (L100): golden sparkles + dragon fire embers
  legendary: (container) => {
    injectStyles();
    const sparkleCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: pick(['\u2726', '\u2727']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(6, 12) + 'px',
        color: pick(['rgba(255,215,0,0.7)', 'rgba(255,180,0,0.5)', 'rgba(255,240,150,0.5)']),
        textShadow: '0 0 6px rgba(255,215,0,0.5)',
        animation: `fxTwinkle ${rand(0.8, 2)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.5, 0.8)),
      }});
      return el;
    }, () => rand(210, 560));
    const emberCleanup = particleLoop(container, (c) => {
      return risingParticle(c, {
        color: pick(['rgba(255,80,20,0.7)', 'rgba(255,200,50,0.6)', 'rgba(255,140,0,0.5)']),
        glow: '0 0 8px rgba(255,100,0,0.5)', sizeMin: 2, sizeMax: 5,
        durationMin: 2, durationMax: 5, opacity: 0.7, opacityEnd: 0.1, scaleEnd: 0.2,
      });
    }, () => rand(350, 1050));
    return () => { sparkleCleanup(); emberCleanup(); };
  },

  // ── Wave 2: the six quiet concept worlds (2026-06-10) ──────────
  // Christopher's bar: "worlds apart, not reskins ... excellent
  // animations and less emojis." Every particle below is DRAWN — a
  // styled div with gradients / clip-paths / dash patterns — never an
  // emoji glyph. Counts stay modest, sizes visible (the Forest-spore
  // lesson), and each theme's motion comes from its own craft idiom.

  // Editorial (L5): the page typesets itself. Nothing falls and nothing
  // flies on a newspaper — the first cut (falling flecks + a sweeping
  // rule) read as dust and an airplane contrail (Christopher,
  // 2026-06-10). Now short lines of "type" fade in AT REST like a
  // galley being composed, with small ink specks blinking like setting
  // characters.
  editorial: (container) => {
    injectStyles();
    const lineCleanup = particleLoop(container, (c) => {
      // A line of type: thin dark rule with a lighter ragged right end.
      const w = rand(34, 78);
      return spawn(c, { style: {
        left: rand(6, 60) + '%', top: rand(6, 92) + '%',
        width: w + 'px', height: '3px', borderRadius: '1.5px',
        background: 'linear-gradient(90deg, rgba(26,26,26,0.42) 0 82%, rgba(26,26,26,0.18) 82% 100%)',
        animation: `fxTwinkle ${rand(3.5, 6)}s ease-in-out forwards`,
        '--fx-opacity': '0.55',
      }});
    }, () => rand(1100, 2200));
    const speckCleanup = particleLoop(container, (c) => {
      const s = rand(2.5, 4.5);
      return spawn(c, { style: {
        left: rand(5, 93) + '%', top: rand(5, 93) + '%',
        width: s + 'px', height: s + 'px', borderRadius: '1px',
        background: pick(['rgba(26,26,26,0.45)', 'rgba(44,62,143,0.35)']),
        animation: `fxTwinkle ${rand(2, 4)}s ease-in-out forwards`,
        '--fx-opacity': '0.5',
      }});
    }, () => rand(900, 1900));
    return () => { lineCleanup(); speckCleanup(); };
  },

  // Sumi-e (L10): ink motes bloom on the paper and feather away; a
  // long brush wisp occasionally floats across. Rarely, a seal-red mote
  // — the artist's stamp.
  sumie: (container) => {
    injectStyles();
    const moteCleanup = particleLoop(container, (c) => {
      const s = rand(8, 18);
      const red = Math.random() < 0.07;
      const ink = red ? '176,48,32' : '42,42,42';
      return spawn(c, { style: {
        left: rand(6, 90) + '%', top: rand(6, 90) + '%',
        width: s + 'px', height: s + 'px', borderRadius: '50%',
        background: `radial-gradient(circle, rgba(${ink},0.4) 0%, rgba(${ink},0.18) 45%, transparent 72%)`,
        animation: `fxTwinkle ${rand(3.5, 6.5)}s ease-in-out forwards`,
        '--fx-opacity': '0.7',
      }});
    }, () => rand(900, 1900));
    const wispCleanup = particleLoop(container, (c) => {
      return spawn(c, { style: {
        left: '-10%', top: rand(12, 82) + '%',
        width: rand(60, 110) + 'px', height: rand(3, 5) + 'px',
        borderRadius: '50%',
        background: 'linear-gradient(90deg, transparent, rgba(42,42,42,0.18) 30%, rgba(42,42,42,0.26) 50%, rgba(42,42,42,0.12) 80%, transparent)',
        animation: `fxSweep ${rand(11, 17)}s ease-in-out forwards`,
      }});
    }, () => rand(5200, 9500));
    return () => { moteCleanup(); wispCleanup(); };
  },

  // Blueprint (L15): drafting ticks — small cyan crosses register on
  // the sheet like compass pricks; a dashed measure line sweeps through
  // on the slow cycle.
  blueprint: (container) => {
    injectStyles();
    const tickCleanup = particleLoop(container, (c) => {
      const s = rand(6, 11);
      const cyan = pick(['90,208,255', '160,224,255', '122,224,255']);
      return spawn(c, { style: {
        left: rand(4, 94) + '%', top: rand(4, 94) + '%',
        width: s + 'px', height: s + 'px',
        background: `linear-gradient(rgba(${cyan},0.75), rgba(${cyan},0.75)) center / 100% 1px no-repeat, ` +
                    `linear-gradient(rgba(${cyan},0.75), rgba(${cyan},0.75)) center / 1px 100% no-repeat`,
        animation: `fxTwinkle ${rand(1.6, 3.2)}s ease-in-out forwards`,
        '--fx-opacity': '0.8',
      }});
    }, () => rand(550, 1250));
    // (The sweeping dashed measure lines were cut 2026-06-11 — moving
    // dashes read as noise on the drafted sheet. Register ticks only.)
    return tickCleanup;
  },

  // Cartography (L20): plotted routes — dashed sepia course segments
  // drift across the chart while tiny sounding rings surface and fade.
  cartography: (container) => {
    injectStyles();
    const routeCleanup = particleLoop(container, (c) => {
      const ang = rand(-24, 24);
      return spawn(c, { style: {
        left: rand(-5, 70) + '%', top: rand(8, 88) + '%',
        width: rand(55, 105) + 'px', height: '2px',
        transform: `rotate(${ang}deg)`,
        background: 'repeating-linear-gradient(90deg, rgba(106,74,38,0.5) 0 7px, transparent 7px 13px)',
        animation: `fxDrift ${rand(9, 15)}s ease-in-out forwards`,
        '--fx-x0': '-12%', '--fx-x2': '12%', '--fx-opacity': '0.5',
      }});
    }, () => rand(2400, 4800));
    const soundingCleanup = particleLoop(container, (c) => {
      const s = rand(5, 9);
      return spawn(c, { style: {
        left: rand(6, 92) + '%', top: rand(6, 92) + '%',
        width: s + 'px', height: s + 'px', borderRadius: '50%',
        border: '1.5px solid rgba(106,74,38,0.55)',
        background: 'transparent',
        animation: `fxTwinkle ${rand(2.5, 4.5)}s ease-in-out forwards`,
        '--fx-opacity': '0.6',
      }});
    }, () => rand(1100, 2300));
    return () => { routeCleanup(); soundingCleanup(); };
  },

  // Origami (L25): folded paper birds — pastel clip-path triangles
  // glide down with the slow rotation of drifting paper.
  origami: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const s = rand(10, 17);
      const hue = pick(['209,74,74', '74,138,192', '90,160,90', '224,144,58', '154,106,192']);
      // Travel must be in PIXELS of the board, not % — fxFall feeds
      // translate(), where % is relative to the PARTICLE's own ~14px
      // box, so '105%' meant triangles died ~15px down (inside the
      // first cell on an expert board).
      const boardH = c.parentElement?.clientHeight || 500;
      return spawn(c, { style: {
        left: rand(4, 92) + '%', top: '0px',
        width: s + 'px', height: s + 'px',
        clipPath: pick([
          'polygon(0 100%, 50% 0, 100% 100%)',
          'polygon(0 0, 100% 35%, 25% 100%)',
          'polygon(0 40%, 100% 0, 70% 100%)',
        ]),
        background: `linear-gradient(135deg, rgba(${hue},0.55), rgba(${hue},0.3))`,
        animation: `fxFall ${rand(6, 11)}s linear forwards`,
        '--fx-x1': rand(-36, 36) + 'px', '--fx-y1': (boardH * 0.5) + 'px',
        '--fx-x2': rand(-55, 55) + 'px', '--fx-y2': (boardH + 25) + 'px',
        '--fx-r0': rand(0, 40) + 'deg', '--fx-r1': rand(90, 180) + 'deg', '--fx-r2': rand(240, 360) + 'deg',
        '--fx-opacity': '0.6', '--fx-opacity-end': '0.25', '--fx-s': '1',
      }});
    }, () => rand(800, 1700));
  },

  // Nest (L85): the open sky — slow soft white clouds drift across, and gulls
  // cross both ways, sometimes singly and sometimes in a little flock of 3-5.
  nest: (container) => {
    injectStyles();
    const SL = "stroke='%23394a5c' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'";
    const gull = (inner) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 12'%3E${inner}%3C/svg%3E")`;
    // Four distant-gull silhouettes (shapes 1-4): plain M, soft, with a body, tips up.
    const BIRDS = [
      gull(`%3Cpath d='M2 10 Q6 3 12 8 Q18 3 22 10' ${SL}/%3E`),
      gull(`%3Cpath d='M2 9 Q7 5 12 8 Q17 5 22 9' ${SL}/%3E`),
      gull(`%3Cpath d='M2 9 Q7 4 11 8 M22 9 Q17 4 13 8' ${SL}/%3E%3Cellipse cx='12' cy='8' rx='1.6' ry='1' fill='%23394a5c'/%3E`),
      gull(`%3Cpath d='M2 8 Q5 9 8 6 Q11 3 12 8 Q13 3 16 6 Q19 9 22 8' ${SL}/%3E`),
    ];
    // Five cloud silhouettes — puffy, small, long stratus, tall cumulus, wispy —
    // so the sky never repeats the same shape. Each carries its aspect (ar) so it
    // scales without distortion.
    const cloud = (b, ar, inner) => ({ uri: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='${b}'%3E%3Cg fill='%23ffffff'%3E${inner}%3C/g%3E%3C/svg%3E")`, ar });
    const CLOUDS = [
      cloud('0 0 64 34', 0.53, "%3Cellipse cx='22' cy='22' rx='18' ry='9'/%3E%3Cellipse cx='35' cy='15' rx='13' ry='10'/%3E%3Cellipse cx='47' cy='22' rx='15' ry='8'/%3E%3Cellipse cx='32' cy='26' rx='25' ry='6'/%3E"),
      cloud('0 0 48 30', 0.62, "%3Cellipse cx='16' cy='20' rx='13' ry='8'/%3E%3Cellipse cx='29' cy='14' rx='12' ry='9'/%3E%3Cellipse cx='24' cy='24' rx='21' ry='6'/%3E"),
      cloud('0 0 84 26', 0.31, "%3Cellipse cx='24' cy='15' rx='20' ry='8'/%3E%3Cellipse cx='52' cy='13' rx='23' ry='9'/%3E%3Cellipse cx='42' cy='20' rx='36' ry='5'/%3E"),
      cloud('0 0 54 42', 0.78, "%3Cellipse cx='27' cy='15' rx='13' ry='12'/%3E%3Cellipse cx='17' cy='26' rx='12' ry='9'/%3E%3Cellipse cx='38' cy='26' rx='13' ry='9'/%3E%3Cellipse cx='27' cy='32' rx='23' ry='7'/%3E"),
      cloud('0 0 76 22', 0.29, "%3Cellipse cx='20' cy='13' rx='15' ry='6'/%3E%3Cellipse cx='42' cy='11' rx='13' ry='7'/%3E%3Cellipse cx='58' cy='14' rx='14' ry='5'/%3E%3Cellipse cx='40' cy='17' rx='32' ry='4'/%3E"),
    ];
    const widthOf = (c) => c.clientWidth || container.parentElement?.clientWidth || 400;
    const path = (W, fromLeft, pad) => { const d = W + pad; return { '--fx-x0': '0px', '--fx-x1': (fromLeft ? d * 0.5 : -d * 0.5) + 'px', '--fx-x2': (fromLeft ? d : -d) + 'px' }; };
    // A loose flock of 1-5 mixed gulls in a random formation, gliding slowly
    // (so they read as far away). Both directions. midFlight seeds the sky.
    const spawnFlock = (c, midFlight) => {
      const W = widthOf(c), fromLeft = pick([true, false]), n = pick([1, 1, 2, 3, 3, 4, 5]), form = pick(['v', 'line', 'cluster']);
      const delay = midFlight ? ` -${rand(4, 13).toFixed(1)}s` : '';
      const el = spawn(c, { style: {
        left: fromLeft ? '-84px' : (W + 40) + 'px', top: rand(5, 85) + '%',
        width: '84px', height: '52px',
        animation: `fxGlide ${rand(17, 27)}s linear${delay} forwards`,
        ...path(W, fromLeft, 120), '--fx-bob': rand(-8, -4) + 'px', '--fx-dir': fromLeft ? '1' : '-1', '--fx-opacity': '0.66',
      }});
      const mid = (n - 1) / 2;
      for (let i = 0; i < n; i++) {
        const g = document.createElement('div'), s = rand(12, 18);
        let dx, dy;
        if (form === 'v') { dx = i * 12; dy = Math.abs(i - mid) * 7 + rand(-2, 2); }
        else if (form === 'line') { dx = i * 14; dy = rand(-3, 3); }
        else { dx = rand(0, 52); dy = rand(0, 28); }
        g.style.cssText = `position:absolute;width:${s}px;height:${s * 0.55}px;left:${dx}px;top:${dy}px;background-image:${pick(BIRDS)};background-repeat:no-repeat;background-size:contain`;
        el.appendChild(g);
      }
      return el;
    };
    // Slow white clouds, ALL drifting the same way (the wind blows one direction).
    const spawnCloud = (c, midFlight) => {
      const W = widthOf(c), cl = pick(CLOUDS), w = rand(58, 122), delay = midFlight ? ` -${rand(10, 50).toFixed(1)}s` : '';
      return spawn(c, { style: {
        left: (-w - 20) + 'px', top: rand(2, 80) + '%', width: w + 'px', height: (w * cl.ar) + 'px',
        backgroundImage: cl.uri, backgroundRepeat: 'no-repeat', backgroundSize: 'contain',
        animation: `fxGlide ${rand(54, 84)}s linear${delay} forwards`,
        ...path(W, true, 240), '--fx-bob': '0px', '--fx-dir': '1', '--fx-opacity': '0.88',
      }});
    };
    // Seed the sky so it's never empty, then keep a steady stream coming.
    spawnFlock(container, true); spawnFlock(container, true); spawnFlock(container, true);
    spawnCloud(container, true); spawnCloud(container, true); spawnCloud(container, true);
    const gulls = particleLoop(container, (c) => spawnFlock(c, false), () => rand(2600, 5200));
    const clouds = particleLoop(container, (c) => spawnCloud(c, false), () => rand(9000, 16000));
    return () => { gulls(); clouds(); };
  },
};

export default THEME_EFFECTS;
