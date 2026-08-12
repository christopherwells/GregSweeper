// The Challenge invite and join surfaces, in a real browser.
//
// WHAT THIS SPEC CANNOT DO, stated rather than faked: a genuine
// host-creates -> guest-joins -> both-play journey needs two authenticated
// Firebase sessions writing to the production database, and the test
// environment deliberately mints NO auth users (the no-op signInAnon gate) and
// short-circuits every write. So the two-client journey is covered where it
// can be covered honestly, in the pure layer (test/matchCodes.test.mjs pins
// the join verdict, test/matchStandings.test.mjs the ranking, and
// test/rules-contract.test.mjs the write authority the server enforces).
//
// What IS testable here is everything before the network: that the sheet
// offers both of his invite routes, that the join card opens from a shared
// link with the code already filled in, that a malformed code is refused
// client-side, and that none of it throws. Those are the parts a pure test
// cannot reach, which is exactly the layering the repo's regression policy
// asks for.

import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

async function boot(page, query = '') {
  await prepareInteractionSpec(page);
  await page.goto(`/?isTest=1${query}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
}

test('the setup sheet offers both invite routes beside solo play', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await boot(page);
  await page.locator('.mode-card[data-mode="match"]').click();
  await expect(page.locator('#match-setup-modal')).toBeVisible();

  // His two routes: share a code, or invite a friend you already have. Solo
  // play stays the primary action, because it is the common case.
  await expect(page.locator('#match-start')).toBeVisible();
  await expect(page.locator('#match-invite-btn')).toBeVisible();
  await expect(page.locator('#match-join-btn')).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('the join card opens from the sheet and refuses a malformed code', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await boot(page);
  await page.locator('.mode-card[data-mode="match"]').click();
  await page.locator('#match-join-btn').click();
  await expect(page.locator('#match-join-modal')).toBeVisible();
  await expect(page.locator('#match-setup-modal')).toBeHidden();

  // A code that cannot BE a code is rejected before anything reaches Firebase:
  // normalizeCode is what stops a hostile value arriving as a path fragment.
  await page.locator('#match-join-input').fill('nope');
  await page.locator('#match-join-lookup').click();
  const status = page.locator('#match-join-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveText(/six letters and numbers/i);
  await expect(status).toHaveClass(/friends-status-error/);
  // Nothing was found, so no join button was offered.
  await expect(page.locator('#match-join-go')).toHaveCount(0);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('a shared ?match= link lands on the join card with the code filled in', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // The whole point of an invite link, so this route is NOT test-gated. The
  // title screen goes up first, so a dead code leaves the player somewhere
  // real instead of on a blank page.
  await boot(page, '&match=K7XPQ4');
  await expect(page.locator('#title-screen')).toBeVisible();
  await expect(page.locator('#match-join-modal')).toBeVisible();
  await expect(page.locator('#match-join-input')).toHaveValue('K7XPQ4');

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('a lowercase or spaced link code still normalizes into the box', async ({ page }) => {
  // Codes get read off screens and retyped; forgiving input is the point of
  // normalizeCode, and the deep link goes through the same one.
  await boot(page, '&match=k7x-pq4');
  await expect(page.locator('#match-join-input')).toHaveValue('K7XPQ4');
});

test('a junk ?match= value is ignored entirely and the title screen loads', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await boot(page, '&match=' + encodeURIComponent('../../evil'));
  await expect(page.locator('#title-screen')).toBeVisible();
  await expect(page.locator('#match-join-modal')).toBeHidden();

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('each of the three invite answers dismisses the card and says what it did', async ({ page }) => {
  // His ruling: Join, "Later" meaning remind me in 24 hours, and a reject
  // meaning "I don't want to play that".
  //
  // This drives the card rather than counting its buttons. Asserting the
  // three ids exist would pass on static markup with every handler deleted,
  // which is the "element is visible is not a test" rule: the markup is in
  // index.html unconditionally and needs no JS at all. So each answer is
  // CLICKED and the outcome checked. A signed-out session has no uid, so the
  // Firebase write behind each answer no-ops; what is under test here is the
  // wiring the player actually feels, the card closing and the confirmation.
  await boot(page);

  const cases = [
    ['#match-invite-later', /ask again tomorrow/i],
    ['#match-invite-decline', /turned down/i],
  ];
  for (const [button, toastText] of cases) {
    // Stage the card the way a live invite does: real matchId + code on the
    // dataset, then unhide. Nothing else about the card is faked.
    await page.evaluate(() => {
      const card = document.getElementById('match-invite-toast');
      card.dataset.matchId = 'MJ0abcdefghijklmnopq';
      card.dataset.code = 'ABC234';
      card.classList.remove('hidden');
    });
    await expect(page.locator('#match-invite-toast')).toBeVisible();

    await page.locator(button).click();

    await expect(page.locator('#match-invite-toast')).toBeHidden();
    await expect(page.locator('.queued-toast', { hasText: toastText }).first()).toBeVisible();
  }

  // Accept routes to the join card carrying the invite's own code, which is
  // what makes an invite and a pasted code the same path.
  await page.evaluate(() => {
    const card = document.getElementById('match-invite-toast');
    card.dataset.matchId = 'MJ0abcdefghijklmnopq';
    card.dataset.code = 'ABC234';
    card.classList.remove('hidden');
  });
  await page.locator('#match-invite-accept').click();
  await expect(page.locator('#match-invite-toast')).toBeHidden();
  await expect(page.locator('#match-join-modal')).toBeVisible();
  await expect(page.locator('#match-join-input')).toHaveValue('ABC234');
});

test('the review list exists and stays hidden with nothing to review', async ({ page }) => {
  // A signed-out test session has no invites and no matches, so the section
  // must not render an empty heading above the sheet's controls.
  await boot(page);
  await page.locator('.mode-card[data-mode="match"]').click();
  await expect(page.locator('#match-setup-modal')).toBeVisible();
  await expect(page.locator('#match-review')).toBeHidden();
});

test('the standings and rematch surfaces start hidden, so no run can leak the last one', async ({ page }) => {
  // The gameover overlay is ONE shared surface across every mode and end
  // state; its optional sections persist in the DOM between games. Both new
  // sections are in GAMEOVER_ELEMENT_IDS, so every render path hides them
  // before deciding, but that only helps if they start hidden too.
  await boot(page);
  await expect(page.locator('#match-standings')).toBeHidden();
  await expect(page.locator('#gameover-match-again')).toBeHidden();
  await expect(page.locator('#match-invite-toast')).toBeHidden();
});
