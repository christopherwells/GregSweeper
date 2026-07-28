import { test, expect } from '@playwright/test';

// Boot / console-error smoke gate (Layer 3). The cheapest guard against a
// "module broke and the screen is white" ship — the failure class the pure
// node tests cannot see (a broken import or a top-level throw in any of the ~20
// ui/ modules). It works BECAUSE the codebase routes faults through
// reportCaughtError and keeps a single intentional console.error (the boot
// net), so a console.error / pageerror here is signal, not noise.
//
// ?isTest=1 → isTestEnvironment() short-circuits every Firebase WRITE — and,
// since the 2026-07-06 orphan incident, the anonymous-auth MINT — while
// leaving reads live, so a boot exercises the real init path without
// polluting production. Each entry drives one interaction so first-render
// runs. EVERY entry must carry isTest=1: plain localhost is NOT a test
// environment (env.js), so an entry without it boots fully ungated against
// production (the crux entry shipped that way until 2026-07-06).

const ENTRIES = [
  { name: 'title screen', q: '?isTest=1' },
  { name: 'daily deep link', q: '?isTest=1&mode=daily' },
  { name: 'weekly deep link', q: '?isTest=1&mode=weekly' },
  { name: 'timed deep link', q: '?isTest=1&mode=timed' },
  { name: 'crux teaser route', q: '?crux=2026-06-01&isTest=1' },
  // ?report= (PR B): a real finding id and a bogus one — the bogus id
  // must fall back to the journal index, never a white screen.
  { name: 'journal report route', q: '?report=sonarCellCount&isTest=1' },
  { name: 'journal report fallback (unknown id)', q: '?report=notAFeature&isTest=1' },
  // Every tiling (2026-07-27). No tiling board had ever had a boot gate, and
  // there are now SIX renderer paths behind ?coastline= — each one generating a
  // certified board and laying out per-cell clip-paths at first render. That is
  // exactly the white-screen class this file exists for, and it is the one
  // surface where a broken build would look fine to every pure test: the four
  // Laves tilings certify by CONSTRUCTION, so a generation fault surfaces as a
  // hang or a throw at boot rather than as a failing assertion.
  { name: 'coastline 4.8.8', q: '?isTest=1&coastline=1' },
  { name: 'coastline hex', q: '?isTest=1&coastline=hex' },
  { name: 'coastline cairo', q: '?isTest=1&coastline=cairo' },
  { name: 'coastline floret', q: '?isTest=1&coastline=floret' },
  { name: 'coastline rhombille', q: '?isTest=1&coastline=rhombille' },
  { name: 'coastline deltoidal', q: '?isTest=1&coastline=deltoidal' },
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

// REGRESSION: 2026-07-06 auth-orphan incident. Only Firebase WRITES were
// isTestEnvironment()-gated; the boot-time anonymous sign-in was not, so
// every fresh-context boot here minted a real anonymous user in production
// Firebase Auth (~9 orphans per CI run since the harness shipped). The mint
// is the identitytoolkit accounts:signUp request — a test session must
// never fire one.
function attachMintCapture(page) {
  const mints = [];
  page.on('request', (req) => {
    if (req.url().includes('accounts:signUp')) mints.push(req.url());
  });
  return mints;
}

for (const { name, q } of ENTRIES) {
  test(`boots clean: ${name} (${q})`, async ({ page }) => {
    const errors = attachErrorCapture(page);
    const mints = attachMintCapture(page);
    await page.goto(q);
    // App is interactive once the boot overlay yields to the title screen, the
    // in-game app, or (for the crux/report routes) their standalone pages.
    await page.waitForSelector(
      '#title-screen:not(.hidden), #app:not(.hidden), #crux-teaser:not(.hidden), #journal-report:not(.hidden)',
      { timeout: 20_000 },
    );
    // Give any first-render microtasks a beat to flush a late throw.
    await page.waitForTimeout(300);
    expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
    expect(mints, `anonymous-auth mint fired in a test session:\n${mints.join('\n')}`).toEqual([]);
  });
}
