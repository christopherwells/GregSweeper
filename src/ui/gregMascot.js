// Animated title-screen Greg mascot.
//
// The art mirrors the shipped master assets/sprites/greg/a7b-idle.svg,
// inlined here so the eyes and smile can animate — the <img>/PNG avatar path
// (spriteImgHTML('smiley')) renders a flat raster and can't. Keep the two in
// sync if the master is redrawn; export-greg-sprites.ps1 -Direction a7b owns
// the PNG slots, this owns the title mascot.
//
// Idle behavior: a periodic blink, with the smile flipping open<->closed on
// every other blink. No other motion (the gentle bob was cut on review).
// Honors prefers-reduced-motion: a reduced-motion user gets a static,
// open-smile Greg with no timers.

const D = '#232838';
const SMILE_OPEN = 'M55 64 Q64 76 73 64 Z';
const SMILE_CLOSED = 'M54 66 Q64 74 74 66';

// viewBox is the content-fitted square from the 2026-06-25 re-frame (nothing
// clips). width/height 100% so the .title-greg-mascot container sizes it.
export const GREG_MASCOT_SVG =
  `<svg viewBox="-8.18 -4.71 140.52 140.52" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Greg the crab">`
  + `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="${D}" stroke-width="9"><path d="M38 82 L26 94 L22 105"/><path d="M48 87 L40 100 L38 110"/><path d="M90 82 L102 94 L106 105"/><path d="M80 87 L88 100 L90 110"/></g><g stroke="#53a05b" stroke-width="4.5"><path d="M38 82 L26 94 L22 105"/><path d="M48 87 L40 100 L38 110"/><path d="M90 82 L102 94 L106 105"/><path d="M80 87 L88 100 L90 110"/></g></g>`
  + `<g fill="none" stroke-linecap="round"><path d="M34 64 L24 54" stroke="${D}" stroke-width="12"/><path d="M94 64 L104 52" stroke="${D}" stroke-width="12"/><path d="M34 64 L24 54" stroke="#53a05b" stroke-width="6"/><path d="M94 64 L104 52" stroke="#53a05b" stroke-width="6"/></g>`
  + `<g fill="none" stroke-linecap="round"><path d="M50 37 L46 25" stroke="${D}" stroke-width="10"/><path d="M78 37 L82 25" stroke="${D}" stroke-width="10"/><path d="M50 37 L46 25" stroke="#53a05b" stroke-width="5"/><path d="M78 37 L82 25" stroke="#53a05b" stroke-width="5"/></g>`
  + `<g class="greg-eyes-open"><circle cx="45" cy="19" r="9" fill="#fff" stroke="${D}" stroke-width="5"/><circle cx="83" cy="19" r="9" fill="#fff" stroke="${D}" stroke-width="5"/><circle cx="46.5" cy="20.5" r="3.4" fill="${D}"/><circle cx="81.5" cy="20.5" r="3.4" fill="${D}"/><circle cx="48" cy="19" r="1.2" fill="#fff"/><circle cx="83" cy="19" r="1.2" fill="#fff"/></g>`
  + `<g class="greg-eyes-closed" style="display:none"><path d="M37 18 Q45 25 53 18" fill="none" stroke="${D}" stroke-width="5" stroke-linecap="round"/><path d="M75 18 Q83 25 91 18" fill="none" stroke="${D}" stroke-width="5" stroke-linecap="round"/></g>`
  + `<path d="M22 62 C22 48 32 38 44 35 Q54 30 64 30 Q74 30 84 35 C96 38 106 48 106 62 C106 76 90 86 64 86 C38 86 22 76 22 62 Z" fill="#53a05b" stroke="${D}" stroke-width="6"/>`
  + `<path d="M30 68 C40 78 88 78 98 68 C92 80 80 84 64 84 C48 84 36 80 30 68 Z" fill="#3e7f46"/>`
  + `<g fill="#7cc184"><circle cx="44" cy="46" r="3.2"/><circle cx="66" cy="40" r="2.8"/><circle cx="86" cy="48" r="3"/><circle cx="55" cy="55" r="2.2"/></g>`
  + `<path class="greg-smile" d="${SMILE_OPEN}" fill="${D}" stroke="${D}" stroke-width="3.5" stroke-linejoin="round"/>`
  + `<ellipse cx="108" cy="45" rx="12.5" ry="10" fill="#53a05b" stroke="${D}" stroke-width="5.5" transform="rotate(-35 108 45)"/><ellipse cx="115" cy="36" rx="6" ry="4.8" fill="#e8873a" stroke="${D}" stroke-width="4.5" transform="rotate(-35 115 36)"/>`
  + `<g transform="rotate(-62 106 41)"><rect x="94" y="37" width="28" height="8" rx="2.2" fill="#ffd23e" stroke="${D}" stroke-width="3.8"/><path d="M122 37 L128 41 L122 45 Z" fill="${D}"/><rect x="88" y="37" width="6" height="8" rx="2.2" fill="#e88a8a" stroke="${D}" stroke-width="3.2"/></g>`
  + `<g transform="rotate(-12 18 60)"><rect x="0" y="38" width="32" height="44" rx="4" fill="#f3f6fb" stroke="${D}" stroke-width="5"/><rect x="9" y="32" width="14" height="9" rx="3" fill="#b9c2d4" stroke="${D}" stroke-width="3.8"/><g fill="#d4dae6"><rect x="5" y="48" width="7" height="7" rx="1.4"/><rect x="14" y="48" width="7" height="7" rx="1.4"/><rect x="23" y="48" width="7" height="7" rx="1.4"/><rect x="5" y="57" width="7" height="7" rx="1.4"/><rect x="23" y="57" width="7" height="7" rx="1.4"/></g><rect x="14" y="57" width="7" height="7" rx="1.4" fill="#ffd23e"/><path d="M24 73 L24 65 L31 67.5 L24 70" fill="#e4453a"/></g>`
  + `<ellipse cx="28" cy="42" rx="11.5" ry="9.5" fill="#53a05b" stroke="${D}" stroke-width="5.5" transform="rotate(28 28 42)"/><ellipse cx="35" cy="34" rx="5.5" ry="4.4" fill="#e8873a" stroke="${D}" stroke-width="4.5" transform="rotate(28 35 34)"/>`
  + `</svg>`;

let _running = false;

// Inject the mascot into `container` (idempotent) and start its idle loop.
// Safe to call on every title-screen show; the loop is created once.
export function startGregMascot(container) {
  if (!container) return;
  if (!container.querySelector('svg')) container.innerHTML = GREG_MASCOT_SVG;
  if (_running) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return; // static open-smile Greg; no timers
  _running = true;
  const eyesOpen = container.querySelector('.greg-eyes-open');
  const eyesClosed = container.querySelector('.greg-eyes-closed');
  const smile = container.querySelector('.greg-smile');
  if (!eyesOpen || !eyesClosed || !smile) return;
  let open = true, n = 0;
  setInterval(() => {
    // Skip work while the title screen is hidden (display:none → no
    // offsetParent), so gameplay doesn't pay for an unseen blink.
    if (!container.offsetParent) return;
    eyesOpen.style.display = 'none';
    eyesClosed.style.display = '';
    setTimeout(() => { eyesOpen.style.display = ''; eyesClosed.style.display = 'none'; }, 150);
    n++;
    if (n % 2 === 0) {
      open = !open;
      if (open) {
        smile.setAttribute('d', SMILE_OPEN);
        smile.setAttribute('fill', D);
        smile.setAttribute('stroke-width', '3.5');
      } else {
        smile.setAttribute('d', SMILE_CLOSED);
        smile.setAttribute('fill', 'none');
        smile.setAttribute('stroke-width', '5');
      }
    }
  }, 2600);
}
