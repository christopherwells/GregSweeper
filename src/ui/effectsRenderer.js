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
const CASCADE_SETTLE_MS = 300;

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

  // Reduced motion: collapse the cascade to instant. Set isStrike on
  // every non-flagged mine synchronously, one render, no per-mine
  // sounds, resolve the promise right away.
  if (prefersReducedMotion()) {
    for (const { r, c } of cascade) state.board[r][c].isStrike = true;
    updateAllCells();
    return Promise.resolve();
  }

  // First repaint reveals every mine as mine.png. The cascade then swaps
  // each non-flagged one to strike.png via per-mine updateCell calls.
  updateAllCells();

  for (let i = 0; i < cascade.length; i++) {
    const { r, c } = cascade[i];
    setTimeout(() => {
      const cell = state.board[r]?.[c];
      if (!cell) return;
      cell.isStrike = true;
      updateCell(r, c);
      const cellEl = boardEl.children[r * state.cols + c];
      if (cellEl) {
        cellEl.style.animationDelay = '0ms';
        cellEl.classList.remove('mine-chain');
        // Force reflow so re-adding the class restarts the keyframe
        void cellEl.offsetWidth;
        cellEl.classList.add('mine-chain');
      }
      // Sound every 3rd mine starting at i=3. i=0 (hit mine) is covered
      // by the initial playExplosion() in handleLoss, so we skip it.
      if (i > 0 && i % CASCADE_SOUND_AT === 0) {
        playExplosion();
      }
    }, i * CASCADE_STEP_MS);
  }

  // Promise resolves after the last mine's pop animation has had a
  // moment to settle. handleLoss awaits this before showing the modal.
  return new Promise(resolve => {
    setTimeout(resolve, cascade.length * CASCADE_STEP_MS + CASCADE_SETTLE_MS);
  });
}

// ── Celebration Effects ─────────────────────────────────

export function showCelebration() {
  showGreenFlash();
  showVictoryOverlay();
  if (prefersReducedMotion()) return;
  // Triple confetti burst staggered for that "you DID it" feeling. Was a
  // single 60-particle burst; promoted the time-record pattern (3 bursts
  // at 200/500/800 ms with cross-screen positions) up to every win.
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
  setTimeout(() => div.remove(), 900);
}

export function showConfettiBurst(originX, originY, count) {
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
    const speed = 3 + Math.random() * 8;
    particles.push({
      x: canvas.width * originX + (Math.random() - 0.5) * 20,
      y: canvas.height * originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      gravity: 0.12 + Math.random() * 0.05,
      life: 1,
      decay: 0.008 + Math.random() * 0.008,
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
