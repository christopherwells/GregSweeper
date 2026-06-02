import { state } from '../state/gameState.js';
import { boardEl, shakeWrapper, particleCanvas } from './domHelpers.js';
import { revealAllMines } from '../logic/boardSolver.js';
import { updateAllCells, updateCell } from './boardRenderer.js';
import { playExplosion } from '../audio/sounds.js';

// ── Reduced Motion Detection ────────────────────────────
const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Effects ────────────────────────────────────────────

export function triggerShake() {
  if (prefersReducedMotion()) return;
  shakeWrapper.classList.add('shaking');
  setTimeout(() => shakeWrapper.classList.remove('shaking'), 450);
}

export function triggerHeavyShake() {
  if (prefersReducedMotion()) return;
  shakeWrapper.classList.add('heavy-shaking');
  setTimeout(() => shakeWrapper.classList.remove('heavy-shaking'), 700);
}

export function haptic(pattern) {
  if (navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

export function showRedFlash() {
  const flash = document.createElement('div');
  flash.className = 'red-flash';
  document.getElementById('app').appendChild(flash);
  setTimeout(() => flash.remove(), 600);
}

export function showGreenFlash() {
  const flash = document.createElement('div');
  flash.className = 'green-flash';
  document.getElementById('app').appendChild(flash);
  setTimeout(() => flash.remove(), 500);
}

// Chain-detonation cascade radiating outward from the hit point. Each
// non-flagged mine pops in turn, swaps from mine.png to strike.png via
// cell.isStrike, and triggers an explosion sound every 3rd mine. The
// initial blast from handleLoss covers i=0; cascade sounds start at i=3.
// Correctly-flagged mines stay revealed but are NOT in the cascade —
// they keep mine.png + their green outline.
const CASCADE_STEP_MS = 120;
const CASCADE_SOUND_AT = 3;
// 1 s breathing room after the last bomb pops before the gameover
// modal slides in. Was 300 ms — too tight; the player barely registered
// the last explosion before the modal covered everything.
const CASCADE_SETTLE_MS = 1000;

export function chainRevealMines(hitRow, hitCol) {
  revealAllMines(state.board);

  // Build cascade list = mines minus correctly-flagged ones, sorted by
  // Manhattan distance from blast. Hit mine is at distance 0 and pops
  // first as the trigger.
  const cascade = [];
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = state.board[r][c];
      if (cell.isMine && !cell.correctFlag) {
        cascade.push({ r, c, dist: Math.abs(r - hitRow) + Math.abs(c - hitCol) });
      }
    }
  }
  cascade.sort((a, b) => a.dist - b.dist);

  // First repaint reveals every mine as mine.png. The cascade then
  // swaps each non-flagged one to strike.png via per-mine updateCell.
  updateAllCells();

  // Themed detonation burst at the hit point (the per-theme explosion moment),
  // fired with the initial blast so it lands under the red flash + shake.
  showExplosionBurst(
    state.cols ? (hitCol + 0.5) / state.cols : 0.5,
    state.rows ? (hitRow + 0.5) / state.rows : 0.5,
    42,
  );

  // Reduced-motion preference suppresses the SCALE/POP keyframe but
  // does NOT collapse the staggered timing or the per-3rd-mine sounds —
  // the user reported "bombs aren't making multiple noises and the
  // modal comes up too soon," which is exactly what happens if the
  // entire cascade gets short-circuited under prefers-reduced-motion.
  // Sounds and modal-delay are not motion concerns, so they stay.
  const reducedMotion = prefersReducedMotion();

  for (let i = 0; i < cascade.length; i++) {
    const { r, c } = cascade[i];
    setTimeout(() => {
      const cell = state.board[r]?.[c];
      if (!cell) return;
      cell.isStrike = true;
      updateCell(r, c);
      if (!reducedMotion) {
        const cellEl = boardEl.children[r * state.cols + c];
        if (cellEl) {
          cellEl.style.animationDelay = '0ms';
          cellEl.classList.remove('mine-chain');
          // Force reflow so re-adding the class restarts the keyframe
          void cellEl.offsetWidth;
          cellEl.classList.add('mine-chain');
        }
      }
      // Sound every 3rd mine starting at i=3. i=0 (hit mine) is covered
      // by the initial playExplosion() in handleLoss, so we skip it.
      if (i > 0 && i % CASCADE_SOUND_AT === 0) {
        playExplosion();
      }
    }, i * CASCADE_STEP_MS);
  }

  // Promise resolves 1 s AFTER the last bomb fires — last bomb
  // pops at (cascade.length - 1) * CASCADE_STEP_MS, then we wait
  // CASCADE_SETTLE_MS before resolving. handleLoss awaits this before
  // showing the modal so the player sees the chain land before being
  // asked to Play Again.
  return new Promise(resolve => {
    const lastPopAt = Math.max(0, cascade.length - 1) * CASCADE_STEP_MS;
    setTimeout(resolve, lastPopAt + CASCADE_SETTLE_MS);
  });
}

// ── Celebration Effects ─────────────────────────────────

// Lightweight transition effect — used by the "Next Level" button on
// the gameover modal to acknowledge advancement without claiming the
// new level is won. Was the original showCelebration before the
// board-win VICTORY ceremony was bolted on top of it.
export function showCelebration() {
  showGreenFlash();
  if (prefersReducedMotion()) return;
  showConfettiBurst(0.5, 0.4, 60);
}

// Full "you beat the board" ceremony — VICTORY! overlay, triple
// confetti, green flash. Called by handleWin only. Kept separate from
// showCelebration so the next-level transition doesn't inherit the
// VICTORY text — it should only show when the player actually wins
// the board, not when they tap to advance.
export function showVictoryCelebration() {
  showGreenFlash();
  showVictoryOverlay();
  if (prefersReducedMotion()) return;
  showConfettiBurst(0.5, 0.3, 60);
  setTimeout(() => showConfettiBurst(0.3, 0.5, 35), 250);
  setTimeout(() => showConfettiBurst(0.7, 0.5, 35), 550);
}

// VICTORY! overlay — large gold text that bounces in over the board for
// ~700 ms then fades out. Built inline so the boot overlay's loading
// path doesn't need to know about it.
export function showVictoryOverlay() {
  const app = document.getElementById('app');
  if (!app) return;
  // Remove any stale overlay from a previous rapid win-loss-win cycle
  document.getElementById('victory-overlay')?.remove();
  const div = document.createElement('div');
  div.id = 'victory-overlay';
  div.className = 'victory-overlay';
  div.textContent = 'VICTORY!';
  div.setAttribute('aria-hidden', 'true');
  app.appendChild(div);
  setTimeout(() => div.remove(), 3600);
}

export function showConfettiBurst(originX, originY, count, opts = {}) {
  const canvas = particleCanvas;
  const ctx = canvas.getContext('2d');
  const rect = boardEl.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  canvas.classList.add('active');

  // Themed particle colors
  const themeColors = {
    classic: ['#ff4444', '#4488ff', '#44cc44', '#ffdd44', '#ff44ff', '#ffd700'],
    dark: ['#e94560', '#53a8ff', '#00d4aa', '#ffd93d', '#c084fc', '#ff6b6b'],
    // New concept worlds — win-confetti palettes drawn from each theme's own ink.
    editorial: ['#1a1a1a', '#c0392b', '#2c3e8f', '#b8a948', '#7a7266', '#3a3a3a'],
    sumie: ['#2a2a2a', '#b03020', '#6a6a6a', '#a0341f', '#3a3a3a', '#c44a32'],
    blueprint: ['#5ad0ff', '#a0e0ff', '#3a90c0', '#ffffff', '#1a5a8a', '#7ae0ff'],
    cartography: ['#8a5a2a', '#b03020', '#2a6a8a', '#c0a040', '#5a4020', '#d0b070'],
    origami: ['#d14a4a', '#4a8ac0', '#5aa05a', '#e0903a', '#9a6ac0', '#e08ab0'],
    chalkboard: ['#7ec0ee', '#9ae07a', '#ff9a8a', '#d8a0e8', '#ffe066', '#f0ebe0'],
    noir: ['#f2efe6', '#8a8a94', '#d6a44a', '#c43a3a', '#44444e', '#c4c4cc'],
    stainedglass: ['#2456c0', '#c41e2a', '#1d7a3a', '#6a2db0', '#e0b040', '#157a82'],
    apothecary: ['#c89030', '#b03818', '#4a7028', '#2a5a8a', '#a07810', '#6a3a8a'],
    splitflap: ['#e8c84a', '#5ab0e8', '#5ad07a', '#f0ece2', '#ff7a5a', '#c89af0'],
    circuitboard: ['#40f090', '#40b0f0', '#ff5a4a', '#f0d040', '#b87838', '#50e060'],
    comic: ['#e81c2a', '#1556d0', '#ffd23a', '#168a2e', '#7a1ec0', '#141414'],
    neon: ['#00ff88', '#ff0066', '#00ccff', '#ffff00', '#ff6600', '#cc44ff'],
    ocean: ['#64d2ff', '#5eead4', '#fbbf24', '#34d399', '#a78bfa', '#00e5ff'],
    sunset: ['#ff6b6b', '#ffa07a', '#ffc107', '#ff8a65', '#bb86fc', '#87d68d'],
    candy: ['#ff69b4', '#e040fb', '#7c4dff', '#ffd740', '#69f0ae', '#ff4081'],
    midnight: ['#cc88ff', '#7c4dff', '#80b0ff', '#ffd740', '#69f0ae', '#b388ff'],
    aurora: ['#00e5a0', '#00bcd4', '#b388ff', '#69f0ae', '#00e5ff', '#a7ffeb'],
    galaxy: ['#ea80fc', '#d050ff', '#82b1ff', '#ff80ab', '#b9f6ca', '#ce93d8'],
    forest: ['#4a8a3a', '#7ec87e', '#d4a843', '#c4a265', '#8bc34a', '#ffd700'],
    stealth: ['#707070', '#505050', '#909090', '#b0a060', '#888888', '#c0c0c0'],
    'cherry-blossom': ['#ff91a4', '#ffb6c1', '#f8c8dc', '#f48fb1', '#ce93d8', '#a8e6cf'],
    volcano: ['#ff6622', '#ff4420', '#ff9944', '#ffcc44', '#ff8830', '#ffd700'],
    ice: ['#b3e5fc', '#e1f5fe', '#80deea', '#b2ebf2', '#e0f7fa', '#ffffff'],
    cyberpunk: ['#ff0080', '#00ffff', '#ffcc00', '#aa44ff', '#ff4444', '#00ff88'],
    retro: ['#e6a23c', '#33cc66', '#ff4444', '#4488ff', '#ffd700', '#cc8844'],
    holographic: ['#ff9ff3', '#48dbfb', '#c8d6e5', '#a29bfe', '#55efc4', '#fd79a8'],
    toxic: ['#76ff03', '#ffea00', '#ff6d00', '#aa00ff', '#00e676', '#eeff41'],
    royal: ['#ffd700', '#4a0080', '#cc1133', '#fffff0', '#e6b800', '#800080'],
    prismatic: ['#ff0000', '#ff8800', '#ffff00', '#00cc00', '#0066ff', '#8800ff'],
    void: ['#4a0066', '#1a0033', '#808080', '#cccccc', '#660099', '#330066'],
    arctic: ['#e0f0ff', '#80d0ff', '#a8e0ff', '#c0c0c0', '#b8d8f0', '#ffffff'],
    jungle: ['#33aa33', '#cc4422', '#9933cc', '#ffcc00', '#88cc22', '#44bb44'],
    obsidian: ['#c0c0c0', '#808080', '#b8860b', '#a9a9a9', '#d3d3d3', '#ffd700'],
    matrix: ['#00ff00', '#33cc33', '#66ff66', '#00cc00', '#99ff99', '#00ff88'],
    inferno: ['#ff6600', '#cc0000', '#ffcc00', '#ff4400', '#ff8800', '#ffd700'],
    celestial: ['#ffd700', '#1a1a4e', '#e0e0ff', '#4488ff', '#ffec80', '#6666cc'],
    bloodmoon: ['#8b0000', '#cc0000', '#660000', '#990000', '#4a0000', '#ff2222'],
    synthwave: ['#ff0080', '#00ffff', '#8800ff', '#ff6600', '#ff44aa', '#00ccff'],
    supernova: ['#ffffff', '#4488ff', '#ff8800', '#aa44ff', '#ffd700', '#ff4444'],
    legendary: ['#ffd700', '#cc0000', '#8800aa', '#c0c0c0', '#ffec80', '#800080'],
  };
  const colors = themeColors[state.theme] || themeColors.classic;

  const particles = [];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (opts.speedBase ?? 3) + Math.random() * (opts.speedVar ?? 8);
    particles.push({
      x: canvas.width * originX + (Math.random() - 0.5) * (opts.spread ?? 20),
      y: canvas.height * originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - (opts.upwardBias ?? 3),
      gravity: (opts.gravityBase ?? 0.12) + Math.random() * 0.05,
      life: 1,
      decay: (opts.decayBase ?? 0.008) + Math.random() * 0.008,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 3 + Math.random() * 5,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.2,
      isCircle: Math.random() > 0.5,
    });
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.life -= p.decay;
      p.rotation += p.rotationSpeed;

      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);

      if (p.isCircle) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      }

      ctx.restore();
    }

    ctx.globalAlpha = 1;
    if (alive) {
      requestAnimationFrame(animate);
    } else {
      canvas.classList.remove('active');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(animate);
}

// One-shot themed detonation burst at a board cell — the "explosion moment" on
// a mine hit. Same particle engine as the confetti, retuned to blast OUTWARD
// (no upward loft), fly faster, and decay quicker so it reads as a detonation
// rather than a celebration. Colors come from the same per-theme palette, so
// forest throws bark-and-leaf debris, inferno throws embers, comic throws
// primary POW shards, etc.
export function showExplosionBurst(originX, originY, count = 36) {
  if (prefersReducedMotion()) return;
  showConfettiBurst(originX, originY, count, {
    upwardBias: 0,     // radial, not lofted
    speedBase: 4,
    speedVar: 9,
    gravityBase: 0.05, // light — debris flies out and fades in place
    decayBase: 0.014,  // quick — a blast, not a slow drift down
    spread: 10,
  });
}
