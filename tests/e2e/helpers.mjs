// Shared setup for the interaction specs (title screen + gameplay journeys).
//
// The app registers its service worker on localhost too, and the FIRST-install
// claim reloads the page (correct on real boots: the page should be
// SW-controlled). Under CI/parallel-worker timing that reload can land in the
// middle of a spec — "Execution context was destroyed, most likely because of
// a navigation" — detaching the DOM between steps (bit the gameplay journeys
// on 2026-07-10 and the titleScreen spec on 2026-07-11). Interaction specs
// therefore neutralize SW registration; the boot smoke spec deliberately does
// NOT use this helper, so booting WITH the service worker stays covered.

import { readFileSync } from 'node:fs';

export async function prepareInteractionSpec(page) {
  await page.addInitScript(() => {
    // Onboarded user lands straight on the title (skips the tutorial overlay).
    try { localStorage.setItem('minesweeper_onboarded', 'true'); } catch {}
    // Never-resolving register(): no SW, no first-install claim, no mid-spec
    // reload. The boot gate treats an absent registration as "nothing to
    // update" and proceeds.
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => new Promise(() => {});
    }
  });
}

/**
 * Wait until every in-flight FINITE animation and transition has finished,
 * then let one more frame land.
 *
 * Any spec that measures geometry needs this. The app animates the things
 * those specs measure: the start-here label rides a 0.5s `fade-in-start`
 * that translates it from -80% to -100% of its own height, and revealed
 * cells run their per-theme reveal choreography. Sampling a rect mid-flight
 * reads a position the layout does not actually hold, and — the part that
 * makes it a FLAKE rather than a plain failure — two samples taken at
 * different animation phases disagree by an amount that depends purely on
 * how loaded the machine was. That is why these specs passed alone and
 * failed in a full parallel run (root-caused 2026-07-18; the start-here
 * label was drifting ~0.15px per sample down the tail of its ease-out, and
 * a slow enough run pushed the gap past the spec's tolerance).
 *
 * INFINITE animations are skipped deliberately: theme-effect particles and
 * the worm crawl never finish, so awaiting them would hang forever.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function settleAnimations(page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => {
      const timing = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming();
      return timing && timing.iterations !== Infinity;
    });
    // A cancelled animation rejects its finished promise; that still counts
    // as "no longer moving", so swallow it.
    await Promise.all(finite.map((a) => a.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  });
}

/**
 * The first LIVE board in the match library, in page order, as the
 * `?matchboard=P:I` pin plus the stored entry itself for assertions.
 *
 * FOUND rather than assumed at 0:0: since the tombstone eviction
 * (2026-08-15) a slot may hold `{ evicted, seed }` with no payload, and a
 * spec pinned to a stub waits forever for a board the deal correctly
 * refuses to install.
 */
export function firstLiveMatchPin() {
  for (let p = 0; p < 5000; p++) {
    let page;
    try {
      page = JSON.parse(readFileSync(new URL(
        `../../scripts/data/match-library/match-${String(p).padStart(3, '0')}.json`,
        import.meta.url), 'utf8'));
    } catch {
      break;
    }
    const idx = page.boards.findIndex((b) => b && !b.evicted);
    if (idx >= 0) return { page: p, idx, board: page.boards[idx] };
  }
  throw new Error('no live board found in the match library');
}
