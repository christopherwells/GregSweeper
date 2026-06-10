/**
 * Theme Effects Engine — spawns dynamic DOM particles and ambient visuals per theme.
 * Called by themeManager when theme changes. Each theme registers an effect function
 * that creates/manages its own visual elements inside the board container.
 */

let activeCleanup = null;
let effectContainer = null;

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

  // Respect prefers-reduced-motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

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

  const el = spawn(container, {
    text: pick(opts.chars),
    style: {
      left: startX + '%',
      top: '0px',
      fontSize: size + 'px',
      lineHeight: '1',
      animation: `fxFall ${duration}s ease-in-out forwards`,
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

  // Ocean (L3): gentle floating particles
  ocean: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const size = rand(3, 6);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(10, 90) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(150, 220, 255, 0.5)',
        boxShadow: '0 0 4px rgba(150, 220, 255, 0.3)',
        animation: `fxFloat ${rand(3, 6)}s ease-in-out forwards, fxTwinkle ${rand(4, 7)}s ease-in-out forwards`,
        '--fx-float-y': rand(-10, -20) + 'px', '--fx-opacity': String(rand(0.4, 0.6)),
      }});
      return el;
    }, () => rand(800, 2100));
  },

  // Sunset (L6): warm golden light drift
  sunset: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 20, style: {
      background: 'radial-gradient(ellipse 60% 50% at 50% 30%, rgba(255, 150, 50, 0.06) 0%, transparent 60%)',
      animation: 'fxDrift 10s ease-in-out infinite alternate',
      '--fx-x0': '-8%', '--fx-x2': '8%', '--fx-opacity': '0.5',
    }});
    return () => {};
  },

  // Forest (L9): drifting leaves (the visible headline) + glowing fireflies
  forest: (container) => {
    injectStyles();
    // falling leaves — clearly readable motion, drifting + tumbling down
    const leafCleanup = particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['🍃', '🍂', '🌿', '🍃', '🍃'],
        sizeMin: 13, sizeMax: 22, durationMin: 5, durationMax: 9,
        opacity: 0.75, opacityEnd: 0.2,
      });
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

  // Candy (L12): a busy shower of sprinkles, hearts + sparkle pops
  candy: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const candyChars = ['\u2726', '\u2022', '\u2666', '\u2605', '\u25CF', '\u2764', '\u273F'];
      const colors = ['rgba(255,64,129,0.7)', 'rgba(224,64,251,0.6)', 'rgba(124,77,255,0.6)', 'rgba(255,170,40,0.7)', 'rgba(64,210,140,0.6)', 'rgba(80,170,255,0.6)'];
      const el = spawn(c, { text: pick(candyChars), style: {
        left: rand(4, 96) + '%', top: rand(4, 96) + '%',
        fontSize: rand(8, 17) + 'px', color: pick(colors),
        textShadow: '0 1px 2px rgba(180,80,120,0.25)',
        animation: `fxTwinkle ${rand(1.4, 2.8)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.55, 0.9)),
      }});
      return el;
    }, () => rand(170, 470));
  },

  // Midnight (L15): twinkling starfield
  midnight: (container) => {
    injectStyles();
    const stars = [];
    for (let i = 0; i < 10; i++) {
      const star = spawn(container, { text: pick(['\u00B7', '\u22C6', '\u2726']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        fontSize: rand(4, 8) + 'px',
        color: pick(['rgba(255,255,255,0.4)', 'rgba(204,136,255,0.35)', 'rgba(128,176,255,0.35)']),
        textShadow: '0 0 3px currentColor',
        animation: `fxTwinkle ${rand(2, 5)}s ease-in-out ${rand(0, 3)}s infinite`,
        '--fx-opacity': String(rand(0.2, 0.5)),
      }});
      stars.push(star);
    }
    return () => stars.forEach(s => s.remove());
  },

  // Stealth (L18): radar scan sweep
  stealth: (container) => {
    injectStyles();
    // Visible radar sweep scanline
    const scanLine = document.createElement('div');
    Object.assign(scanLine.style, {
      position: 'absolute', left: '0', width: '100%', height: '3px',
      background: 'linear-gradient(90deg, transparent 5%, rgba(180,180,180,0.3) 25%, rgba(200,200,200,0.45) 50%, rgba(180,180,180,0.3) 75%, transparent 95%)',
      boxShadow: '0 0 12px rgba(180,180,180,0.15), 0 -4px 20px rgba(180,180,180,0.06)',
      animation: 'fxScanDown 5s linear infinite', pointerEvents: 'none', zIndex: '1',
    });
    container.appendChild(scanLine);
    // Subtle static dots
    const dustCleanup = particleLoop(container, (c) => {
      const size = rand(1, 3);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(200,200,200,0.5)',
        animation: `fxTwinkle ${rand(0.2, 0.6)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.3, 0.6)),
      }});
      return el;
    }, () => rand(500, 1500));
    return () => { scanLine.remove(); dustCleanup(); };
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
      return spawn(c, { text: pick(['\u00B7', '\u26A1', '\u2726', '\u00D7']), style: {
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

  // Cherry Blossom (L24): gentle shower of petals
  'cherry-blossom': (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83C\uDF38', '\uD83C\uDF38', '\uD83C\uDF38', '\uD83D\uDCAE'],
        sizeMin: 12, sizeMax: 20, durationMin: 7, durationMax: 12,
        opacity: 0.5, opacityEnd: 0.1,
      });
    }, () => rand(1050, 2450));
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

  // Volcano (L30): rising embers + heat glow
  volcano: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 25, style: {
      inset: '-10%',
      background: 'radial-gradient(ellipse 80% 40% at 50% 100%, rgba(255,80,20,0.08) 0%, transparent 60%)',
      animation: 'fxFloat 4s ease-in-out infinite', '--fx-float-y': '5px',
    }});
    return particleLoop(container, (c) => {
      return risingParticle(c, {
        color: pick(['rgba(255,100,30,0.7)', 'rgba(255,200,50,0.6)', 'rgba(255,60,10,0.5)']),
        glow: '0 0 6px rgba(255,100,30,0.5)', sizeMin: 2, sizeMax: 5,
        durationMin: 3, durationMax: 6, opacity: 0.7, opacityEnd: 0.1, scaleEnd: 0.2,
      });
    }, () => rand(420, 1260));
  },

  // Copper (L33): metallic shimmer sweep + warm sparks
  copper: (container) => {
    injectStyles();
    const sweep = document.createElement('div');
    Object.assign(sweep.style, {
      position: 'absolute', inset: '-50%',
      background: 'linear-gradient(105deg, transparent 40%, rgba(255,200,150,0.06) 44%, rgba(255,220,180,0.1) 48%, rgba(255,200,150,0.06) 52%, transparent 56%)',
      animation: 'fxSweep 6s ease-in-out infinite', pointerEvents: 'none', zIndex: '0',
    });
    container.appendChild(sweep);
    const sparkleCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: '\u2726', style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(5, 8) + 'px',
        color: pick(['rgba(212,148,76,0.5)', 'rgba(232,168,96,0.4)', 'rgba(184,122,80,0.4)']),
        textShadow: '0 0 3px currentColor',
        animation: `fxTwinkle ${rand(1.5, 3)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.3, 0.5)),
      }});
      return el;
    }, () => rand(1400, 3500));
    return () => { sweep.remove(); sparkleCleanup(); };
  },

  // Ice (L34): drifting snow
  ice: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\u2744', '\u00B7', '\u2745', '\u00B7'],
        color: 'rgba(80,140,200,0.7)',
        sizeMin: 8, sizeMax: 16, durationMin: 5, durationMax: 10,
        opacity: 0.6, opacityEnd: 0.15, scaleMin: 0.6, scaleMax: 1,
      });
    }, () => rand(500, 1400));
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
    const petalCleanup = particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83C\uDF38'], sizeMin: 10, sizeMax: 16,
        durationMin: 9, durationMax: 15, opacity: 0.35, opacityEnd: 0.08,
      });
    }, () => rand(1750, 3500));
    return () => { glowCleanup(); petalCleanup(); };
  },

  // Cyberpunk (L38): glitch bars + neon data drops
  cyberpunk: (container) => {
    injectStyles();
    const glitchCleanup = particleLoop(container, (c) => {
      const h = rand(1, 4);
      const el = spawn(c, { style: {
        left: '0', top: rand(5, 95) + '%', width: '100%', height: h + 'px',
        background: pick([
          'linear-gradient(90deg, transparent, rgba(255,0,128,0.15), rgba(0,255,255,0.1), transparent)',
          'linear-gradient(90deg, transparent, rgba(0,255,255,0.15), rgba(255,0,128,0.1), transparent)',
        ]),
        animation: `fxGlitch ${rand(0.2, 0.5)}s ease-in-out forwards`,
      }});
      return el;
    }, () => rand(1400, 4200));
    const dropCleanup = particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const size = rand(2, 4);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: '0px',
        width: size + 'px', height: size * 2 + 'px',
        background: pick(['rgba(0,255,255,0.5)', 'rgba(255,0,128,0.4)']),
        boxShadow: '0 0 4px currentColor',
        animation: `fxFall ${rand(1.5, 3)}s linear forwards`,
        '--fx-x0': '0px', '--fx-y0': '-5px',
        '--fx-x1': '0px', '--fx-y1': (boardH * 0.5) + 'px',
        '--fx-x2': '0px', '--fx-y2': (boardH + 10) + 'px',
        '--fx-r0': '0deg', '--fx-r1': '0deg', '--fx-r2': '0deg',
        '--fx-opacity': '0.5', '--fx-opacity-end': '0.1', '--fx-s': '1',
      }});
      return el;
    }, () => rand(280, 840));
    return () => { glitchCleanup(); dropCleanup(); };
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

  // Retro (L42): CRT scanlines + pixel dust + static overlay
  retro: (container) => {
    injectStyles();
    // Visible CRT scanline sweep
    const scanLine = document.createElement('div');
    Object.assign(scanLine.style, {
      position: 'absolute', left: '0', width: '100%', height: '4px',
      background: 'linear-gradient(90deg, transparent 5%, rgba(255,51,136,0.35) 25%, rgba(68,204,255,0.3) 50%, rgba(255,51,136,0.35) 75%, transparent 95%)',
      boxShadow: '0 0 16px rgba(255,51,136,0.15), 0 0 4px rgba(68,204,255,0.1)',
      animation: 'fxScanDown 4s linear infinite', pointerEvents: 'none', zIndex: '1',
    });
    container.appendChild(scanLine);
    // CRT static flicker overlay
    const staticOverlay = document.createElement('div');
    Object.assign(staticOverlay.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '0',
      background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
      opacity: '0.5',
    });
    container.appendChild(staticOverlay);
    // Pixel dust — bigger, brighter, more frequent
    const dustCleanup = particleLoop(container, (c) => {
      const size = rand(3, 6);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        width: size + 'px', height: size + 'px',
        background: pick(['rgba(255,51,136,0.7)', 'rgba(68,204,255,0.6)', 'rgba(68,255,170,0.5)']),
        boxShadow: '0 0 4px currentColor',
        animation: `fxTwinkle ${rand(0.3, 1)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.5, 0.8)),
      }});
      return el;
    }, () => rand(350, 1050));
    return () => { scanLine.remove(); staticOverlay.remove(); dustCleanup(); };
  },

  // Lavender (L44): floating particles + dreamy mist
  lavender: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 22, style: {
      background: 'radial-gradient(ellipse 50% 40% at 40% 50%, rgba(168,120,216,0.12) 0%, transparent 55%), radial-gradient(ellipse 40% 50% at 70% 45%, rgba(140,100,200,0.10) 0%, transparent 50%)',
      animation: 'fxDrift 10s ease-in-out infinite alternate', '--fx-x0': '-4%', '--fx-x2': '4%',
    }});
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83E\uDEBB', '\u00B7', '\u273F'],
        color: 'rgba(168,120,216,0.6)',
        sizeMin: 10, sizeMax: 16, durationMin: 8, durationMax: 14,
        opacity: 0.5, opacityEnd: 0.12,
      });
    }, () => rand(1400, 3500));
  },

  // Holographic (L46): rainbow light sweeps
  holographic: (container) => {
    injectStyles();
    const sweeps = [];
    for (let i = 0; i < 2; i++) {
      const sweep = document.createElement('div');
      const angle = 100 + i * 30;
      Object.assign(sweep.style, {
        position: 'absolute', inset: '-50%',
        background: `linear-gradient(${angle}deg, transparent 35%, rgba(255,68,102,0.04) 38%, rgba(255,170,34,0.04) 41%, rgba(68,255,136,0.04) 44%, rgba(68,221,255,0.04) 47%, rgba(187,102,255,0.04) 50%, transparent 53%)`,
        animation: `fxSweep ${6 + i * 3}s ease-in-out ${i * 3}s infinite`, pointerEvents: 'none', zIndex: '0',
      });
      container.appendChild(sweep);
      sweeps.push(sweep);
    }
    const sparkleCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: '\u2726', style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(5, 9) + 'px',
        color: pick(['rgba(255,68,102,0.5)', 'rgba(68,221,255,0.5)', 'rgba(68,255,136,0.4)', 'rgba(187,102,255,0.4)']),
        textShadow: '0 0 3px currentColor',
        animation: `fxTwinkle ${rand(0.8, 2)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.4, 0.7)),
      }});
      return el;
    }, () => rand(280, 840));
    return () => { sweeps.forEach(s => s.remove()); sparkleCleanup(); };
  },

  // Toxic (L48): bubbling toxic waste
  toxic: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 20, style: {
      background: 'radial-gradient(circle at 50% 50%, rgba(0,255,60,0.05) 0%, transparent 50%)',
      animation: 'fxFloat 4s ease-in-out infinite alternate', '--fx-float-y': '3px',
    }});
    return particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const size = rand(3, 8);
      const el = spawn(c, { style: {
        left: rand(10, 90) + '%', bottom: '2%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: pick(['rgba(0,255,60,0.35)', 'rgba(170,255,0,0.3)', 'rgba(0,220,40,0.25)']),
        border: '1px solid rgba(0,255,60,0.2)', boxShadow: '0 0 4px rgba(0,255,60,0.3)',
        animation: `fxRise ${rand(3, 7)}s ease-out forwards`,
        '--fx-x0': '0px', '--fx-y0': '0px',
        '--fx-x1': rand(-10, 10) + 'px', '--fx-y1': -(boardH * 0.4) + 'px',
        '--fx-x2': rand(-15, 15) + 'px', '--fx-y2': -(boardH * 0.85) + 'px',
        '--fx-opacity': '0.5', '--fx-opacity-end': '0.1',
        '--fx-s': '1', '--fx-s-end': String(rand(0.3, 0.6)),
      }});
      return el;
    }, () => rand(560, 1400));
  },

  // Autumn (L52): falling leaves
  autumn: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83C\uDF42', '\uD83C\uDF41', '\uD83C\uDF43', '\uD83C\uDF42'],
        sizeMin: 14, sizeMax: 22, durationMin: 5, durationMax: 9,
        opacity: 0.65, opacityEnd: 0.15,
      });
    }, () => rand(700, 1800));
  },

  // Royal (L55): gold dust + regal sparkles
  royal: (container) => {
    injectStyles();
    const sweep = document.createElement('div');
    Object.assign(sweep.style, {
      position: 'absolute', inset: '-50%',
      background: 'linear-gradient(115deg, transparent 42%, rgba(255,215,0,0.04) 46%, rgba(255,236,128,0.06) 50%, rgba(255,215,0,0.04) 54%, transparent 58%)',
      animation: 'fxSweep 8s ease-in-out infinite', pointerEvents: 'none', zIndex: '0',
    });
    container.appendChild(sweep);
    const sparkleCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: pick(['\u2726', '\u2727', '\u22C6']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(5, 10) + 'px',
        color: pick(['rgba(255,215,0,0.6)', 'rgba(255,236,128,0.5)', 'rgba(184,134,11,0.4)']),
        textShadow: '0 0 4px rgba(255,215,0,0.4)',
        animation: `fxTwinkle ${rand(1, 2.5)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.4, 0.7)),
      }});
      return el;
    }, () => rand(560, 1400));
    return () => { sweep.remove(); sparkleCleanup(); };
  },

  // Coral (L58): underwater caustics + rising bubbles
  coral: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 15, style: {
      background: 'radial-gradient(ellipse 30% 25% at 35% 30%, rgba(240,160,136,0.10) 0%, transparent 50%), radial-gradient(ellipse 25% 30% at 65% 60%, rgba(96,200,176,0.08) 0%, transparent 50%)',
      animation: 'fxDrift 8s ease-in-out infinite alternate', '--fx-x0': '-5%', '--fx-x2': '5%',
    }});
    return particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const size = rand(4, 9);
      const el = spawn(c, { style: {
        left: rand(10, 90) + '%', bottom: '0%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        border: '1.5px solid rgba(240,170,150,0.5)', background: 'rgba(240,170,150,0.08)',
        boxShadow: '0 0 4px rgba(240,170,150,0.2)',
        animation: `fxRise ${rand(4, 8)}s ease-out forwards`,
        '--fx-x0': '0px', '--fx-y0': '0px',
        '--fx-x1': rand(-15, 15) + 'px', '--fx-y1': -(boardH * 0.4) + 'px',
        '--fx-x2': rand(-10, 10) + 'px', '--fx-y2': -(boardH * 0.9) + 'px',
        '--fx-opacity': '0.6', '--fx-opacity-end': '0.15',
        '--fx-s': '1', '--fx-s-end': String(rand(1.3, 2.0)),
      }});
      return el;
    }, () => rand(500, 1400));
  },

  // Emerald (L61): sparkling gem facets
  emerald: (container) => {
    injectStyles();
    const sweep = document.createElement('div');
    Object.assign(sweep.style, {
      position: 'absolute', inset: '-50%',
      background: 'linear-gradient(115deg, transparent 40%, rgba(48,200,120,0.05) 45%, rgba(80,232,160,0.04) 50%, transparent 55%)',
      animation: 'fxSweep 8s ease-in-out infinite', pointerEvents: 'none', zIndex: '0',
    });
    container.appendChild(sweep);
    const sparkleCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: '\u2726', style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(6, 10) + 'px',
        color: pick(['rgba(48,200,120,0.6)', 'rgba(80,232,160,0.5)', 'rgba(255,255,255,0.4)']),
        textShadow: '0 0 4px currentColor',
        animation: `fxTwinkle ${rand(1, 2.5)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.4, 0.7)),
      }});
      return el;
    }, () => rand(420, 1050));
    return () => { sweep.remove(); sparkleCleanup(); };
  },

  // Prismatic (L64): rainbow light prisms
  prismatic: (container) => {
    injectStyles();
    const sweeps = [];
    for (let i = 0; i < 3; i++) {
      const sweep = document.createElement('div');
      const angle = 90 + i * 25;
      Object.assign(sweep.style, {
        position: 'absolute', inset: '-50%',
        background: `linear-gradient(${angle}deg, transparent 35%, rgba(255,68,68,0.03) 38%, rgba(255,204,0,0.03) 41%, rgba(68,255,102,0.03) 44%, rgba(68,170,255,0.03) 47%, rgba(136,68,255,0.03) 50%, transparent 53%)`,
        animation: `fxSweep ${5 + i * 2}s ease-in-out ${i * 1.5}s infinite`, pointerEvents: 'none', zIndex: '0',
      });
      container.appendChild(sweep);
      sweeps.push(sweep);
    }
    const sparkleCleanup = particleLoop(container, (c) => {
      const colors = ['rgba(255,68,68,0.5)', 'rgba(255,204,0,0.5)', 'rgba(68,255,102,0.5)', 'rgba(68,170,255,0.5)', 'rgba(136,68,255,0.5)'];
      const el = spawn(c, { text: '\u2726', style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(5, 9) + 'px',
        color: pick(colors), textShadow: '0 0 4px currentColor',
        animation: `fxTwinkle ${rand(0.6, 1.5)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.4, 0.7)),
      }});
      return el;
    }, () => rand(280, 700));
    return () => { sweeps.forEach(s => s.remove()); sparkleCleanup(); };
  },

  // Slate (L67): falling rain streaks
  slate: (container) => {
    injectStyles();
    // Rain streaks
    return particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const el = spawn(c, { style: {
        left: rand(2, 98) + '%', top: '0px', width: '1.5px', height: rand(12, 28) + 'px',
        background: 'linear-gradient(180deg, transparent, rgba(140,170,200,0.45), transparent)',
        animation: `fxFall ${rand(0.6, 1.2)}s linear forwards`,
        '--fx-x0': '0px', '--fx-y0': '-10px',
        '--fx-x1': rand(-3, 3) + 'px', '--fx-y1': (boardH * 0.5) + 'px',
        '--fx-x2': rand(-5, 5) + 'px', '--fx-y2': (boardH + 10) + 'px',
        '--fx-r0': '0deg', '--fx-r1': '0deg', '--fx-r2': '0deg',
        '--fx-opacity': '0.5', '--fx-opacity-end': '0.1', '--fx-s': '1',
      }});
      return el;
    }, () => rand(60, 200));
  },

  // Void (L70): sparks in absolute darkness
  void: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const el = spawn(c, { text: pick(['\u00B7', '\u22C5']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(6, 12) + 'px',
        color: 'rgba(255,255,255,0.6)', textShadow: '0 0 3px rgba(255,255,255,0.3)',
        animation: `fxTwinkle ${rand(0.3, 0.8)}s ease-in-out forwards`, '--fx-opacity': '0.7',
      }});
      return el;
    }, () => rand(1400, 4200));
  },

  // Arctic (L73): drifting snow
  arctic: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\u2744', '\u2745', '\u2726', '\u00B7'],
        color: 'rgba(60,120,180,0.7)',
        sizeMin: 8, sizeMax: 16, durationMin: 6, durationMax: 11,
        opacity: 0.6, opacityEnd: 0.12, scaleMin: 0.5, scaleMax: 1,
      });
    }, () => rand(500, 1600));
  },

  // Deep Space (L76): distant stars + slow nebula
  deepspace: (container) => {
    injectStyles();
    const stars = [];
    for (let i = 0; i < 20; i++) {
      const star = spawn(container, { text: '\u00B7', style: {
        left: rand(2, 98) + '%', top: rand(2, 98) + '%', fontSize: rand(4, 8) + 'px',
        color: pick(['rgba(200,192,232,0.5)', 'rgba(96,144,255,0.4)', 'rgba(160,112,216,0.3)']),
        animation: `fxTwinkle ${rand(2, 6)}s ease-in-out ${rand(0, 4)}s infinite`,
        '--fx-opacity': String(rand(0.2, 0.6)),
      }});
      stars.push(star);
    }
    ambientGlow(container, { blur: 25, style: {
      background: 'radial-gradient(ellipse 35% 40% at 30% 35%, rgba(96,144,255,0.04) 0%, transparent 50%), radial-gradient(ellipse 30% 35% at 70% 65%, rgba(160,112,216,0.04) 0%, transparent 50%)',
      animation: 'fxDrift 16s ease-in-out infinite alternate', '--fx-x0': '-5%', '--fx-x2': '5%',
    }});
    return () => stars.forEach(s => s.remove());
  },

  // Jungle (L78): fireflies + falling leaves
  jungle: (container) => {
    injectStyles();
    const fireflyCleanup = particleLoop(container, (c) => {
      const size = rand(2, 4);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(10, 90) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(200,255,50,0.5)',
        boxShadow: '0 0 6px rgba(200,255,50,0.4), 0 0 12px rgba(200,255,50,0.15)',
        animation: `fxFloat ${rand(3, 6)}s ease-in-out forwards, fxTwinkle ${rand(3, 6)}s ease-in-out forwards`,
        '--fx-float-y': rand(-15, -30) + 'px', '--fx-opacity': String(rand(0.4, 0.7)),
      }});
      return el;
    }, () => rand(700, 2100));
    const leafCleanup = particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83C\uDF43', '\uD83C\uDF3F'],
        sizeMin: 12, sizeMax: 18, durationMin: 6, durationMax: 11,
        opacity: 0.55, opacityEnd: 0.12,
      });
    }, () => rand(1400, 3500));
    return () => { fireflyCleanup(); leafCleanup(); };
  },

  // Obsidian (L80): sharp light reflections on glass
  obsidian: (container) => {
    injectStyles();
    const sweep = document.createElement('div');
    Object.assign(sweep.style, {
      position: 'absolute', inset: '-50%',
      background: 'linear-gradient(120deg, transparent 42%, rgba(255,255,255,0.06) 46%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.06) 54%, transparent 58%)',
      animation: 'fxSweep 8s ease-in-out infinite', pointerEvents: 'none', zIndex: '0',
    });
    container.appendChild(sweep);
    const sparkCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: pick(['\u00B7', '\u2726']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(5, 9) + 'px',
        color: 'rgba(255,255,255,0.7)', textShadow: '0 0 3px rgba(255,255,255,0.3)',
        animation: `fxTwinkle ${rand(0.2, 0.6)}s ease-in-out forwards`, '--fx-opacity': '0.7',
      }});
      return el;
    }, () => rand(1000, 3000));
    return () => { sweep.remove(); sparkCleanup(); };
  },

  // Phantom (L83): ghostly wisps
  phantom: (container) => {
    injectStyles();
    // Ghostly orbs that drift and pulse
    return particleLoop(container, (c) => {
      const size = rand(20, 45);
      const el = spawn(c, { style: {
        left: rand(10, 80) + '%', top: rand(20, 70) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(88,168,184,0.18) 0%, rgba(64,200,184,0.06) 40%, transparent 70%)',
        boxShadow: '0 0 12px rgba(88,168,184,0.1)',
        animation: `fxTwinkle ${rand(3, 5)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.5, 0.8)),
      }});
      return el;
    }, () => rand(700, 1800));
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

  // Solar (L88): sun rays + warm sparkles
  solar: (container) => {
    injectStyles();
    // Warm sun glow from top
    ambientGlow(container, { blur: 18, style: {
      background: 'radial-gradient(circle at 50% 10%, rgba(232,180,40,0.15) 0%, rgba(255,200,80,0.05) 40%, transparent 60%)',
      animation: 'fxFloat 5s ease-in-out infinite', '--fx-float-y': '4px',
    }});
    // Two diagonal light rays sweeping across
    const rays = [];
    for (let i = 0; i < 2; i++) {
      const ray = document.createElement('div');
      const angle = 100 + i * 40;
      Object.assign(ray.style, {
        position: 'absolute', inset: '-50%',
        background: `linear-gradient(${angle}deg, transparent 38%, rgba(255,220,100,0.12) 43%, rgba(255,200,60,0.08) 50%, transparent 55%)`,
        animation: `fxSweep ${7 + i * 4}s ease-in-out ${i * 2}s infinite`, pointerEvents: 'none', zIndex: '0',
      });
      container.appendChild(ray);
      rays.push(ray);
    }
    // Warm sparkles — sun motes
    const sparkleCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: pick(['\u00B7', '\u2726']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(7, 12) + 'px',
        color: pick(['rgba(232,180,40,0.7)', 'rgba(255,200,80,0.6)', 'rgba(216,160,40,0.5)']),
        textShadow: '0 0 4px rgba(232,180,40,0.4)',
        animation: `fxTwinkle ${rand(1, 2.5)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.5, 0.7)),
      }});
      return el;
    }, () => rand(700, 2100));
    return () => { rays.forEach(r => r.remove()); sparkleCleanup(); };
  },

  // Blood Moon (L90): dripping red particles
  bloodmoon: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 25, style: {
      background: 'radial-gradient(circle at 70% 20%, rgba(200,30,30,0.15) 0%, transparent 40%)',
      animation: 'fxFloat 5s ease-in-out infinite', '--fx-float-y': '3px',
    }});
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\u00B7', '\u22C5', '\u2022'],
        color: 'rgba(200,40,40,0.7)',
        sizeMin: 5, sizeMax: 10, durationMin: 3, durationMax: 5,
        opacity: 0.6, opacityEnd: 0.12,
      });
    }, () => rand(500, 1400));
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

  // Celestial (L96): shooting stars + constellation dots
  celestial: (container) => {
    injectStyles();
    const stars = [];
    for (let i = 0; i < 12; i++) {
      const star = spawn(container, { text: pick(['\u2726', '\u22C6', '\u00B7']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(5, 9) + 'px',
        color: pick(['rgba(255,220,150,0.5)', 'rgba(200,200,255,0.4)', 'rgba(255,255,255,0.3)']),
        textShadow: '0 0 4px currentColor',
        animation: `fxTwinkle ${rand(2, 5)}s ease-in-out ${rand(0, 3)}s infinite`,
        '--fx-opacity': String(rand(0.3, 0.7)),
      }});
      stars.push(star);
    }
    const shootCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { style: {
        left: rand(5, 50) + '%', top: rand(5, 25) + '%',
        width: rand(25, 50) + 'px', height: '1px',
        background: 'linear-gradient(90deg, rgba(255,220,150,0.7), transparent)',
        transformOrigin: 'left center', transform: 'rotate(' + rand(15, 50) + 'deg)',
        animation: `fxSweep ${rand(0.5, 1)}s ease-out forwards`,
      }});
      return el;
    }, () => rand(1500, 4000));
    return () => { stars.forEach(s => s.remove()); shootCleanup(); };
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
      const el = spawn(c, { text: pick(['\u2726', '\u2B50', '\u2727']), style: {
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
};

export default THEME_EFFECTS;
