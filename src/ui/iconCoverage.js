// Coverage manifest for the emoji-to-sprite migration.
// Every emoji glyph that appears in the app's UI belongs to exactly one
// of three buckets:
//   SPRITE   — replaced by a drawn SVG via the spriteLoader system
//   PLAIN    — intentionally kept as emoji (plain-text contexts, numbers, etc.)
//   DEFERRED — not yet drawn; tracked so we know what's left
//
// The CI test (test/iconCoverage.test.mjs) validates that every SPRITE
// entry has a matching file on disk and a SPRITES registry entry in
// spriteLoader.js. Adding a raw emoji to the app without listing it
// here will fail the test.

export const ICON_STATUS = {
  // ── Game objects (Tier 1 sprites, PNG) ──
  '💣': 'sprite',   // mine
  '🚩': 'sprite',   // flag
  '😊': 'sprite',   // smiley idle (Greg)
  '😎': 'sprite',   // smiley win
  '😵': 'sprite',   // smiley loss
  '💥': 'sprite',   // strike / explosion

  // ── Mode cards (Tier 3, SVG) ──
  '⛏️': 'sprite',   // challenge
  '⏱️': 'sprite',   // quick play / timed
  '📅': 'sprite',   // daily
  '🏁': 'sprite',   // weekly
  '🌀': 'sprite',   // chaos (also wormhole modifier)
  '🏋️': 'sprite',   // gym

  // ── Power-ups (Tier 3, SVG) ──
  '🔍': 'sprite',   // reveal safe
  '🛡️': 'sprite',   // shield
  '🧲': 'sprite',   // magnet
  '📡': 'sprite',   // scan (also sonar modifier)
  '🔬': 'sprite',   // x-ray

  // ── Medals (Tier 3, SVG) ──
  '🥉': 'sprite',   // bronze
  '🥈': 'sprite',   // silver
  '🥇': 'sprite',   // gold
  '💎': 'sprite',   // diamond
  '💚': 'sprite',   // emerald

  // ── Modifier icons (Wave A, SVG) ──
  '🧱': 'sprite',   // walls
  '🤥': 'sprite',   // liar
  '❓': 'sprite',   // mystery
  '💨': 'sprite',   // mine shift
  '🔒': 'sprite',   // locked
  '🪞': 'sprite',   // mirror
  '🔴': 'sprite',   // pressure plate
  '🧭': 'sprite',   // compass

  // ── Achievement category icons (Wave B, SVG) ──
  // Rendered by category id (achievementSpriteImgHTML), so the glyph is
  // only a fallback. 📅 / ⛏️ / ⏱️ are shared with mode cards (already
  // 'sprite' above); 🔥 stays 'plain' below (also used as streak fire).
  '🏆': 'sprite',   // wins / Victory
  '⚡': 'sprite',   // speed / Speed Demon
  '🏳️': 'sprite',   // flagless
  '🎯': 'sprite',   // efficient / No Wasted Clicks
  '🧮': 'sprite',   // tankCommander / Tank Commander
  '🕵️': 'sprite',   // lieDetector / Lie Detector
  '💪': 'sprite',   // purist / Fearless
  '🎪': 'sprite',   // gimmickMaster / Modifier Master
  '📆': 'sprite',   // dailyStreak / Daily Devotee

  // ── Chrome / nav / indicators (Wave C, SVG) ──
  // Rendered by key (uiSpriteImgHTML / static <img>), so the glyph is a
  // fallback. ❓ (help) and 🏆 (leaderboard) reuse the 'sprite' rows above.
  '🏠': 'sprite',   // home
  '⚙️': 'sprite',   // settings gear
  '📊': 'sprite',   // stats / progress
  '🎨': 'sprite',   // collection (nav)
  '🎁': 'sprite',   // collection (sheet — unified to one icon)
  '🔊': 'sprite',   // sound on
  '🔇': 'sprite',   // muted
  '▶️': 'sprite',   // replay / resume
  '🔄': 'sprite',   // check for updates
  '🗑️': 'sprite',   // reset profile
  '🌐': 'sprite',   // delete data (server)
  '🐛': 'sprite',   // report a problem
  '💛': 'sprite',   // sponsor
  '🔬': 'sprite',   // diagnostics (own icon; X-ray power-up keeps pow-xray)
  '📋': 'sprite',   // what's new
  '⏸': 'sprite',    // idle / paused
  '🔔': 'sprite',   // notifications on
  '🔕': 'sprite',   // notifications off
  '×':  'sprite',   // close / friend-remove (&times; entity)
  '🏅': 'sprite',   // Achievements sheet row (renders the medal sprite; emoji is the onerror fallback)
  'ℹ️': 'sprite',   // About row (renders Greg's sprite; emoji is the onerror fallback)

  // ── Plain-text / intentional emoji ──
  // These appear in share cards, toast messages, or semantic contexts
  // where an SVG sprite would be wrong (copy-paste, accessibility).
  '🔥': 'plain',    // streak fire
  '🤔': 'plain',    // lens / stuck button
  '🦀': 'plain',    // molt day crab
  '✨': 'plain',    // modifier primer intro
  '🧩': 'plain',    // modifier recap intro
  '✓':  'plain',    // certified chip (text, not emoji)

  // Transient text — toasts, gym headers, receipts, diagnostics, status
  // dots. Emoji inline in a text message, where a sprite would be wrong.
  '✅': 'plain',    // success checkmark (save / submit toasts, receipts)
  '❤️': 'plain',    // lifeline (toast text + power-up onerror fallback)
  '🎉': 'plain',    // new-record toast
  '⚠️': 'plain',    // warning toasts
  '⏳': 'plain',    // loading / pending
  '📱': 'plain',    // install / add-to-home-screen hint
  '🟢': 'plain',    // status dot (online)
  '⚪': 'plain',    // status dot (idle)
  '↔️': 'plain',    // sync direction (status text)
  '★':  'plain',    // diagnostics star (text)
  '📓': 'plain',    // Greg's Gym field notebook header
  '📌': 'plain',    // gym pinned note
  '🤷': 'plain',    // receipt copy
};
