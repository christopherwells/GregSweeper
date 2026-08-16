// ── Journal figures, the notebook's hand-drawn charts ────────────────
// Three figure types, all hand-rolled SVG like dailyHistoryChart.js (no
// library, viewBox scaling, theme CSS classes, native <title> tooltips),
// each drawing only what the pure derivations already prove:
//   sd-trend      - posterior SD over time, normalized to the live
//                   era's first fit (the original sparkline); point
//                   shape rotates per card (circle/square/diamond/tick,
//                   or a bare line with hover-only points)
//   estimate-band, the estimate itself over the LIVE era, with the
//                   ±1 SD band shaded (retrodicted means echo their
//                   priors, so they never enter this figure)
//   band-strip    - the CURRENT estimate as one labeled range bar
// Which figures a card gets (and the dot shape, and the caption) is
// planned deterministically in journalProse.planStudyFigures, this
// module only draws the spec it is handed.

import { estimateSummary, formatShortDate, fmtPct } from '../logic/journalFindings.js';

// viewBox units, not pixels (dailyHistoryChart proportions: at a ~340px
// rendered width one unit ≈ 0.57 CSS px, so 20-unit text ≈ 11 CSS px).
const VB_W = 600;
const VB_H = 150;
const STRIP_H = 84;
const PAD_X = 14;
const PAD_TOP = 18;
const PAD_BOTTOM = 34;

const svgNS = 'http://www.w3.org/2000/svg';

function _svg(height, ariaLabel) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'journal-spark');
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', ariaLabel);
  return svg;
}

function _label(x, y, text, anchor, cls) {
  const el = document.createElementNS(svgNS, 'text');
  el.setAttribute('x', x);
  el.setAttribute('y', y);
  el.setAttribute('text-anchor', anchor);
  el.setAttribute('class', cls);
  el.textContent = text;
  return el;
}

function _titled(node, text) {
  const title = document.createElementNS(svgNS, 'title');
  title.textContent = text;
  node.appendChild(title);
  return node;
}

// One data point in the requested shape. 'none' returns an invisible
// hover target so the per-fit tooltips survive a bare-line figure (the
// planner never picks 'none' for a series with retro points, the
// dimmed visible dot IS the retro disclosure).
function _point(x, y, r, cls, shape) {
  let node;
  if (shape === 'square') {
    node = document.createElementNS(svgNS, 'rect');
    node.setAttribute('x', x - r);
    node.setAttribute('y', y - r);
    node.setAttribute('width', r * 2);
    node.setAttribute('height', r * 2);
  } else if (shape === 'diamond') {
    node = document.createElementNS(svgNS, 'rect');
    node.setAttribute('x', x - r);
    node.setAttribute('y', y - r);
    node.setAttribute('width', r * 2);
    node.setAttribute('height', r * 2);
    node.setAttribute('transform', `rotate(45 ${x} ${y})`);
  } else if (shape === 'tick') {
    node = document.createElementNS(svgNS, 'rect');
    node.setAttribute('x', x - 1.5);
    node.setAttribute('y', y - r * 1.4);
    node.setAttribute('width', 3);
    node.setAttribute('height', r * 2.8);
  } else {
    node = document.createElementNS(svgNS, 'circle');
    node.setAttribute('cx', x);
    node.setAttribute('cy', y);
    node.setAttribute('r', shape === 'none' ? Math.max(r, 7) : r);
  }
  node.setAttribute('class', shape === 'none' ? `${cls} jf-dot-hover` : cls);
  return node;
}

// ── sd-trend ──────────────────────────────────────────────────────────
// The 100% baseline anchors on the first LIVE fit (the current model
// era's start), the same anchor the verdict sentence uses. Retrodicted
// points draw relative to it: anchoring on the series' first point
// would let a sparse retrodiction (a posterior still hugging its prior,
// e.g. sonar's tiny April sd) become the baseline and read every later
// honest fit as a 900% explosion.
function _sdTrend(study, spec) {
  const t = study?.trajectory;
  if (!Array.isArray(t) || t.length < 2) return null;
  const anchor = t.find(p => p.retro !== true) ?? t[0];
  const base = anchor.sd;
  if (!(base > 0)) return null;
  const pts = t.map(p => ({ date: p.date, rel: (p.sd / base) * 100, retro: p.retro === true }));
  const hasRetro = pts.some(p => p.retro);
  // Belt and braces: a bare line may not omit the retro disclosure.
  const shape = hasRetro && spec?.dotShape === 'none' ? 'circle' : (spec?.dotShape || 'circle');

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

  const svg = _svg(VB_H,
    `Uncertainty trend across ${pts.length} nightly fits, relative to the current model's first fit`);

  // The 100% baseline, where the current model era began. Above it =
  // wider than that anchor, below = tighter.
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

  // On a long series (the backfit reaches to April, ~80 fits) full-size
  // points would overlap into a solid bead-chain; shrink them so each
  // fit stays an individual, hoverable point. The latest fit keeps its
  // size.
  const dotR = pts.length > 40 ? 3 : 5.5;
  for (let i = 0; i < pts.length; i++) {
    // Retrodicted fits (the pre-epoch backfit) render dimmer than live
    // nightly fits, and their tooltip says "re-measured", the only
    // retro disclosure left after the standalone caption was cut.
    const cls = pts[i].retro ? 'jf-dot jf-dot-retro' : 'jf-dot';
    const node = _point(xFor(i), yFor(pts[i].rel), i === pts.length - 1 ? 8 : dotR, cls, shape);
    _titled(node, `${formatShortDate(pts[i].date)} · uncertainty vs ${formatShortDate(anchor.date)}: ${Math.round(pts[i].rel)}%`
      + (pts[i].retro ? ' · re-measured' : ''));
    svg.appendChild(node);
  }

  // Start/end date anchors, plus where the line ended up.
  svg.appendChild(_label(PAD_X, VB_H - 10, formatShortDate(pts[0].date), 'start', 'jf-label'));
  svg.appendChild(_label(VB_W - PAD_X, VB_H - 10, formatShortDate(pts[pts.length - 1].date), 'end', 'jf-label'));
  const endRel = Math.round(pts[pts.length - 1].rel);
  const endY = yFor(pts[pts.length - 1].rel);
  svg.appendChild(_label(
    VB_W - PAD_X, endY > PAD_TOP + 26 ? endY - 14 : endY + 28,
    `${endRel}%`, 'end', 'jf-label jf-end-label',
  ));

  return svg;
}

// ── estimate-band ─────────────────────────────────────────────────────
// The live-era effect estimate, in plain percent space, with
// the ±1 SD band shaded. The band may honestly dip below the zero line
// (that IS the uncertainty); the tooltips speak the straddling form
// ("0% to X%") so no fake-negative sentence ships.
function _estimateBand(study) {
  const live = (study?.trajectory || []).filter(p => p && p.retro !== true);
  if (live.length < 2) return null;
  const pct = (m) => (Math.exp(m) - 1) * 100;
  const pts = live.map(p => ({
    date: p.date,
    mid: pct(p.mean),
    lo: pct(p.mean - p.sd),
    hi: pct(p.mean + p.sd),
  }));

  let lo = Math.min(0, ...pts.map(p => p.lo));
  let hi = Math.max(...pts.map(p => p.hi));
  const span = Math.max(hi - lo, 0.5);
  lo -= span * 0.08;
  hi += span * 0.08;

  const plotW = VB_W - PAD_X * 2;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const xFor = (i) => PAD_X + (i / (pts.length - 1)) * plotW;
  const yFor = (v) => PAD_TOP + ((hi - v) / (hi - lo)) * plotH;

  const svg = _svg(VB_H,
    `The fitted effect across ${pts.length} nightly fits, with its uncertainty band`);

  // Zero line: the 0% mark, so a lay reader can see when the band
  // still allows no effect at all.
  const zero = document.createElementNS(svgNS, 'line');
  zero.setAttribute('x1', PAD_X);
  zero.setAttribute('y1', yFor(0));
  zero.setAttribute('x2', VB_W - PAD_X);
  zero.setAttribute('y2', yFor(0));
  zero.setAttribute('class', 'jf-baseline');
  zero.setAttribute('stroke-width', 2);
  svg.appendChild(zero);

  const band = document.createElementNS(svgNS, 'path');
  band.setAttribute('class', 'jf-band');
  band.setAttribute('d',
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(p.hi).toFixed(1)}`).join(' ')
    + ' ' + [...pts].reverse().map((p, i) => `L${xFor(pts.length - 1 - i).toFixed(1)},${yFor(p.lo).toFixed(1)}`).join(' ')
    + ' Z');
  svg.appendChild(band);

  const line = document.createElementNS(svgNS, 'path');
  line.setAttribute('class', 'jf-path');
  line.setAttribute('d', pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(p.mid).toFixed(1)}`).join(' '));
  svg.appendChild(line);

  const dotR = pts.length > 40 ? 3 : 5.5;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const node = _point(xFor(i), yFor(p.mid), i === pts.length - 1 ? 8 : dotR, 'jf-dot', 'circle');
    // "about 0%" for a slightly-negative point estimate is fair
    // rounding language; the band phrase states the straddle honestly.
    const midStr = fmtPct(Math.max(0, p.mid));
    const bandStr = p.lo <= 0
      ? `0% to ${fmtPct(p.hi)}%`
      : `${fmtPct(p.lo)}% to ${fmtPct(p.hi)}%`;
    _titled(node, `${formatShortDate(p.date)} · about ${midStr}%, band ${bandStr}`);
    svg.appendChild(node);
  }

  svg.appendChild(_label(PAD_X, VB_H - 10, formatShortDate(pts[0].date), 'start', 'jf-label'));
  svg.appendChild(_label(VB_W - PAD_X, VB_H - 10, formatShortDate(pts[pts.length - 1].date), 'end', 'jf-label'));
  svg.appendChild(_label(PAD_X, yFor(0) - 6, '0%', 'start', 'jf-label'));
  const last = pts[pts.length - 1];
  const endY = yFor(last.mid);
  svg.appendChild(_label(
    VB_W - PAD_X, endY > PAD_TOP + 26 ? endY - 14 : endY + 28,
    `${fmtPct(Math.max(0, last.mid))}%`, 'end', 'jf-label jf-end-label',
  ));

  return svg;
}

// ── band-strip ────────────────────────────────────────────────────────
// The current estimate as one labeled range bar: 0% on the left, the
// ±1 SD band shaded, a marker at the point estimate. The most
// lay-readable of the three, the whole claim on a single line.
function _bandStrip(study) {
  const est = estimateSummary(study);
  if (!est || !(est.hi > 0)) return null;
  const axisMax = est.hi * 1.18;
  const loClamped = Math.max(0, est.lo);
  const midClamped = Math.max(0, est.pct);

  const padX = 24;
  const trackW = VB_W - padX * 2;
  const xFor = (v) => padX + (v / axisMax) * trackW;
  const y = 40;

  const svg = _svg(STRIP_H, 'The current estimate as a range, from its likely floor to its likely ceiling');

  const track = document.createElementNS(svgNS, 'line');
  track.setAttribute('x1', padX);
  track.setAttribute('y1', y);
  track.setAttribute('x2', VB_W - padX);
  track.setAttribute('y2', y);
  track.setAttribute('class', 'jf-strip-track');
  track.setAttribute('stroke-width', 3);
  svg.appendChild(track);

  const bandRect = document.createElementNS(svgNS, 'rect');
  bandRect.setAttribute('x', xFor(loClamped));
  bandRect.setAttribute('y', y - 9);
  bandRect.setAttribute('width', Math.max(2, xFor(est.hi) - xFor(loClamped)));
  bandRect.setAttribute('height', 18);
  bandRect.setAttribute('rx', 4);
  bandRect.setAttribute('class', 'jf-band');
  const bandStr = est.lo <= 0 ? `0% to ${fmtPct(est.hi)}%` : `${fmtPct(est.lo)}% to ${fmtPct(est.hi)}%`;
  _titled(bandRect, `The likely range: ${bandStr}`);
  svg.appendChild(bandRect);

  const marker = _point(xFor(midClamped), y, 8, 'jf-strip-marker', 'diamond');
  _titled(marker, `Best single read: about ${fmtPct(midClamped)}%`
    + (study.unit ? ` per ${study.unit}` : ''));
  svg.appendChild(marker);

  svg.appendChild(_label(padX, y + 34, '0%', 'start', 'jf-label'));
  svg.appendChild(_label(xFor(est.hi), y + 34, `${fmtPct(est.hi)}%`, 'middle', 'jf-label'));
  svg.appendChild(_label(xFor(midClamped), y - 18, `about ${fmtPct(midClamped)}%`, 'middle', 'jf-label jf-end-label'));

  return svg;
}

// ── move-strip ────────────────────────────────────────────────────────
// Consecutive-fit CHANGES in the estimate, one bar per night, centered on
// a zero line. The claim is only "how far did the number move", in
// percentage points of effect, which the trajectory already proves.
function _moveStrip(study) {
  const live = (study?.trajectory || []).filter(p => p && p.retro !== true);
  if (live.length < 3) return null;
  const pct = (m) => (Math.exp(m) - 1) * 100;
  const moves = [];
  for (let i = 1; i < live.length; i++) {
    moves.push({ date: live[i].date, d: pct(live[i].mean) - pct(live[i - 1].mean) });
  }
  const maxAbs = Math.max(...moves.map(m => Math.abs(m.d)), 0.25);
  const plotW = VB_W - PAD_X * 2;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const midY = PAD_TOP + plotH / 2;
  const yFor = (d) => midY - (d / maxAbs) * (plotH / 2);
  const step = plotW / moves.length;
  const barW = Math.max(6, Math.min(16, step * 0.6));

  const svg = _svg(VB_H, `How far the estimate moved on each of ${moves.length} nightly fits`);

  const zero = document.createElementNS(svgNS, 'line');
  zero.setAttribute('x1', PAD_X);
  zero.setAttribute('y1', midY);
  zero.setAttribute('x2', VB_W - PAD_X);
  zero.setAttribute('y2', midY);
  zero.setAttribute('class', 'jf-baseline');
  zero.setAttribute('stroke-width', 2);
  svg.appendChild(zero);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const x = PAD_X + i * step + (step - barW) / 2;
    const yTop = Math.min(midY, yFor(m.d));
    const bar = document.createElementNS(svgNS, 'rect');
    bar.setAttribute('x', x.toFixed(1));
    bar.setAttribute('y', yTop.toFixed(1));
    bar.setAttribute('width', barW.toFixed(1));
    bar.setAttribute('height', Math.max(3, Math.abs(yFor(m.d) - midY)).toFixed(1));
    bar.setAttribute('rx', 2);
    // Solid marker fill, not the band wash: at bar width the translucent
    // band color was unreadable on his screen (2026-08-16).
    bar.setAttribute('class', 'jf-strip-marker');
    const dir = m.d >= 0 ? 'up' : 'down';
    _titled(bar, `${formatShortDate(m.date)} · ${dir} ${Math.abs(m.d).toFixed(1)} points`);
    svg.appendChild(bar);
  }

  svg.appendChild(_label(PAD_X, VB_H - 10, formatShortDate(moves[0].date), 'start', 'jf-label'));
  svg.appendChild(_label(VB_W - PAD_X, VB_H - 10, formatShortDate(moves[moves.length - 1].date), 'end', 'jf-label'));
  svg.appendChild(_label(PAD_X, midY - 6, '0', 'start', 'jf-label'));
  return svg;
}

// ── then-now ──────────────────────────────────────────────────────────
// The window's opening band over tonight's band, two range bars on one
// axis. band-strip's own drawing idiom, doubled; the comparison is the
// figure's whole content.
function _thenNow(study) {
  const live = (study?.trajectory || []).filter(p => p && p.retro !== true);
  const est = estimateSummary(study);
  if (live.length < 2 || !est || !(est.hi > 0)) return null;
  const pct = (m) => (Math.exp(m) - 1) * 100;
  const first = live[0];
  const then = {
    lo: Math.max(0, pct(first.mean - first.sd)),
    hi: pct(first.mean + first.sd),
    mid: Math.max(0, pct(first.mean)),
  };
  const now = { lo: Math.max(0, est.lo), hi: est.hi, mid: Math.max(0, est.pct) };
  const axisMax = Math.max(then.hi, now.hi) * 1.18;
  if (!(axisMax > 0)) return null;

  const padX = 24;
  const trackW = VB_W - padX * 2;
  const xFor = (v) => padX + (v / axisMax) * trackW;
  const rows = [
    { y: 38, label: formatShortDate(first.date), band: then, dim: true },
    { y: 74, label: 'now', band: now, dim: false },
  ];

  const svg = _svg(STRIP_H + 16, 'The estimate band when this window opened, over the band tonight');
  for (const r of rows) {
    const track = document.createElementNS(svgNS, 'line');
    track.setAttribute('x1', padX);
    track.setAttribute('y1', r.y);
    track.setAttribute('x2', VB_W - padX);
    track.setAttribute('y2', r.y);
    track.setAttribute('class', 'jf-strip-track');
    track.setAttribute('stroke-width', 2);
    svg.appendChild(track);

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', xFor(r.band.lo));
    rect.setAttribute('y', r.y - 7);
    rect.setAttribute('width', Math.max(2, xFor(r.band.hi) - xFor(r.band.lo)));
    rect.setAttribute('height', 14);
    rect.setAttribute('rx', 3);
    rect.setAttribute('class', r.dim ? 'jf-band jf-dot-retro' : 'jf-band');
    _titled(rect, `${r.label} · ${r.band.lo <= 0 ? '0%' : `${fmtPct(r.band.lo)}%`} to ${fmtPct(r.band.hi)}%`);
    svg.appendChild(rect);

    const marker = _point(xFor(r.band.mid), r.y, 6, 'jf-strip-marker', 'diamond');
    _titled(marker, `${r.label} · about ${fmtPct(r.band.mid)}%`);
    svg.appendChild(marker);
    svg.appendChild(_label(padX, r.y - 12, r.label, 'start', 'jf-label'));
  }
  svg.appendChild(_label(padX, STRIP_H + 8, '0%', 'start', 'jf-label'));
  svg.appendChild(_label(VB_W - padX, STRIP_H + 8, `${fmtPct(axisMax / 1.18)}%`, 'end', 'jf-label'));
  return svg;
}

// ── width-funnel ──────────────────────────────────────────────────────
// The width of the band per live-era fit, drawn as a ribbon symmetric about a
// center line: at each fit the ribbon spans ±half the band's width in
// percentage points. Distinct from sd-trend (a relative line) and from
// estimate-band (which is about the level, not the width).
function _widthFunnel(study) {
  const live = (study?.trajectory || []).filter(p => p && p.retro !== true);
  if (live.length < 2) return null;
  const pct = (m) => (Math.exp(m) - 1) * 100;
  const pts = live.map(p => ({
    date: p.date,
    half: (pct(p.mean + p.sd) - pct(p.mean - p.sd)) / 2,
  }));
  const maxHalf = Math.max(...pts.map(p => p.half), 0.25);

  const plotW = VB_W - PAD_X * 2;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const midY = PAD_TOP + plotH / 2;
  const xFor = (i) => PAD_X + (i / (pts.length - 1)) * plotW;
  const yFor = (h) => (h / maxHalf) * (plotH / 2);

  const svg = _svg(VB_H, `The width of the plausible range across ${pts.length} nightly fits`);

  const ribbon = document.createElementNS(svgNS, 'path');
  ribbon.setAttribute('class', 'jf-band');
  ribbon.setAttribute('d',
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${(midY - yFor(p.half)).toFixed(1)}`).join(' ')
    + ' ' + [...pts].reverse().map((p, i) => `L${xFor(pts.length - 1 - i).toFixed(1)},${(midY + yFor(p.half)).toFixed(1)}`).join(' ')
    + ' Z');
  svg.appendChild(ribbon);

  const center = document.createElementNS(svgNS, 'line');
  center.setAttribute('x1', PAD_X);
  center.setAttribute('y1', midY);
  center.setAttribute('x2', VB_W - PAD_X);
  center.setAttribute('y2', midY);
  center.setAttribute('class', 'jf-baseline');
  center.setAttribute('stroke-width', 2);
  svg.appendChild(center);

  const dotR = pts.length > 40 ? 3 : 5;
  for (let i = 0; i < pts.length; i++) {
    const node = _point(xFor(i), midY - yFor(pts[i].half), i === pts.length - 1 ? 7 : dotR, 'jf-dot', 'circle');
    _titled(node, `${formatShortDate(pts[i].date)} · range about ${(pts[i].half * 2).toFixed(1)} points wide`);
    svg.appendChild(node);
  }

  svg.appendChild(_label(PAD_X, VB_H - 10, formatShortDate(pts[0].date), 'start', 'jf-label'));
  svg.appendChild(_label(VB_W - PAD_X, VB_H - 10, formatShortDate(pts[pts.length - 1].date), 'end', 'jf-label'));
  const lastW = pts[pts.length - 1].half * 2;
  svg.appendChild(_label(VB_W - PAD_X, PAD_TOP + 4, `${lastW.toFixed(1)} points wide`, 'end', 'jf-label jf-end-label'));
  return svg;
}

/**
 * Draw the figure a planStudyFigures spec asks for. Returns an SVG node
 * or null when the study can't support that figure (the planner already
 * checks eligibility; this is the belt to its braces).
 */
export function renderStudyFigure(study, spec) {
  switch (spec?.type) {
    case 'sd-trend': return _sdTrend(study, spec);
    case 'estimate-band': return _estimateBand(study);
    case 'band-strip': return _bandStrip(study);
    case 'move-strip': return _moveStrip(study);
    case 'then-now': return _thenNow(study);
    case 'width-funnel': return _widthFunnel(study);
    default: return null;
  }
}
