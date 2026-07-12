// ── Journal figure — the uncertainty sparkline ────────────────────────
// One small SVG per study: the posterior SD trajectory under the current
// model era, normalized to the era's first fit (100%), so the line reads
// the same regardless of the coefficient's units — falling = Greg
// getting surer, rising = the picture widening. Hand-rolled SVG like
// dailyHistoryChart.js: no library, viewBox scaling, theme CSS classes,
// native <title> tooltips.

// viewBox units, not pixels (dailyHistoryChart proportions: at a ~340px
// rendered width one unit ≈ 0.57 CSS px, so 20-unit text ≈ 11 CSS px).
const VB_W = 600;
const VB_H = 150;
const PAD_X = 14;
const PAD_TOP = 18;
const PAD_BOTTOM = 34;

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' → 'Jul 8'. Local to the journal surfaces (the stats
// chart and leaderboard each carry their own copy today — consolidating
// the three is a separate cleanup).
export function formatShortDate(dateStr) {
  const parts = typeof dateStr === 'string' ? dateStr.split('-') : [];
  if (parts.length !== 3) return dateStr;
  const mo = SHORT_MONTHS[parseInt(parts[1], 10) - 1] || parts[1];
  return `${mo} ${parseInt(parts[2], 10)}`;
}

// Build the sparkline SVG for a study, or null when there are fewer
// than two fits to draw (the card's verdict copy already says "too
// soon" in that case — an empty axis would just be noise).
export function renderStudySparkline(study) {
  const t = study?.trajectory;
  if (!Array.isArray(t) || t.length < 2) return null;
  const base = t[0].sd;
  if (!(base > 0)) return null;
  const pts = t.map(p => ({ date: p.date, rel: (p.sd / base) * 100 }));

  // y-domain: cover the data and always include the 100% baseline, with
  // enough padding that a nearly-flat line doesn't hug an edge.
  let lo = Math.min(...pts.map(p => p.rel), 100);
  let hi = Math.max(...pts.map(p => p.rel), 100);
  const span = Math.max(hi - lo, 12);
  const mid = (hi + lo) / 2;
  lo = mid - span / 2 - 4;
  hi = mid + span / 2 + 4;

  const plotW = VB_W - PAD_X * 2;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const xFor = (i) => PAD_X + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const yFor = (rel) => PAD_TOP + ((hi - rel) / (hi - lo)) * plotH;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'journal-spark');
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `Uncertainty trend across ${pts.length} nightly fits, relative to the era's first fit`);

  // The 100% baseline — where the era began. Above it = wider than the
  // start, below = tighter.
  const baseline = document.createElementNS(svgNS, 'line');
  baseline.setAttribute('x1', PAD_X);
  baseline.setAttribute('y1', yFor(100));
  baseline.setAttribute('x2', VB_W - PAD_X);
  baseline.setAttribute('y2', yFor(100));
  baseline.setAttribute('class', 'jf-baseline');
  baseline.setAttribute('stroke-width', 2);
  svg.appendChild(baseline);

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('class', 'jf-path');
  path.setAttribute('d', pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(p.rel).toFixed(1)}`).join(' '));
  svg.appendChild(path);

  for (let i = 0; i < pts.length; i++) {
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', xFor(i));
    dot.setAttribute('cy', yFor(pts[i].rel));
    dot.setAttribute('r', i === pts.length - 1 ? 8 : 5.5);
    dot.setAttribute('class', 'jf-dot');
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${formatShortDate(pts[i].date)} · uncertainty at ${Math.round(pts[i].rel)}% of era start`;
    dot.appendChild(title);
    svg.appendChild(dot);
  }

  // Start/end date anchors, plus where the line ended up.
  const mkLabel = (x, y, text, anchor, cls) => {
    const el = document.createElementNS(svgNS, 'text');
    el.setAttribute('x', x);
    el.setAttribute('y', y);
    el.setAttribute('text-anchor', anchor);
    el.setAttribute('class', cls);
    el.textContent = text;
    return el;
  };
  svg.appendChild(mkLabel(PAD_X, VB_H - 10, formatShortDate(pts[0].date), 'start', 'jf-label'));
  svg.appendChild(mkLabel(VB_W - PAD_X, VB_H - 10, formatShortDate(pts[pts.length - 1].date), 'end', 'jf-label'));
  const endRel = Math.round(pts[pts.length - 1].rel);
  const endY = yFor(pts[pts.length - 1].rel);
  svg.appendChild(mkLabel(
    VB_W - PAD_X, endY > PAD_TOP + 26 ? endY - 14 : endY + 28,
    `${endRel}%`, 'end', 'jf-label jf-end-label',
  ));

  return svg;
}
