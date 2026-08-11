// Daily-win "Remind me tomorrow" CTA outcome (pure, node-tested).
//
// enableNotifications (src/firebase/firebasePush.js) resolves to a STRING
// contract: 'success' | 'denied' | 'ios-needs-install' | 'no-key' |
// 'unsupported' | 'token-null' | 'token-error' | 'error'. The win-modal CTA
// used to test `result === true || result === 'ok'`, two values the
// contract never returns, so even a fully successful enable fell through
// to the "Try again" branch and the best conversion moment in the app
// always looked like a failure (2026-07-10 audit). The Settings toggle
// compared against 'success' correctly; this helper is now the one mapping
// both surfaces can share.

/**
 * @param {*} result the enableNotifications resolution
 * @returns {'enabled'|'install'|'blocked'|'retry'}
 */
export function remindCtaOutcome(result) {
  if (result === 'success') return 'enabled';
  if (result === 'ios-needs-install') return 'install';
  if (result === 'denied') return 'blocked';
  return 'retry';
}
