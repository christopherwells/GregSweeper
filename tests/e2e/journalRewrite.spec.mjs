// The journal's nightly AI rewrite, at the render layer (2026-08-11;
// v2 same day: sections + a per-feature artifact map). The pure guards
// (hash keying, validator, arcSpoken re-detection, carry-forward) are
// node-tested in test/journalRewrite.test.mjs; what only a browser can
// pin is the WIRING: journalView renders the three sections, really
// fetches the artifact map, really swaps a fresh paragraph into the
// hero card AND into a section row's expansion, and really falls back
// to the beat assembly when a hash disagrees. The specs drive the real
// More-sheet path and intercept only the artifact fetch, so the
// entries under test are the ones the shipped code composes from the
// repo's own modelHistory.json.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepareInteractionSpec } from './helpers.mjs';
import { planJournalScreen } from '../../src/logic/journalProse.js';
import {
  MIN_SOURCE_CHARS, buildRewriteArtifact, buildRewriteEntry,
} from '../../src/logic/journalRewrite.js';
import { splitSentences } from '../../src/logic/proseRails.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function composeScreen() {
  const history = JSON.parse(readFileSync(join(ROOT, 'src/logic/modelHistory.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(ROOT, 'src/logic/experimentTarget.json'), 'utf8'));
  return planJournalScreen(history, meta);
}

// A paragraph that is VALID (same sentences, so every rail and digit
// holds) but visibly different from the beat assembly: the sentences in
// reverse order. If reversal happens to be a no-op (a one-sentence
// entry), the caller skips rather than asserting nothing.
function reversedParagraph(text) {
  return splitSentences(text).reverse().join(' ');
}

async function openJournal(page) {
  await page.goto('/?isTest=1');
  await page.click('#title-more-btn');
  await page.click('#sheet-journal-btn');
  await expect(page.locator('#journal-modal')).toBeVisible();
}

function fulfillArtifact(artifact) {
  return route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(artifact),
  });
}

test.describe('journal sections and rewrite rendering', () => {
  test.beforeEach(async ({ page }) => {
    await prepareInteractionSpec(page);
  });

  test('the three sections render, and fresh records swap into the hero and a row expansion', async ({ page }) => {
    const screen = composeScreen();
    test.skip(!screen?.active?.entry?.text, 'no active study in the shipped history');
    const heroRewritten = reversedParagraph(screen.active.entry.text);
    test.skip(heroRewritten === screen.active.entry.text, 'one-sentence hero: reversal proves nothing');

    // A row target from any section, long enough to carry a record.
    const rows = [...screen.revisit, ...screen.closed, ...screen.collecting];
    const rowTarget = rows.find(r => r.entry.text.length >= MIN_SOURCE_CHARS
      && reversedParagraph(r.entry.text) !== r.entry.text);
    const entries = {
      [screen.active.study.feature]: buildRewriteEntry(screen.active.entry.text, heroRewritten),
    };
    if (rowTarget) {
      entries[rowTarget.study.feature] = buildRewriteEntry(
        rowTarget.entry.text, reversedParagraph(rowTarget.entry.text),
      );
    }
    await page.route('**/src/logic/journalRewrite.json',
      fulfillArtifact(buildRewriteArtifact({ date: '2099-01-01', entries, extra: { model: 'e2e' } })));

    await openJournal(page);

    // His three section names, rendered whenever their bucket has rows.
    await expect(page.locator('.journal-collecting .journal-section-title')).toHaveText('Collecting data');
    if (screen.revisit.length > 0) {
      await expect(page.locator('.journal-revisit .journal-section-title')).toHaveText('Need to revisit');
      expect(await page.locator('.journal-revisit .journal-ledger-row').count()).toBe(screen.revisit.length);
    }
    if (screen.closed.length > 0) {
      await expect(page.locator('.journal-closed .journal-section-title')).toHaveText('Closed for now');
    }
    expect(await page.locator('.journal-collecting .journal-ledger-row').count()).toBe(screen.collecting.length);

    // The hero swapped to the intercepted paragraph.
    const heroText = await page.locator('.journal-open .journal-entry').innerText();
    expect(heroText).toBe(heroRewritten);

    // And a section row's expansion swapped too.
    if (rowTarget) {
      const row = page.locator('.journal-ledger-row', {
        has: page.locator('.journal-ledger-line', { hasText: rowTarget.line.slice(0, 40) }),
      }).first();
      await row.locator('summary').click();
      const rowText = await row.locator('.journal-entry').innerText();
      expect(rowText).toBe(reversedParagraph(rowTarget.entry.text));
    }
  });

  test('a hash-mismatched record falls back to the beat assembly byte for byte', async ({ page }) => {
    const screen = composeScreen();
    test.skip(!screen?.active?.entry?.text, 'no active study in the shipped history');

    const stale = buildRewriteArtifact({
      date: '2099-01-01',
      entries: {
        [screen.active.study.feature]: buildRewriteEntry(
          `${screen.active.entry.text} extra`, // hashes to something else
          reversedParagraph(screen.active.entry.text),
        ),
      },
      extra: { model: 'e2e' },
    });
    await page.route('**/src/logic/journalRewrite.json', fulfillArtifact(stale));

    await openJournal(page);
    const heroText = await page.locator('.journal-open .journal-entry').innerText();
    expect(heroText).toBe(screen.active.entry.text);
  });
});
