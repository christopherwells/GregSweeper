// The Challenge match, end to end: the setup sheet opens off the title
// card, its controls change the supply count, a match deals from the served
// library, and a board plays as a FROZEN certified board with the marked
// opener. What the pure layer (test/matchRules) cannot claim is that the
// served index and pages reach the page at all, that the sheet's chips wire
// to real rules, and that the dealt payload renders and certifies; that is
// this file.
//
// Venues load from the committed library so the assertions move with it
// rather than going stale.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { prepareInteractionSpec, firstLiveMatchPin } from './helpers.mjs';
import { CHALLENGE_250_EPOCH } from '../../src/logic/challenge250.js';

const summary = JSON.parse(readFileSync(new URL(
  '../../scripts/data/match-library/match-summary.json', import.meta.url), 'utf8'));
// The harvest (2026-08-16): the sheet counts BOTH shelves, so the supply
// assertion sums the match summary with the Climb-side harvest summary.
const climbSummary = JSON.parse(readFileSync(new URL(
  '../../scripts/data/climb-library/climb-match-summary.json', import.meta.url), 'utf8'));

// A pinned board with a deterministic ?matchboard= target whose dims the
// spec can assert. FOUND, not assumed at 0:0: since the tombstone eviction a
// slot may hold `{ evicted, seed }`, and a spec pinned to a stub waits
// forever for a board the deal correctly refuses to install.
const { page: PIN_PAGE, idx: PIN_IDX, board: pinned } = firstLiveMatchPin();
const PIN = { page: PIN_PAGE, idx: PIN_IDX };

// A player who has met everything, so the sheet offers every chip. The
// unlock derivation reads maxLevelReached off the Climb's stored stats.
//
// The epoch stamps are load-bearing: applyChallenge250Reset runs on every
// boot and zeroes maxLevelReached for any save that predates the C250
// epoch, so a seed without them is a fresh player by the time the sheet
// opens (which is exactly how this spec first failed).
async function seedCrownedPlayer(page) {
  await page.addInitScript((epoch) => {
    try {
      // A REAL save's shape, not a minimal one: loadStats backfills only a
      // named handful of fields, so a partial object leaves readers such as
      // updateHeader dereferencing an absent bestTimes.
      localStorage.setItem('minesweeper_stats', JSON.stringify({
        totalGames: 250, wins: 250, losses: 0,
        currentStreak: 0, bestStreak: 0,
        maxLevelReached: 250, bestTimes: {}, recentGames: [],
        challengeEpoch: epoch,
        challengeSeenEpoch: epoch,
        challengeArtifactEpoch: epoch,
        modeStats: {
          challenge: {
            totalGames: 250, wins: 250, losses: 0,
            currentStreak: 0, bestStreak: 0,
            maxLevelReached: 250, bestTimes: {}, recentGames: [],
          },
        },
      }));
    } catch {}
  }, CHALLENGE_250_EPOCH);
}

test('the Challenge card opens the setup sheet, and its supply line is real', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await prepareInteractionSpec(page);
  await seedCrownedPlayer(page);
  await page.goto('/?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });

  await page.locator('.mode-card[data-mode="match"]').click();
  await expect(page.locator('#match-setup-modal')).toBeVisible();
  // The config sheet is the New run tab now (2026-08-13); the sheet opens on
  // the runs a player already has.
  await page.locator('#match-tab-new').click();

  // The supply line counts the SERVED summary through the deal's own filter,
  // so a real number here proves the fetch, the parse and the filter. With
  // every chip on it must reach every stored board, which is also the
  // end-to-end check that the split summary did not lose a corner.
  const supply = page.locator('#match-supply');
  await expect(supply).toHaveText(/\d+ boards fit these rules/, { timeout: 30_000 });
  const all = Number((await supply.textContent()).match(/(\d+)/)[1]);
  // Every chip on, but the scroll toggle OFF (its default), so the count is
  // every stored board MINUS the marathon lane. Read from the summary's own
  // per-corner `over` splits rather than hardcoded, so this equality keeps
  // its meaning as the lane grows nightly.
  const laneBoards = summary.corners.reduce(
    (n, c) => n + (Array.isArray(c[6]) ? c[6].reduce((a, x) => a + x, 0) : 0), 0);
  expect(laneBoards, 'the lane must hold something for this to test anything').toBeGreaterThan(0);
  expect(all).toBe(summary.boards - laneBoards + climbSummary.boards);

  // And with the opt-in ON, the sheet reaches EVERY stored board on both
  // shelves: the equality the all-chips case used to carry, now split in two
  // so the lane is pinned from both sides.
  const scrollChipsAll = page.locator('#match-scroll .match-chip');
  await scrollChipsAll.filter({ hasText: 'Allow' }).click();
  await expect(supply).toHaveText(/\d+ boards fit these rules/);
  const withLane = Number((await supply.textContent()).match(/(\d+)/)[1]);
  expect(withLane).toBe(summary.boards + climbSummary.boards);
  // Back to the default for the rest of the journey.
  await scrollChipsAll.filter({ hasText: 'Off' }).click();
  await expect(supply).toHaveText(/\d+ boards fit these rules/);

  // Narrowing to one shape must narrow the count: this is the assertion that
  // the chips are wired to the rules the deal will use, not to decoration.
  const shapes = page.locator('#match-shapes .match-chip:not(:disabled)');
  await expect(shapes).toHaveCount(7);
  // Turn every shape off except the first (the group refuses to empty).
  const n = await shapes.count();
  for (let i = 1; i < n; i++) await shapes.nth(i).click();
  await expect(supply).toHaveText(/\d+ boards fit these rules/);
  const narrowed = Number((await supply.textContent()).match(/(\d+)/)[1]);
  expect(narrowed).toBeGreaterThan(0);
  expect(narrowed).toBeLessThan(all);

  // The difficulty chips (2026-08-16) must be wired to the same live count:
  // Mean is a strict subset of Any, so the number can only shrink or hold.
  const diffChips = page.locator('#match-difficulty .match-chip');
  await expect(diffChips).toHaveCount(4);
  await diffChips.filter({ hasText: 'Mean' }).click();
  await expect(supply).toHaveText(/\d+ boards fit these rules/);
  const withDiff = Number((await supply.textContent()).match(/(\d+)/)[1]);
  expect(withDiff).toBeLessThanOrEqual(narrowed);
  await expect(diffChips.filter({ hasText: 'Mean' })).toHaveAttribute('aria-pressed', 'true');

  // The scroll opt-in (the marathon lane, 2026-08-17): two chips, Off
  // default, and Allow can only WIDEN the count (it admits oversized boards
  // beside everything else, never instead of it). Equality would also pass
  // today, with no oversized supply yet, but the invariant that survives
  // the lane filling is the widening, so that is what is pinned.
  const scrollChips = page.locator('#match-scroll .match-chip');
  await expect(scrollChips).toHaveCount(2);
  await expect(scrollChips.filter({ hasText: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  await scrollChips.filter({ hasText: 'Allow' }).click();
  await expect(scrollChips.filter({ hasText: 'Allow' })).toHaveAttribute('aria-pressed', 'true');
  await expect(supply).toHaveText(/\d+ boards fit these rules/);
  const withScroll = Number((await supply.textContent()).match(/(\d+)/)[1]);
  expect(withScroll).toBeGreaterThanOrEqual(withDiff);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('a locked shape is offered as a locked chip naming its Climb level', async ({ page }) => {
  await prepareInteractionSpec(page);
  // A fresh player has met Classic only; the other six chips are locked and
  // each says where it unlocks, rather than vanishing with no explanation.
  await page.goto('/?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.locator('.mode-card[data-mode="match"]').click();
  await expect(page.locator('#match-setup-modal')).toBeVisible();

  await expect(page.locator('#match-shapes .match-chip:not(:disabled)')).toHaveCount(1);
  const locked = page.locator('#match-shapes .match-chip:disabled');
  await expect(locked).toHaveCount(6);
  await expect(locked.first()).toHaveAttribute('title', /Reach Climb Level \d+/);
  // Every modifier is locked too, for the same reason.
  await expect(page.locator('#match-mods .match-chip:not(:disabled)')).toHaveCount(0);
});

test('the matchboard override deals the exact stored board, frozen and certified',
  async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await prepareInteractionSpec(page);
    await page.goto(`/?isTest=1&matchboard=${PIN.page}:${PIN.idx}`);
    await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
    await page.waitForSelector('#board .cell', { timeout: 30_000 });

    // The board on screen IS the stored payload.
    await expect(page.locator('#board .cell')).toHaveCount(pinned.spec.cells);
    const mineText = await page.locator('#mine-counter').textContent();
    expect(Math.abs(parseInt(mineText, 10))).toBe(pinned.spec.mines);

    // The frozen-mode contract: a marked opener (his "Start here must be
    // present" ruling) and the Certified chip, which only renders when the
    // deal re-certified the stored board from that opener.
    await expect(page.locator('#board .cell.suggested-start')).toHaveCount(1);
    await expect(page.locator('#cert-chip')).toBeVisible();

    // The header names the board's place in the match, never a Climb level.
    await expect(page.locator('#level-display')).toHaveText(/Board 1/);

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

test('REGRESSION: Start Challenge runs the REAL deal through to a playing board', async ({ page }) => {
  // Every other spec here pins ?matchboard=, the practice lane, which skips
  // dealMatchEntries entirely. So when #359 changed the deal's reading of
  // planMatchDeal's `eligible` and the two disagreed (a count where rows were
  // expected), every REAL deal crashed, solo and shared alike, the sheet said
  // "check your connection", and the whole suite stayed green. This journey
  // is the seam: sheet, Start Challenge, live library fetch, certification,
  // a board on screen.
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await prepareInteractionSpec(page);
  await page.goto('/?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.locator('.mode-card[data-mode="match"]').click();
  await expect(page.locator('#match-setup-modal')).toBeVisible();
  await page.locator('#match-tab-new').click();

  const start = page.locator('#match-start');
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();

  // The deal fetches shards and re-certifies stored boards; give it room.
  await page.waitForSelector('#board .cell', { timeout: 45_000 });
  await expect(page.locator('#level-display')).toHaveText(/Board 1/);
  await expect(page.locator('#board .cell.suggested-start')).toHaveCount(1);
  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('a match board cannot be restarted, and offers no power-ups', async ({ page }) => {
  // Both follow from the mode's economy: the per-board clock feeds the match
  // total, so a fresh clock on a seen board is the daily's own cheat, and an
  // inventory would let a later board be bought rather than solved.
  await prepareInteractionSpec(page);
  await page.goto(`/?isTest=1&matchboard=${PIN.page}:${PIN.idx}`);
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('#board .cell', { timeout: 30_000 });

  await expect(page.locator('#reset-btn')).toBeDisabled();
  await expect(page.locator('#powerup-bar')).toHaveClass(/hidden/);
});

test('Help Greg fills the sheet with what the fit is short of, and the run still deals', async ({ page }) => {
  // His idea (2026-08-18): a button beside the board count that aims the WHOLE
  // run at what the model needs, where steering claims at most floor(N/5)
  // slots. The e2e layer is the right one for it: the pure choice is tested in
  // matchSteering, and what can only break here is the wiring (the target
  // fetch, the chips re-rendering, the supply line re-counting, the deal still
  // working afterwards) — the #363 lesson exactly.
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await prepareInteractionSpec(page);
  await seedCrownedPlayer(page);
  await page.goto('/?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 30_000 });
  await page.locator('.mode-card[data-mode="match"]').click();
  await page.locator('#match-tab-new').click();

  const supply = page.locator('#match-supply');
  await expect(supply).toHaveText(/\d+ boards fit these rules/, { timeout: 30_000 });

  const before = await page.locator('#match-shapes .match-chip[aria-pressed="true"]').count();
  expect(before, 'a crowned player starts with every shape on').toBe(7);

  await page.locator('#match-help-greg').click();

  // It says what it did, in a sentence naming real shapes.
  const note = page.locator('#match-help-note');
  await expect(note).toHaveText(/Greg has the least data on .+\. Change anything you like\./,
    { timeout: 15_000 });

  // The chips actually moved, and to FEWER shapes than everything.
  const after = await page.locator('#match-shapes .match-chip[aria-pressed="true"]').count();
  expect(after).toBeGreaterThan(0);
  expect(after, 'it must narrow the sheet, not leave it as it was').toBeLessThan(before);

  // The bands it must NOT touch are still Any: setting a density would chase
  // the digit-share target and re-introduce the confound experimentDesign
  // refuses on purpose.
  for (const id of ['#match-density', '#match-time', '#match-difficulty']) {
    await expect(page.locator(`${id} .match-chip[aria-pressed="true"]`)).toHaveText('Any');
  }

  // And the narrowed rules are DEALABLE: a positive supply count through the
  // deal's own filter, and Start live.
  //
  // Deliberately not started here. The deal for a narrow shape selection
  // fetches 437 corner shards (the modifier axis is 2^9 subsets), and eight
  // parallel workers against the dependency-free static server time some of
  // them out, which is a real round-trip finding rather than a flake and is
  // reported on its own. The full sheet-to-playing-board journey is covered
  // by the REGRESSION spec below under the wide default rules.
  await expect(supply).toHaveText(/\d+ boards fit these rules/);
  const n = Number((await supply.textContent()).match(/(\d+)/)[1]);
  expect(n, 'the starved shapes must have supply to be worth proposing').toBeGreaterThan(0);
  await expect(page.locator('#match-start')).toBeEnabled();

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});
