// Canvas share-card renderer (Wave D). Draws the win result as a square
// PNG using the REAL sprites (mine.png, the themed Greg, the modifier
// icons) and the active theme's colors, so the shared image looks like
// the world the player actually played. Emoji-free by construction —
// the whole reason this supersedes the plain-text share card.
//
// Split in two so the drawing is testable with mock data:
//   buildShareData(state) -> a plain spec (reads state + theme CSS vars)
//   renderShareCardImage(data) -> Promise<HTMLCanvasElement>
//   renderShareCardBlob(data)  -> Promise<Blob>  (PNG)

import { getThemeEmoji } from './boardRenderer.js';
import { getSpriteUrl, gimmickSpriteUrl } from './spriteLoader.js';
import { getGimmickDefs } from '../logic/gimmicks.js';

// Portrait card (2026-06-25 redesign). A tall card uses more of a phone's
// vertical screen and lets the board + text stack full-width instead of
// cramming side-by-side, so everything reads larger when shared. Laid out
// on a 1080x1440 (3:4) grid, EXPORTED at 540 wide — the width a phone chat
// shows at full size (a real-phone test found wider images overflow the
// bubble); the height follows the ratio.
const LAYOUT_W = 1080;
const LAYOUT_H = 1440;
const OUTPUT_W = 540;
const OUTPUT_H = 720;
const MONTHS =['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function buildShareData(state) {
  const cs = getComputedStyle(document.documentElement);
  const cv = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const mode = state.gameMode;
  const modeLabel = { normal: 'CHALLENGE', timed: 'QUICK PLAY', daily: 'DAILY', weekly: 'WEEKLY', chaos: 'CHAOS' }[mode] || 'GAME';

  let dateLabel = '';
  const dateSeed = mode === 'weekly' ? state.weeklySeed : state.dailySeed;
  if ((mode === 'daily' || mode === 'weekly') && dateSeed) {
    const [, m, day] = String(dateSeed).split('-').map(Number);
    if (m) dateLabel = `${MONTHS[m - 1]} ${day}`;
  }

  const time = Number(state.elapsedTime) || 0;
  const par = mode === 'daily' ? (state.dailyPar || 0) : (mode === 'timed' ? (state.timedPar || 0) : 0);
  let resultText = null, resultGood = true;
  if (par > 0) {
    const delta = +(time - par).toFixed(1);
    resultGood = delta <= 0;
    resultText = resultGood
      ? `beat Greg by ${Math.abs(delta).toFixed(1)}s`
      : `Greg won by ${Math.abs(delta).toFixed(1)}s`;
  }

  const defs = getGimmickDefs();
  const modifiers = (state.activeGimmicks || [])
    .map((k) => (defs[k] ? { name: defs[k].name, url: gimmickSpriteUrl(k) } : null))
    .filter(Boolean);

  return {
    theme: document.documentElement.getAttribute('data-theme') || 'classic',
    modeLabel,
    dateLabel,
    rows: state.rows,
    cols: state.cols,
    totalMines: state.totalMines,
    revealedCount: state.revealedCount,
    timeText: `${time.toFixed(1)}s`,
    resultText,
    resultGood,
    gregUrl: getSpriteUrl('smileyWin', getThemeEmoji('smileyWin')) || 'assets/sprites/win.png',
    mineUrl: 'assets/sprites/mine.png',
    modifiers,
    certified: !!state.boardCertificate,
    bombHits: state.dailyBombHits || 0,
    colors: {
      bg: cv('--color-bg', '#e8e4da'),
      cellRevealed: cv('--color-cell-revealed', '#d6cdb9'),
      cellHidden: cv('--color-cell-hidden', '#aeb6c6'),
      text: cv('--color-text', '#2c2c2c'),
      textDim: cv('--color-text-secondary', '#9a917e'),
    },
  };
}

function scrambleCells(rows, cols, mines, revealed) {
  const total = rows * cols;
  const safeRevealed = Math.max(0, Math.min(revealed, total - mines));
  const cells = [];
  for (let i = 0; i < mines; i++) cells.push('mine');
  for (let i = 0; i < safeRevealed; i++) cells.push('revealed');
  while (cells.length < total) cells.push('hidden');
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, total);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function withAlpha(hex, a) {
  const h = (hex || '').trim();
  if (h[0] === '#' && h.length >= 7) {
    const r = parseInt(h.slice(1, 3), 16), gg = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    return `rgba(${r},${gg},${b},${a})`;
  }
  return h;
}

// ── Contrast-derived palette helpers ──────────────────────
// The shared card must stay legible across all 26 themes, including dark
// worlds where the theme's own secondary text and cell colors nearly vanish.
// Rather than trust those, we DERIVE the card's dim text and board panel from
// the theme's text+bg (which always contrast each other), and brighten the
// brand/accent colors on dark backgrounds.
function _rgb(h) {
  h = (h || '').trim();
  if (h[0] === '#' && h.length >= 7) return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  return [128, 128, 128];
}
function _hex(r, g, b) {
  const c = (v) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);
  return '#' + c(r) + c(g) + c(b);
}
// Blend hex `a` toward hex `b` by t in [0,1].
function mix(a, b, t) {
  const A = _rgb(a), B = _rgb(b);
  return _hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
// WCAG relative luminance (0 black .. 1 white).
function lum(h) {
  const [r, g, b] = _rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Pull a color toward its own gray by `amt`. The board panel is derived from
// the theme's text color, which keeps the grout the right lightness to
// contrast the cells; desaturating it stops a neon-text world (matrix) from
// painting a glaring neon grout, without touching the near-neutral text most
// themes use.
function desat(hex, amt) {
  const [r, g, b] = _rgb(hex);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return mix(hex, _hex(y, y, y), amt);
}

// Letter-spaced, centered caps line (canvas has no letter-spacing).
function drawSpaced(g, text, cx, y, spacing) {
  const chars = [...text];
  const widths = chars.map((ch) => g.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - spacing;
  const prev = g.textAlign;
  g.textAlign = 'left';
  let x = cx - total / 2;
  chars.forEach((ch, i) => { g.fillText(ch, x, y); x += widths[i]; });
  g.textAlign = prev;
}

// ── Theme background evocation (option B) ─────────────────
// Each effect-bearing world gets a soft color wash + a scatter of its
// signature static particles, so the shared card feels like the theme the
// player played — a still echo of src/ui/themeEffects.js, drawn on canvas.
// Particles sit behind the board + text (the opaque board covers the center,
// so they read in the margins). Classic / dark register nothing — bare by
// design, like their live boards.
const _rn = (a, b) => a + Math.random() * (b - a);
const _pk = (a) => a[Math.floor(Math.random() * a.length)];
function fxGlow(g, x, y, r, rgba) {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  grd.addColorStop(0, rgba);
  grd.addColorStop(1, rgba.replace(/[\d.]+\s*\)\s*$/, '0)'));
  g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
}
function fxDot(g, x, y, s, rgba, glow) {
  if (glow) { g.shadowColor = rgba; g.shadowBlur = glow; }
  g.fillStyle = rgba; g.beginPath(); g.arc(x, y, s, 0, 7); g.fill();
  g.shadowBlur = 0;
}
function fxEllipse(g, x, y, w, h, rgba, rot) {
  g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = rgba;
  g.beginPath(); g.ellipse(0, 0, w, h, 0, 0, 7); g.fill(); g.restore();
}
function fxTri(g, x, y, s, rgba, rot) {
  g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = rgba;
  g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.9, s * 0.7); g.lineTo(-s * 0.9, s * 0.7); g.closePath(); g.fill(); g.restore();
}
function fxDiamond(g, x, y, s, rgba) {
  g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.fillStyle = rgba;
  g.shadowColor = rgba; g.shadowBlur = s; g.fillRect(-s / 2, -s / 2, s, s); g.shadowBlur = 0; g.restore();
}
function fxCapsule(g, x, y, w, rgba, rot) {
  g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = rgba;
  roundRect(g, -w / 2, -w * 0.19, w, w * 0.38, w * 0.19); g.fill(); g.restore();
}
function fxStar(g, x, y, s, rgba) {
  g.save(); g.translate(x, y); g.fillStyle = rgba; g.shadowColor = rgba; g.shadowBlur = s * 1.5;
  g.beginPath();
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, r = i % 2 ? s * 0.34 : s; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fill(); g.shadowBlur = 0; g.restore();
}
function fxRing(g, x, y, s, rgba, lw) {
  g.strokeStyle = rgba; g.lineWidth = lw || 2; g.beginPath(); g.arc(x, y, s, 0, 7); g.stroke();
}
function fxHLine(g, x, y, w, rgba) {
  const grd = g.createLinearGradient(x, y, x + w, y);
  grd.addColorStop(0, rgba.replace(/[\d.]+\s*\)\s*$/, '0)')); grd.addColorStop(0.5, rgba); grd.addColorStop(1, rgba.replace(/[\d.]+\s*\)\s*$/, '0)'));
  g.strokeStyle = grd; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.stroke();
}
function fxCross(g, x, y, s, rgba) {
  g.strokeStyle = rgba; g.lineWidth = 2; g.beginPath();
  g.moveTo(x - s, y); g.lineTo(x + s, y); g.moveTo(x, y - s); g.lineTo(x, y + s); g.stroke();
}
function fxDash(g, x, y, w, rgba, rot) {
  g.save(); g.translate(x, y); g.rotate(rot); g.strokeStyle = rgba; g.lineWidth = 2.5; g.setLineDash([8, 7]);
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, 0); g.stroke(); g.setLineDash([]); g.restore();
}
function fxText(g, x, y, font, rgba, text) {
  g.font = font; g.fillStyle = rgba; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(text, x, y);
}
function fxScatter(g, W, H, n, fn) { for (let i = 0; i < n; i++) fn(_rn(40, W - 40), _rn(40, H - 40), i); }

const SHARE_FX = {
  forest: (g, W, H) => {
    fxGlow(g, W * 0.2, H * 0.2, 360, 'rgba(120,190,80,0.10)'); fxGlow(g, W * 0.82, H * 0.7, 320, 'rgba(95,165,75,0.08)');
    fxScatter(g, W, H, 16, (x, y) => fxEllipse(g, x, y, _rn(8, 14), _rn(5, 8), `rgba(${_pk(['120,165,75', '150,120,46', '170,104,40'])},0.8)`, _rn(0, 6)));
    fxScatter(g, W, H, 8, (x, y) => fxDot(g, x, y, _rn(2, 4), 'rgba(216,255,130,0.85)', 10));
  },
  galaxy: (g, W, H) => {
    fxGlow(g, W * 0.3, H * 0.35, 380, 'rgba(208,80,255,0.10)'); fxGlow(g, W * 0.72, H * 0.62, 340, 'rgba(130,177,255,0.09)');
    fxScatter(g, W, H, 46, (x, y) => fxDot(g, x, y, _rn(1.2, 3), _pk(['rgba(255,255,255,0.85)', 'rgba(234,128,252,0.7)', 'rgba(130,177,255,0.7)']), 6));
    fxScatter(g, W, H, 4, (x, y) => fxStar(g, x, y, _rn(7, 12), 'rgba(255,255,255,0.85)'));
  },
  aurora: (g, W, H) => {
    for (let i = 0; i < 3; i++) { g.fillStyle = _pk(['rgba(0,229,160,0.10)', 'rgba(0,188,212,0.10)', 'rgba(179,136,255,0.09)']); g.fillRect(0, H * (0.12 + i * 0.16), W, H * 0.1); }
    fxScatter(g, W, H, 24, (x, y) => fxDot(g, x, y, _rn(1, 2.4), 'rgba(180,255,230,0.6)', 5));
  },
  sakura: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 0.3, 420, 'rgba(232,112,144,0.08)');
    fxScatter(g, W, H, 16, (x, y) => fxEllipse(g, x, y, _rn(7, 12), _rn(5, 8), `rgba(${_pk(['244,170,190', '240,150,176', '250,190,205'])},0.78)`, _rn(0, 6)));
  },
  ocean: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 0.85, 480, 'rgba(120,200,235,0.09)');
    fxScatter(g, W, H, 20, (x, y) => { fxRing(g, x, y, _rn(4, 9), 'rgba(190,235,255,0.55)', 1.5); fxDot(g, x - 1, y - 1, 1.5, 'rgba(235,250,255,0.7)'); });
  },
  inferno: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 1.02, 560, 'rgba(255,70,0,0.12)'); fxGlow(g, W * 0.5, H * 0.98, 360, 'rgba(255,160,0,0.08)');
    fxScatter(g, W, H, 22, (x, y) => fxDot(g, x, _rn(H * 0.45, H), _rn(1.5, 4), _pk(['rgba(255,80,0,0.7)', 'rgba(255,180,0,0.6)', 'rgba(255,120,0,0.55)']), 8));
  },
  legendary: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 0.4, 420, 'rgba(255,200,40,0.08)');
    fxScatter(g, W, H, 14, (x, y) => fxStar(g, x, y, _rn(5, 10), _pk(['rgba(255,215,0,0.75)', 'rgba(255,240,150,0.6)'])));
    fxScatter(g, W, H, 12, (x, y) => fxDot(g, x, _rn(H * 0.4, H), _rn(1.5, 3.5), 'rgba(255,140,0,0.6)', 7));
  },
  supernova: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 0.5, 460, 'rgba(255,120,20,0.10)');
    fxScatter(g, W, H, 8, (x, y) => fxRing(g, x, y, _rn(10, 26), 'rgba(255,180,50,0.5)', 2));
    fxScatter(g, W, H, 16, (x, y) => fxStar(g, x, y, _rn(4, 8), _pk(['rgba(255,200,60,0.8)', 'rgba(255,255,180,0.6)'])));
  },
  matrix: (g, W, H) => {
    fxScatter(g, W, H, 14, (x, y) => fxText(g, x, _rn(20, H - 120), '600 15px monospace', 'rgba(140,255,165,0.5)', Array.from({ length: Math.floor(_rn(4, 9)) }, () => _pk(['0', '1'])).join('\n')));
  },
  neon: (g, W, H) => {
    fxScatter(g, W, H, 26, (x, y) => fxStar(g, x, y, _rn(3, 7), _pk(['rgba(0,255,136,0.8)', 'rgba(0,221,255,0.7)', 'rgba(255,0,110,0.6)'])));
  },
  synthwave: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 1.0, 520, 'rgba(255,0,200,0.08)'); fxGlow(g, W * 0.5, H * 1.0, 380, 'rgba(0,200,255,0.05)');
    for (let i = 0; i < 5; i++) fxHLine(g, 60, H * (0.2 + i * 0.16), W - 120, _pk(['rgba(255,0,200,0.35)', 'rgba(0,200,255,0.35)']));
  },
  candy: (g, W, H) => {
    fxScatter(g, W, H, 22, (x, y) => fxCapsule(g, x, y, _rn(10, 18), `rgba(${_pk(['255,64,129', '224,64,251', '124,77,255', '255,170,40', '64,210,140', '80,170,255'])},0.8)`, _rn(0, 6)));
  },
  circuitboard: (g, W, H) => {
    fxScatter(g, W, H, 20, (x, y) => fxDot(g, x, y, _rn(2, 4), _pk(['rgba(64,240,144,0.85)', 'rgba(64,200,240,0.8)', 'rgba(240,80,60,0.75)', 'rgba(240,200,64,0.8)']), 7));
    fxScatter(g, W, H, 5, (x, y) => fxHLine(g, x, y, _rn(40, 90), 'rgba(64,255,150,0.5)'));
  },
  stainedglass: (g, W, H) => {
    fxGlow(g, W * 0.26, H * 0.3, 300, 'rgba(120,60,200,0.10)'); fxGlow(g, W * 0.74, H * 0.6, 300, 'rgba(200,50,70,0.09)');
    fxScatter(g, W, H, 18, (x, y) => fxDiamond(g, x, y, _rn(5, 10), _pk(['rgba(180,80,240,0.7)', 'rgba(240,80,110,0.7)', 'rgba(80,160,240,0.65)', 'rgba(240,200,80,0.7)'])));
  },
  apothecary: (g, W, H) => {
    fxGlow(g, W * 0.8, H * 0.16, 360, 'rgba(255,190,90,0.14)');
    fxScatter(g, W, H, 16, (x, y) => fxDot(g, x, y, _rn(2, 4), 'rgba(232,190,110,0.5)', 6));
  },
  splitflap: (g, W, H) => {
    fxScatter(g, W, H, 16, (x, y) => { g.fillStyle = 'rgba(36,36,44,0.85)'; roundRect(g, x, y, 16, 20, 3); g.fill(); g.fillStyle = 'rgba(66,66,78,0.85)'; roundRect(g, x, y, 16, 9, 3); g.fill(); });
  },
  blueprint: (g, W, H) => {
    fxScatter(g, W, H, 22, (x, y) => fxCross(g, x, y, _rn(4, 8), `rgba(${_pk(['90,208,255', '160,224,255'])},0.7)`));
  },
  cartography: (g, W, H) => {
    fxScatter(g, W, H, 7, (x, y) => fxDash(g, x, y, _rn(55, 105), 'rgba(106,74,38,0.5)', _rn(-0.4, 0.4)));
    fxScatter(g, W, H, 10, (x, y) => fxRing(g, x, y, _rn(4, 8), 'rgba(106,74,38,0.5)', 1.5));
  },
  origami: (g, W, H) => {
    fxScatter(g, W, H, 16, (x, y) => fxTri(g, x, y, _rn(7, 13), `rgba(${_pk(['209,74,74', '74,138,192', '90,160,90', '224,144,58', '154,106,192'])},0.5)`, _rn(0, 6)));
  },
  comic: (g, W, H) => {
    fxScatter(g, W, H, 10, (x, y) => { for (let i = 0; i < 9; i++) fxDot(g, x + (i % 3) * 7, y + Math.floor(i / 3) * 7, 1.6, 'rgba(42,34,24,0.5)'); });
  },
  editorial: (g, W, H) => {
    fxScatter(g, W, H, 14, (x, y) => fxHLine(g, x, y, _rn(34, 78), 'rgba(26,26,26,0.32)'));
    fxScatter(g, W, H, 10, (x, y) => fxDot(g, x, y, _rn(1.5, 2.5), 'rgba(44,62,143,0.4)'));
  },
  sumie: (g, W, H) => {
    fxScatter(g, W, H, 14, (x, y) => fxGlow(g, x, y, _rn(10, 22), `rgba(${Math.random() < 0.08 ? '176,48,32' : '42,42,42'},0.28)`));
  },
  chalkboard: (g, W, H) => {
    fxScatter(g, W, H, 24, (x, y) => fxDot(g, x, y, _rn(1, 2.5), 'rgba(240,235,224,0.45)', 3));
  },
  noir: (g, W, H) => {
    fxScatter(g, W, H, 18, (x, y) => fxDot(g, x, y, _rn(1.5, 3), 'rgba(238,234,222,0.35)', 4));
  },
};

function drawThemeFx(g, W, H, theme) {
  const fn = SHARE_FX[theme];
  if (!fn) return;
  g.save();
  fn(g, W, H);
  g.restore();
  g.textBaseline = 'alphabetic'; // restore the renderer's default
}

export async function renderShareCardImage(data) {
  const W = LAYOUT_W, H = LAYOUT_H;
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_W;
  canvas.height = OUTPUT_H;
  const g = canvas.getContext('2d');
  g.scale(OUTPUT_W / W, OUTPUT_H / H);
  const C = data.colors;

  // Contrast-derived palette so every theme stays legible (see helpers).
  const dark = lum(C.bg) < 0.4;
  const dim = mix(C.text, C.bg, 0.34);     // readable secondary text
  const dimmer = mix(C.text, C.bg, 0.5);   // quietest line (url)
  const panel = desat(mix(C.text, C.bg, dark ? 0.13 : 0.10), 0.45); // board surface / grout
  const mineCell = '#ec9a86';              // Option C: fixed warm danger tint
  const good = dark ? '#54d07e' : '#2e8b57';
  const bad = dark ? '#ff7d75' : '#e0564f';
  const wm1 = dark ? '#9d8cff' : '#7b6cf0';
  const wm2 = dark ? '#e88ab6' : '#d06a8f';

  const [gregImg, mineImg, ...modImgs] = await Promise.all([
    loadImage(data.gregUrl),
    loadImage(data.mineUrl),
    ...data.modifiers.map((m) => loadImage(m.url)),
  ]);

  // Background + the theme's evoked backdrop (color wash + signature particles)
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  drawThemeFx(g, W, H, data.theme);

  // ── Header ──
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const grad = g.createLinearGradient(W / 2 - 250, 0, W / 2 + 250, 0);
  grad.addColorStop(0, wm1);
  grad.addColorStop(1, wm2);
  g.fillStyle = grad;
  g.font = '800 84px system-ui, "Segoe UI", sans-serif';
  g.fillText('GregSweeper', W / 2, 112);
  g.fillStyle = dim;
  g.font = '700 24px system-ui, sans-serif';
  drawSpaced(g, 'NO GUESSES. EVER.', W / 2, 150, 5);
  g.fillStyle = C.text;
  g.font = '700 30px system-ui, sans-serif';
  drawSpaced(g, data.dateLabel ? `${data.modeLabel} · ${data.dateLabel}` : data.modeLabel, W / 2, 218, 3);
  g.strokeStyle = withAlpha(dim, 0.55);
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(90, 250); g.lineTo(W - 90, 250); g.stroke();

  // ── Board: full-width hero on a contrasting panel (grout reads on dark) ──
  const box = 720, boxX = (W - box) / 2, boxY = 286;
  // Light touch: a thin panel edge (just enough grout to delineate cells on
  // dark themes) instead of the heavy framed slab. The theme backdrop carries
  // the visual interest now.
  roundRect(g, boxX - 5, boxY - 5, box + 10, box + 10, 16);
  g.fillStyle = panel; g.fill();
  const cell = box / Math.max(data.rows, data.cols);
  const gridW = cell * data.cols, gridH = cell * data.rows;
  const gx = boxX + (box - gridW) / 2, gy = boxY + (box - gridH) / 2;
  const gap = Math.max(2, cell * 0.055), rad = Math.min(7, cell * 0.14);
  const cells = scrambleCells(data.rows, data.cols, data.totalMines, data.revealedCount);
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) {
      const kind = cells[r * data.cols + c];
      const x = gx + c * cell, y = gy + r * cell;
      const w = cell - gap;
      roundRect(g, x, y, w, w, rad);
      // Mine cells get the danger tint so the dark mine.png always reads,
      // and the mines visibly "pop" out of the board on any theme.
      g.fillStyle = kind === 'mine' ? mineCell : (kind === 'hidden' ? C.cellHidden : C.cellRevealed);
      g.fill();
      if (kind === 'mine' && mineImg) {
        const p = w * 0.12;
        g.drawImage(mineImg, x + p, y + p, w - 2 * p, w - 2 * p);
      }
    }
  }

  // Bottom block anchored from the floor up so the layout never collides.
  const fy = H - 52;
  const hasMods = data.modifiers.length > 0;
  const my = fy - 70;
  const divY = hasMods ? my - 54 : fy - 48;

  // ── Result: Greg + time + delta, centered group below the board ──
  const ry = boxY + box + 42;
  const gz = 176;
  g.font = '800 104px system-ui, sans-serif';
  const timeW = g.measureText(data.timeText).width;
  g.font = '700 38px system-ui, sans-serif';
  const resW = data.resultText ? g.measureText(data.resultText).width : 0;
  const groupW = gz + 32 + Math.max(timeW, resW);
  const startX = (W - groupW) / 2;
  if (gregImg) g.drawImage(gregImg, startX, ry, gz, gz);
  const tx = startX + gz + 32;
  g.textAlign = 'left';
  g.fillStyle = C.text;
  g.font = '800 104px system-ui, sans-serif';
  g.fillText(data.timeText, tx, ry + 98);
  let bY = ry + 144;
  if (data.resultText) {
    g.fillStyle = data.resultGood ? good : bad;
    g.font = '700 38px system-ui, sans-serif';
    g.fillText(data.resultText, tx, bY);
    bY += 42;
  }
  if (data.bombHits > 0) {
    g.fillStyle = dim;
    g.font = '600 28px system-ui, sans-serif';
    g.fillText(`${data.bombHits} mine hit${data.bombHits > 1 ? 's' : ''}`, tx, bY);
  }

  // ── Divider ──
  g.strokeStyle = withAlpha(dim, 0.55);
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(90, divY); g.lineTo(W - 90, divY); g.stroke();

  // ── Modifiers row (centered) ──
  if (hasMods) {
    const iconSz = 46, nameGap = 12, pairGap = 44, labelGap = 20;
    g.font = '600 32px system-ui, sans-serif';
    g.textAlign = 'left';
    const label = 'Modifiers:';
    let totalW = g.measureText(label).width + labelGap;
    for (let i = 0; i < data.modifiers.length; i++) {
      totalW += iconSz + nameGap + g.measureText(data.modifiers[i].name).width + (i < data.modifiers.length - 1 ? pairGap : 0);
    }
    let x = W / 2 - totalW / 2;
    g.fillStyle = dim;
    g.fillText(label, x, my);
    x += g.measureText(label).width + labelGap;
    g.fillStyle = C.text;
    data.modifiers.forEach((m, i) => {
      if (modImgs[i]) g.drawImage(modImgs[i], x, my - iconSz + 9, iconSz, iconSz);
      x += iconSz + nameGap;
      g.fillText(m.name, x, my);
      x += g.measureText(m.name).width + pairGap;
    });
  }

  // ── Footer: certified (left) + url (right) ──
  if (data.certified) {
    g.textAlign = 'left';
    g.fillStyle = good;
    g.font = '700 27px system-ui, sans-serif';
    g.fillText('✓ Certified no-guess', 90, fy);
  }
  g.textAlign = 'right';
  g.fillStyle = dimmer;
  g.font = '500 25px system-ui, sans-serif';
  g.fillText('christopherwells.github.io/GregSweeper', W - 90, fy);

  return canvas;
}

export async function renderShareCardBlob(data) {
  const canvas = await renderShareCardImage(data);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

// The most-recently prepared share File, kept module-side so the share
// handler (a separate module) can grab it synchronously inside the
// click's activation window — Web Share rejects files attached after an
// await yields the gesture.
let _lastFile = null;
export function getLastShareFile() {
  return _lastFile;
}

// Render the card, stash it as a File, and paint it into the preview
// element. Called when the win modal opens so the File is ready the
// instant the player taps Share.
export async function prepareShareCard(state, previewEl) {
  _lastFile = null;
  const data = buildShareData(state);
  const blob = await renderShareCardBlob(data);
  _lastFile = new File([blob], 'gregsweeper.png', { type: 'image/png' });
  if (previewEl) {
    if (previewEl._cardUrl) URL.revokeObjectURL(previewEl._cardUrl);
    const url = URL.createObjectURL(blob);
    previewEl._cardUrl = url;
    previewEl.innerHTML = `<img class="share-card-img" src="${url}" alt="Your GregSweeper result">`;
    previewEl.classList.remove('hidden');
  }
  return _lastFile;
}
