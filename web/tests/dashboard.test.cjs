const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const code = fs.readFileSync(`${__dirname}/../app.js`, 'utf8');
const REVIEW_ID = 'e4de82d3-9e39-4c15-a435-de206852b186';
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function boot(options = {}) {
  const {window, document} = parseHTML(html);
  const $ = id => document.getElementById(id);
  for (const [id, value] of [['symbol', 'AAPL'], ['order-type', 'market']]) Object.defineProperty($(id), 'value', {writable: true, value});
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; };
  const saved = options.saved || new Map();
  const storage = {getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value)};
  const calls = [];
  let submitCount = 0;
  const periodicRefresh = [];
  let streamTransport;
  const date = new Date().toISOString();
  const fetch = async (url, init) => {
    const path = new URL(url).pathname; calls.push({path, url, init});
    let data;
    if (options.offline) throw new TypeError('Failed to fetch');
    if (path === '/api/health') data = {broker_configured: options.configured !== false, setup_message: options.configured === false ? 'Configure Alpaca paper keys in .env, then restart Uvicorn.' : null, market_stream: options.stream === true, public_market_data: options.publicData === true};
    else if (path === '/api/account') data = {cash: '90000', equity: '100000', buying_power: '180000'};
    else if (path === '/api/market/stream') {
      const body = new ReadableStream({
        start(controller) {
          streamTransport = controller;
          init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} });
        },
        cancel() { streamTransport = null; }
      });
      return new Response(body, {headers: {'Content-Type': 'text/event-stream'}});
    }
    else if (path === '/api/positions') data = [{symbol: 'AAPL', qty: '100', avg_entry_price: '90', current_price: '100', market_value: '10000', unrealized_pl: '1000'}];
    else if (path === '/api/market/clock') data = {is_open: true, timestamp: date, schedule_available: true};
    else if (path.endsWith('/quote')) data = {price: '100', timestamp: date, feed: options.publicData ? 'public' : 'iex', coverage: options.publicData ? 'Yahoo Finance' : 'IEX exchange only', change_pct: '1.2', delayed: !!options.publicData, timing_verified: !options.publicData};
    else if (path.endsWith('/bars')) data = {bars: [{c: 99, t: new Date(Math.floor(Date.now() / 60000) * 60000 - 60000).toISOString()}, {c: 100, t: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString()}], delay_minutes: options.publicData ? null : 16, source: options.publicData ? 'Yahoo Finance' : undefined};
    else if (path === '/api/risk') data = {max_position_pct: '20', max_order_notional: '5000', max_daily_loss: '1000', daily_loss: '0', basis: 'Previous close'};
    else if (path === '/api/performance') data = {realized_pl: '200', unrealized_pl: '1000', fill_count: 3, realized_complete: true, method: 'Weighted-average fills', portfolio_history: {timestamp: [1, 2], equity: [99000, 100000]}};
    else if (path === '/api/trades') data = {trades: []};
    else if (path === '/api/orders/review') {
      const draft = JSON.parse(init.body);
      data = {review_id: REVIEW_ID, expires_at: Date.now() / 1000 + 60, order: draft, estimated_price: draft.limit_price || '100', estimated_total: '100', quote: {timestamp: date}};
    } else if (path === '/api/orders' && init.method === 'POST') {
      submitCount++;
      if (options.submitTimeout) throw new TypeError('Connection interrupted after acceptance');
      data = {id: 'broker-id', status: 'new', symbol: 'AAPL', qty: '1', side: 'buy'};
    } else if (path.startsWith('/api/orders/by-review/')) data = {status: options.reconcileStatus || 'new'};
    else if (path === '/api/orders') data = {orders: [], local: []};
    else throw new Error(`Unexpected API ${path}`);
    return new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
  };
  const context = vm.createContext({window, document, Node: window.Node, location: {origin: 'http://localhost:8000', hash: ''}, localStorage: storage, sessionStorage: storage, URL, AbortController, TextDecoder, fetch, console, setTimeout, clearTimeout, setInterval: callback => { periodicRefresh.push(callback); return 0; }});
  vm.runInContext(code, context);
  await flush();
  const click = async selector => { document.querySelector(selector).dispatchEvent(new window.Event('click')); await flush(); };
  const submit = async id => { $(id).dispatchEvent(new window.Event('submit', {cancelable: true})); await flush(); };
  return {$, click, submit, calls, saved, window, context, options, tick: async () => { periodicRefresh.forEach(callback => callback()); await flush(); },
    emit: async (event, split = false) => {
      const bytes = new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n');
      if (split) { streamTransport.enqueue(bytes.slice(0, 10)); streamTransport.enqueue(bytes.slice(10)); } else streamTransport.enqueue(bytes);
      await flush();
    },
    close: async () => { vm.runInContext('stopMarketStream()', context); await flush(); }, get submitCount() { return submitCount; }};
}

test('dashboard renders broker balances, timestamps, holdings and performance', async () => {
  const app = await boot();
  assert.equal(app.$('equity').textContent, '$100,000.00');
  assert.equal(app.$('cash').textContent, '$90,000.00');
  assert.match(app.$('holdings-content').textContent, /\$90.00/);
  assert.equal(app.$('realized-pl').textContent, '$200.00');
  assert.match(app.$('quote-time').textContent, /Latest trade/);
  assert.equal(app.$('submit-order').disabled, false);
  assert.ok(app.$('chart-line').getAttribute('d').startsWith('M'));
});

test('review is required before a single confirmed broker submission', async () => {
  const app = await boot();
  await app.submit('order-form');
  assert.equal(app.submitCount, 0);
  assert.equal(app.$('review-dialog').open, true);
  assert.match(app.$('review-details').textContent, /AAPL/);
  // Dispatch twice without waiting to exercise the double-click guard.
  app.$('confirm-order').dispatchEvent(new app.window.Event('click'));
  app.$('confirm-order').dispatchEvent(new app.window.Event('click'));
  await flush();
  assert.equal(app.submitCount, 1);
  assert.equal(app.saved.get('trade-pending:http://localhost:8000'), '');
  assert.match(app.$('order-message').textContent, /Paper order new/);
});

test('unknown order outcome survives reload and blocks replacements until reconciliation', async () => {
  const app = await boot({submitTimeout: true});
  await app.submit('order-form'); await app.click('#confirm-order');
  assert.equal(app.saved.get('trade-pending:http://localhost:8000'), REVIEW_ID);
  assert.equal(app.$('submit-order').disabled, true);
  assert.match(app.$('activity-content').textContent, /Reconcile/);
  const reloaded = await boot({saved: app.saved, reconcileStatus: 'unknown'});
  assert.equal(reloaded.$('submit-order').disabled, true);
  await reloaded.click('#activity-content button');
  assert.equal(reloaded.saved.get('trade-pending:http://localhost:8000'), REVIEW_ID);
  reloaded.options.reconcileStatus = 'new';
  await reloaded.click('#activity-content button');
  assert.equal(reloaded.saved.get('trade-pending:http://localhost:8000'), '');
  assert.equal(reloaded.$('submit-order').disabled, false);
});

test('limit order form uses a whole-share step and includes the limit price', async () => {
  const app = await boot();
  app.$('order-type').value = 'limit';
  app.$('order-type').dispatchEvent(new app.window.Event('change'));
  app.$('limit-price').value = '98.50';
  assert.equal(app.$('quantity').step, '1');
  assert.equal(app.$('quantity').min, '1');
  assert.equal(app.$('limit-price').required, true);
  await app.submit('order-form');
  const request = app.calls.find(item => item.path === '/api/orders/review');
  assert.equal(JSON.parse(request.init.body).limit_price, '98.50');
});

test('API failure does not fall back to fake balances or enable trading', async () => {
  const app = await boot({offline: true});
  assert.equal(app.$('equity').textContent, '—');
  assert.equal(app.$('submit-order').disabled, true);
  assert.match(app.$('connection-status').textContent, /Failed to fetch/);
  assert.equal(app.$('chart-line').getAttribute('d'), '');
});


test('missing Alpaca setup shows instructions and stops failing API polls until a manual retry', async () => {
  const app = await boot({configured: false});
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health']);
  assert.match(app.$('connection-status').textContent, /Configure Alpaca paper keys/);
  assert.equal(app.$('market-status').textContent, 'Alpaca setup required');
  assert.equal(app.$('submit-order').disabled, true);
  await app.tick(); await app.tick();
  assert.equal(app.calls.length, 1);
  app.options.configured = true;
  await app.click('#refresh-data');
  assert.equal(app.$('cash').textContent, '$90,000.00');
  assert.equal(app.$('submit-order').disabled, false);
});


test('live SSE quotes update prices, watchlist, estimates and the intraday chart without a reload', async () => {
  const app = await boot({stream: true});
  try {
    const before = app.$('chart-line').getAttribute('d');
    await app.emit({type: 'status', state: 'connected', feed: 'iex'});
    await app.emit({type: 'quote', symbol: 'AAPL', price: '105', timestamp: new Date(Date.now() + 10).toISOString(), feed: 'iex', coverage: 'IEX exchange only', delayed: false}, true);
    assert.equal(app.$('price').textContent, '$105.00');
    assert.equal(app.$('estimate').textContent, '$105.00');
    assert.match(app.$('watchlist-body').textContent, /\$105.00/);
    assert.match(app.$('stream-status').textContent, /Live market feed/);
    assert.equal(app.$('axis-high').textContent, '105.00');
    await app.emit({type: 'quote', symbol: 'AAPL', price: '1', timestamp: new Date(Date.now() - 3600000).toISOString(), feed: 'iex'});
    assert.equal(app.$('price').textContent, '$105.00');
    await app.click('#refresh-data');
    assert.equal(app.$('price').textContent, '$105.00');
    assert.equal(app.calls.filter(call => call.path === '/api/market/stream').length, 1);
  } finally { await app.close(); }
});

test('live stream uses bearer headers and preserves denied-feed messages without retry loops', async () => {
  const saved = new Map([['trade-api-token', 'application-test-token']]);
  const app = await boot({stream: true, saved});
  try {
    const request = app.calls.find(call => call.path === '/api/market/stream');
    assert.equal(request.init.headers.Authorization, 'Bearer application-test-token');
    assert.ok(!request.url.includes('application-test-token'));
    await app.emit({type: 'status', state: 'unavailable', message: 'Feed entitlement denied', retryable: false});
    await app.tick();
    assert.match(app.$('stream-status').textContent, /Feed entitlement denied/);
    assert.equal(app.calls.filter(call => call.path === '/api/market/stream').length, 1);
  } finally { await app.close(); }
});

test('delayed stream stays labelled delayed and live ticks leave historical ranges unchanged', async () => {
  const app = await boot({stream: true});
  try {
    await app.click('[data-range="1W"]');
    const before = app.$('chart-line').getAttribute('d');
    await app.emit({type: 'status', state: 'connected'});
    await app.emit({type: 'quote', symbol: 'AAPL', price: '106', timestamp: new Date(Date.now() + 10).toISOString(), feed: 'delayed_sip', coverage: 'DELAYED_SIP', delayed: true});
    assert.match(app.$('quote-time').textContent, /Delayed/);
    assert.match(app.$('stream-status').textContent, /delayed/);
    assert.equal(app.$('chart-line').getAttribute('d'), before);
  } finally { await app.close(); }
});


test('without paper keys, real public market prices populate charts while account and order controls stay unavailable', async () => {
  const app = await boot({configured: false, publicData: true});
  assert.equal(app.$('price').textContent, '$100.00');
  assert.match(app.$('watchlist-body').textContent, /\$100.00/);
  assert.ok(app.$('chart-line').getAttribute('d').startsWith('M'));
  assert.match(app.$('connection-status').textContent, /Yahoo Finance/);
  assert.match(app.$('chart-data-note').textContent, /may be delayed/);
  assert.match(app.$('stream-status').textContent, /30-second refresh/);
  assert.equal(app.$('submit-order').disabled, true);
  assert.equal(app.$('cash').textContent, '—');
  assert.ok(app.window.document.body.classList.contains('market-only'));
  assert.ok(!app.calls.some(call => ['/api/account', '/api/positions', '/api/orders', '/api/performance', '/api/market/stream'].includes(call.path)));
  await app.click('[data-stock="NVDA"]');
  assert.match(app.$('quote-name').textContent, /NVIDIA/);
  assert.ok(app.calls.some(call => call.path === '/api/market/NVDA/bars'));
  await app.click('[data-range="1W"]');
  assert.ok(app.calls.some(call => call.url.endsWith('period=1W')));
  await app.click('#refresh-market');
  assert.ok(app.calls.filter(call => call.path === '/api/health').length >= 2);
  assert.equal(app.$('submit-order').disabled, true);
});
