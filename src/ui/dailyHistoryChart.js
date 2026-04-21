// Daily history timeline — SVG chart of the signed-in user's past daily
// completions, one dot per day, y = seconds off Greg's par. Rendered under
// the leaderboard table so players can see their personal trajectory without
// needing a separate "stats" screen.
//
// No external dependencies. Hand-rolled SVG with a viewBox so it scales to
// whatever container width it lives in (including tight mobile viewports).

const DAYS_BACK = 30;

// Layout — expressed in viewBox units, not pixels. The real rendered size is
// controlled by the container's width via preserveAspectRatio.
const VB_WIDTH = 600;
const VB_HEIGHT = 180;
const PAD_LEFT = 36;
const PAD_RIGHT = 10;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

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
    empty.textContent = 'No daily history yet — play a daily to start your timeline.';
    return empty;
  }

  // Index by date string for gap-aware rendering. We walk the last N days
  // (today-anchored) from left to right; days without an entry just don't
  // draw a dot.
  const byDate = new Map();
  for (const e of entries) byDate.set(e.date, e);

  // Build the array of N daily slots, newest-on-right. If today doesn't have
  // an entry we still reserve a slot for it — the user might complete today's
  // daily later and come back to this chart.
  const today = localDateString(new Date());
  const slots = []; // { date, entry?: {...} }
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = localDateString(d);
    slots.push({ date: dateStr, entry: byDate.get(dateStr) || null });
  }

  // y-axis domain — symmetric around 0, clamped.
  let maxAbsDelta = MIN_Y_SPAN_HALF;
  for (const s of slots) {
    if (s.entry && Math.abs(s.entry.delta) > maxAbsDelta) {
      maxAbsDelta = Math.abs(s.entry.delta);
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
    svg.appendChild(line);

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', PAD_LEFT - 6);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', v === 0 ? 'dhc-axis-label dhc-axis-label-zero' : 'dhc-axis-label');
    label.textContent = (v > 0 ? '+' : '') + v;
    svg.appendChild(label);
  }

  // x-axis date ticks — every ~5 days, labeled at the left edge.
  const xTickEvery = Math.max(1, Math.floor(slots.length / 6));
  for (let i = 0; i < slots.length; i++) {
    if (i % xTickEvery !== 0 && i !== slots.length - 1) continue;
    const x = xFor(i);
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', VB_HEIGHT - 8);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'dhc-axis-label dhc-date-label');
    label.textContent = formatShortDate(slots[i].date, slots[i].date === today);
    svg.appendChild(label);
  }

  // Dots — one per entry-bearing slot. Colour by over/under/even.
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s.entry) continue;
    const x = xFor(i);
    const y = yFor(s.entry.delta);
    const cls = s.entry.delta < -0.5 ? 'dhc-dot dhc-dot-under'
      : s.entry.delta > 0.5 ? 'dhc-dot dhc-dot-over'
      : 'dhc-dot dhc-dot-even';

    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', 4);
    dot.setAttribute('class', cls);
    // Native SVG <title> renders a browser tooltip on hover with no extra JS.
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${s.date} · ${s.entry.time.toFixed(1)}s vs par ${s.entry.par.toFixed(1)}s · ${formatDelta(s.entry.delta)}`;
    dot.appendChild(title);
    svg.appendChild(dot);
  }

  return svg;
}

// ── Helpers ──────────────────────────────────────────

function localDateString(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatShortDate(dateStr, isToday) {
  if (isToday) return 'today';
  // YYYY-MM-DD → "4/21"
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
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
