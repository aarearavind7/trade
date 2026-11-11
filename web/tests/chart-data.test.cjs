const {test} = require('node:test');
const assert = require('node:assert/strict');
const chart = require('../chart-data.js');
const bar = (i, c = i + 100) => ({t: new Date(1700000000000 + i * 60000).toISOString(), o: c - 1, h: c + 2, l: c - 2, c, v: i * 100});
test('chart sorts and deduplicates real bars; incomplete or inconsistent OHLC is not invented', () => {
  const rows = chart.normalize([bar(2), bar(1), {...bar(1), c: 102}, {...bar(3), h: 1}, {t: 'bad', c: 1}, {...bar(4), c: null}, {...bar(5), v: -1}]);
  assert.deepEqual(rows.map(b => b.c), [102, 102, 103, 105]);
  assert.equal(rows[2].o, null); assert.equal(rows[3].v, null);
});
test('SMA starts only after its complete window and uses closes at the selected timeframe', () => {
  const rows = Array.from({length: 60}, (_, i) => bar(i, i + 1));
  const model = chart.model(rows, {limit: 15});
  assert.equal(model.lines[0].values[0], 36.5);
  assert.equal(model.lines[1].values[3], null);
  assert.equal(model.lines[1].values[4], 25.5);
  assert.equal(model.truncated, true);
});
test('crosshair mapping, flat-price scale, volume, and empty charts stay finite', () => {
  const model = chart.model([bar(1, 5), bar(2, 5)]);
  assert.ok(model.high > model.low);
  assert.equal(model.nearest(-100), 0); assert.equal(model.nearest(1000), 1);
  assert.ok(Math.abs(model.priceAt(model.y(5)) - 5) < 1e-9);
  assert.equal(model.maxVolume, 200);
  assert.match(chart.path([null, 5], model), /^ M/);
  assert.ok(!chart.path([5, 5], model).includes('NaN'));
  assert.equal(chart.model([]).bars.length, 0);
});
