// The board coach line: one persistent sentence under the live board,
// updated in place (#board-coach in index.html, styled with the Gym's
// .lexicon-coach). The Lens used to answer through transient toasts,
// which punished exactly the player who needed them: a hint you cannot
// re-read four seconds later is barely a hint. The line stays until
// the next reveal, flag, or chord — the action the hint was shaping —
// then clears. aria-live="polite" on the element announces updates to
// screen readers without interrupting.

export function showBoardCoach(message) {
  const el = document.getElementById('board-coach');
  if (!el) return;
  el.textContent = message || '';
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
