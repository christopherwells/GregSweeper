import { test, expect } from '@playwright/test';
import { prepareInteractionSpec } from './helpers.mjs';

// Title-screen integrity for the 2026-06-25 front-door rebuild. The boot smoke
// proves the title renders without a console error; these prove the design
// decisions survive: (1) the animated Greg mascot actually mounts in the header
// (a regression that drops the startGregMascot call would still boot clean, so
// the smoke can't see it), (2) the "one Greg" call — the Daily card rides
// its calendar icon, never re-growing a note-Greg sprite — and (3) the
// mode-card grid spans its last card full-width exactly when an odd number
// of cards is VISIBLE (the 2026-07-06 orphan-cell fix).

test.beforeEach(async ({ page }) => {
  // Onboarded + no service worker: the first-install SW claim reloads the
  // page and destroyed this spec's evaluate context on CI (2026-07-11) —
  // see helpers.mjs. The boot smoke keeps SW-inclusive coverage.
  await prepareInteractionSpec(page);
});

test('the title header mounts the animated Greg mascot', async ({ page }) => {
  await page.goto('?isTest=1');
  // The mascot is injected by startGregMascot in init; its smile + eye hooks
  // appearing means the SVG mounted. A dropped call would never satisfy this.
  // The smile is a two-path open/closed toggle (theme-aware rig, 2026-06-27).
  await page.waitForSelector('#title-greg-mascot svg .greg-smile-open', { timeout: 20_000 });
  const ok = await page.evaluate(() => {
    const el = document.getElementById('title-greg-mascot');
    return !!(el && el.querySelector('.greg-eyes-open') && el.querySelector('.greg-eyes-closed')
      && el.querySelector('.greg-smile-open') && el.querySelector('.greg-smile-closed'));
  });
  expect(ok, 'the header Greg must carry its eyes + smile (open + closed) for the blink/smile rig').toBe(true);
});

test('the Daily card keeps its calendar icon and grows no note-Greg', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  await page.waitForTimeout(300); // let updateTitleProgress fill the card
  const calendarIcon = await page.evaluate(() => !!document.querySelector('.mode-card[data-mode="daily"] .mode-card-icon img, .mode-card[data-mode="daily"] .mode-card-icon svg'));
  const noteGreg = await page.evaluate(() => !!document.querySelector('#title-daily-progress .sprite-greg-note'));
  expect(calendarIcon, 'the Daily card keeps its calendar mode icon').toBe(true);
  expect(noteGreg, 'the Daily card note-Greg was dropped (one Greg lives in the header)').toBe(false);
});

// 2026-07-06 orphan-cell incident: the old span rule
// (.mode-card:last-child:nth-child(odd)) never fired because the locked
// Chaos card is hidden via inline display:none but STAYS in the DOM — a
// hidden card still occupies its :nth-child slot, so the Gym card counted
// as an even child and every player below Challenge L50 saw it half-width
// beside an empty cell. updateTitleProgress now counts the cards actually
// shown and toggles .odd-cards on the grid; these pin both sides.

test('REGRESSION: locked Chaos hides its card and the Gym card spans the full row', async ({ page }) => {
  await page.goto('?isTest=1');
  // #title-screen is never .hidden during boot — the #boot-overlay covers
  // it. The overlay is removed at the END of init, after showTitleScreen's
  // updateTitleProgress has settled the grid, so it is the honest anchor.
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  const layout = await page.evaluate(() => {
    const chaos = document.querySelector('.mode-card[data-mode="chaos"]');
    const gym = document.getElementById('mode-card-gym');
    const grid = document.querySelector('.title-screen-modes');
    return {
      chaosHidden: !!chaos && getComputedStyle(chaos).display === 'none',
      gymWidth: gym.getBoundingClientRect().width,
      gridWidth: grid.getBoundingClientRect().width,
    };
  });
  expect(layout.chaosHidden, 'a fresh profile keeps Chaos locked and its card hidden').toBe(true);
  // A half-width card is ~half the grid minus the gap; a full-row span is
  // the whole grid width. 90% cleanly separates the two.
  expect(layout.gymWidth, 'the Gym card must span the full row when 5 cards are visible')
    .toBeGreaterThan(layout.gridWidth * 0.9);
});

test('unlocked Chaos shows its card and the Gym card stays half-width', async ({ page }) => {
  // Seed a profile AT CHAOS_UNLOCK_LEVEL (50) — the unlock is >=, so this
  // also pins the boundary. No modeStats on purpose: loadStats' migration
  // path seeds challenge stats from these top-level fields, producing a
  // fully-shaped stats object.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('minesweeper_stats', JSON.stringify({
        totalGames: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0,
        // Chaos unlocks at CHAOS_UNLOCK_LEVEL (100 since his 2026-08-04
        // ruling — it was 50 on the old 120-level ladder).
        bestTimes: {}, recentGames: [], maxLevelReached: 100,
        dailiesCompleted: 0, puristWins: 0, gimmickWins: 0,
        flaglessWins: 0, efficientWins: 0, searchWins: 0, liarWins: 0,
        // Post-reset profile: without the epoch stamp the Challenge 250
        // reset (main.js init) wipes maxLevelReached back to 1 and the
        // Chaos card relocks, which is correct behavior but not what
        // this spec is measuring. Keep in step with CHALLENGE_250_EPOCH.
        challengeEpoch: 1,
      }));
    } catch {}
  });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });
  const layout = await page.evaluate(() => {
    const chaos = document.querySelector('.mode-card[data-mode="chaos"]');
    const gym = document.getElementById('mode-card-gym');
    const grid = document.querySelector('.title-screen-modes');
    return {
      chaosVisible: !!chaos && getComputedStyle(chaos).display !== 'none',
      chaosCopy: document.getElementById('title-chaos-progress')?.textContent || '',
      gymWidth: gym.getBoundingClientRect().width,
      gridWidth: grid.getBoundingClientRect().width,
    };
  });
  expect(pageErrors, 'the seeded L50 profile must boot without page errors').toEqual([]);
  // The static DOM already shows the Chaos card (with "Reach Level 50"
  // copy) and a half-width Gym, and init() swallows its own throws — so a
  // crashed boot would satisfy the layout assertions vacuously. The unlock
  // copy is written ONLY by updateTitleProgress's unlock branch, making it
  // the proof that the seeded profile actually rendered.
  expect(layout.chaosCopy, 'the Chaos card must carry the unlock-branch copy, not the static locked text')
    .toMatch(/No guarantees/);
  expect(layout.chaosVisible, 'an L50 profile shows the Chaos card').toBe(true);
  expect(layout.gymWidth, 'with 6 visible cards the Gym card stays a half-width cell')
    .toBeLessThan(layout.gridWidth * 0.6);
});
