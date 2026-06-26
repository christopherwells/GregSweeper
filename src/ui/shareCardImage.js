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

// Resolve a CSS value (incl. var()) to a #hex by letting the browser compute it
// on a throwaway element — getPropertyValue returns custom-property values with
// var() intact. Returns hex (the palette helpers need hex, not rgb()); falls
// back when the computed value isn't a plain rgb() (e.g. a color-mix() default).
function resolveCssColor(value, fallback) {
  try {
    const el = document.createElement('span');
    el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:' + value;
    document.body.appendChild(el);
    const c = getComputedStyle(el).color;
    el.remove();
    const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return m ? _hex(+m[1], +m[2], +m[3]) : fallback;
  } catch { return fallback; }
}

export function buildShareData(state) {
  const cs = getComputedStyle(document.documentElement);
  const cv = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const wm1 = resolveCssColor('var(--wordmark-from)', cv('--color-accent', '#5c6bc0'));
  // A theme may override --wordmark-to with an explicit color; otherwise derive
  // the gradient's light end in JS (the default color-mix() doesn't serialize as
  // rgb, so resolveCssColor falls back here).
  const wm2 = resolveCssColor('var(--wordmark-to)', '') || mix(wm1, '#ffffff', 0.3);
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
    wordmarkFont: cv('--font-display', 'system-ui, "Segoe UI", sans-serif'),
    wm1,
    wm2,
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

// Richer structure drawers used by the backdrops below.
function fxVignette(g, W, H, rgba) {
  const grd = g.createRadialGradient(W / 2, H * 0.46, H * 0.28, W / 2, H * 0.46, H * 0.78);
  grd.addColorStop(0, rgba.replace(/[\d.]+\s*\)\s*$/, '0)')); grd.addColorStop(1, rgba);
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
}
function fxGrid(g, W, H, rgba, sp) {
  g.strokeStyle = rgba; g.lineWidth = 1; g.beginPath();
  for (let x = 0; x <= W; x += sp) { g.moveTo(x, 0); g.lineTo(x, H); }
  for (let y = 0; y <= H; y += sp) { g.moveTo(0, y); g.lineTo(W, y); }
  g.stroke();
}
function fxPersp(g, W, H, rgba, hy) { // perspective grid converging to (W/2, hy)
  g.strokeStyle = rgba; g.lineWidth = 1.5; g.beginPath();
  for (let i = -9; i <= 9; i++) { g.moveTo(W / 2, hy); g.lineTo(W / 2 + i * (W * 0.7 / 9), H); }
  let y = hy + 7, step = 9;
  while (y < H) { g.moveTo(0, y); g.lineTo(W, y); y += step; step *= 1.32; }
  g.stroke();
}
function fxRibbon(g, W, yC, h, colors) { // soft wobbly aurora band; colors[] blend along its length
  g.save(); g.filter = 'blur(17px)'; g.globalCompositeOperation = 'lighter';
  const grd = g.createLinearGradient(0, 0, W, 0);
  colors.forEach((c, i) => grd.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
  g.fillStyle = grd;
  // Two sine terms at different frequencies → an organic, non-stripey wobble.
  const wob = (x) => Math.sin(x * 0.014 + yC * 0.05) * h * 0.85 + Math.sin(x * 0.043 + yC) * h * 0.4;
  g.beginPath(); g.moveTo(-60, yC - h + wob(-60));
  for (let x = -60; x <= W + 60; x += 16) g.lineTo(x, yC - h + wob(x));
  for (let x = W + 60; x >= -60; x -= 16) g.lineTo(x, yC + h + wob(x));
  g.closePath(); g.fill();
  g.filter = 'none'; g.globalCompositeOperation = 'source-over'; g.restore();
}
function fxBlinds(g, W, H, rgba) {
  // Bands span far past every edge so the -0.12 rotation can't leave a corner
  // (the bottom-left) uncovered.
  g.save(); g.rotate(-0.12); g.fillStyle = rgba;
  for (let y = -160; y < H + 240; y += 52) g.fillRect(-H, y, W + 2 * H, 22);
  g.restore();
}
function fxSun(g, x, y, r) {
  g.save(); g.beginPath(); g.arc(x, y, r, 0, 7); g.clip();
  const grd = g.createLinearGradient(0, y - r, 0, y + r);
  grd.addColorStop(0, 'rgba(255,210,90,0.9)'); grd.addColorStop(0.45, 'rgba(255,110,180,0.9)'); grd.addColorStop(1, 'rgba(170,80,210,0.75)');
  g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
  g.fillStyle = 'rgba(18,10,38,0.92)';
  for (let i = 0; i < 7; i++) g.fillRect(x - r, y + r * 0.12 + i * r * 0.13, r * 2, 2 + i * 1.5);
  g.restore();
}
function fxRays(g, x, y, n, r0, r1, rgba) {
  g.save(); g.translate(x, y); g.strokeStyle = rgba; g.lineWidth = 3;
  for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n; g.beginPath(); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); g.stroke(); }
  g.restore();
}
function fxBurst(g, x, y, r, rgba) { // comic starburst (spiky polygon)
  g.save(); g.translate(x, y); g.fillStyle = rgba; g.beginPath();
  for (let i = 0; i < 24; i++) { const a = i * Math.PI / 12, rr = i % 2 ? r * 0.55 : r; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  g.closePath(); g.fill(); g.restore();
}
function fxFish(g, x, y, s, rgba, flip) { // simple fish silhouette (body + tail + eye)
  g.save(); g.translate(x, y); if (flip) g.scale(-1, 1); g.fillStyle = rgba;
  g.beginPath(); g.ellipse(0, 0, s, s * 0.5, 0, 0, 7); g.fill();
  g.beginPath(); g.moveTo(-s * 0.85, 0); g.lineTo(-s * 1.5, -s * 0.55); g.lineTo(-s * 1.5, s * 0.55); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); g.arc(s * 0.5, -s * 0.12, s * 0.11, 0, 7); g.fill();
  g.restore();
}
function fxBlossom(g, x, y, s, rgba) { // 5-petal cherry blossom with a yellow center
  g.save(); g.translate(x, y); g.fillStyle = rgba;
  for (let i = 0; i < 5; i++) { g.save(); g.rotate(i * 2 * Math.PI / 5); g.beginPath(); g.ellipse(0, -s * 0.6, s * 0.4, s * 0.62, 0, 0, 7); g.fill(); g.restore(); }
  g.fillStyle = 'rgba(255,232,120,0.65)'; g.beginPath(); g.arc(0, 0, s * 0.22, 0, 7); g.fill();
  g.restore();
}
function fxBottle(g, x, baseY, w, h, rgba) { // apothecary bottle/jar sitting on a shelf
  g.fillStyle = rgba;
  roundRect(g, x - w / 2, baseY - h, w, h, 4); g.fill();
  g.fillRect(x - w * 0.18, baseY - h - h * 0.22, w * 0.36, h * 0.22);
  g.beginPath(); g.ellipse(x, baseY - h - h * 0.22, w * 0.26, h * 0.09, 0, 0, 7); g.fill();
}
function fxWrapper(g, x, y, s, rgba, rot) { // wrapped hard candy: oval center + twisted ends
  g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = rgba;
  g.beginPath(); g.ellipse(0, 0, s, s * 0.62, 0, 0, 7); g.fill();
  for (const d of [1, -1]) { g.beginPath(); g.moveTo(d * s, 0); g.lineTo(d * s * 1.7, -s * 0.55); g.lineTo(d * s * 1.7, s * 0.55); g.closePath(); g.fill(); }
  g.fillStyle = 'rgba(255,255,255,0.4)'; g.beginPath(); g.ellipse(-s * 0.2, -s * 0.18, s * 0.4, s * 0.22, 0, 0, 7); g.fill();
  g.restore();
}
function fxCrown(g, x, y, s, rgba) { // five-point crown silhouette
  g.save(); g.translate(x, y); g.fillStyle = rgba;
  g.beginPath(); g.moveTo(-s, s * 0.45); g.lineTo(-s, -s * 0.35); g.lineTo(-s * 0.5, s * 0.1); g.lineTo(0, -s * 0.55); g.lineTo(s * 0.5, s * 0.1); g.lineTo(s, -s * 0.35); g.lineTo(s, s * 0.45); g.closePath(); g.fill();
  g.restore();
}
function fxCompass(g, x, y, r, rgba) {
  g.strokeStyle = rgba; g.fillStyle = rgba; g.lineWidth = 2;
  g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke(); g.beginPath(); g.arc(x, y, r * 0.66, 0, 7); g.stroke();
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, lr = i % 2 ? r * 0.66 : r; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * lr, y + Math.sin(a) * lr); g.stroke(); }
  g.beginPath(); g.moveTo(x, y - r); g.lineTo(x - r * 0.13, y); g.lineTo(x + r * 0.13, y); g.closePath(); g.fill();
}
function fxTrace(g, x, y, rgba) {
  g.strokeStyle = rgba; g.lineWidth = 2; g.beginPath();
  let cx = x, cy = y; g.moveTo(cx, cy);
  for (let i = 0; i < 5; i++) { if (i % 2) cx += (Math.random() < 0.5 ? 1 : -1) * _rn(28, 64); else cy += (Math.random() < 0.5 ? 1 : -1) * _rn(28, 64); g.lineTo(cx, cy); }
  g.stroke(); fxDot(g, x, y, 3, rgba); fxDot(g, cx, cy, 3, rgba);
}
function fxWave(g, W, y, amp, rgba) {
  g.strokeStyle = rgba; g.lineWidth = 2; g.beginPath(); g.moveTo(-20, y);
  for (let x = -20; x <= W + 20; x += 22) g.lineTo(x, y + Math.sin(x * 0.03 + y) * amp);
  g.stroke();
}
function fxCol(g, x, y, n, fs, rgba) { // matrix code column, bright leading head
  g.font = '700 ' + fs + 'px monospace'; g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i < n; i++) { g.fillStyle = i === n - 1 ? 'rgba(170,235,185,0.6)' : rgba; g.fillText(Math.random() < 0.5 ? '0' : '1', x, y + i * fs); }
}

const SHARE_FX = {
  forest: (g, W, H) => {
    fxGlow(g, W * 0.22, H * 0.18, 440, 'rgba(120,195,80,0.13)'); fxGlow(g, W * 0.8, H * 0.74, 400, 'rgba(80,150,70,0.11)');
    fxVignette(g, W, H, 'rgba(18,38,16,0.34)');
    // Keep leaves out of the centered text (header at top, result/footer at
    // bottom); fill the margins densely instead.
    const inText = (x, y) => x > W * 0.16 && x < W * 0.84 && (y < H * 0.19 || y > H * 0.7);
    for (let placed = 0, tries = 0; placed < 38 && tries < 700; tries++) {
      const x = _rn(18, W - 18), y = _rn(18, H - 18); if (inText(x, y)) continue;
      fxEllipse(g, x, y, _rn(8, 16), _rn(5, 9), `rgba(${_pk(['120,165,75', '150,120,46', '170,104,40', '96,150,70'])},0.82)`, _rn(0, 6)); placed++;
    }
    fxScatter(g, W, H, 12, (x, y) => fxDot(g, x, y, _rn(2, 4.2), 'rgba(216,255,130,0.85)', 11));
  },
  galaxy: (g, W, H) => {
    fxGlow(g, W * 0.3, H * 0.32, 440, 'rgba(208,80,255,0.13)'); fxGlow(g, W * 0.74, H * 0.66, 400, 'rgba(130,177,255,0.11)');
    g.save(); g.filter = 'blur(24px)'; g.translate(W / 2, H / 2); g.rotate(-0.7); g.fillStyle = 'rgba(220,205,255,0.07)'; g.fillRect(-W, -70, W * 2, 140); g.filter = 'none'; g.restore();
    fxScatter(g, W, H, 64, (x, y) => fxDot(g, x, y, _rn(1, 3), _pk(['rgba(255,255,255,0.9)', 'rgba(234,128,252,0.72)', 'rgba(130,177,255,0.72)']), 6));
    fxScatter(g, W, H, 6, (x, y) => fxStar(g, x, y, _rn(7, 13), 'rgba(255,255,255,0.9)'));
  },
  aurora: (g, W, H) => {
    fxRibbon(g, W, H * 0.2, 58, ['rgba(0,229,160,0)', 'rgba(0,229,160,0.4)', 'rgba(0,188,212,0.4)', 'rgba(120,150,255,0.3)', 'rgba(120,150,255,0)']);
    fxRibbon(g, W, H * 0.33, 50, ['rgba(60,235,180,0)', 'rgba(40,215,180,0.36)', 'rgba(150,120,255,0.36)', 'rgba(150,120,255,0)']);
    fxRibbon(g, W, H * 0.49, 44, ['rgba(90,255,200,0)', 'rgba(80,230,210,0.3)', 'rgba(120,160,255,0.3)', 'rgba(170,130,255,0.26)', 'rgba(170,130,255,0)']);
    fxScatter(g, W, H, 46, (x, y) => fxDot(g, x, y, _rn(0.8, 2), 'rgba(220,255,245,0.7)', 4));
  },
  sakura: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 0.28, 470, 'rgba(232,112,144,0.10)');
    fxDot(g, W * 0.82, H * 0.12, 44, 'rgba(255,238,228,0.55)', 50);
    fxScatter(g, W, H, 50, (x, y) => fxEllipse(g, x, y, _rn(7, 13), _rn(5, 9), `rgba(${_pk(['244,170,190', '240,150,176', '250,190,205'])},0.8)`, _rn(0, 6)));
    fxScatter(g, W, H, 8, (x, y) => fxBlossom(g, x, y, _rn(8, 13), `rgba(${_pk(['250,180,200', '244,160,185'])},0.7)`));
  },
  ocean: (g, W, H) => {
    const og = g.createLinearGradient(0, 0, 0, H); og.addColorStop(0, 'rgba(90,185,225,0.13)'); og.addColorStop(1, 'rgba(0,40,80,0.22)'); g.fillStyle = og; g.fillRect(0, 0, W, H);
    // Fish in the side margins (the board fills the center) + a corner fish.
    const fish = [[W * 0.06, H * 0.3, 0], [W * 0.13, H * 0.4, 0], [W * 0.07, H * 0.52, 0], [W * 0.12, H * 0.63, 0], [W * 0.94, H * 0.34, 1], [W * 0.88, H * 0.46, 1], [W * 0.93, H * 0.58, 1], [W * 0.86, H * 0.69, 1], [W * 0.2, H * 0.13, 0]];
    for (const [fx, fy, fl] of fish) fxFish(g, fx, fy, _rn(12, 17), 'rgba(120,185,215,0.5)', !!fl);
    fxScatter(g, W, H, 30, (x, y) => { fxRing(g, x, y, _rn(4, 11), 'rgba(205,242,255,0.55)', 1.5); fxDot(g, x - 1.6, y - 1.6, 2, 'rgba(240,252,255,0.7)'); });
  },
  inferno: (g, W, H) => {
    fxGlow(g, W * 0.5, H * 1.05, 720, 'rgba(255,35,0,0.26)'); fxGlow(g, W * 0.5, H * 0.95, 480, 'rgba(255,80,0,0.18)'); fxGlow(g, W * 0.28, H * 1.0, 380, 'rgba(255,140,0,0.10)'); fxGlow(g, W * 0.74, H * 1.0, 380, 'rgba(255,50,0,0.14)');
    fxScatter(g, W, H, 42, (x, y) => fxDot(g, x, _rn(H * 0.32, H), _rn(1.5, 5), _pk(['rgba(255,45,0,0.8)', 'rgba(255,130,0,0.7)', 'rgba(255,80,0,0.7)']), 10));
  },
  legendary: (g, W, H) => {
    // Crowns + a stronger radiant sunburst + bigger gold (Christopher: make it
    // more legendary).
    fxGlow(g, W * 0.5, H * 0.42, 540, 'rgba(255,200,50,0.15)');
    fxRays(g, W * 0.5, H * 0.42, 28, 64, 500, 'rgba(255,215,90,0.13)');
    fxCrown(g, W * 0.13, H * 0.1, 36, 'rgba(255,212,70,0.55)'); fxCrown(g, W * 0.87, H * 0.1, 36, 'rgba(255,212,70,0.55)');
    fxScatter(g, W, H, 30, (x, y) => fxStar(g, x, y, _rn(5, 13), _pk(['rgba(255,215,0,0.85)', 'rgba(255,245,160,0.72)', 'rgba(255,255,255,0.6)'])));
    fxScatter(g, W, H, 14, (x, y) => fxDot(g, x, y, _rn(2, 4), 'rgba(255,150,0,0.6)', 8));
  },
  supernova: (g, W, H) => {
    // Deep-space blue-black base (the theme board reads warm), then aurora-style
    // ribbons in nebula blues/violets + stars — no random rings (Christopher:
    // more aurora, supernova colors, fewer circles).
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(6,10,32,0.93)'); bg.addColorStop(0.5, 'rgba(12,18,52,0.9)'); bg.addColorStop(1, 'rgba(4,8,26,0.95)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    fxRibbon(g, W, H * 0.26, 66, ['rgba(80,140,255,0)', 'rgba(80,150,255,0.36)', 'rgba(150,110,255,0.36)', 'rgba(150,110,255,0)']);
    fxRibbon(g, W, H * 0.44, 58, ['rgba(60,200,225,0)', 'rgba(70,190,225,0.32)', 'rgba(150,150,255,0.32)', 'rgba(150,150,255,0)']);
    fxRibbon(g, W, H * 0.64, 52, ['rgba(120,150,255,0)', 'rgba(130,160,255,0.3)', 'rgba(205,120,255,0.28)', 'rgba(205,120,255,0)']);
    fxScatter(g, W, H, 32, (x, y) => fxStar(g, x, y, _rn(4, 9), _pk(['rgba(205,225,255,0.85)', 'rgba(255,255,255,0.7)', 'rgba(150,200,255,0.6)'])));
  },
  matrix: (g, W, H) => {
    fxVignette(g, W, H, 'rgba(0,28,6,0.42)');
    // More columns, dimmer (Christopher: more 0/1 but not as bright).
    for (let i = 0; i < 44; i++) fxCol(g, _rn(10, W - 10), _rn(-90, H - 50), Math.floor(_rn(5, 14)), 15, `rgba(70,200,105,${_rn(0.16, 0.34).toFixed(2)})`);
  },
  neon: (g, W, H) => {
    fxPersp(g, W, H, 'rgba(0,255,136,0.18)', H * 0.6);
    fxGlow(g, W * 0.5, H * 0.6, 440, 'rgba(0,255,136,0.08)');
    fxScatter(g, W, H, 30, (x, y) => fxStar(g, x, y, _rn(3, 7), _pk(['rgba(0,255,136,0.85)', 'rgba(0,221,255,0.75)', 'rgba(255,0,110,0.65)'])));
    fxScatter(g, W, H, 4, (x, y) => fxHLine(g, 0, y, W, _pk(['rgba(0,255,136,0.4)', 'rgba(255,0,110,0.4)'])));
  },
  synthwave: (g, W, H) => {
    // A warm sunset (vs neon's cool electric grid) — the sun + warm sky are the
    // differentiator (Christopher: make synthwave and neon more unique).
    const sg = g.createLinearGradient(0, 0, 0, H);
    sg.addColorStop(0, 'rgba(95,25,125,0.15)'); sg.addColorStop(0.42, 'rgba(255,70,150,0.14)'); sg.addColorStop(0.64, 'rgba(255,140,70,0.13)'); sg.addColorStop(1, 'rgba(60,20,90,0.17)');
    g.fillStyle = sg; g.fillRect(0, 0, W, H);
    fxSun(g, W * 0.5, H * 0.16, 122);
    fxPersp(g, W, H, 'rgba(255,60,190,0.34)', H * 0.6);
  },
  candy: (g, W, H) => {
    const cols = ['255,64,129', '224,64,251', '124,77,255', '255,170,40', '64,210,140', '80,170,255'];
    fxScatter(g, W, H, 48, (x, y) => fxCapsule(g, x, y, _rn(9, 18), `rgba(${_pk(cols)},0.82)`, _rn(0, 6)));
    fxScatter(g, W, H, 11, (x, y) => fxWrapper(g, x, y, _rn(9, 14), `rgba(${_pk(cols)},0.78)`, _rn(-0.6, 0.6)));
    fxScatter(g, W, H, 16, (x, y) => fxDot(g, x, y, _rn(2.5, 6), `rgba(${_pk(['255,255,255', '255,200,230', '255,240,150'])},0.7)`));
  },
  circuitboard: (g, W, H) => {
    fxScatter(g, W, H, 18, (x, y) => fxTrace(g, x, y, 'rgba(64,200,120,0.42)'));
    g.strokeStyle = 'rgba(64,200,120,0.32)'; g.lineWidth = 2;
    for (let i = 0; i < 4; i++) { const yy = _rn(20, H - 20); g.beginPath(); g.moveTo(20, yy); g.lineTo(W - 20, yy); g.stroke(); }
    g.strokeStyle = 'rgba(70,210,130,0.5)'; g.fillStyle = 'rgba(70,210,130,0.45)';
    for (const [cx, cy, cw, ch] of [[W * 0.62, H * 0.06, 124, 78], [W * 0.07, H * 0.8, 92, 60]]) {
      g.lineWidth = 2; roundRect(g, cx, cy, cw, ch, 6); g.stroke();
      for (let i = 0; i < 5; i++) { const px = cx + 10 + i * (cw - 20) / 4; g.fillRect(px, cy - 6, 5, 6); g.fillRect(px, cy + ch, 5, 6); }
    }
    fxScatter(g, W, H, 14, (x, y) => fxRing(g, x, y, _rn(3, 5), 'rgba(64,200,120,0.5)', 1.5));
    fxScatter(g, W, H, 22, (x, y) => fxDot(g, x, y, _rn(2, 4.2), _pk(['rgba(64,240,144,0.9)', 'rgba(64,200,240,0.85)', 'rgba(240,80,60,0.8)', 'rgba(240,200,64,0.85)']), 8));
  },
  stainedglass: (g, W, H) => {
    // More, brighter, more varied jewel twinkles (Christopher: more colorful).
    fxGlow(g, W * 0.26, H * 0.3, 320, 'rgba(120,60,200,0.12)'); fxGlow(g, W * 0.74, H * 0.62, 320, 'rgba(200,50,70,0.11)'); fxGlow(g, W * 0.5, H * 0.48, 320, 'rgba(80,160,240,0.08)');
    fxGrid(g, W, H, 'rgba(20,18,30,0.4)', 84);
    fxScatter(g, W, H, 44, (x, y) => fxDiamond(g, x, y, _rn(5, 12), _pk(['rgba(190,90,250,0.82)', 'rgba(250,90,120,0.82)', 'rgba(90,170,250,0.8)', 'rgba(250,210,90,0.82)', 'rgba(90,220,150,0.8)', 'rgba(250,140,60,0.8)'])));
  },
  apothecary: (g, W, H) => {
    // A shop wall: shelves lined with bottles + jars, a candle, warm light.
    fxGlow(g, W * 0.82, H * 0.12, 440, 'rgba(255,190,90,0.18)');
    fxVignette(g, W, H, 'rgba(30,16,6,0.42)');
    const shelves = [H * 0.3, H * 0.55, H * 0.8];
    g.strokeStyle = 'rgba(150,110,60,0.42)'; g.lineWidth = 4;
    for (const sy of shelves) { g.beginPath(); g.moveTo(0, sy); g.lineTo(W, sy); g.stroke(); }
    const jarCols = ['rgba(120,90,50,0.6)', 'rgba(90,110,70,0.55)', 'rgba(110,70,55,0.6)', 'rgba(80,95,110,0.55)', 'rgba(140,110,60,0.55)'];
    for (const sy of shelves) for (const bx of [W * 0.05, W * 0.11, W * 0.17, W * 0.83, W * 0.89, W * 0.95]) fxBottle(g, bx, sy, _rn(20, 30), _rn(38, 66), _pk(jarCols));
    g.fillStyle = 'rgba(255,205,95,0.7)'; g.beginPath(); g.ellipse(W * 0.82, H * 0.09, 8, 15, 0, 0, 7); g.fill();
    fxScatter(g, W, H, 12, (x, y) => fxDot(g, x, y, _rn(2, 4), 'rgba(232,190,110,0.5)', 6));
  },
  splitflap: (g, W, H) => {
    // A Solari departures board framing the card: real character tiles with the
    // top-flap highlight, the mid split seam, and a glyph.
    const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'.split('');
    const tile = (x, y, w, h) => {
      g.fillStyle = 'rgba(24,24,30,0.92)'; roundRect(g, x, y, w, h, 3); g.fill();
      g.fillStyle = 'rgba(48,48,58,0.92)'; roundRect(g, x, y, w, h * 0.47, 3); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + 1, y + h / 2); g.lineTo(x + w - 1, y + h / 2); g.stroke();
      g.fillStyle = 'rgba(238,238,242,0.9)'; g.font = '700 ' + Math.round(h * 0.56) + 'px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(_pk(chars), x + w / 2, y + h / 2 + 1);
    };
    const tw = 26, th = 33, gp = 5;
    for (let i = 0, n = Math.floor((W - 24) / (tw + gp)); i < n; i++) tile(14 + i * (tw + gp), 12, tw, th);
    for (let r = 0, n = Math.floor(710 / (th + gp)); r < n; r++) { const y = 292 + r * (th + gp); tile(12, y, tw, th); tile(W - 12 - tw, y, tw, th); }
  },
  blueprint: (g, W, H) => {
    fxGrid(g, W, H, 'rgba(150,210,255,0.12)', 40);
    g.strokeStyle = 'rgba(140,220,255,0.5)'; g.lineWidth = 2; g.setLineDash([10, 8]); g.beginPath(); g.moveTo(60, H * 0.5); g.lineTo(W - 60, H * 0.5); g.stroke(); g.setLineDash([]);
    g.lineWidth = 1.5; roundRect(g, W * 0.6, H * 0.84, 150, 60, 2); g.stroke();
    fxScatter(g, W, H, 22, (x, y) => fxCross(g, x, y, _rn(4, 9), `rgba(${_pk(['90,208,255', '160,224,255'])},0.75)`));
  },
  cartography: (g, W, H) => {
    fxCompass(g, W * 0.84, H * 0.14, 56, 'rgba(106,74,38,0.55)');
    for (const wy of [H * 0.62, H * 0.74, H * 0.86]) fxWave(g, W, wy, 9, 'rgba(106,74,38,0.4)');
    fxScatter(g, W, H, 8, (x, y) => fxDash(g, x, y, _rn(55, 110), 'rgba(106,74,38,0.5)', _rn(-0.4, 0.4)));
    fxScatter(g, W, H, 12, (x, y) => fxRing(g, x, y, _rn(4, 8), 'rgba(106,74,38,0.5)', 1.5));
  },
  origami: (g, W, H) => {
    g.strokeStyle = 'rgba(120,120,140,0.22)'; g.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(_rn(0, W), 0); g.lineTo(_rn(0, W), H); g.stroke(); }
    fxScatter(g, W, H, 24, (x, y) => fxTri(g, x, y, _rn(8, 16), `rgba(${_pk(['209,74,74', '74,138,192', '90,160,90', '224,144,58', '154,106,192'])},0.55)`, _rn(0, 6)));
  },
  comic: (g, W, H) => {
    fxBurst(g, W * 0.84, H * 0.13, 64, 'rgba(255,210,70,0.55)');
    g.save(); g.strokeStyle = 'rgba(42,34,24,0.4)'; g.lineWidth = 3; for (let i = 0; i < 18; i++) { const a = i * Math.PI / 9; g.beginPath(); g.moveTo(W * 0.16 + Math.cos(a) * 30, H * 0.86 + Math.sin(a) * 30); g.lineTo(W * 0.16 + Math.cos(a) * 120, H * 0.86 + Math.sin(a) * 120); g.stroke(); } g.restore();
    fxScatter(g, W, H, 10, (x, y) => { for (let i = 0; i < 9; i++) fxDot(g, x + (i % 3) * 7, y + Math.floor(i / 3) * 7, 1.7, 'rgba(42,34,24,0.5)'); });
  },
  editorial: (g, W, H) => {
    // An actual newspaper page: four justified text columns with column rules,
    // headline decks atop the outer columns, a masthead rule, and section
    // labels — the NYT/online-paper structure rather than loose lines.
    const ink = (a) => `rgba(26,26,26,${a})`;
    const cols = 4, colW = W / cols;
    g.strokeStyle = ink(0.16); g.lineWidth = 1.5;
    for (let i = 1; i < cols; i++) { g.beginPath(); g.moveTo(i * colW, 56); g.lineTo(i * colW, H - 28); g.stroke(); }
    for (let c = 0; c < cols; c++) {
      const x0 = c * colW + 12, cw = colW - 24;
      let y = 66;
      if (c === 0 || c === cols - 1) { g.fillStyle = ink(0.36); g.fillRect(x0, y, cw * _rn(0.75, 1), 9); y += 15; g.fillRect(x0, y, cw * _rn(0.55, 0.85), 7); y += 18; }
      g.fillStyle = ink(0.13);
      while (y < H - 28) { g.fillRect(x0, y, cw * _rn(0.5, 1), 2.4); y += 7; }
    }
    fxText(g, 14, 24, '700 15px Georgia, serif', ink(0.5), 'O P I N I O N');
    fxText(g, W - 116, 24, '700 15px Georgia, serif', ink(0.5), 'A R T S');
    g.strokeStyle = ink(0.42); g.lineWidth = 1.5; g.beginPath(); g.moveTo(12, 48); g.lineTo(W - 12, 48); g.stroke();
    fxScatter(g, W, H, 6, (x, y) => fxDot(g, x, y, 1.5, 'rgba(44,62,143,0.42)'));
  },
  sumie: (g, W, H) => {
    // Bold sweeping brush strokes (the sumi-e gesture) + the artist's red seal
    // + soft ink motes. No heavy bottom wash (the old one read as a black blob).
    g.save(); g.lineCap = 'round'; g.filter = 'blur(2px)'; g.strokeStyle = 'rgba(42,42,42,0.2)';
    g.lineWidth = 10; g.beginPath(); g.moveTo(W * 0.05, H * 0.13); g.quadraticCurveTo(W * 0.34, H * 0.03, W * 0.62, H * 0.15); g.stroke();
    g.lineWidth = 6; g.beginPath(); g.moveTo(W * 0.12, H * 0.92); g.quadraticCurveTo(W * 0.32, H * 0.985, W * 0.52, H * 0.9); g.stroke();
    g.filter = 'none'; g.restore();
    g.fillStyle = 'rgba(176,48,32,0.72)'; roundRect(g, W * 0.87, H * 0.06, 34, 34, 4); g.fill();
    fxScatter(g, W, H, 18, (x, y) => fxGlow(g, x, y, _rn(10, 24), `rgba(${Math.random() < 0.08 ? '176,48,32' : '42,42,42'},0.3)`));
  },
  chalkboard: (g, W, H) => {
    const ch = (a) => `rgba(240,235,224,${a})`;
    fxText(g, W * 0.07, H * 0.08, '600 30px Georgia, serif', ch(0.4), 'a² + b² = c²');
    fxText(g, W * 0.64, H * 0.84, '600 26px Georgia, serif', ch(0.34), '∑ x → ∞');
    g.strokeStyle = ch(0.32); g.lineWidth = 2.5; g.beginPath(); g.moveTo(W * 0.1, H * 0.92); g.lineTo(W * 0.2, H * 0.79); g.lineTo(W * 0.26, H * 0.93); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(W * 0.74, H * 0.1); g.lineTo(W * 0.9, H * 0.1); g.lineTo(W * 0.86, H * 0.07); g.moveTo(W * 0.9, H * 0.1); g.lineTo(W * 0.86, H * 0.13); g.stroke();
    fxScatter(g, W, H, 24, (x, y) => fxDot(g, x, y, _rn(1, 2.5), ch(0.4), 3));
  },
  noir: (g, W, H) => {
    fxGlow(g, W * 0.7, H * 0.18, 360, 'rgba(255,250,235,0.07)');
    fxScatter(g, W, H, 18, (x, y) => fxDot(g, x, y, _rn(1.5, 3), 'rgba(238,234,222,0.4)', 4));
  },
};

// Overlay pass — drawn ON TOP of the board + text (faint), for effects that
// fall across the whole scene rather than sitting behind it. Noir's venetian
// blind light rakes the entire card, board included.
const SHARE_FX_OVERLAY = {
  noir: (g, W, H) => fxBlinds(g, W, H, 'rgba(255,250,235,0.05)'),
};
function drawThemeFxOverlay(g, W, H, theme) {
  const fn = SHARE_FX_OVERLAY[theme];
  if (!fn) return;
  g.save(); fn(g, W, H); g.restore();
  g.textBaseline = 'alphabetic';
}

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
  // Wordmark gradient comes themed from the tokens; nudge toward legibility if a
  // theme's accent sits too close to its own background luminance.
  const wmContrast = (h) => (Math.abs(lum(h) - lum(C.bg)) < 0.22 ? mix(h, dark ? '#ffffff' : '#000000', 0.4) : h);
  const wm1 = wmContrast(data.wm1);
  const wm2 = wmContrast(data.wm2);

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
  // Wordmark in the theme's display font; shrink if a wide font would overflow.
  let wmSize = 84;
  g.font = `700 ${wmSize}px ${data.wordmarkFont}`;
  while (g.measureText('GregSweeper').width > W - 90 && wmSize > 46) { wmSize -= 2; g.font = `700 ${wmSize}px ${data.wordmarkFont}`; }
  const grad = g.createLinearGradient(W / 2 - 250, 0, W / 2 + 250, 0);
  grad.addColorStop(0, wm1);
  grad.addColorStop(1, wm2);
  g.fillStyle = grad;
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

  // Overlay effects that fall across the whole card (e.g. noir blinds).
  drawThemeFxOverlay(g, W, H, data.theme);

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
