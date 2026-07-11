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
