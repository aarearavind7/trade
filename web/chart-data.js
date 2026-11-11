/* Shared chart calculations. No generated OHLC or volume for missing provider fields. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeChart = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const timestamp = value => new Date(typeof value === 'string' ? value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, '$1') : value).getTime();
  function normalize(rows) {
    const unique = new Map();
    for (const row of rows || []) {
      if (!row || row.t == null || row.t === '') continue;
      const stamp = timestamp(row.t), c = number(row.c);
      if (!Number.isFinite(stamp) || c == null || c <= 0) continue;
      const o = number(row.o), h = number(row.h), l = number(row.l), v = number(row.v);
      const complete = o > 0 && h > 0 && l > 0 && h >= Math.max(o, c) && l <= Math.min(o, c);
      unique.set(stamp, {t: new Date(stamp).toISOString(), stamp, c, o: complete ? o : null,
        h: complete ? h : null, l: complete ? l : null, v: v != null && v >= 0 ? v : null,
        provisional: !!row._provisional});
    }
    return [...unique.values()].sort((a, b) => a.stamp - b.stamp);
  }
  function sma(bars, period) {
    let total = 0;
    return bars.map((bar, index) => {
      total += bar.c;
      if (index >= period) total -= bars[index - period].c;
      return index >= period - 1 ? total / period : null;
    });
  }
  function model(rows, {averages = [20, 50], limit = 1500} = {}) {
    const all = normalize(rows), start = Math.max(0, all.length - limit), bars = all.slice(start);
    const lines = averages.map(period => ({period, values: sma(all, period).slice(start)}));
    const prices = bars.flatMap(b => [b.l ?? b.c, b.h ?? b.c]);
    lines.forEach(line => line.values.forEach(value => { if (value != null) prices.push(value); }));
    const min = prices.length ? Math.min(...prices) : 0, max = prices.length ? Math.max(...prices) : 1;
    const pad = (max - min || Math.max(1, max * .01)) * .08;
    const low = min - pad, high = max + pad;
    return {bars, lines, low, high, x: i => (i + .5) * 760 / Math.max(1, bars.length),
      y: value => 12 + (high - value) / (high - low) * 192,
      priceAt: y => high - Math.max(0, Math.min(1, (y - 12) / 192)) * (high - low),
      nearest: x => Math.max(0, Math.min(bars.length - 1, Math.floor(x / 760 * bars.length))),
      maxVolume: Math.max(1, ...bars.map(bar => bar.v ?? 0)), truncated: start > 0};
  }
  function path(values, chart) {
    let pen = false;
    return values.map((value, i) => {
      if (value == null) { pen = false; return ''; }
      const part = `${pen ? 'L' : 'M'}${chart.x(i).toFixed(2)},${chart.y(value).toFixed(2)}`;
      pen = true; return part;
    }).join(' ');
  }
  return {timestamp, normalize, sma, model, path};
});
