const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const code = fs.readFileSync(`${__dirname}/../app.js`, 'utf8');
const researchCode = fs.readFileSync(`${__dirname}/../research.js`, 'utf8');
const backupCode = fs.readFileSync(`${__dirname}/../workspace-backup.js`, 'utf8');
const chartCode = fs.readFileSync(`${__dirname}/../chart-data.js`, 'utf8');
const alertsCode = fs.readFileSync(`${__dirname}/../price-alerts.js`, 'utf8');
const REVIEW_ID = 'e4de82d3-9e39-4c15-a435-de206852b186';
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function boot(options = {}) {
  const {window, document} = parseHTML(html);
  const $ = id => document.getElementById(id);
  for (const [id, value] of [['symbol', 'AAPL'], ['order-type', 'market'], ['watchlist-page-select', '0'], ['alert-symbol', 'AAPL'], ['alert-condition', 'above'], ['journal-state', 'planned'], ['import-workspace-mode', 'merge']]) Object.defineProperty($(id), 'value', {writable: true, value});
  for (const id of ['chart-volume', 'chart-ma20', 'chart-ma50']) $(id).checked = true;
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; };
  const saved = options.saved || new Map();
  const storage = {getItem: key => saved.get(key) || null, setItem: (key, value) => { if (options.storageFailure) throw new Error('Storage unavailable'); saved.set(key, value); }};
  const calls = [];
  const journalEntries = [];
  window.HTMLElement.prototype.focus = function () {};

  let submitCount = 0;
  const periodicRefresh = [], intervals = [];
  let streamTransport;
  const date = new Date().toISOString();
  const fetch = async (url, init) => {
    const path = new URL(url).pathname; calls.push({path, url, init});
    let data;
    if (options.offline) throw new TypeError('Failed to fetch');
    if (path === '/api/health') data = {broker_configured: options.configured !== false, setup_message: options.configured === false ? 'Configure Alpaca paper keys in .env, then restart Uvicorn.' : null, market_stream: options.stream === true, public_market_data: options.publicData === true};
    else if (path === '/api/account') data = {cash: '90000', equity: '100000', buying_power: '180000'};
    else if (path === '/api/stocks/sp500') {
      if (options.sp500Failure) return new Response(JSON.stringify({detail: 'S&P 500 company list is unavailable'}), {status: 502, headers: {'Content-Type': 'application/json'}});
      const results = options.sp500Results || [
        ...['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'TSLA'].map(symbol => ({symbol, name: symbol + ' Company'})),
        ...Array.from({length: 495}, (_, index) => ({symbol: 'S' + String(index).padStart(3, '0'), name: 'Constituent ' + index}))
      ];
      data = {results, count: results.length, source: 'test membership source', fetched_at: date};
    }
    else if (path === '/api/stocks/search') {
      if (options.searchHandler) return options.searchHandler(url, init);
      if (options.searchFailure) return new Response(JSON.stringify({detail: 'Stock search is temporarily unavailable'}), {status: 502, headers: {'Content-Type': 'application/json'}});
      data = {source: 'Yahoo Finance', results: options.searchResults || [{symbol: 'AMZN', name: 'Amazon.com, Inc.', exchange: 'NASDAQ'}, {symbol: 'JPM', name: 'JPMorgan Chase', exchange: 'NYSE'}]};
    }
    else if (path.startsWith('/api/research/')) {
      if (options.researchFailure) return new Response(JSON.stringify({detail: 'Add FMP_API_KEY to the server .env'}), {status: 503, headers: {'Content-Type': 'application/json'}});
      data = {symbol: path.split('/')[3], name: 'Company', revenue: 1000000, net_income: 200000, total_debt: 50000, pe_ttm: 20, sector: 'Technology', market_cap: 5000000, currency: 'USD', income_date: '2025-12-31', debt_date: '2025-12-31', next_earnings_date: '2027-01-20', source: 'Financial Modeling Prep', retrieved_at: date, unavailable_sections: []};
    }
    else if (path === '/api/benchmark') data = {points: [{date: '2026-11-09', portfolio_pct: 0, benchmark_pct: 0}, {date: '2026-11-10', portfolio_pct: 2, benchmark_pct: 1}], portfolio_return_pct: 2, benchmark_return_pct: 1, start: '2026-11-09', end: '2026-11-10', source: 'Yahoo Finance', matched_sessions: 2, note: 'Equity includes deposits; index excludes dividends.'};
    else if (path === '/api/screener') data = {results: [{symbol: 'AMZN', name: 'Amazon', sector: 'Technology', price: 200, volume: 1000, market_cap: 2000000, change_pct: 2, timestamp: 1794411000}], candidate_count: 100, source: 'Financial Modeling Prep', retrieved_at: date, note: 'Bounded candidates; quotes may be delayed.'};
    else if (path.startsWith('/api/journal')) {
      const id = path.split('/')[3];
      if (init.method === 'POST') { data = {...JSON.parse(init.body), id: REVIEW_ID, revision: 1, created_at: date, updated_at: date}; journalEntries.push(data); }
      else if (init.method === 'PUT') { data = {...JSON.parse(init.body), id, revision: 2, updated_at: date}; journalEntries.splice(0, 1, data); }
      else if (init.method === 'DELETE') { journalEntries.splice(0, 1); data = {deleted: true}; }
      else data = {entries: journalEntries, total: journalEntries.length, offset: 0, limit: 50};
    }
    else if (path === '/api/connection') {
      if (options.connectionUnauthorized) return new Response(JSON.stringify({detail: 'Enter the application access token'}), {status: 401, headers: {'Content-Type': 'application/json'}});
      data = {service: options.wrongConnection ? 'other-service' : 'trade-paper-api',
        server: {status: 'connected', message: 'API reachable', action: 'Keep Terminal open'},
        market_data: {status: options.publicData ? 'delayed' : 'connected', message: 'Prices available', action: 'Check timestamps'},
        paper_account: {status: options.configured === false ? 'not_configured' : 'connected', message: options.configured === false ? 'Paper account is optional' : 'Paper account active', action: 'Keys stay in .env'}};
    }
    else if (path === '/api/market/stream') {
      let ownTransport;
      const body = new ReadableStream({
        start(controller) {
          ownTransport = controller; streamTransport = controller;
          init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} });
        },
        cancel() { if (streamTransport === ownTransport) streamTransport = null; }
      });
      return new Response(body, {headers: {'Content-Type': 'text/event-stream'}});
    }
    else if (path === '/api/positions') data = [{symbol: 'AAPL', qty: '100', avg_entry_price: '90', current_price: '100', market_value: '10000', unrealized_pl: '1000'}];
    else if (path === '/api/market/clock') data = {is_open: true, timestamp: date, schedule_available: true};
    else if (path.endsWith('/quote')) data = {price: '100', timestamp: date, feed: options.publicData ? 'public' : 'iex', coverage: options.publicData ? 'Yahoo Finance' : 'IEX exchange only', change_pct: '1.2', delayed: !!options.publicData, timing_verified: !options.publicData, ...(options.marketQuotes?.[path.split('/').at(-2)] || {})};
    else if (path.endsWith('/bars')) data = {bars: options.bars || [{c: 99, t: new Date(Math.floor(Date.now() / 60000) * 60000 - 60000).toISOString()}, {c: 100, t: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString()}], delay_minutes: options.publicData ? null : 16, source: options.publicData ? 'Yahoo Finance' : undefined};
    else if (path.startsWith('/api/exports/')) {
      if (options.exportFailure) return new Response(JSON.stringify({detail: 'Broker temporarily unavailable'}), {status: 502, headers: {'Content-Type': 'application/json'}});
      return new Response('timestamp,equity\r\n2026-11-11,1000\r\n', {headers: {'Content-Type': options.exportWrongType ? 'text/html' : 'text/csv'}});
    }
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
  const context = vm.createContext({window, document, Node: window.Node, location: {origin: options.origin || 'http://localhost:8000', href: options.href || 'http://localhost:8000', hash: ''}, localStorage: storage, sessionStorage: storage, URL, URLSearchParams, Blob, AbortController, TextDecoder, navigator: options.navigator, fetch, console, setTimeout, clearTimeout, setInterval: (callback, ms) => { periodicRefresh.push(callback); intervals.push({callback, ms}); return 0; }});
  vm.runInContext(chartCode, context);
  vm.runInContext(alertsCode, context);
  vm.runInContext(backupCode, context);
  vm.runInContext(code, context);
  if (options.research) vm.runInContext(researchCode, context);
  await flush();
  const click = async selector => { document.querySelector(selector).dispatchEvent(new window.Event('click')); await flush(); };
  const submit = async id => { $(id).dispatchEvent(new window.Event('submit', {cancelable: true})); await flush(); };
  return {$, click, submit, calls, saved, window, context, options, tickInterval: async ms => { intervals.filter(timer => timer.ms === ms).forEach(timer => timer.callback()); await flush(); }, tick: async () => { periodicRefresh.forEach(callback => callback()); await flush(); },
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
    assert.ok(Number(app.$('axis-high').textContent) >= 105);
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
  assert.match(app.$('stream-status').textContent, /10-second refresh/);
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


test('guided connection checks server, data and optional account without saving or submitting trades', async () => {
  const app = await boot({configured: false, publicData: true});
  await app.click('#connect-api');
  await app.click('#test-connection');
  assert.equal(app.$('check-server').dataset.state, 'connected');
  assert.equal(app.$('check-market').dataset.state, 'delayed');
  assert.equal(app.$('check-account').dataset.state, 'not_configured');
  assert.match(app.$('connection-summary').textContent, /Market prices are available/);
  assert.equal(app.saved.get('trade-api-base'), undefined);
  assert.equal(app.submitCount, 0);
  await app.submit('connection-form');
  assert.equal(app.saved.get('trade-api-base'), 'http://localhost:8000');
  assert.equal(app.$('connection-dialog').open, false);
  assert.equal(app.calls.filter(call => call.path === '/api/connection').length, 1);
});

test('incorrect API addresses and application tokens are diagnosed without replacing working settings', async () => {
  const app = await boot({wrongConnection: true});
  await app.click('#connect-api');
  app.$('api-url').value = 'https://wrong.example.com';
  await app.submit('connection-form');
  assert.equal(app.saved.get('trade-api-base'), undefined);
  assert.match(app.$('connection-error').textContent, /not a compatible Trade API/);
  assert.equal(app.$('connection-dialog').open, true);
  app.options.wrongConnection = false;
  app.options.connectionUnauthorized = true;
  await app.click('#test-connection');
  assert.equal(app.$('check-server').dataset.state, 'unauthorized');
  assert.equal(app.$('check-market').dataset.state, 'not_checked');
  assert.match(app.$('check-server-action').textContent, /API_ACCESS_TOKEN/);
  assert.equal(app.saved.get('trade-api-base'), undefined);
});

test('local setup shortcut selects the correct server without transmitting stale tokens', async () => {
  const app = await boot();
  await app.click('#connect-api');
  app.$('api-token').value = 'old-server-app-token';
  await app.click('#use-local-api');
  assert.equal(app.$('api-url').value, 'http://localhost:8000');
  assert.equal(app.$('api-token').value, '');
  const calls = app.calls.length;
  app.$('api-url').value = 'http://remote.example.com';
  await app.click('#test-connection');
  assert.equal(app.calls.length, calls);
  assert.match(app.$('connection-error').textContent, /HTTPS/);
});


test('search adds a custom stock, prevents duplicates and restores the watchlist after reload', async () => {
  const app = await boot({configured: false, publicData: true});
  await app.click('#open-stock-search');
  app.$('stock-query').value = 'Amazon';
  await app.submit('stock-search-form');
  assert.match(app.$('stock-results').textContent, /Amazon.com/);
  await app.click('[data-add-stock="AMZN"]');
  assert.equal(app.$('watchlist-count').textContent, '6');
  assert.match(app.$('quote-name').textContent, /Amazon/);
  assert.equal(app.$('symbol').value, 'AMZN');
  assert.ok(app.$('stock-tabs').querySelector('[data-stock="AMZN"]'));
  assert.equal(app.$('stock-results').querySelector('[data-add-stock="AMZN"]').disabled, true);
  await app.click('[data-add-stock="AMZN"]');
  assert.equal(JSON.parse(app.saved.get('trade-watchlist-v1')).length, 6);
  const restored = await boot({saved: app.saved, configured: false, publicData: true});
  assert.match(restored.$('watchlist-body').textContent, /AMZN/);
  await restored.click('[data-remove-stock="AMZN"]');
  assert.equal(restored.$('watchlist-count').textContent, '5');
  assert.ok(!JSON.parse(restored.saved.get('trade-watchlist-v1')).some(stock => stock.symbol === 'AMZN'));
  assert.equal(restored.submitCount, 0);
});

test('watchlists can be emptied and rebuilt without loading a hidden default stock', async () => {
  const app = await boot({configured: false, publicData: true});
  for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'TSLA']) await app.click(`[data-remove-stock="${symbol}"]`);
  assert.equal(app.saved.get('trade-watchlist-v1'), '[]');
  assert.equal(app.$('watchlist-count').textContent, '0');
  assert.equal(app.$('symbol').disabled, true);
  assert.equal(app.$('submit-order').disabled, true);
  assert.match(app.$('chart-empty').textContent, /watchlist is empty/);
  const restored = await boot({saved: app.saved, configured: false, publicData: true});
  assert.equal(restored.$('watchlist-count').textContent, '0');
  assert.ok(!restored.calls.some(call => call.path.endsWith('/quote') || call.path.endsWith('/bars')));
  await restored.click('#open-stock-search'); restored.$('stock-query').value = 'Amazon';
  await restored.submit('stock-search-form'); await restored.click('[data-add-stock="AMZN"]');
  assert.equal(restored.$('watchlist-count').textContent, '1');
  assert.equal(restored.$('price').textContent, '$100.00');
});

test('watchlist limits, unavailable storage and unsafe saved names are handled safely', async () => {
  const saved = new Map([['trade-watchlist-v1', JSON.stringify(Array.from({length: 1000}, (_, i) => ({symbol: 'S' + i, name: 'Stock ' + i})))]]);
  const full = await boot({saved});
  await full.click('#open-stock-search'); full.$('stock-query').value = 'Amazon'; await full.submit('stock-search-form');
  assert.equal(full.$('stock-results').querySelector('[data-add-stock="AMZN"]').disabled, true);
  await full.click('[data-add-stock="AMZN"]');
  assert.equal(JSON.parse(saved.get('trade-watchlist-v1')).length, 1000);
  const blocked = await boot({storageFailure: true});
  await blocked.click('#open-stock-search'); blocked.$('stock-query').value = 'Amazon'; await blocked.submit('stock-search-form'); await blocked.click('[data-add-stock="AMZN"]');
  assert.match(blocked.$('watchlist-status').textContent, /storage is unavailable/);
  const unsafe = await boot({saved: new Map([['trade-watchlist-v1', JSON.stringify([{symbol: 'AMZN', name: '<img src=x onerror=alert(1)>'}])]])});
  assert.equal(unsafe.$('watchlist-body').querySelector('img'), null);
  assert.match(unsafe.$('watchlist-body').textContent, /<img/);
});

test('search failures and stale search responses do not show misleading results', async () => {
  const app = await boot({searchFailure: true});
  await app.click('#open-stock-search'); app.$('stock-query').value = 'Amazon'; await app.submit('stock-search-form');
  assert.match(app.$('stock-search-status').textContent, /temporarily unavailable/);
  assert.equal(app.$('stock-results').children.length, 0);
  let resolveOld;
  app.options.searchFailure = false;
  app.options.searchHandler = url => {
    const query = new URL(url).searchParams.get('q');
    if (query === 'Amazon') return new Promise(resolve => { resolveOld = resolve; });
    return new Response(JSON.stringify({source: 'test', results: [{symbol: 'JPM', name: 'JPMorgan', exchange: 'NYSE'}]}), {headers: {'Content-Type': 'application/json'}});
  };
  await app.submit('stock-search-form');
  app.$('stock-query').value = 'JPM'; await app.submit('stock-search-form');
  resolveOld(new Response(JSON.stringify({source: 'test', results: [{symbol: 'AMZN', name: 'Amazon'}]}), {headers: {'Content-Type': 'application/json'}}));
  await flush();
  assert.ok(app.$('stock-results').querySelector('[data-add-stock="JPM"]'));
  assert.equal(app.$('stock-results').querySelector('[data-add-stock="AMZN"]'), null);
});

test('custom watchlist stocks are included in the authenticated live feed', async () => {
  const app = await boot({stream: true});
  try {
    await app.click('#open-stock-search'); app.$('stock-query').value = 'Amazon'; await app.submit('stock-search-form'); await app.click('[data-add-stock="AMZN"]');
    const requests = app.calls.filter(call => call.path === '/api/market/stream');
    assert.ok(new URL(requests.at(-1).url).searchParams.get('symbols').split(',').includes('AMZN'));
    await app.emit({type: 'status', state: 'connected'});
    await app.emit({type: 'quote', symbol: 'AMZN', price: '205', timestamp: new Date(Date.now() + 10).toISOString(), feed: 'iex', delayed: false, coverage: 'IEX exchange only'});
    assert.equal(app.$('price').textContent, '$205.00');
    await app.click('[data-remove-stock="AMZN"]');
    const latest = app.calls.filter(call => call.path === '/api/market/stream').at(-1);
    assert.ok(!new URL(latest.url).searchParams.get('symbols').split(',').includes('AMZN'));
  } finally { await app.close(); }
});


test('bulk S&P 500 addition saves the complete list, deduplicates and loads prices only for the visible page', async () => {
  const app = await boot({configured: false, publicData: true});
  const before = app.calls.length;
  await app.click('#add-sp500');
  assert.equal(app.$('watchlist-count').textContent, '500');
  assert.equal(JSON.parse(app.saved.get('trade-watchlist-v1')).length, 500);
  assert.equal(app.$('watchlist-body').querySelectorAll('tr').length, 20);
  assert.equal(app.$('stock-tabs').querySelectorAll('button').length, 20);
  assert.match(app.$('watchlist-page-label').textContent, /1–20 of 500/);
  assert.ok(app.calls.slice(before).filter(call => call.path.endsWith('/quote')).length <= 21);
  await app.click('#add-sp500');
  assert.equal(JSON.parse(app.saved.get('trade-watchlist-v1')).length, 500);
  const restored = await boot({saved: app.saved, configured: false, publicData: true});
  assert.equal(restored.$('watchlist-count').textContent, '500');
  assert.equal(restored.$('watchlist-body').querySelectorAll('tr').length, 20);
  assert.ok(restored.calls.filter(call => call.path.endsWith('/quote')).length <= 21);
  await restored.click('#watchlist-next');
  assert.match(restored.$('watchlist-page-label').textContent, /21–40 of 500/);
  assert.equal(restored.$('watchlist-body').querySelectorAll('tr').length, 20);
  const pageSymbols = [...restored.$('stock-tabs').querySelectorAll('button')].map(button => button.textContent);
  assert.equal(restored.$('symbol').value, pageSymbols[0]);
  await restored.click('#watchlist-prev');
  assert.match(restored.$('watchlist-page-label').textContent, /1–20 of 500/);
  assert.equal(restored.submitCount, 0);
});

test('bulk source failures leave the current watchlist intact and search can jump to saved constituents', async () => {
  const app = await boot({sp500Failure: true, configured: false, publicData: true});
  await app.click('#add-sp500');
  assert.equal(app.$('watchlist-count').textContent, '5');
  assert.equal(app.saved.get('trade-watchlist-v1'), undefined);
  assert.match(app.$('watchlist-status').textContent, /unavailable/);
  app.options.sp500Failure = false; await app.click('#add-sp500');
  app.options.searchResults = [{symbol: 'S400', name: 'Constituent 400'}];
  await app.click('#open-stock-search'); app.$('stock-query').value = 'S400'; await app.submit('stock-search-form');
  await app.click('[data-view-stock="S400"]');
  assert.equal(app.$('symbol').value, 'S400');
  assert.ok(app.$('stock-tabs').querySelector('[data-stock="S400"]'));
  assert.match(app.$('watchlist-body').textContent, /S400/);
  assert.equal(app.$('stock-dialog').open, false);
});

test('large watchlist streams are bounded to the selected page', async () => {
  const app = await boot({stream: true});
  try {
    await app.click('#add-sp500');
    let stream = app.calls.filter(call => call.path === '/api/market/stream').at(-1);
    assert.equal(new URL(stream.url).searchParams.get('symbols').split(',').length, 20);
    await app.click('#watchlist-next');
    stream = app.calls.filter(call => call.path === '/api/market/stream').at(-1);
    const symbols = new URL(stream.url).searchParams.get('symbols').split(',');
    assert.equal(symbols.length, 20);
    assert.ok(!symbols.includes('AAPL'));
    assert.equal(app.$('symbol').value, symbols[0]);
  } finally { await app.close(); }
});

async function createPriceAlert(app, target = '105', condition = 'above', symbol) {
  await app.click('#new-price-alert');
  if (symbol) { app.$('alert-symbol').value = symbol; app.$('alert-symbol').dispatchEvent(new app.window.Event('change')); await flush(); }
  app.$('alert-condition').value = condition; app.$('alert-target').value = target;
  await app.submit('price-alert-form');
}

test('a live target hit creates one persistent in-app notification and never submits an order', async () => {
  const app = await boot({stream: true});
  try {
    await createPriceAlert(app);
    assert.equal(app.$('price-alert-dialog').open, false);
    assert.match(app.$('price-alerts-list').textContent, /active/);
    assert.equal(app.$('notification-count').textContent, '0');
    const event = {type: 'quote', symbol: 'AAPL', price: '105', timestamp: new Date(Date.now() + 10).toISOString(), feed: 'iex', coverage: 'IEX exchange only', delayed: false};
    await app.emit(event);
    assert.equal(app.$('notification-count').textContent, '1');
    assert.match(app.$('alert-toasts').textContent, /AAPL at or above \$105.00/);
    assert.equal(app.$('alert-toasts').children.length, 1);
    await app.emit({...event, price: '106', timestamp: new Date(Date.now() + 20).toISOString()});
    assert.equal(app.$('notification-count').textContent, '1');
    const restored = await boot({saved: app.saved});
    assert.equal(restored.$('notification-count').textContent, '1');
    assert.equal(restored.$('alert-toasts').children.length, 0);
    await restored.click('#open-notifications');
    assert.match(restored.$('notification-list').textContent, /IEX exchange only/);
    await restored.click('#mark-notifications-read');
    assert.equal(restored.$('notification-count').hidden, true);
    assert.ok(JSON.parse(restored.saved.get('trade-price-alerts-v1')).notifications.every(item => item.read));
    assert.equal(app.submitCount, 0);
  } finally { await app.close(); }
});

test('pause, resume, delete and duplicate target validation work through the alert controls', async () => {
  const app = await boot({stream: true});
  try {
    await createPriceAlert(app);
    await createPriceAlert(app);
    assert.match(app.$('price-alert-error').textContent, /already/);
    await app.click('#cancel-price-alert');
    await app.click('[data-alert-toggle]');
    assert.match(app.$('price-alerts-list').textContent, /paused/);
    await app.emit({type: 'quote', symbol: 'AAPL', price: '106', timestamp: new Date(Date.now() + 10).toISOString(), feed: 'iex', coverage: 'IEX exchange only'});
    assert.equal(app.$('notification-count').textContent, '0');
    await app.click('[data-alert-toggle]');
    assert.match(app.$('price-alerts-list').textContent, /active/);
    await app.emit({type: 'quote', symbol: 'AAPL', price: '107', timestamp: new Date(Date.now() + 20).toISOString(), feed: 'iex', coverage: 'IEX exchange only'});
    assert.equal(app.$('notification-count').textContent, '1');
    await app.click('[data-alert-delete]');
    assert.equal(JSON.parse(app.saved.get('trade-price-alerts-v1')).alerts.length, 0);
    assert.equal(app.$('price-alert-count').textContent, '0');
  } finally { await app.close(); }
});

test('off-page and removed stocks remain monitored by bounded public quote polling', async () => {
  const app = await boot({configured: false, publicData: true});
  await app.click('#add-sp500');
  await createPriceAlert(app, '105', 'above', 'S400');
  app.$('symbol').value = 'S400'; app.$('symbol').dispatchEvent(new app.window.Event('change')); await flush();
  await app.click('[data-remove-stock="S400"]');
  assert.ok(!JSON.parse(app.saved.get('trade-watchlist-v1')).some(item => item.symbol === 'S400'));
  app.options.marketQuotes = {S400: {price: '110', timestamp: new Date(Date.now() + 10).toISOString()}};
  const before = app.calls.length;
  await app.tick();
  assert.ok(app.calls.slice(before).some(call => call.path === '/api/market/S400/quote'));
  assert.equal(app.$('notification-count').textContent, '1');
  await app.click('#open-notifications');
  assert.match(app.$('notification-list').textContent, /may be delayed/);
  assert.equal(app.submitCount, 0);
});

test('already displayed quotes do not fire on creation, and invalid or unsaved alerts have clear feedback', async () => {
  const app = await boot({configured: false, publicData: true});
  await createPriceAlert(app, '90');
  assert.equal(app.$('notification-count').textContent, '0');
  assert.equal(app.$('alert-toasts').children.length, 0);
  await app.click('#new-price-alert'); app.$('alert-target').value = '1.23456'; await app.submit('price-alert-form');
  assert.match(app.$('price-alert-error').textContent, /four decimal/);
  const blocked = await boot({storageFailure: true, configured: false, publicData: true});
  await createPriceAlert(blocked);
  assert.match(blocked.$('alerts-action-status').textContent, /session only/);
});


test('same-origin tabs share a single persisted trigger through the Web Locks path', async () => {
  let chain = Promise.resolve();
  const navigator = {locks: {request(name, action) { const work = chain.then(action); chain = work.catch(() => {}); return work; }}};
  const saved = new Map();
  const one = await boot({saved, stream: true, navigator});
  let two;
  try {
    await createPriceAlert(one);
    two = await boot({saved, stream: true, navigator});
    const event = {type: 'quote', symbol: 'AAPL', price: '106', timestamp: new Date(Date.now() + 10).toISOString(), feed: 'iex', coverage: 'IEX exchange only'};
    await Promise.all([one.emit(event), two.emit(event)]);
    await chain; await flush();
    assert.equal(JSON.parse(saved.get('trade-price-alerts-v1')).notifications.length, 1);
    assert.equal(one.$('alert-toasts').children.length + two.$('alert-toasts').children.length, 1);
  } finally { await one.close(); if (two) await two.close(); }
});

test('candles, volume and SMA controls render real OHLC and keyboard crosshair shows the selected bar', async () => {
  const bars = Array.from({length: 60}, (_, i) => ({t: new Date(1700000000000 + i * 60000).toISOString(), o: 100 + i, h: 103 + i, l: 99 + i, c: 102 + i, v: 1000 + i}));
  const app = await boot({bars});
  assert.equal(app.$('chart-candles').querySelectorAll('rect').length, 60);
  assert.equal(app.$('chart-volumes').querySelectorAll('rect').length, 60);
  assert.equal(app.$('chart-averages').children.length, 2);
  app.$('chart').dispatchEvent(new app.window.Event('focus'));
  assert.match(app.$('chart-readout').textContent, /O \$159.00.*H \$162.00.*Volume 1,059.*SMA 20/);
  const key = new app.window.Event('keydown', {cancelable: true}); Object.defineProperty(key, 'key', {value: 'Home'});
  app.$('chart').dispatchEvent(key);
  assert.match(app.$('chart-readout').textContent, /C \$102.00/);
  assert.equal(app.$('chart-crosshair').getAttribute('visibility'), 'visible');
  await app.click('[data-chart-type="line"]');
  assert.equal(app.$('chart-candles').children.length, 0);
  assert.equal(app.$('chart-line').getAttribute('visibility'), 'visible');
  app.$('chart-volume').checked = false; app.$('chart-volume').dispatchEvent(new app.window.Event('change'));
  assert.equal(app.$('chart-volumes').children.length, 0);
});

test('CSV download sends bearer auth and reports API or incompatible-server errors', async () => {
  for (const options of [{exportFailure: true}, {exportWrongType: true}]) {
    const app = await boot({...options, saved: new Map([['trade-api-token', 'test-token']])});
    await app.click('#export-trades');
    assert.equal(app.$('export-trades').disabled, false);
    assert.match(app.$('export-trades-status').textContent, options.exportFailure ? /Broker temporarily unavailable/ : /does not support CSV/);
    const request = app.calls.find(call => call.path === '/api/exports/trades.csv');
    assert.equal(request.init.headers.Authorization, 'Bearer test-token');
    assert.ok(!request.url.includes('test-token'));
  }
});

test('Mac launcher selects its actual local API origin instead of stale saved remote settings', async () => {
  const app = await boot({origin: 'http://127.0.0.1:8003', href: 'http://127.0.0.1:8003/?local=1', saved: new Map([['trade-api-base', 'https://old.example'], ['trade-api-token', 'old-token']])});
  assert.ok(app.calls.every(call => call.url.startsWith('http://127.0.0.1:8003/')));
  assert.ok(app.calls.every(call => !call.init.headers.Authorization));
});

test('live broker bars retain their OHLC and volume; trade-only ticks stay visibly provisional', async () => {
  const app = await boot({stream: true});
  try {
    const stamp = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    await app.emit({type: 'bar', symbol: 'AAPL', bar: {t: stamp, o: 99, h: 105, l: 98, c: 103, v: 1234}});
    assert.equal(app.$('chart-candles').querySelectorAll('rect').length, 1);
    assert.equal(app.$('chart-volumes').querySelectorAll('rect').length, 1);
    app.$('chart').dispatchEvent(new app.window.Event('focus'));
    assert.match(app.$('chart-readout').textContent, /O \$99.00.*Volume 1,234/);
    await app.emit({type: 'quote', symbol: 'AAPL', price: 106, timestamp: new Date(Date.now() + 20).toISOString(), feed: 'iex'});
    assert.match(app.$('chart-indicator-note').textContent, /provisional/);
    assert.match(app.$('chart-readout').textContent, /OHLC\/volume awaiting broker bar/);
  } finally { await app.close(); }
});

test('public stock prices and selected chart refresh on the ten-second timer without account polling', async () => {
  const app = await boot({configured: false, publicData: true});
  const before = app.calls.length;
  await app.tickInterval(10000);
  const requests = app.calls.slice(before);
  assert.equal(requests.filter(call => call.path.endsWith('/quote')).length, 6);
  assert.ok(requests.some(call => call.path === '/api/market/AAPL/bars'));
  assert.ok(!requests.some(call => call.path === '/api/account' || call.path === '/api/performance'));
  assert.match(app.$('stream-status').textContent, /10-second refresh.*may be delayed/);
  assert.match(app.$('chart-data-note').textContent, /every 10 seconds/);
  Object.defineProperty(app.window.document, 'hidden', {configurable: true, value: true});
  const hidden = app.calls.length;
  await app.tickInterval(10000);
  assert.equal(app.calls.length, hidden);
});

test('research panels show fiscal dates, compare matched returns, and add screened stocks', async () => {
  const app = await boot({research: true});
  assert.match(app.$('fundamentals-content').textContent, /Revenue.*2025-12-31.*Net income.*P\/E.*Total debt.*2027-01-20/);
  await app.click('#load-benchmark');
  assert.match(app.$('benchmark-summary').textContent, /\+2.00%.*\+1.00%/);
  assert.ok(app.$('benchmark-portfolio').getAttribute('d').startsWith('M'));
  assert.match(app.$('benchmark-status').textContent, /deposits/);
  await app.submit('screener-form');
  assert.match(app.$('screener-results').textContent, /AMZN.*Amazon.*Technology/);
  await app.click('[aria-label="Watch AMZN"]');
  assert.match(app.$('watchlist-body').textContent, /AMZN/);
});

test('journal creates, edits and deletes notes through the server without submitting orders', async () => {
  const app = await boot({research: true, configured: false, publicData: true});
  app.$('journal-thesis').value = 'Growing revenue'; app.$('journal-expected').value = 'Review after earnings';
  await app.submit('journal-form');
  assert.match(app.$('journal-list').textContent, /Growing revenue.*Review after earnings/);
  await app.click('#journal-list button');
  app.$('journal-lessons').value = 'Wait for confirmation';
  await app.submit('journal-form');
  assert.match(app.$('journal-list').textContent, /Wait for confirmation/);
  await app.click('#journal-list button:nth-child(2)');
  assert.match(app.$('journal-list').textContent, /No journal entries/);
  assert.equal(app.submitCount, 0);
});

test('research setup failures remain explicit and data status records and clears request failures', async () => {
  const options = {research: true, researchFailure: true};
  const app = await boot(options);
  assert.match(app.$('fundamentals-status').textContent, /FMP_API_KEY/);
  await app.tickInterval(2000);
  assert.match(app.$('data-status-errors').textContent, /FMP_API_KEY/);
  options.researchFailure = false;
  await app.click('#refresh-fundamentals'); await app.tickInterval(2000);
  assert.match(app.$('data-status-errors').textContent, /previously failed.*succeeded/);
  assert.match(app.$('data-status-content').textContent, /IEX exchange only/);
});

test('backup preview and import restore selections without importing credentials or submitting orders', async () => {
  const app = await boot({research: true});
  const raw = {type: 'trade-workspace', version: 1, watchlist: [{symbol: 'AMZN', name: 'Amazon'}], price_alerts: {version: 1, alerts: [], notifications: []}, apiToken: 'DO-NOT-IMPORT'};
  const file = {size: 1000, text: async () => JSON.stringify(raw)};
  Object.defineProperty(app.$('import-workspace-file'), 'files', {value: [file]});
  app.$('import-workspace-mode').value = 'replace';
  await app.click('#preview-workspace');
  assert.match(app.$('workspace-backup-status').textContent, /Replace preview: 1 saved stocks/);
  await app.click('#apply-workspace');
  assert.match(app.$('workspace-backup-status').textContent, /Import saved: 1 stocks/);
  assert.deepEqual(JSON.parse(app.saved.get('trade-watchlist-v1')), [{symbol: 'AMZN', name: 'Amazon'}]);
  assert.ok(![...app.saved.values()].join('').includes('DO-NOT-IMPORT'));
  assert.equal(app.submitCount, 0);
});
