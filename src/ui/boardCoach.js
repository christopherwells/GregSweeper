// The board coach line: one persistent sentence under the live board,
// updated in place (#board-coach in index.html, styled with the Gym's
// .lexicon-coach). The Lens used to answer through transient toasts,
// which punished exactly the player who needed them: a hint you cannot
// re-read four seconds later is barely a hint. The line stays until
// the next reveal, flag, or chord — the action the hint was shaping —
// then clears. aria-live="polite" on the element announces updates to
// screen readers without interrupting.

import { uiSpriteUrl } from './spriteLoader.js';

export function showBoardCoach(message, icon = null) {
  const el = document.getElementById('board-coach');
  if (!el) return;
  el.textContent = '';
  const iconUrl = message && icon ? uiSpriteUrl(icon) : null;
  if (iconUrl) {
    const img = document.createElement('img');
    img.className = 'coach-icon';
    img.src = iconUrl;
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    el.appendChild(img);
    el.appendChild(document.createTextNode(message));
  } else {
    el.textContent = message || '';
  }
  el.hidden = !message;
  // Retrigger the pop animation on every update so a repeated tap of
  // Stuck? visibly responds even when the text is unchanged.
  el.classList.remove('coach-pop');
  void el.offsetWidth;
  el.classList.add('coach-pop');
}

export function clearBoardCoach() {
  const el = document.getElementById('board-coach');
  if (!el || el.hidden) return;
  el.textContent = '';
  el.hidden = true;
}
