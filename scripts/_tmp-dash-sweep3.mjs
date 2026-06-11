import fs from 'node:fs';
const edits = {
  'src/game/winLossHandler.js': [
    ['`${unlock.category} — ${unlock.tier.charAt(0).toUpperCase()', '`${unlock.category} · ${unlock.tier.charAt(0).toUpperCase()'],
    ['`Time: ${precise.toFixed(1)}s — ${rating.icon} ${rating.name}!`', '`Time: ${precise.toFixed(1)}s · ${rating.icon} ${rating.name}!`'],
    ['First attempt this week — set the bar at', 'First attempt this week. You set the bar at'],
    ["'📡 Saved — uploads when you reconnect'", "'📡 Saved. Uploads when you reconnect'"],
  ],
  'src/logic/gimmicks.js': [
    ['Treat walls like the edge of the board — they split the grid into sections.', 'Treat walls like the edge of the board: they split the grid into sections.'],
    ["The cell is safe — it just won\\'t tell you its count.", "The cell is safe, it just won\\'t tell you its count."],
    ['Flag mines quickly to pin them in place — flagged mines never move.', 'Flag mines quickly to pin them in place. Flagged mines never move.'],
    ['Locked cells may contain mines — be careful when they unlock!', 'Locked cells may contain mines, so be careful when they unlock!'],
  ],
  'src/main.js': [
    ["'No fits yet — first row lands after the next refit run.'", "'No fits yet. The first row lands after the next refit run.'"],
    ["'(seed-residuals fallback — no posterior this refit)'", "'(seed-residuals fallback, no posterior this refit)'"],
    ["section('Skill feats — certified by the board', feats)", "section('Skill feats (certified by the board)', feats)"],
    ['`${getThemeEmoji(\'mine\')} GregSweeper — Timed ${levelLabel}\\n`', '`${getThemeEmoji(\'mine\')} GregSweeper · Timed ${levelLabel}\\n`'],
    ['`${rating.icon} ${rating.name} — ${time}s (${diff.rows}×${diff.cols})${tierText}\\n\\n`', '`${rating.icon} ${rating.name} · ${time}s (${diff.rows}×${diff.cols})${tierText}\\n\\n`'],
    ['`${getThemeEmoji(\'mine\')} GregSweeper — ${modeLabel}\\n`', '`${getThemeEmoji(\'mine\')} GregSweeper · ${modeLabel}\\n`'],
    ['`Level ${cp}–${Math.min(', '`Level ${cp}-${Math.min('],
    ['Signing in here will switch this device to that account — your phone', 'Signing in here will switch this device to that account. Your phone'],
    ["'Popup blocked — try again or use email link'", "'Popup blocked. Try again or use the email link'"],
    ['Your synced progress stays with your account — sign in again to bring it', 'Your synced progress stays with your account. Sign in again to bring it'],
    ["'Couldn\\'t copy — long-press the ID and Copy manually'", "'Couldn\\'t copy. Long-press the ID and Copy manually'"],
    ["showToast(submitOk ? '✅ Score submitted!' : '📡 Saved — uploads when you reconnect')", "showToast(submitOk ? '✅ Score submitted!' : '📡 Saved. Uploads when you reconnect')"],
    ["'Notifications on — see you tomorrow!'", "'Notifications on. See you tomorrow!'"],
    ['"That name isn\'t allowed — please pick another."', '"That name isn\'t allowed. Please pick another."'],
    ["'Notifications are blocked in your browser settings — enable them there to use this.'", "'Notifications are blocked in your browser settings. Enable them there to use this.'"],
    ["'⚠️ Playing in temporary mode — progress won\\'t be saved'", "'⚠️ Playing in temporary mode: progress won\\'t be saved'"],
  ],
  'src/state/gameState.js': [
    ["'Shake it off — next board\\'s yours.'", "'Shake it off. Next board\\'s yours.'"],
  ],
  'src/ui/dailyHistoryChart.js': [
    ["'No daily history yet — play a daily to start your timeline.'", "'No daily history yet. Play a daily to start your timeline.'"],
  ],
  'src/ui/diagnosticsModal.js': [
    ["'Copy failed — long-press to select'", "'Copy failed. Long-press to select'"],
  ],
  'src/ui/headerRenderer.js': [
    ['`${def.icon} ${def.name} — ${def.desc || \'\'}`', '`${def.icon} ${def.name}: ${def.desc || \'\'}`'],
  ],
  'src/ui/lexiconUI.js': [
    ["'Could not build a lesson board — please try again'", "'Could not build a lesson board. Please try again'"],
  ],
  'src/ui/receiptRenderer.js': [
    ["'🔍 The lens works mid-game — start revealing first'", "'🔍 The lens works mid-game. Start revealing first'"],
  ],
  'src/ui/statsRenderer.js': [
    ["'Handicap trajectory — career average and last-10-play rolling'", "'Handicap trajectory: career average and last-10-play rolling'"],
  ],
};
let n = 0, miss = 0;
for (const [file, pairs] of Object.entries(edits)) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) {
    if (s.includes(a)) { s = s.split(a).join(b); n++; }
    else { console.error('MISS ' + file + ': ' + a.slice(0, 70)); miss++; }
  }
  fs.writeFileSync(file, s, 'utf8');
}
console.log('applied ' + n + ', missed ' + miss);
