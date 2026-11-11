const {test} = require('node:test');
const assert = require('node:assert/strict');
const {AlertBook, quoteStamp} = require('../price-alerts.js');
const NOW = Date.parse('2026-11-10T15:00:00Z');
let id = 0;
const options = {now: () => NOW + 5000, id: () => 'test-' + ++id};
const q = (price, delta = 0, extra = {}) => ({price, timestamp: new Date(NOW + delta).toISOString(), feed: 'iex', coverage: 'IEX exchange only', ...extra});
const rule = (changes = {}) => ({symbol: 'AAPL', name: 'Apple', condition: 'above', target: '100', ...changes});

test('inclusive above/below alerts fire once and remain triggered after reload', () => {
  for (const condition of ['above', 'below']) {
    const book = new AlertBook('', options);
    book.add(rule({condition}), q(condition === 'above' ? 99 : 101));
    const fired = book.accept('AAPL', q(100, 1000));
    assert.equal(fired.length, 1);
    assert.equal(fired[0].quote.price, 100);
    assert.equal(book.alerts[0].status, 'triggered');
    assert.equal(book.accept('AAPL', q(100, 2000)).length, 0);
    assert.equal(new AlertBook(book.serialize(), options).accept('AAPL', q(100, 3000)).length, 0);
  }
});

test('initial, duplicate, historical and invalid quotes never imply a new target hit', () => {
  const book = new AlertBook('', options);
  book.add(rule());
  assert.equal(book.accept('AAPL', q(150)).length, 0); // First quote establishes a baseline.
  assert.equal(book.accept('AAPL', q(151)).length, 0); // Same quote time is not new.
  assert.equal(book.accept('AAPL', q(200, -1000)).length, 0);
  for (const quote of [q(NaN, 1000), q(Infinity, 1000), q(-1, 1000), {...q(200), timestamp: 'bad'}, q(200, 120000)]) assert.equal(book.accept('AAPL', quote).length, 0);
  assert.equal(book.accept('AAPL', q(151, 1000)).length, 1);
});

test('nanosecond trade timestamps remain ordered even in the same millisecond', () => {
  const first = {...q(99), timestamp: '2026-11-10T15:00:00.123000000Z'};
  const next = {...q(100), timestamp: '2026-11-10T15:00:00.123000001Z'};
  assert.ok(quoteStamp(next.timestamp).key > quoteStamp(first.timestamp).key);
  const book = new AlertBook('', options); book.add(rule(), first);
  assert.equal(book.accept('AAPL', next).length, 1);
});

test('provider changes prime a baseline and delayed notifications retain provenance', () => {
  const book = new AlertBook('', options); book.add(rule(), q(99));
  const delayed = {feed: 'public', source: 'Yahoo Finance', delayed: true, timing_verified: false};
  assert.equal(book.accept('AAPL', q(150, 1000, delayed)).length, 0);
  const fired = book.accept('AAPL', q(151, 2000, delayed));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].quote.source, 'Yahoo Finance');
  assert.equal(fired[0].quote.timing_verified, false);
});

test('pause/resume/re-arm are explicit, notifications deduplicate, and read state persists', () => {
  const book = new AlertBook('', options), alert = book.add(rule(), q(99));
  book.pause(alert.id); assert.equal(book.accept('AAPL', q(105, 1000)).length, 0);
  book.arm(alert.id, q(105, 1000)); assert.equal(book.accept('AAPL', q(105, 1000)).length, 0);
  const one = book.accept('AAPL', q(106, 2000))[0];
  book.arm(alert.id, q(106, 2000));
  const two = book.accept('AAPL', q(107, 3000))[0];
  assert.notEqual(one.id, two.id);
  book.markRead(); assert.ok(new AlertBook(book.serialize(), options).notifications.every(item => item.read));
  book.dismiss(one.id); assert.equal(book.notifications.length, 1);
  book.remove(alert.id); assert.equal(book.alerts.length, 0);
});

test('invalid targets, duplicate rules and active-symbol limits are enforced', () => {
  for (const target of ['0', '-1', 'NaN', 'Infinity', '10000001', '.00001', '1.23456', '1e2']) assert.throws(() => new AlertBook('', options).add(rule({target})));
  const book = new AlertBook('', options);
  const first = book.add(rule(), q(99)); assert.throws(() => book.add(rule()), /already/);
  for (let i = 1; i < 20; i++) book.add(rule({symbol: 'S' + i}), q(99));
  assert.throws(() => book.add(rule({symbol: 'EXTRA'})), /20 distinct/);
  book.pause(first.id); book.add(rule({symbol: 'EXTRA'}), q(99));
  assert.throws(() => book.arm(first.id, q(99)), /20 distinct/);
  assert.equal(first.status, 'paused');
});

test('saved data is bounded and malformed records cannot become alerts or notifications', () => {
  const book = new AlertBook('', options);
  for (let i = 1; i <= 50; i++) book.add(rule({target: String(i)}), q(.5));
  assert.throws(() => book.add(rule({target: '51'})), /50 saved/);
  const data = JSON.parse(book.serialize()); data.alerts.push({...data.alerts[0], id: '../bad', symbol: '<script>'});
  data.notifications = [{id: '<img>', symbol: 'AAPL', condition: 'above', target: 5}];
  const restored = new AlertBook(data, options);
  assert.equal(restored.alerts.length, 50); assert.equal(restored.notifications.length, 0);
  assert.equal(new AlertBook('not-json').alerts.length, 0);
});
