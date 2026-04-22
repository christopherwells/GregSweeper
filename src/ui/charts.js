// Minimalist SVG chart toolkit. No external dependencies. Every chart
// function returns a single <svg> element the caller can append to the DOM.
//
// Shared conventions across charts:
//   - viewBox is 600 × 400 by default (aspect ~1.5:1) — same as the
//     history chart so all stats-panel charts render at a consistent
//     size when the panel width changes.
//   - User units. Text sizes (~22 units) render readably even when the
//     SVG scales down to a 340px-wide mobile viewport.
//   - Grid is light, zero-line is prominent, colors come from CSS classes
//     so themes can override.
//
// All charts degrade gracefully on empty/sparse input — they return an
// empty-state <div> when there's nothing to draw.

const NS = 'http://www.w3.org/2000/svg';
const VB_W = 600;
const VB_H = 400;

const DEFAULT_LAYOUT = {
  padLeft: 64,
  padRight: 24,
  padTop: 28,
  padBottom: 56,
};

function el(tag, attrs = {}, children = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.appendChild(c);
  return e;
}

function emptyState(message) {
  const d = document.createElement('div');
  d.className = 'chart-empty';
  d.textContent = message;
  return d;
}

function makeSvg(ariaLabel) {
  const svg = el('svg', {
    class: 'stats-chart',
    viewBox: `0 0 ${VB_W} ${VB_H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': ariaLabel,
  });
  return svg;
}

// Nice axis tick step — returns a step value that divides `range` into 4-7 ticks.
function niceStep(range) {
  if (range <= 1) return 0.2;
  if (range <= 2.5) return 0.5;
  if (range <= 5) return 1;
  if (range <= 12) return 2;
  if (range <= 25) return 5;
  if (range <= 60) return 10;
  if (range <= 120) return 20;
  if (range <= 300) return 50;
  return 100;
}

function drawYAxis(svg, layout, yDomain, yToPx, opts = {}) {
  const { padLeft, padRight, padTop } = layout;
  const plotH = VB_H - padTop - layout.padBottom;
  const [yMin, yMax] = yDomain;
  const step = opts.step || niceStep(yMax - yMin);

  const first = Math.ceil(yMin / step) * step;
  for (let v = first; v <= yMax + 0.001; v += step) {
    const y = yToPx(v);
    const isZero = Math.abs(v) < 1e-9;
    svg.appendChild(el('line', {
      x1: padLeft, y1: y, x2: VB_W - padRight, y2: y,
      class: isZero ? 'chart-axis-zero' : 'chart-axis-grid',
    }));
    const rounded = Math.abs(v) < 1e-9 ? 0 : Math.round(v * 100) / 100;
    const label = el('text', {
      x: padLeft - 10, y: y + 7,
      'text-anchor': 'end',
      class: isZero ? 'chart-axis-label chart-axis-label-zero' : 'chart-axis-label',
    });
    label.textContent = opts.yFormat ? opts.yFormat(rounded) : String(rounded);
    svg.appendChild(label);
  }
}

function drawXTicks(svg, layout, xValues, xToPx, opts = {}) {
  const labels = opts.labels || xValues.map(v => String(v));
  const tickEvery = Math.max(1, Math.ceil(xValues.length / 5));
  const lastIdx = xValues.length - 1;

  for (let i = 0; i < xValues.length; i++) {
    const isFirst = i === 0;
    const isLast = i === lastIdx;
    const isRegular = i % tickEvery === 0 && !isFirst;
    if (!isFirst && !isLast && !isRegular) continue;
    if (isRegular && lastIdx - i < tickEvery / 2) continue;

    const x = xToPx(i);
    const anchor = isFirst ? 'start' : (isLast ? 'end' : 'middle');
    const label = el('text', {
      x, y: VB_H - layout.padBottom + 28,
      'text-anchor': anchor,
      class: 'chart-axis-label chart-x-label',
    });
    label.textContent = labels[i];
    svg.appendChild(label);
  }
}

// ── Line chart ──────────────────────────────────────────────────
//
// points: [{x: string or index, y: number, label?: string}]
// opts: {
//   ariaLabel, yLabel,
//   yDomain? (auto if omitted),
//   yFormat? (function),
//   lineClass? (CSS class for the connecting path),
//   dotClassForValue? (fn: value -> class),
//   thresholdLine? (y value for a reference horizontal, e.g. 0)
// }
export function lineChart(points, opts = {}) {
  if (!points || points.length === 0) {
    return emptyState(opts.emptyMessage || 'Not enough data yet.');
  }

  const svg = makeSvg(opts.ariaLabel || 'Trend line');
  const layout = { ...DEFAULT_LAYOUT };

  // Optional secondary series, rendered on the same y-axis as the
  // primary one. Same x-count expected; if the caller passes fewer
  // points the series just draws shorter. Styled with a distinct
  // class (dashed line by default via `chart-line-secondary` CSS).
  const secondary = Array.isArray(opts.secondary) ? opts.secondary : null;

  // Pool y-values from both series when picking the auto-domain so
  // neither line clips.
  const primaryYs = points.map(p => p.y).filter(v => Number.isFinite(v));
  const secondaryYs = secondary
    ? secondary.map(p => p.y).filter(v => Number.isFinite(v))
    : [];
  const allYs = [...primaryYs, ...secondaryYs];
  if (allYs.length === 0) return emptyState(opts.emptyMessage || 'Not enough data yet.');

  // Y-domain: given, or fit to data with a little breathing room.
  let yMin = opts.yDomain ? opts.yDomain[0] : Math.min(...allYs);
  let yMax = opts.yDomain ? opts.yDomain[1] : Math.max(...allYs);
  if (!opts.yDomain) {
    const span = yMax - yMin;
    const pad = span < 1 ? 1 : span * 0.15;
    yMin -= pad;
    yMax += pad;
  }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }

  const plotH = VB_H - layout.padTop - layout.padBottom;
  const plotW = VB_W - layout.padLeft - layout.padRight;
  const yToPx = v => layout.padTop + plotH * (1 - (v - yMin) / (yMax - yMin));
  const xToPx = i => layout.padLeft + (points.length === 1 ? plotW / 2 : plotW * i / (points.length - 1));

  drawYAxis(svg, layout, [yMin, yMax], yToPx, { yFormat: opts.yFormat });

  // Optional threshold line (e.g. zero)
  if (opts.thresholdLine != null && opts.thresholdLine >= yMin && opts.thresholdLine <= yMax) {
    const y = yToPx(opts.thresholdLine);
    svg.appendChild(el('line', {
      x1: layout.padLeft, y1: y, x2: VB_W - layout.padRight, y2: y,
      class: 'chart-threshold',
    }));
  }

  // Secondary series FIRST so the primary renders on top (primary is
  // the main signal the user reads; secondary is supporting context).
  if (secondary && secondary.length > 1) {
    const d = secondary
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xToPx(i)},${yToPx(p.y)}`)
      .join(' ');
    svg.appendChild(el('path', {
      d,
      class: opts.secondaryLineClass || 'chart-line chart-line-secondary',
      fill: 'none',
    }));
    for (let i = 0; i < secondary.length; i++) {
      const p = secondary[i];
      const dot = el('circle', {
        cx: xToPx(i), cy: yToPx(p.y), r: 4,
        class: 'chart-dot chart-dot-secondary',
      });
      const title = el('title', {});
      title.textContent = p.label || `${p.x}: ${p.y}`;
      dot.appendChild(title);
      svg.appendChild(dot);
    }
  }

  // Primary connecting path
  if (points.length > 1) {
    const d = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xToPx(i)},${yToPx(p.y)}`)
      .join(' ');
    svg.appendChild(el('path', {
      d,
      class: opts.lineClass || 'chart-line',
      fill: 'none',
    }));
  }

  // Primary dots
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cls = 'chart-dot ' + (opts.dotClassForValue ? opts.dotClassForValue(p.y) : '');
    const dot = el('circle', {
      cx: xToPx(i), cy: yToPx(p.y), r: 7, class: cls.trim(),
    });
    const title = el('title', {});
    title.textContent = p.label || `${p.x}: ${p.y}`;
    dot.appendChild(title);
    svg.appendChild(dot);
  }

  drawXTicks(svg, layout, points, xToPx, { labels: points.map(p => p.x) });
  return svg;
}

// ── Stacked area chart ──────────────────────────────────────────
//
// series: [{ label, colorClass, values: number[] }]
// xLabels: string[]  (same length as values)
// opts: { ariaLabel, yLabel, yFormat, normalize? (if true, stack to 100%) }
export function stackedAreaChart(series, xLabels, opts = {}) {
  if (!series || series.length === 0 || !xLabels || xLabels.length === 0) {
    return emptyState(opts.emptyMessage || 'Not enough data yet.');
  }
  const n = xLabels.length;

  // Stack: for each x, cumulative sum of each series' value.
  const stacks = series.map(() => new Array(n).fill(0));
  const totals = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < series.length; s++) {
      totals[i] += series[s].values[i] || 0;
    }
  }
  for (let i = 0; i < n; i++) {
    let cum = 0;
    for (let s = 0; s < series.length; s++) {
      const raw = series[s].values[i] || 0;
      const v = opts.normalize ? (totals[i] > 0 ? raw / totals[i] : 0) : raw;
      cum += v;
      stacks[s][i] = cum;
    }
  }

  const svg = makeSvg(opts.ariaLabel || 'Stacked area');
  const layout = { ...DEFAULT_LAYOUT };
  const plotH = VB_H - layout.padTop - layout.padBottom;
  const plotW = VB_W - layout.padLeft - layout.padRight;
  const yMax = opts.normalize ? 1 : Math.max(...stacks[stacks.length - 1], 1);
  const yToPx = v => layout.padTop + plotH * (1 - v / yMax);
  const xToPx = i => layout.padLeft + (n === 1 ? plotW / 2 : plotW * i / (n - 1));

  drawYAxis(svg, layout, [0, yMax], yToPx, {
    yFormat: opts.yFormat || (opts.normalize ? v => `${Math.round(v * 100)}%` : undefined),
  });

  // Draw each area from top of stack down to baseline (0 for lowest, previous stack for others).
  for (let s = series.length - 1; s >= 0; s--) {
    const top = stacks[s];
    const bottom = s > 0 ? stacks[s - 1] : new Array(n).fill(0);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(`${xToPx(i)},${yToPx(top[i])}`);
    for (let i = n - 1; i >= 0; i--) pts.push(`${xToPx(i)},${yToPx(bottom[i])}`);
    svg.appendChild(el('polygon', {
      points: pts.join(' '),
      class: `chart-area ${series[s].colorClass || ''}`.trim(),
    }));
  }

  drawXTicks(svg, layout, xLabels.map((_, i) => i), xToPx, { labels: xLabels });

  // Legend along the top-right
  let legendX = VB_W - layout.padRight;
  let legendY = layout.padTop - 8;
  for (let s = series.length - 1; s >= 0; s--) {
    const label = el('text', {
      x: legendX, y: legendY,
      'text-anchor': 'end',
      class: `chart-legend chart-area ${series[s].colorClass || ''}`.trim(),
    });
    label.textContent = series[s].label;
    svg.appendChild(label);
    legendY -= 26;
  }

  return svg;
}

// ── Grouped bar chart ───────────────────────────────────────────
//
// groups: [{ label, values: number[] }]
// seriesLabels: ['current', 'previous']  (optional)
// opts: { ariaLabel, yFormat, barClasses?: string[] }
export function groupedBarChart(groups, seriesLabels, opts = {}) {
  if (!groups || groups.length === 0) {
    return emptyState(opts.emptyMessage || 'Not enough data yet.');
  }
  const nSeries = groups[0].values.length;
  const svg = makeSvg(opts.ariaLabel || 'Grouped bars');
  const layout = { ...DEFAULT_LAYOUT };
  const plotH = VB_H - layout.padTop - layout.padBottom;
  const plotW = VB_W - layout.padLeft - layout.padRight;

  const allValues = groups.flatMap(g => g.values);
  const yMin = Math.min(0, ...allValues);
  const yMax = Math.max(0, ...allValues);
  const span = (yMax - yMin) || 1;
  const paddedMin = yMin - span * 0.08;
  const paddedMax = yMax + span * 0.08;

  const yToPx = v => layout.padTop + plotH * (1 - (v - paddedMin) / (paddedMax - paddedMin));

  drawYAxis(svg, layout, [paddedMin, paddedMax], yToPx, { yFormat: opts.yFormat });

  // Zero reference
  if (paddedMin < 0 && paddedMax > 0) {
    const y = yToPx(0);
    svg.appendChild(el('line', {
      x1: layout.padLeft, y1: y, x2: VB_W - layout.padRight, y2: y,
      class: 'chart-axis-zero',
    }));
  }

  const groupWidth = plotW / groups.length;
  const barWidth = (groupWidth * 0.8) / nSeries;
  const barClasses = opts.barClasses || ['chart-bar-a', 'chart-bar-b'];

  for (let g = 0; g < groups.length; g++) {
    const cx = layout.padLeft + groupWidth * (g + 0.5);
    for (let s = 0; s < nSeries; s++) {
      const v = groups[g].values[s];
      const y = yToPx(Math.max(0, v));
      const h = Math.abs(yToPx(v) - yToPx(0));
      const x = cx + barWidth * (s - nSeries / 2);
      svg.appendChild(el('rect', {
        x, y, width: barWidth - 2, height: Math.max(1, h),
        class: `chart-bar ${barClasses[s] || ''}`.trim(),
      }));
    }
    // x label
    const lbl = el('text', {
      x: cx, y: VB_H - layout.padBottom + 28,
      'text-anchor': 'middle',
      class: 'chart-axis-label chart-x-label',
    });
    lbl.textContent = groups[g].label;
    svg.appendChild(lbl);
  }

  // Legend
  if (seriesLabels && seriesLabels.length > 0) {
    let lx = VB_W - layout.padRight;
    let ly = layout.padTop - 8;
    for (let s = seriesLabels.length - 1; s >= 0; s--) {
      const lbl = el('text', {
        x: lx, y: ly,
        'text-anchor': 'end',
        class: `chart-legend ${barClasses[s] || ''}`.trim(),
      });
      lbl.textContent = seriesLabels[s];
      svg.appendChild(lbl);
      ly -= 26;
    }
  }

  return svg;
}

// ── Bar chart (single series) ────────────────────────────────────
export function barChart(labels, values, opts = {}) {
  const groups = labels.map((l, i) => ({ label: l, values: [values[i]] }));
  const svg = groupedBarChart(groups, null, { ...opts, barClasses: [opts.barClass || 'chart-bar-a'] });
  // Optional vertical marker line at a specific data index (fractional OK).
  // Used by the delta-distribution histogram to place a zero indicator
  // between the bin whose range brackets 0.
  if (typeof opts.verticalMarkerAt === 'number' && svg.tagName?.toLowerCase() === 'svg') {
    const layout = { ...DEFAULT_LAYOUT };
    const plotW = VB_W - layout.padLeft - layout.padRight;
    const n = groups.length;
    const groupWidth = plotW / n;
    const x = layout.padLeft + groupWidth * (opts.verticalMarkerAt + 0.5);
    svg.appendChild(el('line', {
      x1: x, y1: layout.padTop, x2: x, y2: VB_H - layout.padBottom,
      class: 'chart-threshold',
    }));
    if (opts.verticalMarkerLabel) {
      const lbl = el('text', {
        x, y: layout.padTop - 6,
        'text-anchor': 'middle',
        class: 'chart-axis-label chart-axis-label-zero',
      });
      lbl.textContent = opts.verticalMarkerLabel;
      svg.appendChild(lbl);
    }
  }
  return svg;
}

// ── Kernel density estimate (frequency distribution) ──────────
//
// Smooth distribution of a univariate sample. Bandwidth picked by
// Silverman's rule of thumb: h = 1.06 σ n^(-1/5). Renders as a filled
// curve with an optional vertical threshold line (e.g. par = 0).
//
// values: number[] — the samples
// opts: {
//   ariaLabel,
//   xFormat? (number -> string for axis labels),
//   thresholdLine? number,
//   thresholdLabel? string,
// }
export function densityChart(values, opts = {}) {
  if (!values || values.length < 3) {
    return emptyState(opts.emptyMessage || 'Need at least 3 data points.');
  }
  const svg = makeSvg(opts.ariaLabel || 'Density');
  const layout = { ...DEFAULT_LAYOUT };
  const plotH = VB_H - layout.padTop - layout.padBottom;
  const plotW = VB_W - layout.padLeft - layout.padRight;

  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance) || 1;
  // Silverman's rule of thumb — robust for small samples and easy to reason
  // about. Floor keeps the curve readable when variance is tiny.
  const bandwidth = Math.max(1, 1.06 * sd * Math.pow(n, -1 / 5));

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max(3 * bandwidth, (rawMax - rawMin) * 0.1 || 1);
  const xMin = rawMin - pad;
  const xMax = rawMax + pad;

  const SAMPLES = 120;
  const kde = x => {
    let acc = 0;
    for (const v of values) {
      const z = (x - v) / bandwidth;
      acc += Math.exp(-0.5 * z * z);
    }
    // Constant normaliser — not needed for display shape, but keeps
    // peak height comparable across populations.
    return acc / (n * bandwidth * Math.sqrt(2 * Math.PI));
  };

  const xs = [];
  const ys = [];
  for (let i = 0; i < SAMPLES; i++) {
    const x = xMin + (xMax - xMin) * (i / (SAMPLES - 1));
    xs.push(x);
    ys.push(kde(x));
  }
  const yMax = Math.max(...ys) || 1;

  const xToPx = x => layout.padLeft + plotW * ((x - xMin) / (xMax - xMin));
  const yToPx = y => layout.padTop + plotH * (1 - y / (yMax * 1.1));

  // Y grid — omit y-axis labels since the numeric density value is not
  // the reader's target ("how often this delta" reads more intuitively
  // from bar height alone).
  drawYAxis(svg, layout, [0, yMax * 1.1], yToPx, {
    yFormat: () => '',
    step: yMax * 1.1, // just the top line
  });

  // Helper to draw a labeled vertical marker line inside the plot area.
  // labelYOffset lets callers stagger nearby labels vertically so two
  // close-together markers don't collide (par vs. mean, typically).
  const drawMarker = (x, label, cls, labelYOffset = 0) => {
    if (x < xMin || x > xMax) return;
    const px = xToPx(x);
    svg.appendChild(el('line', {
      x1: px, y1: layout.padTop, x2: px, y2: VB_H - layout.padBottom,
      class: cls,
    }));
    if (label) {
      const lbl = el('text', {
        x: px, y: layout.padTop - 6 + labelYOffset,
        'text-anchor': 'middle',
        class: 'chart-axis-label chart-axis-label-zero',
      });
      lbl.textContent = label;
      svg.appendChild(lbl);
    }
  };

  // Par line (threshold)
  if (typeof opts.thresholdLine === 'number') {
    drawMarker(opts.thresholdLine, opts.thresholdLabel, 'chart-threshold');
  }
  // Optional second line for the sample mean (shown distinct from par).
  // If it's close enough to the par line that labels would run into each
  // other, drop the mean label below the plot area instead of above.
  if (typeof opts.meanLine === 'number') {
    let labelYOffset = 0;
    if (typeof opts.thresholdLine === 'number') {
      const px = xToPx(opts.meanLine);
      const parPx = xToPx(opts.thresholdLine);
      if (Math.abs(px - parPx) < 80) {
        // Render the mean label below the plot so it doesn't stack on "par"
        labelYOffset = VB_H - 2 * layout.padTop + 12;
      }
    }
    drawMarker(opts.meanLine, opts.meanLabel, 'chart-meanline', labelYOffset);
  }

  // Filled curve
  const pathD = [];
  pathD.push(`M${xToPx(xs[0])},${yToPx(0)}`);
  for (let i = 0; i < SAMPLES; i++) {
    pathD.push(`L${xToPx(xs[i])},${yToPx(ys[i])}`);
  }
  pathD.push(`L${xToPx(xs[xs.length - 1])},${yToPx(0)}`);
  pathD.push('Z');
  svg.appendChild(el('path', {
    d: pathD.join(' '),
    class: 'chart-density-fill',
  }));

  // Stroke on top for definition
  const strokeD = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${xToPx(x)},${yToPx(ys[i])}`).join(' ');
  svg.appendChild(el('path', {
    d: strokeD,
    class: 'chart-density-line',
    fill: 'none',
  }));

  // X tick labels — use nice round values near min, mean, and max.
  const ticks = [xMin, (xMin + xMax) / 2, xMax].map(v => Math.round(v));
  const uniqueTicks = [...new Set(ticks)].sort((a, b) => a - b);
  for (const t of uniqueTicks) {
    const label = el('text', {
      x: xToPx(t), y: VB_H - layout.padBottom + 28,
      'text-anchor': 'middle',
      class: 'chart-axis-label chart-x-label',
    });
    label.textContent = opts.xFormat ? opts.xFormat(t) : ((t > 0 ? '+' : '') + t + 's');
    svg.appendChild(label);
  }

  return svg;
}

// ── IQR / box-range chart ──────────────────────────────────────
//
// boxes: [{ label, median, q1, q3, min, max }]
// Plots a vertical range from q1 to q3 with a median tick. Thin
// whiskers mark min/max. Useful for showing consistency over weeks.
export function boxChart(boxes, opts = {}) {
  if (!boxes || boxes.length === 0) {
    return emptyState(opts.emptyMessage || 'Not enough data yet.');
  }
  const svg = makeSvg(opts.ariaLabel || 'IQR bands');
  const layout = { ...DEFAULT_LAYOUT };
  const plotH = VB_H - layout.padTop - layout.padBottom;
  const plotW = VB_W - layout.padLeft - layout.padRight;

  const all = boxes.flatMap(b => [b.min, b.max]);
  let yMin = Math.min(...all), yMax = Math.max(...all);
  const span = (yMax - yMin) || 1;
  yMin -= span * 0.1;
  yMax += span * 0.1;

  const yToPx = v => layout.padTop + plotH * (1 - (v - yMin) / (yMax - yMin));

  drawYAxis(svg, layout, [yMin, yMax], yToPx, { yFormat: opts.yFormat });

  // Zero reference (for delta charts)
  if (opts.thresholdLine != null && opts.thresholdLine >= yMin && opts.thresholdLine <= yMax) {
    const y = yToPx(opts.thresholdLine);
    svg.appendChild(el('line', {
      x1: layout.padLeft, y1: y, x2: VB_W - layout.padRight, y2: y,
      class: 'chart-threshold',
    }));
  }

  const groupWidth = plotW / boxes.length;
  const boxWidth = groupWidth * 0.55;

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const cx = layout.padLeft + groupWidth * (i + 0.5);

    // Whisker
    svg.appendChild(el('line', {
      x1: cx, y1: yToPx(b.min), x2: cx, y2: yToPx(b.max),
      class: 'chart-whisker',
    }));
    // Box (q1 to q3)
    const top = yToPx(b.q3);
    const bottom = yToPx(b.q1);
    svg.appendChild(el('rect', {
      x: cx - boxWidth / 2, y: top, width: boxWidth, height: Math.max(1, bottom - top),
      class: 'chart-box',
    }));
    // Median tick
    svg.appendChild(el('line', {
      x1: cx - boxWidth / 2, y1: yToPx(b.median),
      x2: cx + boxWidth / 2, y2: yToPx(b.median),
      class: 'chart-median',
    }));

    const lbl = el('text', {
      x: cx, y: VB_H - layout.padBottom + 28,
      'text-anchor': 'middle',
      class: 'chart-axis-label chart-x-label',
    });
    lbl.textContent = b.label;
    svg.appendChild(lbl);
  }

  return svg;
}

// ── Heat-map (per-category bars with color) ─────────────────────
//
// Items: [{ label, value, sub? (e.g. "n=14") }]
// Layout: fixed left column for category label, fixed right column for
// value text, bars live in the middle with a vertical zero line. Bars
// extend left for negative values and right for positive, but the value
// text always sits in the same far-right column — so collisions between
// bar and value label are impossible even on very short bars.
export function heatBars(items, opts = {}) {
  if (!items || items.length === 0) {
    return emptyState(opts.emptyMessage || 'Not enough data yet.');
  }
  const svg = makeSvg(opts.ariaLabel || 'Heat bars');
  const LABEL_COL = 170;  // left-side category labels
  const VALUE_COL = 130;  // right-side value text
  const PAD_TOP = 16;
  const PAD_BOTTOM = 16;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const plotLeft = LABEL_COL;
  const plotRight = VB_W - VALUE_COL;
  const plotW = plotRight - plotLeft;

  const absMax = Math.max(1, ...items.map(i => Math.abs(i.value)));
  const zeroX = plotLeft + plotW * 0.5;
  const xToPx = v => zeroX + (plotW * 0.5) * (v / absMax);

  const rowH = plotH / items.length;

  // Vertical zero line
  svg.appendChild(el('line', {
    x1: zeroX, y1: PAD_TOP, x2: zeroX, y2: VB_H - PAD_BOTTOM,
    class: 'chart-axis-zero',
  }));

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const cy = PAD_TOP + rowH * (i + 0.5);
    const x = xToPx(it.value);
    const barLeft = Math.min(x, zeroX);
    const barRight = Math.max(x, zeroX);

    const cls = it.value < -0.5 ? 'chart-heat-good'
      : it.value > 0.5 ? 'chart-heat-bad'
      : 'chart-heat-even';

    svg.appendChild(el('rect', {
      x: barLeft, y: cy - rowH * 0.28, width: Math.max(2, barRight - barLeft), height: rowH * 0.56,
      class: `chart-heat-bar ${cls}`,
    }));

    // Category label (left column, right-aligned)
    const label = el('text', {
      x: LABEL_COL - 16, y: cy + 8,
      'text-anchor': 'end',
      class: 'chart-axis-label',
    });
    label.textContent = it.label;
    svg.appendChild(label);

    // Value label (right column, left-aligned so all values line up)
    const valLabel = el('text', {
      x: plotRight + 12, y: cy + 8,
      'text-anchor': 'start',
      class: `chart-axis-label chart-value-label ${cls}`,
    });
    const valText = opts.valueFormat
      ? opts.valueFormat(it.value)
      : (it.value > 0 ? '+' : '') + it.value.toFixed(1);
    valLabel.textContent = valText + (it.sub ? ' ' + it.sub : '');
    svg.appendChild(valLabel);
  }

  return svg;
}
