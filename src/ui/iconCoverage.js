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

  // ── Wave E chrome (2026-06-24) ──
  // Lens / Share / Copy / Notebook / molt and the ten toast-coach icons
  // render BY KEY (ui-*.svg, no emoji), so they need no entry here. The
  // one survivor is the Lens button's onerror fallback.
  '🤔': 'sprite',   // Stuck button (renders ui-lens.svg; emoji is the onerror fallback)

  // ── Plain-text / intentional emoji ──
  // What's LEFT after the Wave E squish: the share-card caption (kept by
  // design), code comments, and data/onerror fallbacks. Every player-facing
  // render surface is now drawn — the literals below are caption text,
  // comments, or registry fallbacks, not visible chrome.
  '🔥': 'plain',    // streak fire — share-card caption text + achievement data def (UI draws achStreak)
  '🦀': 'plain',    // molt crab — share caption text (UI draws uiMolt)
  '✓':  'plain',    // certified chip (text, not emoji)
  '❤️': 'plain',    // lifeline — onerror fallback (UI draws the powLifeline life-ring)
  '🟢': 'plain',    // pace dot (share caption)
  '⚪': 'plain',    // pace dot (share caption)
  '↔️': 'plain',    // sync direction (code comment)
  '★':  'plain',    // diagnostics star (text)
};
