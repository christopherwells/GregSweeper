// Test-environment detector.
//
// True when the page is served from a Cloudflare Pages preview
// (test.gregsweeper.pages.dev or similar), OR when the URL carries
// ?isTest=1 (manual override for local dev). Used by every Firebase
// WRITE entry point to short-circuit before touching production data.
// Reads pass through unchanged — leaderboards, dailyMeta, and the
// canonical daily/weekly boards still display so the test branch
// plays a full game, just without persisting anything.
//
// The guard also matters for the canonical-board WRITE fallbacks
// (saveDailyBoard / saveWeeklyBoard) since test-branch code could
// generate a slightly different board layout than master and clobber
// the production canonical via the fire-and-forget save path.

export function isTestEnvironment() {
  if (typeof location === 'undefined') return false;
  if (location.hostname.endsWith('.pages.dev')) return true;
  try {
    return new URLSearchParams(location.search).get('isTest') === '1';
  } catch {
    return false;
  }
}
