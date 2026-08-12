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

// The front door leads with two full-width heroes (Daily, Weekly) over a
// two-column grid of the four evergreen modes. This pins the heroes are
// heroes AND that they come first: putting the two expiring boards anywhere
// but the top is the thing the layout exists to prevent, and a card that
// merely spans a row in the middle would satisfy a width-only check.
test('the Daily and Weekly cards lead the grid at full width', async ({ page }) => {
  await page.goto('?isTest=1');
  await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
  await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });

  const { gridW, visible, rows } = await readGridRows(page);
  expect(visible, 'the grid must render some cards at all').toBeGreaterThan(0);
  expect(rows.length, 'the grid needs at least a hero row and a pair row').toBeGreaterThan(2);

  for (const [i, mode] of ['daily', 'weekly'].entries()) {
    expect(rows[i].map((c) => c.label), `row ${i} must be the ${mode} hero alone`).toEqual([mode]);
    expect(rows[i][0].w, `the ${mode} hero must span the grid`).toBeGreaterThan(gridW * 0.9);
  }
  // Everything below the heroes shares its row, or spans as the odd one out.
  const below = rows.slice(2).flat().map((c) => c.label);
  expect(below, 'the four evergreen modes sit under the heroes')
    .toEqual(expect.arrayContaining(['normal', 'match', 'mode-card-gym']));
});

// 2026-07-06 orphan-cell incident: the old span rule
// (.mode-card:last-child:nth-child(odd)) never fired because the locked
// Chaos card is hidden via inline display:none but STAYS in the DOM — a
// hidden card still occupies its :nth-child slot, so the Gym card counted
// as an even child and every player below the Chaos unlock saw it half-width
// beside an empty cell. updateTitleProgress now counts the GRID cards
// actually shown (the heroes are excluded, since they always span) and
// toggles .odd-cards; these pin both sides.

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
  expect(layout.gymWidth,
    'with Chaos hidden the grid holds three cards (The Climb, Quick Play, Gym), so the Gym spans its row')
    .toBeGreaterThan(layout.gridWidth * 0.9);
});

// The two tests above name the cards involved, which is what makes them
// readable and also what makes them fragile: any change to the grid's contents
// breaks them, and the tempting fix is to loosen the numbers. This one pins the
// PROPERTY instead -- no visible card is ever left alone on a row at half
// width -- so it survives a card being added, removed or reordered, and it is
// what should stay honest when the front door gains its seventh card.

const CHAOS_UNLOCKED_PROFILE = {
  totalGames: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0,
  bestTimes: {}, recentGames: [], maxLevelReached: 100,
  dailiesCompleted: 0, puristWins: 0, gimmickWins: 0,
  flaglessWins: 0, efficientWins: 0, searchWins: 0, liarWins: 0,
  challengeEpoch: 1,
};

// Measures the laid-out grid rather than the CSS: group the visible cards into
// rows by their top edge, then judge each row on its own.
async function readGridRows(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.title-screen-modes');
    const gridW = grid.getBoundingClientRect().width;
    const cards = [...grid.querySelectorAll('.mode-card')]
      .filter((c) => getComputedStyle(c).display !== 'none');
    const rows = new Map();
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const key = Math.round(r.top);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ w: r.width, label: c.dataset.mode || c.id || 'card' });
    }
    return {
      gridW,
      visible: cards.length,
      rows: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    };
  });
}

for (const [w, h, label] of [[360, 740, 'reference phone'], [390, 844, 'tall phone'], [1280, 900, 'desktop']]) {
  for (const chaos of ['locked', 'unlocked']) {
    test(`no mode card is orphaned at half width — ${label}, Chaos ${chaos}`, async ({ page }) => {
      if (chaos === 'unlocked') {
        await page.addInitScript((profile) => {
          try { localStorage.setItem('minesweeper_stats', JSON.stringify(profile)); } catch {}
        }, CHAOS_UNLOCKED_PROFILE);
      }
      await page.setViewportSize({ width: w, height: h });
      await page.goto('?isTest=1');
      await page.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20_000 });
      await page.waitForSelector('#title-screen:not(.hidden)', { timeout: 20_000 });

      const { gridW, visible, rows } = await readGridRows(page);
      expect(visible, 'the grid must render some cards at all').toBeGreaterThan(0);

      for (const row of rows) {
        const names = row.map((c) => c.label).join(', ');
        if (row.length === 1) {
          // Alone on a row is only legitimate at full width. A lone half-width
          // card IS the 2026-07-06 orphan cell.
          expect(row[0].w, `"${names}" sits alone on its row, so it must span it`)
            .toBeGreaterThan(gridW * 0.9);
        } else {
          expect(row.length, `row [${names}] should hold at most two cards`).toBe(2);
          for (const c of row) {
            expect(c.w, `"${c.label}" shares its row, so it must be a half cell`)
              .toBeLessThan(gridW * 0.6);
          }
        }
      }
    });
  }
}

test('unlocked Chaos shows its card and the Gym card stays half-width', async ({ page }) => {
  // Seed a profile AT CHAOS_UNLOCK_LEVEL (100) — the unlock is >=, so this
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
  expect(layout.chaosVisible, 'an unlocked profile shows the Chaos card').toBe(true);
  expect(layout.gymWidth,
    'with Chaos shown the grid holds four cards, so the Gym stays a half-width cell')
    .toBeLessThan(layout.gridWidth * 0.6);
});
