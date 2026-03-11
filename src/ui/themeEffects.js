/**
 * Theme Effects Engine — spawns dynamic DOM particles and ambient visuals per theme.
 * Called by themeManager when theme changes. Each theme registers an effect function
 * that creates/manages its own visual elements inside the board container.
 */

let activeCleanup = null;
let effectContainer = null;

/** Remove all active effects and their DOM elements */
export function clearThemeEffects() {
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

  activeCleanup = effectFn(effectContainer, board);
}

// Utility helpers

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function spawn(container, opts = {}) {
  const el = document.createElement('div');
  el.className = 'fx-particle';
  Object.assign(el.style, {
    position: 'absolute',
    pointerEvents: 'none',
    willChange: 'transform, opacity',
    ...opts.style,
  });
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
    .theme-fx {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
      overflow: hidden;
    }
    .fx-particle { z-index: 2; }
    .fx-ambient { z-index: 0; }

    @keyframes fxFall {
      0% { transform: translate(var(--fx-x0, 0px), var(--fx-y0, -20px)) rotate(var(--fx-r0, 0deg)) scale(var(--fx-s, 1)); opacity: 0; }
      8% { opacity: var(--fx-opacity, 0.6); }
      50% { transform: translate(var(--fx-x1, 20px), var(--fx-y1, 50%)) rotate(var(--fx-r1, 180deg)) scale(var(--fx-s, 1)); opacity: var(--fx-opacity, 0.5); }
      85% { opacity: var(--fx-opacity-end, 0.15); }
      100% { transform: translate(var(--fx-x2, 40px), var(--fx-y2, 110%)) rotate(var(--fx-r2, 360deg)) scale(var(--fx-s, 1)); opacity: 0; }
    }

    @keyframes fxRise {
      0% { transform: translate(var(--fx-x0, 0px), var(--fx-y0, 0px)) scale(var(--fx-s, 1)); opacity: 0; }
      10% { opacity: var(--fx-opacity, 0.7); }
      50% { transform: translate(var(--fx-x1, 5px), var(--fx-y1, -40%)) scale(var(--fx-s, 1)); opacity: var(--fx-opacity, 0.5); }
      90% { opacity: var(--fx-opacity-end, 0.1); }
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
      '--fx-opacity-end': String(opts.opacityEnd || 0.12),
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
      '--fx-opacity-end': String(opts.opacityEnd || 0.1),
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
      const size = rand(2, 4);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(10, 90) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'rgba(150, 220, 255, 0.3)',
        animation: `fxFloat ${rand(3, 6)}s ease-in-out forwards, fxTwinkle ${rand(5, 8)}s ease-in-out forwards`,
        '--fx-float-y': rand(-8, -15) + 'px', '--fx-opacity': String(rand(0.2, 0.4)),
      }});
      return el;
    }, () => rand(2000, 5000));
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

  // Forest (L9): floating spores / pollen
  forest: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const size = rand(2, 4);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: pick(['rgba(180, 220, 80, 0.4)', 'rgba(255, 215, 0, 0.3)', 'rgba(200, 200, 100, 0.3)']),
        animation: `fxFloat ${rand(3, 6)}s ease-in-out forwards, fxTwinkle ${rand(4, 7)}s ease-in-out forwards`,
        '--fx-float-y': rand(-10, -20) + 'px', '--fx-opacity': String(rand(0.3, 0.5)),
      }});
      return el;
    }, () => rand(1500, 4000));
  },

  // Candy (L12): floating sprinkles + sparkle pops
  candy: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const candyChars = ['\u2726', '\u2022', '\u2666', '\u2605', '\u25CF'];
      const colors = ['rgba(255,64,129,0.5)', 'rgba(224,64,251,0.4)', 'rgba(124,77,255,0.4)', 'rgba(255,215,64,0.5)', 'rgba(105,240,174,0.4)'];
      const el = spawn(c, { text: pick(candyChars), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        fontSize: rand(6, 12) + 'px', color: pick(colors),
        animation: `fxTwinkle ${rand(1.5, 3)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.4, 0.7)),
      }});
      return el;
    }, () => rand(800, 2000));
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
    const scanLine = document.createElement('div');
    Object.assign(scanLine.style, {
      position: 'absolute', left: '0', width: '100%', height: '2px',
      background: 'linear-gradient(90deg, transparent 5%, rgba(136,136,136,0.15) 30%, rgba(136,136,136,0.25) 50%, rgba(136,136,136,0.15) 70%, transparent 95%)',
      boxShadow: '0 0 8px rgba(136,136,136,0.1), 0 -4px 16px rgba(136,136,136,0.03)',
      animation: 'fxScanDown 4s linear infinite', pointerEvents: 'none', zIndex: '1',
    });
    container.appendChild(scanLine);
    return () => scanLine.remove();
  },

  // Neon (L21): neon spark flickers
  neon: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const el = spawn(c, { text: pick(['\u00B7', '\u26A1', '\u2726']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        fontSize: rand(6, 10) + 'px',
        color: pick(['rgba(0,255,136,0.6)', 'rgba(0,204,255,0.5)', 'rgba(255,0,102,0.4)']),
        textShadow: '0 0 6px currentColor',
        animation: `fxTwinkle ${rand(0.3, 0.8)}s ease-in-out forwards`,
        '--fx-opacity': '0.7',
      }});
      return el;
    }, () => rand(1500, 4000));
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
    }, () => rand(1500, 3500));
  },

  // Aurora (L27): drifting colored light bands
  aurora: (container) => {
    injectStyles();
    const colors = ['rgba(0,229,160,0.06)', 'rgba(0,188,212,0.06)', 'rgba(179,136,255,0.05)', 'rgba(0,255,200,0.05)'];
    const bands = [];
    for (let i = 0; i < 3; i++) {
      const band = document.createElement('div');
      Object.assign(band.style, {
        position: 'absolute', top: rand(5, 40) + '%', left: '-20%', width: '140%', height: rand(20, 35) + '%',
        background: `linear-gradient(90deg, transparent, ${pick(colors)}, ${pick(colors)}, transparent)`,
        filter: 'blur(25px)', animation: `fxDrift ${rand(8, 14)}s ease-in-out infinite alternate`,
        '--fx-x0': rand(-20, -5) + '%', '--fx-x2': rand(5, 20) + '%',
        '--fx-opacity': String(rand(0.3, 0.7)), pointerEvents: 'none', zIndex: '0',
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
    }, () => rand(600, 1800));
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
    }, () => rand(2000, 5000));
    return () => { sweep.remove(); sparkleCleanup(); };
  },

  // Ice (L34): drifting snow
  ice: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\u2744', '\u00B7', '\u2745', '\u00B7'],
        sizeMin: 6, sizeMax: 14, durationMin: 6, durationMax: 12,
        opacity: 0.35, opacityEnd: 0.08, scaleMin: 0.6, scaleMax: 1,
      });
    }, () => rand(1000, 3000));
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
    }, () => rand(2000, 5000));
    const petalCleanup = particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83C\uDF38'], sizeMin: 10, sizeMax: 16,
        durationMin: 9, durationMax: 15, opacity: 0.35, opacityEnd: 0.08,
      });
    }, () => rand(2500, 5000));
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
    }, () => rand(2000, 6000));
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
    }, () => rand(400, 1200));
    return () => { glitchCleanup(); dropCleanup(); };
  },

  // Galaxy (L40): twinkling star field + shooting star
  galaxy: (container) => {
    injectStyles();
    const stars = [];
    for (let i = 0; i < 15; i++) {
      const star = spawn(container, { text: pick(['\u00B7', '\u2726', '\u22C6', '.']), style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(6, 11) + 'px',
        color: pick(['rgba(255,255,255,0.5)', 'rgba(234,128,252,0.4)', 'rgba(130,177,255,0.4)']),
        textShadow: '0 0 3px currentColor',
        animation: `fxTwinkle ${rand(2, 5)}s ease-in-out ${rand(0, 3)}s infinite`,
        '--fx-opacity': String(rand(0.3, 0.7)),
      }});
      stars.push(star);
    }
    ambientGlow(container, { blur: 20, style: {
      background: 'radial-gradient(ellipse 40% 40% at 30% 40%, rgba(208,80,255,0.05) 0%, transparent 50%), radial-gradient(ellipse 35% 35% at 70% 60%, rgba(130,177,255,0.04) 0%, transparent 50%)',
      animation: 'fxDrift 12s ease-in-out infinite alternate', '--fx-x0': '-5%', '--fx-x2': '5%',
    }});
    const shootCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { style: {
        left: rand(10, 60) + '%', top: rand(5, 30) + '%',
        width: rand(20, 40) + 'px', height: '1px',
        background: 'linear-gradient(90deg, rgba(255,255,255,0.6), transparent)',
        transformOrigin: 'left center', transform: 'rotate(' + rand(15, 45) + 'deg)',
        animation: `fxSweep ${rand(0.6, 1.2)}s ease-out forwards`,
      }});
      return el;
    }, () => rand(6000, 15000));
    return () => { stars.forEach(s => s.remove()); shootCleanup(); };
  },

  // Retro (L42): CRT scanlines + pixel dust
  retro: (container) => {
    injectStyles();
    const scanLine = document.createElement('div');
    Object.assign(scanLine.style, {
      position: 'absolute', left: '0', width: '100%', height: '3px',
      background: 'linear-gradient(90deg, transparent, rgba(255,51,136,0.08), rgba(68,204,255,0.06), transparent)',
      boxShadow: '0 0 12px rgba(255,51,136,0.04)',
      animation: 'fxScanDown 6s linear infinite', pointerEvents: 'none', zIndex: '1',
    });
    container.appendChild(scanLine);
    const dustCleanup = particleLoop(container, (c) => {
      const size = rand(2, 4);
      const el = spawn(c, { style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%',
        width: size + 'px', height: size + 'px',
        background: pick(['rgba(255,51,136,0.4)', 'rgba(68,204,255,0.35)', 'rgba(68,255,170,0.3)']),
        animation: `fxTwinkle ${rand(0.5, 1.5)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.3, 0.5)),
      }});
      return el;
    }, () => rand(1000, 3000));
    return () => { scanLine.remove(); dustCleanup(); };
  },

  // Lavender (L44): floating particles + dreamy mist
  lavender: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 22, style: {
      background: 'radial-gradient(ellipse 50% 40% at 40% 50%, rgba(168,120,216,0.05) 0%, transparent 55%), radial-gradient(ellipse 40% 50% at 70% 45%, rgba(140,100,200,0.04) 0%, transparent 50%)',
      animation: 'fxDrift 10s ease-in-out infinite alternate', '--fx-x0': '-4%', '--fx-x2': '4%',
    }});
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83E\uDEBB', '\u00B7', '\u273F'],
        sizeMin: 8, sizeMax: 14, durationMin: 10, durationMax: 16,
        opacity: 0.3, opacityEnd: 0.06,
      });
    }, () => rand(3000, 7000));
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
    }, () => rand(400, 1200));
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
    }, () => rand(800, 2000));
  },

  // Autumn (L52): falling leaves
  autumn: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83C\uDF42', '\uD83C\uDF41', '\uD83C\uDF43', '\uD83C\uDF42'],
        sizeMin: 12, sizeMax: 18, durationMin: 6, durationMax: 11,
        opacity: 0.45, opacityEnd: 0.1,
      });
    }, () => rand(1500, 3500));
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
    }, () => rand(800, 2000));
    return () => { sweep.remove(); sparkleCleanup(); };
  },

  // Coral (L58): underwater caustics + rising bubbles
  coral: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 15, style: {
      background: 'radial-gradient(ellipse 30% 25% at 35% 30%, rgba(240,160,136,0.06) 0%, transparent 50%), radial-gradient(ellipse 25% 30% at 65% 60%, rgba(96,200,176,0.05) 0%, transparent 50%)',
      animation: 'fxDrift 10s ease-in-out infinite alternate', '--fx-x0': '-5%', '--fx-x2': '5%',
    }});
    return particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const size = rand(3, 7);
      const el = spawn(c, { style: {
        left: rand(10, 90) + '%', bottom: '0%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        border: '1px solid rgba(240,160,136,0.25)', background: 'transparent',
        animation: `fxRise ${rand(5, 10)}s ease-out forwards`,
        '--fx-x0': '0px', '--fx-y0': '0px',
        '--fx-x1': rand(-10, 10) + 'px', '--fx-y1': -(boardH * 0.35) + 'px',
        '--fx-x2': rand(-8, 8) + 'px', '--fx-y2': -(boardH * 0.85) + 'px',
        '--fx-opacity': '0.4', '--fx-opacity-end': '0.08',
        '--fx-s': '1', '--fx-s-end': String(rand(1.2, 1.8)),
      }});
      return el;
    }, () => rand(1200, 3000));
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
    }, () => rand(600, 1500));
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
    }, () => rand(400, 1000));
    return () => { sweeps.forEach(s => s.remove()); sparkleCleanup(); };
  },

  // Slate (L67): falling rain streaks
  slate: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const el = spawn(c, { style: {
        left: rand(2, 98) + '%', top: '0px', width: '1px', height: rand(8, 20) + 'px',
        background: 'linear-gradient(180deg, transparent, rgba(120,150,180,0.2), transparent)',
        animation: `fxFall ${rand(0.8, 1.5)}s linear forwards`,
        '--fx-x0': '0px', '--fx-y0': '-10px',
        '--fx-x1': rand(-3, 3) + 'px', '--fx-y1': (boardH * 0.5) + 'px',
        '--fx-x2': rand(-5, 5) + 'px', '--fx-y2': (boardH + 10) + 'px',
        '--fx-r0': '0deg', '--fx-r1': '0deg', '--fx-r2': '0deg',
        '--fx-opacity': '0.3', '--fx-opacity-end': '0.05', '--fx-s': '1',
      }});
      return el;
    }, () => rand(100, 400));
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
    }, () => rand(2000, 6000));
  },

  // Arctic (L73): drifting snow
  arctic: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\u2744', '\u2745', '\u2726', '\u00B7'],
        sizeMin: 6, sizeMax: 14, durationMin: 7, durationMax: 13,
        opacity: 0.3, opacityEnd: 0.06, scaleMin: 0.5, scaleMax: 1,
      });
    }, () => rand(1200, 3500));
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
    }, () => rand(1000, 3000));
    const leafCleanup = particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\uD83C\uDF43', '\uD83C\uDF3F'],
        sizeMin: 10, sizeMax: 16, durationMin: 8, durationMax: 14,
        opacity: 0.3, opacityEnd: 0.06,
      });
    }, () => rand(5000, 12000));
    return () => { fireflyCleanup(); leafCleanup(); };
  },

  // Obsidian (L80): sharp light reflections on glass
  obsidian: (container) => {
    injectStyles();
    const sweep = document.createElement('div');
    Object.assign(sweep.style, {
      position: 'absolute', inset: '-50%',
      background: 'linear-gradient(120deg, transparent 45%, rgba(255,255,255,0.02) 48%, rgba(255,255,255,0.04) 50%, rgba(255,255,255,0.02) 52%, transparent 55%)',
      animation: 'fxSweep 10s ease-in-out infinite', pointerEvents: 'none', zIndex: '0',
    });
    container.appendChild(sweep);
    const sparkCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: '\u00B7', style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(4, 7) + 'px',
        color: 'rgba(255,255,255,0.5)',
        animation: `fxTwinkle ${rand(0.2, 0.5)}s ease-in-out forwards`, '--fx-opacity': '0.5',
      }});
      return el;
    }, () => rand(4000, 10000));
    return () => { sweep.remove(); sparkCleanup(); };
  },

  // Phantom (L83): ghostly wisps
  phantom: (container) => {
    injectStyles();
    return particleLoop(container, (c) => {
      const size = rand(20, 40);
      const el = spawn(c, { style: {
        left: rand(10, 80) + '%', top: rand(20, 70) + '%',
        width: size + 'px', height: size + 'px', borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(64,200,184,0.06) 0%, transparent 70%)',
        animation: `fxTwinkle ${rand(3, 6)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.3, 0.6)),
      }});
      return el;
    }, () => rand(1500, 4000));
  },

  // Matrix (L86): falling green characters
  matrix: (container) => {
    injectStyles();
    const matrixChars = '01\u30A2\u30A4\u30A6\u30A8\u30AA\u30AB\u30AD\u30AF\u30B1\u30B3\u30B5\u30B7\u30B9\u30BB\u30BD'.split('');
    return particleLoop(container, (c) => {
      const boardH = c.parentElement?.clientHeight || 500;
      const el = spawn(container, { text: pick(matrixChars), style: {
        left: rand(2, 98) + '%', top: '0px', fontFamily: 'monospace',
        fontSize: rand(10, 16) + 'px', color: 'rgba(0,255,65,0.6)',
        textShadow: '0 0 4px rgba(0,255,65,0.4)',
        animation: `fxFall ${rand(2, 5)}s linear forwards`,
        '--fx-x0': '0px', '--fx-y0': '-10px',
        '--fx-x1': '0px', '--fx-y1': (boardH * 0.5) + 'px',
        '--fx-x2': '0px', '--fx-y2': (boardH + 20) + 'px',
        '--fx-r0': '0deg', '--fx-r1': '0deg', '--fx-r2': '0deg',
        '--fx-opacity': '0.6', '--fx-opacity-end': '0.1', '--fx-s': '1',
      }});
      return el;
    }, () => rand(150, 500));
  },

  // Solar (L88): sun rays
  solar: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 18, style: {
      background: 'radial-gradient(circle at 50% 20%, rgba(232,200,80,0.08) 0%, transparent 50%)',
      animation: 'fxFloat 5s ease-in-out infinite', '--fx-float-y': '4px',
    }});
    const ray = document.createElement('div');
    Object.assign(ray.style, {
      position: 'absolute', inset: '0',
      background: 'linear-gradient(110deg, transparent 40%, rgba(255,240,180,0.06) 45%, rgba(255,230,140,0.04) 50%, transparent 55%)',
      animation: 'fxSweep 10s ease-in-out infinite', pointerEvents: 'none', zIndex: '0',
    });
    container.appendChild(ray);
    const sparkleCleanup = particleLoop(container, (c) => {
      const el = spawn(c, { text: '\u00B7', style: {
        left: rand(5, 95) + '%', top: rand(5, 95) + '%', fontSize: rand(6, 10) + 'px',
        color: 'rgba(232,200,80,0.5)', textShadow: '0 0 3px rgba(216,160,40,0.4)',
        animation: `fxTwinkle ${rand(1.5, 3)}s ease-in-out forwards`,
        '--fx-opacity': String(rand(0.3, 0.6)),
      }});
      return el;
    }, () => rand(1000, 3000));
    return () => { ray.remove(); sparkleCleanup(); };
  },

  // Blood Moon (L90): dripping red particles
  bloodmoon: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 25, style: {
      background: 'radial-gradient(circle at 70% 20%, rgba(200,30,30,0.06) 0%, transparent 40%)',
      animation: 'fxFloat 5s ease-in-out infinite', '--fx-float-y': '3px',
    }});
    return particleLoop(container, (c) => {
      return fallingParticle(c, {
        chars: ['\u00B7', '\u22C5', '\u2022'],
        sizeMin: 4, sizeMax: 8, durationMin: 3, durationMax: 6,
        opacity: 0.4, opacityEnd: 0.05,
      });
    }, () => rand(1000, 3000));
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
    }, () => rand(300, 900));
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
    }, () => rand(2000, 5000));
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
    }, () => rand(4000, 10000));
    return () => { stars.forEach(s => s.remove()); shootCleanup(); };
  },

  // Supernova (L98): explosive particles + heat waves
  supernova: (container) => {
    injectStyles();
    ambientGlow(container, { blur: 20, style: {
      background: 'radial-gradient(ellipse at 50% 100%, rgba(255,100,0,0.06) 0%, transparent 50%)',
      animation: 'fxFloat 3s ease-in-out infinite', '--fx-float-y': '4px',
    }});
    return particleLoop(container, (c) => {
      return risingParticle(c, {
        color: pick(['rgba(255,100,0,0.6)', 'rgba(255,200,0,0.5)', 'rgba(255,50,50,0.4)']),
        glow: '0 0 6px rgba(255,136,0,0.4)', sizeMin: 2, sizeMax: 5,
        durationMin: 2, durationMax: 5, opacity: 0.6, opacityEnd: 0.08, scaleEnd: 0.2,
      });
    }, () => rand(400, 1200));
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
    }, () => rand(300, 800));
    const emberCleanup = particleLoop(container, (c) => {
      return risingParticle(c, {
        color: pick(['rgba(255,80,20,0.7)', 'rgba(255,200,50,0.6)', 'rgba(255,140,0,0.5)']),
        glow: '0 0 8px rgba(255,100,0,0.5)', sizeMin: 2, sizeMax: 5,
        durationMin: 2, durationMax: 5, opacity: 0.7, opacityEnd: 0.1, scaleEnd: 0.2,
      });
    }, () => rand(500, 1500));
    return () => { sparkleCleanup(); emberCleanup(); };
  },
};

export default THEME_EFFECTS;
