import { state } from '../state/gameState.js?v=0.9.1';
import { boardEl, shakeWrapper, particleCanvas } from './domHelpers.js?v=0.9.1';
import { revealAllMines } from '../logic/boardSolver.js?v=0.9.1';
import { updateAllCells } from './boardRenderer.js?v=0.9.1';

// ── Effects ────────────────────────────────────────────

export function triggerShake() {
  shakeWrapper.classList.add('shaking');
  setTimeout(() => shakeWrapper.classList.remove('shaking'), 450);
}

export function triggerHeavyShake() {
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

// Chain-reveal mines outward from hit point for dramatic effect
export function chainRevealMines(hitRow, hitCol) {
  revealAllMines(state.board);

  // Find all mine cells and sort by distance from hit
  const mineCells = [];
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (state.board[r][c].isMine) {
        const dist = Math.abs(r - hitRow) + Math.abs(c - hitCol);
        mineCells.push({ r, c, dist });
      }
    }
  }
  mineCells.sort((a, b) => a.dist - b.dist);

  // Reveal immediately — add staggered explosion animation
  updateAllCells();
  for (let i = 0; i < mineCells.length; i++) {
    const { r, c } = mineCells[i];
    const cellEl = boardEl.children[r * state.cols + c];
    if (cellEl) {
      cellEl.style.animationDelay = `${i * 50}ms`;
      cellEl.classList.add('mine-chain');
    }
  }
}

// ── Celebration Effects ─────────────────────────────────

export function showCelebration() {
  showGreenFlash();
  // Single lightweight confetti burst — 60 particles, simple shapes
  showConfettiBurst(0.5, 0.4, 60);
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
