// Daily history timeline — SVG chart of the signed-in user's past daily
// completions, one dot per day, y = seconds off Greg's par. Rendered under
// the leaderboard table so players can see their personal trajectory without
// needing a separate "stats" screen.
//
// No external dependencies. Hand-rolled SVG with a viewBox so it scales to
// whatever container width it lives in (including tight mobile viewports).

import { getLocalDateString, addCalendarDays } from '../logic/seededRandom.js';

const DAYS_BACK = 30;

// The chart's day columns, oldest → newest, ending at `today`. Pure ET-date
// string arithmetic — the caller passes getLocalDateString() so the slots
// share the app's ET anchor. The old slot walk used the BROWSER-local clock
// (new Date + setDate), so a player west of ET finishing after midnight ET
// had their newest dot dated outside every slot — invisible until the next
// browser-day (2026-07-11 audit). Exported for the node suite.
export function chartDateSlots(today, daysBack) {
  const out = [];
  for (let i = daysBack - 1; i >= 0; i--) out.push(addCalendarDays(today, -i));
  return out;
}

// Layout — expressed in viewBox units, not pixels. The real rendered size is
// controlled by the container's width via preserveAspectRatio. Aspect is
// ~1.5:1 (taller than a typical dashboard chart) so that when the SVG
// shrinks to fit a ~350px mobile viewport, text and dots stay readable
// instead of collapsing to microscopic.
const VB_WIDTH = 600;
const VB_HEIGHT = 400;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const PAD_TOP = 24;
const PAD_BOTTOM = 48;

// Clamp the y-range so a single extreme outlier (e.g. a brand-new player's
// first attempt took 5 minutes) doesn't compress every other dot to a hair.
// The axis still labels the outlier's numeric value — we just bound the
// plotted y coordinate.
const MIN_Y_SPAN_HALF = 10;   // seconds — axis covers at least ±10s
const MAX_Y_SPAN_HALF = 90;   // seconds — axis covers at most ±90s

/**
 * Build an SVG element visualising `entries`. Empty state if entries is [].
 *
 * @param {Array<{date: string, time: number, par: number, delta: number}>} entries
 *        Sorted newest-first (as returned by fetchUserDailyHistory).
 * @param {Object} [opts]
 * @param {number} [opts.daysBack=30]
 * @returns {SVGElement|HTMLElement}
 */
export function renderDailyHistoryChart(entries, opts = {}) {
  const daysBack = opts.daysBack || DAYS_BACK;

  if (!entries || entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'daily-history-empty';
    empty.textContent = 'No daily history yet. Play a daily to start your timeline.';
    return empty;
  }

  // Group by date string for gap-aware rendering. We walk the last N days
  // (today-anchored) from left to right; days without entries just don't
  // draw dots. `date` is the day the run was PLAYED (archive replays are
  // attributed to their play day, never back-dated to the board's date). A
  // day can hold SEVERAL dots — a live daily plus archive replays all count.
  // Replays sort first so the live play draws last (on top) when they overlap.
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => (a.archive === true ? 0 : 1) - (b.archive === true ? 0 : 1));
  }

  // Build the array of N daily slots, newest-on-right, anchored to the ET
  // clock like every other daily surface. If today doesn't have an entry we
  // still reserve a slot for it — the user might complete today's daily
  // later and come back to this chart.
  const today = getLocalDateString();
  const slots = chartDateSlots(today, daysBack)
    .map((dateStr) => ({ date: dateStr, entries: byDate.get(dateStr) || [] }));

  // y-axis domain — symmetric around 0, clamped.
  let maxAbsDelta = MIN_Y_SPAN_HALF;
  for (const s of slots) {
    for (const e of s.entries) {
      if (Math.abs(e.delta) > maxAbsDelta) maxAbsDelta = Math.abs(e.delta);
    }
  }
  maxAbsDelta = Math.min(maxAbsDelta, MAX_Y_SPAN_HALF);
  // Round up to a visually clean tick spacing
  const tickStep = niceTickStep(maxAbsDelta);
  const yHalfSpan = Math.ceil(maxAbsDelta / tickStep) * tickStep;

  // Axis geometry
  const plotW = VB_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = VB_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const yZero = PAD_TOP + plotH / 2;
  const xStep = plotW / (slots.length - 1 || 1);

  function xFor(i) { return PAD_LEFT + i * xStep; }
  function yFor(delta) {
    // Positive delta = over par (slower) = plotted BELOW zero line.
    // Matches "over par is bad" intuition: worse scores sit lower on the chart.
    const clamped = Math.max(-yHalfSpan, Math.min(yHalfSpan, delta));
    return yZero + (clamped / yHalfSpan) * (plotH / 2);
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'daily-history-chart');
  svg.setAttribute('viewBox', `0 0 ${VB_WIDTH} ${VB_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily history timeline');

  // Horizontal gridlines + y labels at tickStep intervals above and below 0.
  for (let v = -yHalfSpan; v <= yHalfSpan; v += tickStep) {
    const y = yFor(v);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', PAD_LEFT);
    line.setAttribute('y1', y);
    line.setAttribute('x2', VB_WIDTH - PAD_RIGHT);
    line.setAttribute('y2', y);
    line.setAttribute('class', v === 0 ? 'dhc-axis-zero' : 'dhc-axis-grid');
    line.setAttribute('stroke-width', v === 0 ? 2 : 1);
    svg.appendChild(line);

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', PAD_LEFT - 10);
    label.setAttribute('y', y + 7);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', v === 0 ? 'dhc-axis-label dhc-axis-label-zero' : 'dhc-axis-label');
    label.textContent = (v > 0 ? '+' : '') + v;
    svg.appendChild(label);
  }

  // x-axis date ticks — spaced so roughly 4-5 labels fit across the width
  // without collision at the default font. First tick left-anchored, last
  // tick right-anchored, middle ticks centered. The last position is
  // always "today"; intermediate ticks within ~half an interval of the end
  // are skipped so they don't collide with the "today" label.
  const xTickEvery = Math.max(1, Math.floor(slots.length / 4));
  const lastIdx = slots.length - 1;
  for (let i = 0; i < slots.length; i++) {
    const isFirst = i === 0;
    const isLast = i === lastIdx;
    const isRegular = i % xTickEvery === 0 && !isFirst;
    if (!isFirst && !isLast && !isRegular) continue;
    if (isRegular && lastIdx - i < xTickEvery / 2) continue; // would collide with "today"
    const x = xFor(i);
    const label = document.createElementNS(svgNS, 'text');
    const anchor = isFirst ? 'start' : (isLast ? 'end' : 'middle');
    label.setAttribute('x', x);
    label.setAttribute('y', VB_HEIGHT - 16);
    label.setAttribute('text-anchor', anchor);
    label.setAttribute('class', 'dhc-axis-label dhc-date-label');
    label.textContent = formatShortDate(slots[i].date, slots[i].date === today);
    svg.appendChild(label);
  }

  // Dots — one per play, stacked in the play-day's column (a live daily and
  // any replays that day each get their own dot). Colour by over/under/even.
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const x = xFor(i);
    for (const entry of s.entries) {
      const y = yFor(entry.delta);
      const cls = entry.delta < -0.5 ? 'dhc-dot dhc-dot-under'
        : entry.delta > 0.5 ? 'dhc-dot dhc-dot-over'
        : 'dhc-dot dhc-dot-even';

      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.setAttribute('r', 9);
      dot.setAttribute('class', cls);
      // Native SVG <title> renders a browser tooltip on hover with no extra JS.
      const title = document.createElementNS(svgNS, 'title');
      const replayNote = entry.archive === true && entry.boardDate
        ? ` · replay of ${formatShortDate(entry.boardDate, false)}` : '';
      title.textContent = `${formatLongDate(s.date)} · ${entry.time.toFixed(1)}s vs par ${entry.par.toFixed(1)}s · ${formatDelta(entry.delta)}${replayNote}`;
      dot.appendChild(title);
      svg.appendChild(dot);
    }
  }

  return svg;
}

// ── Helpers ──────────────────────────────────────────

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS  = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatShortDate(dateStr, isToday) {
  if (isToday) return 'today';
  // YYYY-MM-DD → "Apr 21"
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const mo = SHORT_MONTHS[parseInt(parts[1], 10) - 1] || parts[1];
  return `${mo} ${parseInt(parts[2], 10)}`;
}

function formatLongDate(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const mo = LONG_MONTHS[parseInt(parts[1], 10) - 1];
  if (!mo) return dateStr;
  return `${mo} ${parseInt(parts[2], 10)}, ${parts[0]}`;
}

function formatDelta(delta) {
  const abs = Math.abs(delta).toFixed(1);
  if (delta < -0.5) return '-' + abs + 's under';
  if (delta > 0.5) return '+' + abs + 's over';
  return 'even';
}

// Pick a visually clean tick step (5, 10, 15, 30, 60) given the axis half-span.
function niceTickStep(halfSpan) {
  if (halfSpan <= 10) return 5;
  if (halfSpan <= 20) return 10;
  if (halfSpan <= 45) return 15;
  if (halfSpan <= 60) return 30;
  return 60;
}
