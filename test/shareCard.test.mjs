// Daily share-card lines (pure). Pins the two contracts the 2026-07-10 audit
// found untested:
//   - the card's date is the BOARD's date (state.dailySeed), never the wall
//     clock — a finish just past midnight ET and every archive replay used
//     to stamp the wrong day;
//   - the documented HARD CEILING: five content lines plus the one URL line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dailyShareLines } = await import('../src/logic/shareCard.js');

const BASE = {
  mineEmoji: '💣',
  dateStr: '2026-03-14',
  time: 45,
  par: 60,
  gimmickIcons: '',
  certTier: 0,
  bombHits: 0,
  cruxUrl: 'https://gregsweeper.com/?crux=2026-07-09',
};

test('REGRESSION: the card carries the BOARD date passed in, not the system date', () => {
  const lines = dailyShareLines(BASE);
  assert.ok(lines[0].includes('2026-03-14'), `title line: ${lines[0]}`);
  // The system's own date must not appear anywhere on the card (the crux URL
  // is caller-built, dated by the caller).
  const today = new Date().toISOString().slice(0, 10);
  if (today !== BASE.dateStr) {
    assert.ok(!lines.join('\n').includes(today), 'wall-clock date leaked onto the card');
  }
});

test('hard ceiling: five content lines plus the URL, with every optional line active', () => {
  const lines = dailyShareLines({
    ...BASE,
    gimmickIcons: '📡',
    certTier: 2,
    bombHits: 3,
  });
  assert.ok(lines.length <= 6, `ceiling is 5 content lines + URL, got ${lines.length}`);
  assert.equal(lines.length, 6, 'all-options card uses exactly the full budget');
  assert.ok(lines[lines.length - 1].includes('?crux='), 'the last line is the single crux link');
  assert.equal(lines.filter((l) => l.includes('http')).length, 1, 'exactly one URL on the card');
});

test('beat-Greg framing: under par beats Greg, over par Greg wins, and the pace bar has 8 dots', () => {
  const under = dailyShareLines({ ...BASE, time: 45, par: 60 });
  assert.ok(under[1].includes('beat Greg by 15.0s'), under[1]);
  const over = dailyShareLines({ ...BASE, time: 80, par: 60 });
  assert.ok(over[1].includes('Greg won by 20.0s'), over[1]);
  for (const card of [under, over]) {
    const dots = [...card[2]].filter((ch) => ch === '🟢' || ch === '🔴' || ch === '⚪').length;
    assert.equal(dots, 8, `pace bar must be 8 dots: ${card[2]}`);
  }
});

test('no par: plain time line, no pace bar', () => {
  const lines = dailyShareLines({ ...BASE, par: 0 });
  assert.equal(lines[1], '⏱ 45s');
  assert.ok(!lines.join('\n').includes('🟢'));
});

test('strikes line renders only when the player hit a mine', () => {
  assert.ok(!dailyShareLines(BASE).join('\n').includes('💥'));
  assert.ok(dailyShareLines({ ...BASE, bombHits: 2 }).join('\n').includes('💥×2'));
});

test('the certified tier renders in plain words and never overclaims tier 0', () => {
  assert.ok(dailyShareLines({ ...BASE, certTier: 3 }).join('\n').includes('liar logic'));
  assert.ok(dailyShareLines({ ...BASE, certTier: 1 }).join('\n').includes('clue-comparison'));
  assert.ok(!dailyShareLines({ ...BASE, certTier: 0 }).join('\n').includes('hardest step'));
});
