// Static audit of the per-theme objects + moments contract (CLAUDE.md
// "Per-theme objects + moments contract" + grout-contrast HARD rule).
// Cross-references the four registries a theme participates in:
//   - THEME_UNLOCKS (themeManager.js): objects (mine/flag/strikeCell)
//   - THEME_EFFECTS (themeEffects.js): ambient effect -> grout REQUIRED
//   - THEME_PARTICLE_COLORS (effectsRenderer.js): win confetti palette
//   - src/styles/themes/<theme>.css: --cell-gap-seal + reveal keyframes
// Static layer only — computed-style floors (luminance delta, marker
// contrast) are the browser probe's job. Run: node scripts/audit-theme-contract.mjs

import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(p, 'utf8');

const themeManager = read('src/ui/themeManager.js');
const themeEffects = read('src/ui/themeEffects.js');
const effectsRenderer = read('src/ui/effectsRenderer.js');

// THEME_UNLOCKS entries: key + fields
const unlocks = {};
const unlockBlock = themeManager.match(/THEME_UNLOCKS = \{([\s\S]*?)\n\};/)[1];
for (const m of unlockBlock.matchAll(/^\s*(\w+):\s*\{([^}]*)\}/gm)) {
  unlocks[m[1]] = {
    strikeCell: /strikeCell:/.test(m[2]),
  };
}

// THEME_EFFECTS keys: `  <key>: (container) =>` entries inside the object
const effectsBlock = themeEffects.match(/const THEME_EFFECTS = \{([\s\S]*?)\n\};/)[1];
const effectThemes = [...effectsBlock.matchAll(/^  (\w+):\s*\(/gm)].map(m => m[1]);

// Win-confetti palette keys (the local `themeColors` object inside
// showConfettiBurst — CLAUDE.md's THEME_PARTICLE_COLORS name is the
// intended extraction, not yet real).
const particleMatch = effectsRenderer.match(/const themeColors = \{([\s\S]*?)\n  \};/);
const particleThemes = particleMatch
  ? [...particleMatch[1].matchAll(/^\s*'?([\w-]+)'?:\s*\[/gm)].map(m => m[1])
  : [];

// Theme CSS files: gap-seal + bespoke reveal keyframes
const themesDir = 'src/styles/themes';
const css = {};
for (const f of fs.readdirSync(themesDir).filter(f => f.endsWith('.css'))) {
  const name = path.basename(f, '.css');
  const text = read(path.join(themesDir, f));
  css[name] = {
    gapSeal: /--cell-gap-seal\s*:/.test(text),
    revealKeyframes: /@keyframes\s+\w*[Rr]eveal|animation-name:\s*\w+(Reveal|Print|Bleed|Pop|Scrawl|Flicker|Bloom|Flip|Power)/.test(text)
      || /num-pop[\s\S]{0,200}?animation/.test(text),
  };
}

let failures = 0;
const fail = (msg) => { console.log('FAIL  ' + msg); failures++; };
const warn = (msg) => console.log('warn  ' + msg);

console.log(`themes in THEME_UNLOCKS: ${Object.keys(unlocks).length}`);
console.log(`themes with effects:     ${effectThemes.length} (${effectThemes.join(', ')})`);
console.log(`confetti palettes:       ${particleThemes.length}`);
console.log('');

for (const theme of Object.keys(unlocks)) {
  const c = css[theme] || {};
  const hasEffect = effectThemes.includes(theme);
  // HARD RULE: every effect theme must set its own contrasting grout.
  if (hasEffect && !c.gapSeal) {
    fail(`${theme}: registered in THEME_EFFECTS but its CSS never sets --cell-gap-seal (slab grout)`);
  }
  // Contract minimum for any theme carrying a world treatment (effect or
  // bespoke strikeCell): confetti palette entry.
  if ((hasEffect || unlocks[theme].strikeCell) && !particleThemes.includes(theme)) {
    fail(`${theme}: world-treatment theme with no THEME_PARTICLE_COLORS confetti palette`);
  }
  // Reveal-moment kit: themes with a world treatment should ship bespoke
  // reveal choreography (warn — base themes legitimately use the default).
  if ((hasEffect || unlocks[theme].strikeCell) && css[theme] && !c.revealKeyframes) {
    warn(`${theme}: world-treatment theme without bespoke reveal keyframes`);
  }
}

// Orphans: registry entries pointing at themes that don't exist.
for (const t of effectThemes) if (!unlocks[t]) fail(`THEME_EFFECTS has unknown theme "${t}"`);
for (const t of particleThemes) if (!unlocks[t] && t !== 'default') warn(`THEME_PARTICLE_COLORS has unknown theme "${t}"`);
for (const t of Object.keys(unlocks)) if (!css[t]) fail(`${t}: no CSS file in src/styles/themes/`);

console.log('');
console.log(failures === 0 ? 'CONTRACT CLEAN (static layer)' : `${failures} static contract failure(s)`);
process.exit(failures === 0 ? 0 : 1);
