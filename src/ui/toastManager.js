import { toastContainer } from './domHelpers.js';
import { uiSpriteUrl, uiSpriteImgHTML } from './spriteLoader.js';

// ── Toast Queue ────────────────────────────────────────
const _toastQueue = [];
let _toastActive = false;

// `icon` (optional) is a SPRITES key (e.g. 'uiSuccess'). When given, a
// drawn sprite leads the message — the message stays a TEXT NODE (never
// innerHTML), so a dynamic message can't inject markup.
export function showToast(message, duration = 2000, icon = null) {
  _toastQueue.push({ message, duration, icon });
  if (!_toastActive) _processToastQueue();
}

function _processToastQueue() {
  if (_toastQueue.length === 0) { _toastActive = false; return; }
  _toastActive = true;
  const { message, duration, icon } = _toastQueue.shift();
  const el = document.createElement('div');
  el.className = 'queued-toast';
  const iconUrl = icon ? uiSpriteUrl(icon) : null;
  if (iconUrl) {
    el.classList.add('has-icon');
    const img = document.createElement('img');
    img.className = 'toast-icon';
    img.src = iconUrl;
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    el.appendChild(img);
    el.appendChild(document.createTextNode(message));
  } else {
    el.textContent = message;
  }
  if (toastContainer) toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-exit');
    setTimeout(() => {
      el.remove();
      _processToastQueue();
    }, 250);
  }, duration);
}

// ── Level Up Toast ─────────────────────────────────────

export function showLevelUpToast(level) {
  const toast = document.createElement('div');
  toast.className = 'level-up-toast';
  toast.textContent = `Level ${level}!`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ── Checkpoint Toast ──────────────────────────────────

export function showCheckpointToast(checkpointLevel) {
  const toast = document.createElement('div');
  toast.className = 'checkpoint-toast';
  toast.innerHTML = `${uiSpriteImgHTML('uiFlagChecked', 'toast-icon')} Checkpoint! <span style="font-size:12px; opacity:0.8">Level ${checkpointLevel}</span>`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ── Level Info Toast ───────────────────────────────────

export function showLevelInfoToast(level, diff, label) {
  const toast = document.createElement('div');
  toast.className = 'level-info-toast';
  const sizeLabel = `${diff.rows}×${diff.cols}`;
  const mineLabel = `${diff.mines} mines`;
  const timeLabel = ''; // Timed mode counts up now, no time limit to show
  const title = label ? `${label}` : `Level ${level}`;
  toast.innerHTML = `<strong>${title}</strong><br><span class="level-info-details">${sizeLabel} · ${mineLabel}${timeLabel}</span>`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
