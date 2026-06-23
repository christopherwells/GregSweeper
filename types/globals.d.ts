// Ambient declarations for the dev/CI typecheck gate (jsconfig checkJs).
// These are real runtime globals with no ES import, so checkJs would otherwise
// flag every use as "Cannot find name". Declaring them `any` keeps the gate
// focused on logic errors, not missing-global noise. Affects nothing at
// runtime — this file is type information only.

// Firebase compat SDK, loaded via CDN <script> tags in index.html.
declare const firebase: any;

interface Window {
  firebase?: any;
  gsTestError?: (label: string) => void;
  sendPrompt?: (text: string) => void;
}
