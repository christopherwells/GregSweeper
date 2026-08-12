// A themed background under a HARDCODED foreground is the contrast defect
// class this test pins.
//
// REGRESSION: .checkpoint-resume-btn (the Climb's "Resume Game" button, and
// the Challenge sheet's "Resume run" button — matchSetup.js reuses the class)
// paired `background: var(--color-accent)` with `color: #fff`. Measured
// through the frozen probe (scripts/theme-style-probe.html) that pairing read
// 1.30:1 on chalkboard and 1.37:1 on matrix against a 4.5:1 text floor, and
// its 0.85-opacity sublabel read 1.25:1. Only classic cleared the floor, and
// only on the main label — the exact "clears it on the default theme" trap
// CLAUDE.md's Theme System section names. The fix moved it to the selected-
// chip idiom .match-start-btn already uses: an accent BORDER plus the glow
// over the hidden-cell fill, with color: var(--color-text), which cannot
// desynchronize from the theme because both sides come from the same palette.
//
// WHAT THIS TEST CAN AND CANNOT DO. A contrast RATIO is a paint question and
// node cannot answer it: it needs a resolved cascade, ancestor compositing,
// and accumulated opacity. Those numbers come from the browser probe and are
// recorded in the PR body, not here. What IS statically decidable, and what
// this test decides, is the PATTERN that produces the failure: a background
// drawn from a theme token while the foreground is a fixed literal. A themed
// accent lands at any lightness across the 26 themes; a literal foreground
// cannot follow it. So the pairing is a defect wherever it appears, and that
// is checkable from source alone.
//
// The allowlist below is DEBT, not permission. Fourteen selectors still carry
// the pairing (see the PR that added this file); they were left alone because
// the fix was scoped to the resume button. The third test keeps the list
// honest: fixing one of them REQUIRES deleting its entry, so the list can
// never rot into a blanket that quietly re-permits the pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const CSS_FILES = [
  'src/styles/global.css',
  ...readdirSync(new URL('src/styles/themes/', root))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `src/styles/themes/${f}`),
];

// A foreground that cannot follow the theme: a literal color, not a var()
// and not one of the keywords that defer to context.
const LITERAL_COLOR = /^(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|white\b|black\b)/;

/**
 * Rule extractor. Comments are stripped first, then @keyframes blocks (their
 * percentage stops are animation frames, not surfaces a reader sits in front
 * of). The remaining text is walked by brace depth so rules nested in a
 * @media/@supports block are collected with their own selector rather than
 * their at-rule's.
 */
function extractRules(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Drop @keyframes and their bodies (one level of nesting inside).
  const noFrames = noComments.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

  const rules = [];
  let depth = 0;
  let buf = '';
  let selector = '';
  for (const ch of noFrames) {
    if (ch === '{') {
      if (depth === 0 || /^\s*@/.test(buf)) {
        // Opening an at-rule wrapper: its "selector" is discarded.
        if (/^\s*@/.test(buf) && depth === 0) { buf = ''; depth++; continue; }
        selector = buf.trim();
        buf = '';
        depth++;
        continue;
      }
      selector = buf.trim();
      buf = '';
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (selector) rules.push({ selector, body: buf });
      buf = '';
      selector = '';
      continue;
    }
    buf += ch;
  }
  return rules;
}

/** Rules pairing a var()-driven background with a literal foreground. */
function findThemedBgLiteralFg(css) {
  const hits = [];
  for (const { selector, body } of extractRules(css)) {
    const bg = body.match(/(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/);
    const fg = body.match(/(?:^|[;\s])color\s*:\s*([^;]+)/);
    if (!bg || !fg) continue;
    const bgVal = bg[1].trim();
    const fgVal = fg[1].replace(/!important/g, '').trim();
    if (!/var\(--/.test(bgVal)) continue;
    if (!LITERAL_COLOR.test(fgVal)) continue;
    hits.push({ selector, background: bgVal, color: fgVal });
  }
  return hits;
}

const ALL_HITS = CSS_FILES.flatMap((f) =>
  findThemedBgLiteralFg(read(f)).map((h) => ({ ...h, file: f }))
);

// Selectors that still pair a themed background with a literal foreground.
// Each is real debt measured by nobody yet; this file does not bless them, it
// records them so a NEW one cannot slip in unnoticed. `.skill-cell
// .skill-mystery` is the one entry governed by a different rule (CLAUDE.md's
// special-cell legibility floors let a MARKER keep its identity hue), and it
// is listed here for the same reason as the rest: so the count cannot drift.
const KNOWN_LITERAL_FOREGROUNDS = [
  '.crux-cell.crux-found',
  '.next-move-label',
  '.clear-cache-btn:hover',
  '.clear-cache-btn:active',
  '.lb-scope-toggle .leaderboard-tab.active',
  '.friends-btn-primary',
  '.action-btn.primary',
  '.action-btn.share-btn',
  '.about-photo-fallback',
  '.level-up-toast',
  '.share-copied-toast',
  '.molt-earned-done',
  '.archive-day.completed',
  '.skill-cell.skill-mystery',
];

test('REGRESSION: .checkpoint-resume-btn never puts a fixed foreground on a themed background', () => {
  const offenders = ALL_HITS.filter((h) => h.selector.includes('checkpoint-resume-btn'));
  assert.deepEqual(
    offenders,
    [],
    'The resume button measured 1.30:1 on chalkboard with color:#fff over the accent. '
      + 'Use the .match-start-btn idiom: accent border + glow over var(--color-cell-hidden), '
      + 'foreground var(--color-text). Found: ' + JSON.stringify(offenders, null, 2)
  );

  // Non-vacuity: the scanner must actually SEE this rule, or the assertion
  // above would pass on a typo in the selector name just as happily.
  const resumeRules = CSS_FILES.flatMap((f) => extractRules(read(f)))
    .filter((r) => r.selector === '.checkpoint-resume-btn');
  assert.equal(resumeRules.length, 1, 'scanner lost sight of .checkpoint-resume-btn');
  assert.match(resumeRules[0].body, /color:\s*var\(--color-text\)/);
  assert.match(resumeRules[0].body, /background:\s*var\(--color-cell-hidden\)/);
});

test('no NEW themed-background rule ships a hardcoded foreground', () => {
  const unexpected = ALL_HITS.filter(
    (h) => !KNOWN_LITERAL_FOREGROUNDS.includes(h.selector)
  );
  assert.deepEqual(
    unexpected,
    [],
    'A themed background under a literal foreground cannot hold its contrast across 26 themes. '
      + 'Either take the foreground from the palette too (var(--color-text)), or keep the accent '
      + 'as a BORDER over a neutral fill (the .match-start-btn idiom). New offenders:\n'
      + JSON.stringify(unexpected, null, 2)
  );
});

test('the known-offender list stays honest (no stale entries)', () => {
  const live = new Set(ALL_HITS.map((h) => h.selector));
  const stale = KNOWN_LITERAL_FOREGROUNDS.filter((s) => !live.has(s));
  assert.deepEqual(
    stale,
    [],
    'These selectors no longer pair a themed background with a literal foreground, so they '
      + 'must be REMOVED from KNOWN_LITERAL_FOREGROUNDS — a list that outlives its entries '
      + 'silently re-permits the pattern it exists to catch:\n' + JSON.stringify(stale, null, 2)
  );
});
