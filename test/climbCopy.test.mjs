// The 250-level ladder is "The Climb" to a player. The word "Challenge" now
// belongs to the head-to-head mode, so any player-visible string still using
// it for the ladder is a lie the moment that mode ships.
//
// This is the copy half of a pair. Its sibling, challengeStorageContract, pins
// the nine STORED things that keep the name "challenge" and must never move:
// the runtime mode value is 'normal', the storage name is 'challenge', and the
// module filenames are coupled to sw.js precache paths. So the two tests pull
// in opposite directions on purpose -- this one forbids the word in front of
// the player, that one requires it behind the player -- and together they
// describe exactly where the rename stops.
//
// It follows the modifierCopy discipline: scan the shipped surfaces rather
// than a hand-kept list of strings, so copy added tomorrow is covered without
// anyone remembering to extend a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

// The head-to-head Challenge mode's OWN copy legitimately says "Challenge"
// -- those strings live here rather than weakening the scan. Each entry is an
// exact phrase from that mode's own surfaces, matched against the SOURCE line
// (markup included, which is what makes a short one like the mode-card name
// safe: it can only ever match that one element, never a bare "Challenge"
// written of the ladder somewhere else).
//
// PR 3 (Challenge solo, absorbing Quick Play) filled this hook. Additions
// belong to the mode's own surfaces only; if a phrase here would read as the
// ladder in its own context, it does not belong.
const SANCTIONED_PHRASES = [
  // index.html: the title card, the stats tab, the setup sheet.
  '<div class="mode-card-name">Challenge</div>',
  'data-tab="match" role="tab" aria-selected="false">Challenge<',
  'Challenge setup',
  'Start Challenge',
  // index.html help + stats copy, where the mode is named beside the others.
  'Hitting a mine in Daily, Weekly or Challenge is not the end.',
  '<p><strong>Challenge:</strong> build a run of one to ten boards',
  'Daily, Weekly and Challenge are played clean.',
  'Every board you have finished in a Challenge run.',
  // src: the two share cards' mode maps (each names the ladder correctly in
  // the same line, so the line itself proves the distinction), the text
  // card's headline, and the stats panel's empty state.
  "normal: 'The Climb', match: 'Challenge'",
  "normal: 'THE CLIMB', match: 'CHALLENGE'",
  'GregSweeper · Challenge',
  'Build a Challenge run to see your history!',
  // The head-to-head surfaces (match node, PR 4a). Every one of these names
  // the mode a player joins with a code, never the 250-level ladder, which is
  // the distinction this file exists to keep. Sanctioned line by line rather
  // than by loosening the scan, so the next stretch of copy still has to
  // justify itself.
  'Join a Challenge',
  'Challenge code',
  'A board in this Challenge failed its check',
  'That Challenge run has closed.',
  'You need a connection to join a Challenge.',
  'That Challenge is full.',
  'That Challenge is no longer available.',
  'Could not join that Challenge.',
  'invited you to a Challenge.',
];

// ── index.html: visible text and the attributes a human reads ──────────────

// Blocks are blanked line-for-line so reported line numbers stay true to the
// file. src=/id=/data-* are deliberately NOT read: mode-challenge.svg is a
// precache path and data-tab="challenge" is a wiring key, neither of which a
// player ever sees.
function visibleHtmlLines(html) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script[\s\S]*?<\/script>/gi, blank)
    .replace(/<style[\s\S]*?<\/style>/gi, blank);

  return stripped.split('\n').map((line) => {
    const readable = [...line.matchAll(/\s(?:alt|title|aria-label|placeholder)\s*=\s*"([^"]*)"/gi)]
      .map((m) => m[1]).join(' ');
    return `${line.replace(/<[^>]*>/g, ' ')} ${readable}`;
  });
}

test('REGRESSION: index.html never says "Challenge" where it means the ladder', () => {
  const html = read('index.html');
  const lines = visibleHtmlLines(html);
  const rawLines = html.split('\n');
  const hits = [];
  lines.forEach((text, i) => {
    if (!/challeng/i.test(text)) return;
    // Sanctions match the RAW source line, so a markup-anchored phrase can
    // exempt exactly one element rather than any line reading "Challenge".
    if (SANCTIONED_PHRASES.some((p) => rawLines[i].includes(p))) return;
    hits.push(`index.html:${i + 1}  ${text.trim().slice(0, 110)}`);
  });
  assert.deepEqual(hits, [],
    `player-visible copy still names the ladder "Challenge":\n  ${hits.join('\n  ')}`);
});

// ── src/**/*.js: strings that reach a player ───────────────────────────────

// A code line with its comments removed. The `:` guard keeps `https://` from
// being mistaken for a comment; nothing else in src puts `//` inside a string.
function codeOf(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  return line.replace(/(^|[^:])\/\/.*$/, '$1');
}

// Two shapes of player copy, and neither can be confused with a stored key.
//
//   Capitalised -- "Challenge", "Challenger", "CHALLENGE". The lookahead
//     spares Challenge250, CHALLENGE_MAX_LEVEL and every camelCase identifier,
//     which are code and never reach a player.
//
//   Lowercase inside a sentence -- " challenge link", " challenges completed".
//     The rule is that the word is followed by a space and another lowercase
//     word, or by sentence-ending punctuation. That is sound rather than
//     merely convenient: in JavaScript an identifier followed by a space and
//     a second lowercase identifier is a syntax error, so this shape can only
//     be prose. It leaves every stored use alone, whether quoted
//     ('challenge'), destructured (const { challenge } = ...), a property
//     access (.challenge) or an object key (challenge: 0).
const COPY_PATTERNS = [
  /\bChallenge(?![0-9_A-Za-z])/,
  /\bChallenger\b/,
  /\bCHALLENGE\b/,
  / challenges?(?: [a-z]|[.!?](?![A-Za-z0-9_]))/,
];

test('REGRESSION: no src string names the ladder "Challenge" to a player', () => {
  const srcRoot = new URL('src/', root);
  const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\\/g, '/'))
    .sort();
  assert.ok(files.length > 40, `only ${files.length} src modules scanned -- the walk is broken`);

  const hits = [];
  for (const rel of files) {
    readFileSync(new URL(rel, srcRoot), 'utf8').split('\n').forEach((line, i) => {
      const code = codeOf(line);
      if (!code) return;
      if (SANCTIONED_PHRASES.some((p) => code.includes(p))) return;
      if (COPY_PATTERNS.some((re) => re.test(code))) {
        hits.push(`src/${rel}:${i + 1}  ${code.trim().slice(0, 110)}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    `these strings say "Challenge" and mean the ladder:\n  ${hits.join('\n  ')}`);
});

// ── Non-vacuity: the scan must be looking at real copy ─────────────────────
//
// Both tests above pass on an empty file, so each surface the rename touches
// is named here. Deleting the copy is not a way to make the guard green.

test('the ladder is called The Climb on every surface the rename touched', () => {
  const html = read('index.html');
  const visible = visibleHtmlLines(html).join('\n');

  // The scan has to see a substantial amount of prose, or a broken extractor
  // would report zero hits above for the wrong reason.
  assert.ok(visible.length > 20_000,
    `the html extractor recovered only ${visible.length} chars of visible text`);
  assert.ok(/No guesses/.test(visible), 'the extractor should see the title-screen subtitle');
  assert.ok(/Reveal every safe square/.test(visible), 'the extractor should see the help copy');

  // The three named surfaces, matched on their own markup so a stray mention
  // elsewhere cannot satisfy them.
  assert.match(html, /<div class="mode-card-name">The Climb<\/div>/,
    'the title-screen card must be named The Climb');
  assert.match(html, /id="checkpoint-modal"[\s\S]{0,600}?<h2>[\s\S]{0,300}?The Climb/,
    'the checkpoint selector title must be The Climb');
  assert.match(html, /data-tab="challenge"[^>]*>The Climb</,
    'the stats tab must be labelled The Climb while keeping its data-tab wiring');
});

test('the share surfaces label the ladder The Climb', () => {
  assert.match(read('src/ui/shareActions.js'), /normal:\s*'The Climb'/,
    'the text share card must name the mode The Climb');
  assert.match(read('src/ui/shareCardImage.js'), /normal:\s*'THE CLIMB'/,
    'the image share card must name the mode THE CLIMB');
});

test('the storage name is untouched by the rename', () => {
  // A belt-and-braces echo of challengeStorageContract, here so that anyone
  // reading THIS file learns the boundary without having to find that one.
  const stats = read('src/storage/statsStorage.js');
  assert.match(stats, /'normal'[^\n]{0,40}'challenge'/,
    'getModeKey still maps the runtime mode onto the stored name');
  assert.match(read('src/firebase/firebaseProgress.js'), /challenge250/,
    'the Firebase progression node keeps its name');
});
