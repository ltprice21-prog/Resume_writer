/* Chart builders for the Account Health dashboard.
 *
 * Plain HTML and inline SVG — no libraries, no network. Colour comes from CSS
 * custom properties so light and dark are separate, deliberate palettes rather
 * than an automatic flip. Series colour never carries meaning alone: every chart
 * ships a legend, direct labels, or both, and each mark exposes `data-tip` for
 * the shared tooltip.
 *
 * Extends the global `AMI` namespace.
 */
(function (global) {
  'use strict';

  const AMI = global.AMI || (global.AMI = {});
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmt = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString());

  /* ------------------------------------------------------------------ *
   * Stage fills
   * ------------------------------------------------------------------ *
   *
   * A stage is drawn with a hue AND a weave, because hue alone excludes a
   * reader with colour vision deficiency — and on this pipeline the four stages
   * sit on one hue by design, which makes them the hardest case. The weave order
   * is solid, diagonal, horizontal, vertical, matching pipeline order.
   */

  const PATTERN_WORD = {
    solid: 'solid', diagonal: 'diagonal stripes',
    horizontal: 'horizontal stripes', vertical: 'vertical stripes',
  };

  /** The class that paints a stage. Everything showing a stage uses this. */
  const stageClass = (step) => 'stage-fill stage-' + step;

  /** Spoken form of a stage's fill, for tooltips and screen readers. */
  const patternWord = (status) => PATTERN_WORD[(status && status.pattern) || 'solid'] || 'solid';

  /**
   * SVG cannot reach the CSS gradients, so stage fills are declared once per
   * chart as `<pattern>` elements referencing the same custom properties.
   */
  function stagePatternDefs(steps) {
    const list = steps || [1, 2, 3, 4];
    const body = list.map((n) => {
      const ink = 'var(--stage-ink-' + n + ')';
      const bg = '<rect width="8" height="8" fill="var(--stage-' + n + ')"/>';
      if (n === 1) return pat(n, bg);
      if (n === 2) {
        return pat(n, bg + '<path d="M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4" stroke="' + ink
          + '" stroke-width="3"/>');
      }
      if (n === 3) return pat(n, bg + '<rect y="4" width="8" height="3" fill="' + ink + '"/>');
      return pat(n, bg + '<rect x="4" width="3" height="8" fill="' + ink + '"/>');
    }).join('');
    return '<defs>' + body + '</defs>';

    function pat(n, inner) {
      return '<pattern id="stagepat-' + n + '" patternUnits="userSpaceOnUse" width="8" height="8">'
        + inner + '</pattern>';
    }
  }

  const stagePaint = (step) => 'url(#stagepat-' + step + ')';

  /* ------------------------------------------------------------------ *
   * Stat tiles
   * ------------------------------------------------------------------ */

  /**
   * A row of headline figures. Each tile states what it counts; `tone` maps to
   * the reserved status palette and always ships with its label, never colour alone.
   */
  function statTiles(tiles) {
    return '<div class="stat-row">' + tiles.map((t) => {
      const tone = t.tone ? ' tone-' + t.tone : '';
      return '<div class="stat-tile' + tone + '"'
        + (t.tip ? ' data-tip="' + esc(t.tip) + '"' : '') + '>'
        + '<div class="stat-label">' + esc(t.label) + '</div>'
        + '<div class="stat-value">' + esc(t.value) + '</div>'
        + (t.sub ? '<div class="stat-sub">' + esc(t.sub) + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Stacked bar (ordinal pipeline)
   * ------------------------------------------------------------------ */

  /**
   * One stacked bar. Segments carry a 2px surface gap and their own weave, so
   * adjacent stages stay separable without relying on hue contrast.
   *
   * Each segment is `{ value, label, step, key }`; `key` makes the segment
   * clickable for drill-down.
   */
  function stackedBar(segments, opts) {
    const o = opts || {};
    const total = segments.reduce((a, s) => a + (s.value || 0), 0);
    if (!total) {
      return '<div class="bar-track empty"><span class="bar-empty">' + esc(o.emptyText || 'Nothing to show') + '</span></div>';
    }
    const parts = segments.filter((s) => s.value > 0).map((s) => {
      const pct = (s.value / total) * 100;
      const patterned = s.step && s.step !== 1;
      const label = pct >= (o.labelThreshold || 11)
        ? '<span class="bar-inline' + (patterned ? ' on-pattern' : '') + '">' + esc(s.value) + '</span>'
        : '';
      const tip = s.label + ': ' + fmt(s.value) + ' of ' + fmt(total) + ' (' + Math.round(pct) + '%)'
        + (s.patternWord ? ' · ' + s.patternWord : '');
      return '<span class="bar-seg ' + esc(stageClass(s.step || 1)) + '"'
        + ' style="flex:' + s.value + ';"'
        + (s.key ? ' data-drill="' + esc(s.key) + '" tabindex="0" role="button"' : '')
        + ' data-tip="' + esc(tip) + '">' + label + '</span>';
    }).join('');
    return '<div class="bar-track">' + parts + '</div>';
  }

  /**
   * Shared key for anything drawn with the status ramp. Names the weave as well
   * as showing it, so the key still works when read aloud or printed in grey.
   */
  function statusLegend(statuses, counts) {
    return '<ul class="legend">' + statuses.map((s) => {
      const n = counts ? counts[s.id] : null;
      const word = patternWord(s);
      return '<li data-tip="' + esc(s.hint + ' Shown as ' + word + '.') + '">'
        + '<span class="swatch ' + esc(stageClass(s.step)) + '" aria-hidden="true"></span>'
        + '<span class="legend-label">' + esc(s.short) + '</span>'
        + '<span class="legend-pattern">' + esc(word) + '</span>'
        + (n != null ? '<span class="legend-value">' + fmt(n) + '</span>' : '')
        + '</li>';
    }).join('') + '</ul>';
  }

  /* ------------------------------------------------------------------ *
   * Bar list (one labelled bar per row)
   * ------------------------------------------------------------------ */

  /**
   * Rows of `{ label, sub, segments | value, meta }`. Used for orders-by-account
   * and for the aging list; the row label is always present, so the bars add
   * proportion rather than carrying identity.
   */
  function barList(rows, opts) {
    const o = opts || {};
    if (!rows.length) return '<p class="chart-empty">' + esc(o.emptyText || 'Nothing to show') + '</p>';
    const max = o.max != null ? o.max : Math.max(1, ...rows.map((r) => (
      r.segments ? r.segments.reduce((a, s) => a + s.value, 0) : (r.value || 0))));

    return '<div class="bar-list">' + rows.map((r) => {
      const total = r.segments ? r.segments.reduce((a, s) => a + s.value, 0) : (r.value || 0);
      const scale = max ? (total / max) * 100 : 0;
      // A row that measures something other than pipeline position (an age, a
      // count) takes the reserved status palette, never a stage weave — a weave
      // there would claim a stage the row does not have.
      const paint = r.tone ? 'bar-tone-' + r.tone : stageClass(r.step || 3);
      const inner = r.segments
        ? stackedBar(r.segments, { labelThreshold: 14 })
        : '<div class="bar-track"><span class="bar-seg ' + esc(paint) + '"'
          + ' style="flex:1;"'
          + (r.key ? ' data-drill="' + esc(r.key) + '" tabindex="0" role="button"' : '')
          + ' data-tip="' + esc(r.tip || (r.label + ': ' + fmt(total))) + '"></span></div>';
      return '<div class="bar-row"' + (r.onclickKey ? ' data-row-key="' + esc(r.onclickKey) + '"' : '') + '>'
        + '<div class="bar-label">' + esc(r.label)
        + (r.sub ? '<span class="bar-sub">' + esc(r.sub) + '</span>' : '') + '</div>'
        + '<div class="bar-plot" style="--fill:' + scale.toFixed(2) + '%">' + inner + '</div>'
        + '<div class="bar-total">' + esc(r.meta != null ? r.meta : fmt(total)) + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Column chart (volume over time)
   * ------------------------------------------------------------------ */

  /**
   * Monthly columns. A single series, so no legend — the title names it. Value
   * labels are selective: the peak and the final column only.
   */
  function columnChart(points, opts) {
    const o = opts || {};
    const width = o.width || 640;
    const height = o.height || 168;
    const padL = 34;
    const padB = 26;
    const padT = 12;
    if (!points.length) return '<p class="chart-empty">' + esc(o.emptyText || 'No dated activity yet') + '</p>';

    const max = Math.max(1, ...points.map((p) => p.value));
    const plotW = width - padL - 8;
    const plotH = height - padT - padB;
    const slot = plotW / points.length;
    const barW = Math.max(6, Math.min(30, slot - 8));
    const peakIdx = points.reduce((bi, p, i) => (p.value > points[bi].value ? i : bi), 0);

    const gridVals = [0, max / 2, max];
    const grid = gridVals.map((v) => {
      const y = padT + plotH - (v / max) * plotH;
      return '<line x1="' + padL + '" x2="' + (width - 8) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1)
        + '" class="grid"/>'
        + '<text x="' + (padL - 7) + '" y="' + (y + 3.5).toFixed(1) + '" class="axis" text-anchor="end">'
        + esc(Math.round(v)) + '</text>';
    }).join('');

    const bars = points.map((p, i) => {
      const h = (p.value / max) * plotH;
      const x = padL + i * slot + (slot - barW) / 2;
      const y = padT + plotH - h;
      const showLabel = i === peakIdx || i === points.length - 1;
      const r = Math.min(4, barW / 2);
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1)
        + '" height="' + Math.max(h, p.value ? 2 : 0).toFixed(1) + '" rx="' + r + '" class="col"'
        + (p.key && p.value ? ' data-drill="' + esc(p.key) + '" tabindex="0" role="button"' : '')
        + ' data-tip="' + esc(p.label + ': ' + fmt(p.value) + (o.unit ? ' ' + o.unit : '')) + '"/>'
        + (showLabel && p.value
          ? '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (y - 5).toFixed(1)
            + '" class="col-label" text-anchor="middle">' + esc(fmt(p.value)) + '</text>'
          : '')
        + (i % (points.length > 8 ? 2 : 1) === 0
          ? '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (height - 8)
            + '" class="axis" text-anchor="middle">' + esc(p.short || p.label) + '</text>'
          : '');
    }).join('');

    return '<svg class="chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" '
      + 'aria-label="' + esc(o.ariaLabel || 'Monthly volume') + '" preserveAspectRatio="xMidYMid meet">'
      + grid + bars + '</svg>';
  }

  /* ------------------------------------------------------------------ *
   * Health pill
   * ------------------------------------------------------------------ */

  const HEALTH_ICON = { good: '✓', warning: '!', critical: '!' };
  const HEALTH_WORD = { good: 'On track', warning: 'Needs attention', critical: 'At risk' };

  /** Status colour is never alone: an icon and a word ship with it. */
  function healthPill(level, tip) {
    return '<span class="health health-' + esc(level) + '"'
      + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '>'
      + '<span class="health-icon" aria-hidden="true">' + (HEALTH_ICON[level] || '') + '</span>'
      + esc(HEALTH_WORD[level] || level) + '</span>';
  }

  function statusPill(status, opts) {
    const o = opts || {};
    if (!status || !status.id) {
      return '<span class="pill pill-unset"' + (o.tip ? ' data-tip="' + esc(o.tip) + '"' : '') + '>Not set</span>';
    }
    const tip = [o.tip, 'Shown as ' + patternWord(status) + '.'].filter(Boolean).join(' ');
    return '<span class="pill pill-stage ' + esc(stageClass(status.step)) + '"'
      + ' data-tip="' + esc(tip) + '">' + esc(o.short ? status.short : status.label) + '</span>';
  }

  /* ------------------------------------------------------------------ *
   * Monthly buckets
   * ------------------------------------------------------------------ */

  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Bucket a set of dated values into the trailing `months` calendar months. */
  function monthlySeries(entries, months, today) {
    const now = today || new Date();
    const n = months || 12;
    const buckets = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        year: d.getFullYear(), month: d.getMonth(), value: 0,
        short: MONTH_SHORT[d.getMonth()],
        label: MONTH_SHORT[d.getMonth()] + ' ' + d.getFullYear(),
      });
    }
    for (const e of entries) {
      if (!e.date) continue;
      const b = buckets.find((x) => x.year === e.date.getFullYear() && x.month === e.date.getMonth());
      if (b) b.value += (e.value == null ? 1 : e.value);
    }
    return buckets;
  }

  Object.assign(AMI, {
    statTiles, stackedBar, statusLegend, barList, columnChart,
    healthPill, statusPill, monthlySeries, MONTH_SHORT,
    stageClass, stagePatternDefs, stagePaint, patternWord, PATTERN_WORD,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
