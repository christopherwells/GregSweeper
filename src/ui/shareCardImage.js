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

const LAYOUT = 1080;
// The card is laid out on a 1080 grid but EXPORTED smaller, so the shared
// PNG displays within a phone chat instead of spilling off both edges
// (a phone test showed 1080 overflowing). Text stays crisp; the messaging
// app scales the smaller image down to the bubble.
const OUTPUT = 540;
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

export async function renderShareCardImage(data) {
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const g = canvas.getContext('2d');
  g.scale(OUTPUT / LAYOUT, OUTPUT / LAYOUT);
  const C = data.colors;

  const [gregImg, mineImg, ...modImgs] = await Promise.all([
    loadImage(data.gregUrl),
    loadImage(data.mineUrl),
    ...data.modifiers.map((m) => loadImage(m.url)),
  ]);

  // Background
  g.fillStyle = C.bg;
  g.fillRect(0, 0, LAYOUT, LAYOUT);

  // Wordmark
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const grad = g.createLinearGradient(LAYOUT / 2 - 230, 0, LAYOUT / 2 + 230, 0);
  grad.addColorStop(0, '#7b6cf0');
  grad.addColorStop(1, '#d06a8f');
  g.fillStyle = grad;
  g.font = '800 76px system-ui, "Segoe UI", sans-serif';
  g.fillText('GregSweeper', LAYOUT / 2, 116);

  g.fillStyle = C.textDim;
  g.font = '700 22px system-ui, sans-serif';
  drawSpaced(g, 'NO GUESSES. EVER.', LAYOUT / 2, 150, 4);

  g.font = '700 26px system-ui, sans-serif';
  drawSpaced(g, data.dateLabel ? `${data.modeLabel} · ${data.dateLabel}` : data.modeLabel, LAYOUT / 2, 212, 3);
  g.strokeStyle = withAlpha(C.textDim, 0.4);
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(70, 240); g.lineTo(LAYOUT - 70, 240); g.stroke();

  // Scrambled board (left). Square cells, centered in a 440px box.
  const boxX = 64, boxY = 282, box = 444;
  const cell = box / Math.max(data.rows, data.cols);
  const gridW = cell * data.cols, gridH = cell * data.rows;
  const gx = boxX + (box - gridW) / 2, gy = boxY + (box - gridH) / 2;
  const gap = Math.max(2, cell * 0.09), rad = Math.min(6, cell * 0.16);
  const cells = scrambleCells(data.rows, data.cols, data.totalMines, data.revealedCount);
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) {
      const kind = cells[r * data.cols + c];
      const x = gx + c * cell, y = gy + r * cell;
      const w = cell - gap;
      roundRect(g, x, y, w, w, rad);
      g.fillStyle = (kind === 'hidden') ? C.cellHidden : C.cellRevealed;
      g.fill();
      if (kind === 'mine' && mineImg) {
        const p = w * 0.08;
        g.drawImage(mineImg, x + p, y + p, w - 2 * p, w - 2 * p);
      }
    }
  }

  // Right column: Greg + time + result
  const rcx = (boxX + box + (LAYOUT - 64)) / 2;
  if (gregImg) {
    const gz = 196;
    g.drawImage(gregImg, rcx - gz / 2, 300, gz, gz);
  }
  g.textAlign = 'center';
  g.fillStyle = C.text;
  g.font = '800 106px system-ui, sans-serif';
  g.fillText(data.timeText, rcx, 600);
  if (data.resultText) {
    g.fillStyle = data.resultGood ? '#33a957' : '#e0564f';
    g.font = '700 34px system-ui, sans-serif';
    g.fillText(data.resultText, rcx, 652);
  }
  if (data.bombHits > 0) {
    g.fillStyle = C.textDim;
    g.font = '600 24px system-ui, sans-serif';
    g.fillText(`${data.bombHits} mine hit${data.bombHits > 1 ? 's' : ''}`, rcx, 694);
  }

  // Divider
  g.strokeStyle = withAlpha(C.textDim, 0.4);
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(70, 768); g.lineTo(LAYOUT - 70, 768); g.stroke();

  // Modifiers row: "Modifiers:" + icon/name pairs, centered.
  if (data.modifiers.length) {
    const iconSz = 42, nameGap = 10, pairGap = 40, labelGap = 18;
    g.font = '600 30px system-ui, sans-serif';
    g.textAlign = 'left';
    const label = 'Modifiers:';
    let totalW = g.measureText(label).width + labelGap;
    for (let i = 0; i < data.modifiers.length; i++) {
      totalW += iconSz + nameGap + g.measureText(data.modifiers[i].name).width + (i < data.modifiers.length - 1 ? pairGap : 0);
    }
    let x = LAYOUT / 2 - totalW / 2;
    const y = 824;
    g.fillStyle = C.textDim;
    g.fillText(label, x, y);
    x += g.measureText(label).width + labelGap;
    g.fillStyle = C.text;
    data.modifiers.forEach((m, i) => {
      if (modImgs[i]) g.drawImage(modImgs[i], x, y - iconSz + 8, iconSz, iconSz);
      x += iconSz + nameGap;
      g.fillText(m.name, x, y);
      x += g.measureText(m.name).width + pairGap;
    });
  }

  // Footer: certified (left) + url (right)
  const fy = data.modifiers.length ? 916 : 862;
  if (data.certified) {
    g.textAlign = 'left';
    g.fillStyle = '#2e8b57';
    g.font = '700 25px system-ui, sans-serif';
    g.fillText('✓ Certified no-guess', 64, fy);
  }
  g.textAlign = 'right';
  g.fillStyle = C.textDim;
  g.font = '500 23px system-ui, sans-serif';
  g.fillText('christopherwells.github.io/GregSweeper', LAYOUT - 64, fy);

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
