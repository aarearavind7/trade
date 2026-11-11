const {test} = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../workspace-backup.js');
const {AlertBook} = require('../price-alerts.js');
const workspace = (symbol = 'AAPL') => ({type: 'trade-workspace', version: 1, watchlist: [{symbol, name: symbol}], price_alerts: {version: 1, alerts: [], notifications: []}});
const withAlert = (symbol, id = 'alert-1') => {
  const value = workspace(symbol), book = new AlertBook('', {now: () => 1700000000000, id: () => id});
  book.add({symbol, name: symbol, condition: 'above', target: 100});
  value.price_alerts = JSON.parse(book.serialize()); return value;
};
test('backup round trip keeps only workspace selections and alert state', () => {
  const data = {...withAlert('AAPL'), apiToken: 'SECRET', alpaca: 'PRIVATE'};
  const parsed = tools.parse(JSON.stringify(data));
  assert.equal(parsed.watchlist[0].symbol, 'AAPL'); assert.equal(parsed.price_alerts.alerts.length, 1);
  assert.ok(!JSON.stringify(parsed).includes('SECRET')); assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));
});
test('merge deduplicates stocks and rules, resolves ID collisions, and resets imported quote cursors', () => {
  const saved = withAlert('AAPL'), incoming = withAlert('MSFT');
  const merged = tools.prepare(incoming, saved, 'merge');
  assert.equal(merged.watchlist.length, 2); assert.equal(merged.price_alerts.alerts.length, 2);
  assert.notEqual(merged.price_alerts.alerts[0].id, merged.price_alerts.alerts[1].id);
  assert.equal(merged.price_alerts.alerts[1].lastQuote, null);
  assert.equal(tools.prepare(saved, saved, 'merge').watchlist.length, 1);
  assert.equal(tools.prepare(incoming, saved, 'replace').watchlist[0].symbol, 'MSFT');
  assert.equal(saved.watchlist.length, 1);
});
test('malformed, oversized, duplicate and over-capacity imports fail before applying', () => {
  assert.throws(() => tools.parse('{bad'), /valid JSON/);
  assert.throws(() => tools.parse('x'.repeat(2000001)), /2 MB/);
  assert.throws(() => tools.validate({...workspace(), version: 2}));
  const duplicate = workspace(); duplicate.watchlist.push(duplicate.watchlist[0]); assert.throws(() => tools.validate(duplicate));
  const bad = withAlert('AAPL'); bad.price_alerts.alerts[0].target = -1; assert.throws(() => tools.validate(bad));
  const big = workspace(); big.watchlist = Array.from({length: 1000}, (_, i) => ({symbol: 'S'+i, name: 'Stock '+i}));
  assert.throws(() => tools.prepare(workspace('EXTRA'), big, 'merge'), /1,000/);
  const many = workspace(); many.price_alerts.alerts = Array.from({length: 21}, (_, i) => ({...withAlert('S'+i, 'alert-'+i).price_alerts.alerts[0]}));
  assert.throws(() => tools.validate(many), /20 active/);
});
