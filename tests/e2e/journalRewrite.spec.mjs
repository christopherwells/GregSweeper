// The journal's nightly AI rewrite, at the render layer (2026-08-11).
// The pure guards (hash keying, validator, arcSpoken re-detection) are
// node-tested in test/journalRewrite.test.mjs; what only a browser can
// pin is the WIRING: journalView really fetches the artifact, really
// swaps the paragraph into the active card when it is fresh, and really
// falls back to the beat assembly when the hash disagrees. Both specs
// drive the real More-sheet path and intercept only the artifact fetch,
// so the entry under test is the one the shipped code composes from the
// repo's own modelHistory.json.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepareInteractionSpec } from './helpers.mjs';
import { planJournalScreen } from '../../src/logic/journalProse.js';
import { buildRewriteArtifact } from '../../src/logic/journalRewrite.js';
import { splitSentences } from '../../src/logic/proseRails.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function composeActive() {
  const history = JSON.parse(readFileSync(join(ROOT, 'src/logic/modelHistory.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(ROOT, 'src/logic/experimentTarget.json'), 'utf8'));
  const screen = planJournalScreen(history, meta);
  return screen?.active ?? null;
}

// A paragraph that is VALID (same sentences, so every rail and digit
// holds) but visibly different from the beat assembly: the sentences in
// reverse order. If reversal happens to be a no-op (a one-sentence
// entry), the spec skips rather than asserting nothing.
function reversedParagraph(text) {
  return splitSentences(text).reverse().join(' ');
}

async function openJournal(page) {
  await page.goto('/?isTest=1');
  await page.click('#title-more-btn');
  await page.click('#sheet-journal-btn');
  await expect(page.locator('#journal-modal')).toBeVisible();
}

test.describe('journal rewrite rendering', () => {
  test.beforeEach(async ({ page }) => {
    await prepareInteractionSpec(page);
  });

  test('a fresh artifact replaces the active entry verbatim', async ({ page }) => {
    const active = composeActive();
    test.skip(!active?.entry?.text, 'no active study in the shipped history');
    const rewritten = reversedParagraph(active.entry.text);
    test.skip(rewritten === active.entry.text, 'one-sentence entry: reversal proves nothing');

    const artifact = buildRewriteArtifact({
      feature: active.study.feature,
      date: '2099-01-01',
      entryText: active.entry.text,
      paragraph: rewritten,
      extra: { model: 'e2e-intercept' },
    });
    await page.route('**/src/logic/journalRewrite.json', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(artifact),
    }));

    await openJournal(page);
    const entryText = await page.locator('.journal-open .journal-entry').innerText();
    expect(entryText).toBe(rewritten);
    expect(entryText).not.toBe(active.entry.text);
  });

  test('a hash-mismatched artifact falls back to the beat assembly byte for byte', async ({ page }) => {
    const active = composeActive();
    test.skip(!active?.entry?.text, 'no active study in the shipped history');

    const stale = buildRewriteArtifact({
      feature: active.study.feature,
      date: '2099-01-01',
      entryText: `${active.entry.text} extra`, // hashes to something else
      paragraph: reversedParagraph(active.entry.text),
      extra: { model: 'e2e-intercept' },
    });
    await page.route('**/src/logic/journalRewrite.json', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(stale),
    }));

    await openJournal(page);
    const entryText = await page.locator('.journal-open .journal-entry').innerText();
    expect(entryText).toBe(active.entry.text);
  });
});
