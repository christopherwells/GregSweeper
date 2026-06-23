import { test, expect } from '@playwright/test';

// Boot / console-error smoke gate (Layer 3). The cheapest guard against a
// "module broke and the screen is white" ship — the failure class the pure
// node tests cannot see (a broken import or a top-level throw in any of the ~20
// ui/ modules). It works BECAUSE the codebase routes faults through
// reportCaughtError and keeps a single intentional console.error (the boot
// net), so a console.error / pageerror here is signal, not noise.
//
// ?isTest=1 → isTestEnvironment() short-circuits every Firebase WRITE while
// leaving reads live, so a boot exercises the real init path without polluting
// production. Each entry drives one interaction so first-render runs.

const ENTRIES = [
  { name: 'title screen', q: '?isTest=1' },
  { name: 'daily deep link', q: '?isTest=1&mode=daily' },
  { name: 'weekly deep link', q: '?isTest=1&mode=weekly' },
  { name: 'timed deep link', q: '?isTest=1&mode=timed' },
  { name: 'crux teaser route', q: '?crux=2026-06-01' },
];

// Substrings of console output that are known-benign and NOT app faults. Keep
// this list tiny; never broaden it to silence a real error. (Warnings aren't
// captured below, but a matching pageerror/error would be filtered here.)
const ALLOW = [];

function attachErrorCapture(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (ALLOW.some((a) => text.includes(a))) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

for (const { name, q } of ENTRIES) {
  test(`boots clean: ${name} (${q})`, async ({ page }) => {
    const errors = attachErrorCapture(page);
    await page.goto(q);
    // App is interactive once the boot overlay yields to the title screen, the
    // in-game app, or (for the crux route) the standalone teaser.
    await page.waitForSelector(
      '#title-screen:not(.hidden), #app:not(.hidden), #crux-teaser:not(.hidden)',
      { timeout: 20_000 },
    );
    // Give any first-render microtasks a beat to flush a late throw.
    await page.waitForTimeout(300);
    expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
  });
}
