// Test-environment detector.
//
// Returns true on the test deployment, false on production. Used by
// every Firebase WRITE entry point to short-circuit before touching
// production data. Reads pass through unchanged — leaderboards,
// dailyMeta, and the canonical daily/weekly boards still display so
// the test branch plays a full game, just without persisting anything.
//
// We deploy via a GH Actions workflow that publishes the test branch
// at /<repo>/test/ on the same github.io host as master, so the
// detection has to be path-based (NOT hostname-based). The legacy
// hostname check stays in for the Cloudflare Pages path in case we
// ever switch hosts.

export function isTestEnvironment() {
  if (typeof location === 'undefined') return false;
  // Cloudflare Pages preview (legacy path).
  if (location.hostname.endsWith('.pages.dev')) return true;
  // GH Pages subdirectory deploy — test branch publishes at
  // /<repo>/test/. Master root never has a `test` path segment, so
  // checking for it as a discrete segment is unambiguous.
  if (location.pathname.split('/').includes('test')) return true;
  // Manual override for local dev (`?isTest=1`).
  try {
    return new URLSearchParams(location.search).get('isTest') === '1';
  } catch {
    return false;
  }
}
