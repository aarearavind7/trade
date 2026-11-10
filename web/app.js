'use strict';

const STOCKS = [
  {symbol: 'AAPL', name: 'Apple Inc.', icon: 'A'},
  {symbol: 'MSFT', name: 'Microsoft Corp.', icon: '▦'},
  {symbol: 'NVDA', name: 'NVIDIA Corp.', icon: 'N'},
  {symbol: 'GOOGL', name: 'Alphabet Inc.', icon: 'G'},
  {symbol: 'TSLA', name: 'Tesla Inc.', icon: 'T'}
];
const $ = id => document.getElementById(id);
const money = value => value == null || !Number.isFinite(Number(value)) ? '—' : new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(Number(value));
const quantity = value => new Intl.NumberFormat('en-US', {maximumFractionDigits: 6}).format(Number(value));
const time = value => value ? new Date(value).toLocaleString() : 'Unavailable';
const storage = {get(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key) || ''; } catch { return ''; } }, set(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch { /* API still maintains durable order state. */ } }};
let apiBase = storage.get('trade-api-base') || location.origin;
let apiToken = storage.get('trade-api-token', true);
let selected = STOCKS[0], side = 'buy', range = '1D', review = null;
let connected = false, refreshing = false, submitting = false, selectionEpoch = 0;
let configurationBlocked = false, publicMarketMode = false, marketConnected = false;
let streamSupported = false, streamController = null, streamRetryTimer = null, streamTerminal = false;
let streamGeneration = 0, streamState = 'waiting', streamRetry = 1000, streamDetail = '';
const liveBars = new Map();
let account = null, clock = null, quotes = {}, currentBars = [], lastRefresh = null;
let pendingReview = storage.get(`trade-pending:${apiBase}`);

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function message(text, error = false) {
  $('order-message').textContent = text;
  $('order-message').className = `order-message${error ? ' negative' : ''}`;
}
function banner(text, error = false) {
  $('connection-status').textContent = text;
  $('connection-status').className = `connection-banner${error ? ' error' : ''}`;
}
function rememberPending(value) {
  pendingReview = value;
  storage.set(`trade-pending:${apiBase}`, value || '');
  updateEstimate();
}
async function api(path, {method = 'GET', body} = {}) {
  const headers = {'Accept': 'application/json'};
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  if (body) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'POST' ? 60000 : 30000);
  try {
    const response = await fetch(`${apiBase}${path}`, {method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store', credentials: 'omit'});
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('No trading API at this address. Use Connect API to enter your FastAPI server URL.');
    const data = await response.json();
    if (!response.ok) {
      const detail = Array.isArray(data.detail) ? data.detail.map(error => error.msg).join('; ') : data.detail;
      const error = new Error(detail || `API error (${response.status})`); error.status = response.status; throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('API request timed out. If an order was submitted, reconcile its status before retrying.');
    throw error;
  } finally { clearTimeout(timer); }
}
function table(headers, rows, emptyText) {
  if (!rows.length) return element('p', emptyText, 'empty-state');
  const wrap = element('div', null, 'table-scroll'), grid = element('table'), head = element('thead'), header = element('tr'), body = element('tbody');
  headers.forEach(label => header.append(element('th', label))); head.append(header);
  rows.forEach(values => { const row = element('tr'); values.forEach(value => { const cell = element('td'); if (value instanceof Node) cell.append(value); else cell.textContent = value; row.append(cell); }); body.append(row); });
  grid.append(head, body); wrap.append(grid); return wrap;
}
function statusBadge(status) {
  const label = ['accepted', 'new', 'pending_new', 'accepted_for_bidding'].includes(status) ? 'pending' : status;
  return element('span', (label || 'unknown').replaceAll('_', ' '), `status-badge ${label}`);
}
function updateEstimate() {
  const limit = $('order-type').value === 'limit';
  const price = limit ? Number($('limit-price').value) : Number(quotes[selected.symbol]?.price);
  const qty = Number($('quantity').value);
  $('order-price').textContent = money(quotes[selected.symbol]?.price);
  $('estimate').textContent = price > 0 && qty > 0 ? money(price * qty) : '—';
  $('submit-order').replaceChildren(document.createTextNode(`Review ${side} ${selected.symbol}`), element('span', '↗'));
  $('submit-order').disabled = !connected || submitting || !!pendingReview || !quotes[selected.symbol];
  $('limit-field').hidden = !limit;
  $('limit-price').required = limit;
  $('quantity').step = limit ? '1' : '0.000001';
  $('quantity').min = limit ? '1' : '0.000001';
  $('order-type-label').textContent = limit ? 'Limit · day' : 'Market · day';
}
function quoteDelayed(quote) {
  return !!quote && (quote.delayed || quote.feed === 'delayed_sip' || Date.now() - new Date(quote.timestamp).getTime() > 120000);
}
function renderStreamStatus(detail) {
  if (detail !== undefined) streamDetail = detail;
  if (publicMarketMode) {
    $('stream-status').className = 'stream-indicator delayed';
    $('stream-status').textContent = 'Yahoo Finance · 30-second refresh · may be delayed';
    return;
  }
  const quote = quotes[selected.symbol];
  const delayed = quoteDelayed(quote);
  const live = streamState === 'connected' && quote && !delayed;
  $('stream-status').className = `stream-indicator ${live ? 'live' : delayed ? 'delayed' : 'offline'}`;
  $('stream-status').textContent = streamDetail || (streamState === 'connected'
    ? `${delayed ? 'Connected · delayed / stale trade' : quote ? 'Live market feed' : 'Connected · awaiting trades'} · ${quote?.coverage || 'Alpaca'}${clock?.is_open === false ? ' · market closed' : ''}`
    : streamState === 'waiting' ? 'Market stream awaiting connection' : `${streamState === 'connecting' ? 'Connecting to market stream' : 'Market stream offline'} · REST refresh available`);
}
function renderQuote() {
  const quote = quotes[selected.symbol];
  $('quote-name').textContent = selected.name;
  $('price').textContent = money(quote?.price);
  const change = quote?.change_pct == null ? null : Number(quote.change_pct);
  $('change').textContent = change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  $('change').className = change != null && change < 0 ? 'negative' : 'positive';
  $('quote-time').textContent = quote ? `${quote.timing_verified === false ? 'Market price · timing unverified' : quoteDelayed(quote) ? 'Delayed / stale' : 'Latest trade'} · ${time(quote.timestamp)}` : 'No quote available';
  $('feed-label').textContent = quote ? `${quote.coverage} · ${quote.feed}` : 'Awaiting market data';
  renderStreamStatus(); updateEstimate();
}
function linePath(values, width, height, padding = 12) {
  if (!values.length) return '';
  const low = Math.min(...values), high = Math.max(...values), spread = high - low || Math.max(1, high * .01);
  return values.map((value, index) => `${index ? 'L' : 'M'}${(index * width / Math.max(1, values.length - 1)).toFixed(2)},${(height - padding - (value - low) / spread * (height - padding * 2)).toFixed(2)}`).join(' ');
}
function renderChart() {
  const valid = currentBars.filter(bar => Number.isFinite(Number(bar.c)));
  const values = valid.map(bar => Number(bar.c)), path = linePath(values, 760, 240);
  $('chart-line').setAttribute('d', path);
  $('chart-area').setAttribute('d', values.length ? `${path} L760,240 L0,240 Z` : '');
  $('chart-empty').hidden = !!values.length;
  $('chart-empty').textContent = 'No historical bars available for this range.';
  $('chart').setAttribute('aria-label', `${selected.name} ${range} price chart. Feed timestamps and delay status are shown below.`);
  $('axis-high').textContent = values.length ? Math.max(...values).toFixed(2) : '';
  $('axis-mid').textContent = values.length ? ((Math.max(...values) + Math.min(...values)) / 2).toFixed(2) : '';
  $('axis-low').textContent = values.length ? Math.min(...values).toFixed(2) : '';
  const marks = valid.length ? [0, Math.floor((valid.length - 1) / 2), valid.length - 1] : [];
  $('chart-times').replaceChildren(...marks.map(index => element('span', new Date(valid[index].t).toLocaleString(undefined, range === '1D' ? {hour: 'numeric', minute: '2-digit'} : {month: 'short', day: 'numeric'}))));
}
async function loadSelected() {
  const epoch = ++selectionEpoch, symbol = selected.symbol, period = range;
  const results = await Promise.allSettled([api(`/api/market/${symbol}/quote`), api(`/api/market/${symbol}/bars?period=${period}`)]);
  if (epoch !== selectionEpoch) return;
  if (results[0].status === 'fulfilled') saveSnapshot(symbol, results[0].value);
  else { message(results[0].reason.message, true); }
  if (results[1].status === 'fulfilled') {
    currentBars = results[1].value.bars || [];
    if (period === '1D') mergeLiveBars(symbol);
    const delay = results[1].value.delay_minutes || 0;
    $('chart-data-note').textContent = results[1].value.source === 'Yahoo Finance' ? 'Yahoo Finance · may be delayed · refreshed every 30 seconds' : `${delay ? `Historical bars · ≥${delay} min delay` : period === '1D' ? '1-minute bars · live trade updates' : 'Historical bars · current feed'}${results[1].value.next_page_token ? ' · truncated' : ''}`;
  } else { currentBars = []; $('chart-data-note').textContent = results[1].reason.message; }
  renderQuote(); renderChart(); renderWatchlist();
}
function selectStock(symbol) {
  selected = STOCKS.find(stock => stock.symbol === symbol) || STOCKS[0];
  $('symbol').value = selected.symbol;
  document.querySelectorAll('[data-stock]').forEach(button => { const active = button.dataset.stock === symbol; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  currentBars = []; renderQuote(); renderChart();
  if (marketConnected || connected) loadSelected();
}
function renderWatchlist() {
  const body = $('watchlist-body'); body.replaceChildren();
  STOCKS.forEach(stock => {
    const quote = quotes[stock.symbol], row = element('tr'), asset = element('div', null, 'asset-cell');
    const name = element('div', null, 'asset-name'); name.append(element('strong', stock.symbol), element('small', stock.name));
    asset.append(element('span', stock.icon, 'asset-icon'), name);
    const change = quote?.change_pct == null ? null : Number(quote.change_pct);
    const timestamp = element('span', quote ? new Date(quote.timestamp).toLocaleTimeString() : '—');
    if (quote) timestamp.append(element('small', quote.timing_verified === false ? 'May be delayed' : quoteDelayed(quote) ? 'Delayed / stale' : quote.coverage, 'quote-state'));
    const action = element('button', '↗', 'trade-link'); action.type = 'button'; action.setAttribute('aria-label', `Trade ${stock.symbol}`);
    action.addEventListener('click', () => { selectStock(stock.symbol); $('order-form').scrollIntoView({behavior: 'smooth', block: 'center'}); $('quantity').focus({preventScroll: true}); });
    [asset, money(quote?.price), change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, timestamp, action].forEach((value, index) => {
      const cell = element('td'); if (value instanceof Node) cell.append(value); else cell.textContent = value;
      if (index === 2) cell.className = change != null && change < 0 ? 'negative' : 'positive';
      if (index === 3) cell.className = 'spark-col'; row.append(cell);
    }); body.append(row);
  });
}
function renderAccount(positions) {
  $('equity').textContent = money(account.equity);
  $('cash').textContent = money(account.cash);
  $('buying-power').textContent = money(account.buying_power);
  $('invested').textContent = money(positions.reduce((sum, position) => sum + Number(position.market_value), 0));
  $('position-count').textContent = `${positions.length} open position${positions.length === 1 ? '' : 's'}`;
  $('holdings-content').replaceChildren(table(['Asset', 'Shares', 'Average cost', 'Market price', 'Market value', 'Unrealized P/L'], positions.map(p => [p.symbol, quantity(p.qty), money(p.avg_entry_price), money(p.current_price), money(p.market_value), money(p.unrealized_pl)]), 'No open paper positions. Review an order to get started.'));
}
function renderOrders(data) {
  const root = $('activity-content'); root.replaceChildren();
  const locals = [...(data.local || [])];
  if (pendingReview && !locals.some(item => item.review_id === pendingReview)) locals.unshift({review_id: pendingReview, status: 'unknown'});
  locals.forEach(local => {
    const row = element('div', null, 'activity-row'), details = element('span', `Review ${local.review_id.slice(0, 8)}`);
    details.append(element('small', local.status === 'unknown' ? 'Reconcile before submitting another order.' : 'Broker rejected this order.'));
    const actions = element('span', null, 'order-actions'), button = element('button', 'Reconcile'); button.type = 'button';
    button.addEventListener('click', () => reconcileOrder(local.review_id, button)); actions.append(statusBadge(local.status), button); row.append(details, actions); root.append(row);
  });
  (data.orders || []).slice(0, 30).forEach(order => {
    const row = element('div', null, 'activity-row'), details = element('span', `${order.side === 'buy' ? 'Buy' : 'Sell'} ${quantity(order.qty)} ${order.symbol} · ${order.type}`);
    details.append(element('small', `${time(order.submitted_at || order.created_at)} · Filled ${quantity(order.filled_qty || 0)}${order.filled_avg_price ? ` @ ${money(order.filled_avg_price)}` : ''}${order.limit_price ? ` · Limit ${money(order.limit_price)}` : ''}`));
    const actions = element('span', null, 'order-actions'); actions.append(statusBadge(order.status));
    if (!['filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'].includes(order.status)) {
      const cancel = element('button', 'Cancel'); cancel.type = 'button';
      cancel.addEventListener('click', async () => { cancel.disabled = true; try { const result = await api(`/api/orders/${order.id}`, {method: 'DELETE'}); message(result.message); await refresh(); } catch (error) { message(error.message, true); } finally { cancel.disabled = false; } }); actions.append(cancel);
    }
    row.append(details, actions); root.append(row);
  });
  if (!root.childNodes.length) root.append(element('p', 'No broker orders yet. Reviewed paper orders will appear here.', 'empty-state'));
}
function renderPerformance(data) {
  $('realized-pl').textContent = money(data.realized_pl);
  $('unrealized-pl').textContent = money(data.unrealized_pl);
  $('fill-count').textContent = data.fill_count;
  $('performance-note').textContent = `${data.method}${data.since ? ` Coverage since ${time(data.since)}.` : ''}${!data.realized_complete ? ' Fill history does not reconcile; realized P/L is unavailable.' : ''}`;
  const history = data.portfolio_history || {}, points = (history.equity || []).map((value, i) => ({value, timestamp: history.timestamp?.[i]})).filter(item => item.value != null && Number.isFinite(Number(item.value)));
  $('equity-line').setAttribute('d', linePath(points.map(item => Number(item.value)), 760, 160));
  $('equity-chart').hidden = !points.length; $('equity-empty').hidden = !!points.length;
  if (points.length) $('equity-chart').setAttribute('aria-label', `Portfolio equity: ${money(points[0].value)} to ${money(points.at(-1).value)} over ${points.length} observations.`);
}
function renderRisk(data) {
  const root = $('risk-values'); root.replaceChildren();
  [['Max position', `${data.max_position_pct}% of equity`], ['Max order', money(data.max_order_notional)], ['Daily loss limit', money(data.max_daily_loss)], ['Current daily loss', money(data.daily_loss)]].forEach(([label, value]) => { const el = element('span', `${label}: `); el.append(element('strong', value)); root.append(el); });
  root.append(element('p', `${data.buys_paused ? 'Daily loss limit reached: new buys paused. Sells remain available. ' : ''}${data.basis} Limits are configured on the server; pending orders count toward exposure. No margin or short selling.`));
}
async function reconcileOrder(id, button) {
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/orders/by-review/${id}`);
    if (result.status === 'unknown') { message(`Order ${id}: outcome is still unknown. Check this exact client order ID in Alpaca before taking further action.`, true); return; }
    if (pendingReview === id) rememberPending('');
    message(result.status === 'not_submitted' ? 'This review was never sent to the broker. You can review a new order.' : `Broker order status: ${result.status}.`);
    await refresh();
  } catch (error) { message(error.message, true); }
  finally { if (button) button.disabled = false; }
}
function saveSnapshot(symbol, snapshot) {
  const existing = quotes[symbol];
  if (!existing || new Date(snapshot.timestamp) >= new Date(existing.timestamp)) quotes[symbol] = snapshot;
  else if (snapshot.previous_close) {
    existing.previous_close = snapshot.previous_close;
    existing.change_pct = (Number(existing.price) / Number(snapshot.previous_close) - 1) * 100;
  }
}
function mergeLiveBars(symbol) {
  const merged = new Map(currentBars.map(bar => { const t = new Date(bar.t).toISOString(); return [t, {...bar, t}]; }));
  const first = currentBars.length ? new Date(currentBars[0].t).getTime() : Date.now() - 86400000;
  for (const bar of liveBars.get(symbol)?.values() || []) {
    if (new Date(bar.t).getTime() >= first) merged.set(bar.t, bar);
  }
  currentBars = [...merged.values()].sort((a, b) => new Date(a.t) - new Date(b.t)).slice(-1500);
}
function rememberLiveBar(symbol, bar, source) {
  const stamp = new Date(bar.t).getTime();
  if (!Number.isFinite(stamp) || !Number.isFinite(Number(bar.c)) || Number(bar.c) <= 0) return;
  const key = new Date(Math.floor(stamp / 60000) * 60000).toISOString();
  if (!liveBars.has(symbol)) liveBars.set(symbol, new Map());
  const cache = liveBars.get(symbol), old = cache.get(key);
  // Completed/updated broker bars may correct the close; older trade ticks must not replace newer ticks.
  if (source === 'trade' && old && old._tradeTime > stamp) return;
  cache.set(key, {t: key, c: Number(bar.c), _tradeTime: source === 'trade' ? stamp : old?._tradeTime || stamp});
  while (cache.size > 1500) cache.delete(cache.keys().next().value);
  if (symbol === selected.symbol && range === '1D') { mergeLiveBars(symbol); renderChart(); }
}
function handleMarketEvent(event) {
  if (event.type === 'status' || event.type === 'heartbeat') {
    streamState = event.state;
    if (event.retryable === false) streamTerminal = true;
    renderStreamStatus(event.state === 'connected' ? '' : event.message);
    return;
  }
  if (!STOCKS.some(stock => stock.symbol === event.symbol)) return;
  if (event.type === 'quote') {
    const old = quotes[event.symbol];
    if (!Number.isFinite(Number(event.price)) || Number(event.price) <= 0 || !Number.isFinite(new Date(event.timestamp).getTime())) return;
    if (old && new Date(event.timestamp) < new Date(old.timestamp)) return;
    const previous = old?.previous_close || (old?.change_pct != null ? Number(old.price) / (1 + Number(old.change_pct) / 100) : null);
    quotes[event.symbol] = {...event, previous_close: previous, change_pct: previous > 0 ? (Number(event.price) / Number(previous) - 1) * 100 : null};
    rememberLiveBar(event.symbol, {t: event.timestamp, c: event.price}, 'trade');
    if (event.symbol === selected.symbol) renderQuote();
    renderWatchlist();
  } else if (event.type === 'bar' && event.bar) {
    rememberLiveBar(event.symbol, event.bar, 'bar');
  }
}
function stopMarketStream() {
  streamGeneration++;
  if (streamRetryTimer) clearTimeout(streamRetryTimer);
  streamRetryTimer = null;
  if (streamController) streamController.abort();
  streamController = null; streamState = 'waiting'; renderStreamStatus('');
}
async function startMarketStream() {
  if (!streamSupported || !connected || configurationBlocked || streamTerminal || streamController || document.hidden) return;
  const generation = ++streamGeneration, controller = new AbortController();
  streamController = controller; streamState = 'connecting'; renderStreamStatus('');
  const connectTimeout = setTimeout(() => controller.abort(), 15000);
  let idleTimeout;
  const headers = {'Accept': 'text/event-stream'};
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  try {
    const response = await fetch(`${apiBase}/api/market/stream`, {headers, signal: controller.signal, cache: 'no-store', credentials: 'omit'});
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/event-stream') || !response.body) {
      if ([401, 403, 503].includes(response.status)) streamTerminal = true;
      throw new Error('Market stream unavailable. Check server credentials and feed permissions.');
    }
    clearTimeout(connectTimeout);
    idleTimeout = setTimeout(() => controller.abort(), 45000);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      while (generation === streamGeneration) {
        const {value, done} = await reader.read();
        if (done || generation !== streamGeneration) break;
        clearTimeout(idleTimeout); idleTimeout = setTimeout(() => controller.abort(), 45000);
        buffer += decoder.decode(value, {stream: true});
        if (buffer.length > 1048576) throw new Error('Invalid market stream frame.');
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const packet = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = packet.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) { handleMarketEvent(JSON.parse(data)); streamRetry = 1000; }
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    if (generation === streamGeneration && error.name !== 'AbortError') renderStreamStatus(error.message);
  } finally {
    clearTimeout(connectTimeout); clearTimeout(idleTimeout);
    if (generation === streamGeneration) {
      streamController = null; streamState = 'offline';
      if (!streamTerminal) {
        renderStreamStatus('Market stream disconnected · reconnecting; REST refresh remains available');
        streamRetryTimer = setTimeout(() => { streamRetryTimer = null; startMarketStream(); }, streamRetry);
        streamRetry = Math.min(streamRetry * 2, 30000);
      }
    }
  }
}
async function refresh() {
  if (refreshing || submitting) return;
  refreshing = true; $('refresh-data').disabled = true; $('refresh-market').disabled = true;
  try {
    const health = await api('/api/health');
    const previousPublicMode = publicMarketMode;
    publicMarketMode = health.broker_configured === false && health.public_market_data === true;
    if (previousPublicMode !== publicMarketMode) { liveBars.clear(); quotes = {}; currentBars = []; stopMarketStream(); }
    configurationBlocked = health.broker_configured === false && !publicMarketMode;
    document.body.classList.toggle('market-only', publicMarketMode);
    $('account-label').textContent = publicMarketMode ? 'Market data only' : 'Practice account';
    $('account-mode').textContent = publicMarketMode ? 'No trading account connected' : 'Personal workspace';
    $('account-status').textContent = publicMarketMode ? 'Market data only' : 'Paper trading';
    $('data-disclaimer').textContent = publicMarketMode ? 'Yahoo Finance · quotes may be delayed · no trading account connected' : 'Alpaca paper trading · IEX prices may differ from the consolidated market.';
    $('order-note').textContent = publicMarketMode
      ? 'Prices are available without keys. Connect Alpaca paper credentials in the server .env to enable orders. Public prices are never used to submit trades.'
      : 'Orders go to Alpaca paper trading after your confirmation. Market buys reserve a 2% price buffer.';
    streamSupported = health.market_stream === true;
    if (configurationBlocked) {
      marketConnected = false; connected = false; quotes = {}; currentBars = []; stopMarketStream();
      $('market-status').textContent = 'Alpaca setup required';
      banner(health.setup_message || 'Configure Alpaca paper keys in the server .env file, restart Uvicorn, then click Refresh.', true);
      renderQuote(); renderChart(); renderWatchlist();
      return;
    }
    if (publicMarketMode) {
      connected = false; marketConnected = true; stopMarketStream();
      banner('Real market data from Yahoo Finance · quotes may be delayed. Add Alpaca paper credentials to enable account balances, trading, and streaming.');
      const schedule = await api('/api/market/clock').catch(() => null);
      clock = schedule;
      $('market-status').textContent = schedule?.schedule_available
        ? `${schedule.is_open ? 'Regular session open' : 'Regular session closed'} · provider schedule estimate`
        : 'Market data only · session status unavailable';
      const quotesResult = await Promise.allSettled(STOCKS.map(async stock => {
        const quote = await api(`/api/market/${stock.symbol}/quote`); saveSnapshot(stock.symbol, quote);
      }));
      renderWatchlist(); await loadSelected();
      if (quotesResult.every(result => result.status === 'rejected')) throw quotesResult[0].reason;
      return;
    }
    const results = await Promise.allSettled([api('/api/account'), api('/api/positions'), api('/api/market/clock'), api('/api/orders'), api('/api/risk'), api('/api/performance'), api('/api/trades')]);
    connected = results.slice(0, 3).every(result => result.status === 'fulfilled');
    marketConnected = connected;
    if (results[0].status === 'fulfilled') account = results[0].value;
    if (results[1].status === 'fulfilled' && account) renderAccount(results[1].value);
    if (results[2].status === 'fulfilled') { clock = results[2].value; $('market-status').textContent = `${clock.is_open ? 'Market open' : 'Market closed'} · ${time(clock.timestamp)}`; }
    if (results[3].status === 'fulfilled') {
      const unresolved = results[3].value.local?.find(item => item.status === 'unknown');
      if (unresolved && !pendingReview) rememberPending(unresolved.review_id);
      renderOrders(results[3].value);
    }
    if (results[4].status === 'fulfilled') renderRisk(results[4].value);
    if (results[5].status === 'fulfilled') renderPerformance(results[5].value);
    if (results[6].status === 'fulfilled') $('trades-content').replaceChildren(table(['Time', 'Asset', 'Side', 'Filled shares', 'Fill price', 'Value'], results[6].value.trades.map(fill => [time(fill.transaction_time), fill.symbol, fill.side, quantity(fill.qty), money(fill.price), money(Number(fill.qty) * Number(fill.price))]), 'No fills in this paper account.'));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) banner(`${failures[0].reason.message}${lastRefresh ? ` Last complete refresh: ${time(lastRefresh)}. Previously displayed values may be stale.` : ''}`, true);
    else { lastRefresh = new Date().toISOString(); banner(`Connected to Alpaca paper trading · Updated ${time(lastRefresh)}. Quotes are timestamped; IEX covers one exchange. Streaming prices and chart updates use your selected market-data feed.`); }
    updateEstimate();
    if (connected) {
      await Promise.allSettled(STOCKS.map(async stock => { try { saveSnapshot(stock.symbol, await api(`/api/market/${stock.symbol}/quote`)); } catch { /* Retain timestamped values until the next refresh or stream event. */ } }));
      renderWatchlist(); await loadSelected(); startMarketStream();
    }
  } catch (error) { connected = false; banner(error.message, true); }
  finally { refreshing = false; $('refresh-data').disabled = false; $('refresh-market').disabled = false; updateEstimate(); }
}

STOCKS.forEach(stock => {
  const tab = element('button', stock.symbol); tab.type = 'button'; tab.dataset.stock = stock.symbol; tab.addEventListener('click', () => selectStock(stock.symbol)); $('stock-tabs').append(tab);
  const option = element('option', `${stock.symbol} · ${stock.name}`); option.value = stock.symbol; $('symbol').append(option);
});
$('symbol').addEventListener('change', event => selectStock(event.target.value));
['quantity', 'limit-price'].forEach(id => $(id).addEventListener('input', updateEstimate));
$('order-type').addEventListener('change', updateEstimate);
document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => { range = button.dataset.range; document.querySelectorAll('[data-range]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); }); if (marketConnected || connected) loadSelected(); }));
document.querySelectorAll('[data-side]').forEach(button => button.addEventListener('click', () => { side = button.dataset.side; document.querySelectorAll('[data-side]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); }); message(''); updateEstimate(); }));
$('order-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (pendingReview || submitting || !connected) return;
  const draft = {symbol: selected.symbol, side, qty: $('quantity').value, order_type: $('order-type').value};
  if (draft.order_type === 'limit') draft.limit_price = $('limit-price').value;
  $('submit-order').disabled = true;
  try {
    review = await api('/api/orders/review', {method: 'POST', body: draft});
    const root = $('review-details'); root.replaceChildren();
    [['Asset', review.order.symbol], ['Side', review.order.side.toUpperCase()], ['Shares', review.order.qty], ['Order type', `${review.order.order_type} · day`], ['Estimated price', money(review.estimated_price)], ['Estimated value', money(review.estimated_total)], ...(review.order.limit_price ? [['Limit price', money(review.order.limit_price)]] : []), ['Quote time', time(review.quote.timestamp)]].forEach(([key, value]) => { const row = element('div'); row.append(element('dt', key), element('dd', value)); root.append(row); });
    $('review-error').textContent = ''; $('confirm-order').disabled = false;
    $('review-expiry').textContent = `Review expires at ${new Date(review.expires_at * 1000).toLocaleTimeString()}. Market fills may differ from the estimate. Risk limits are checked again on confirmation.`;
    $('review-dialog').showModal();
  } catch (error) { message(error.message, true); }
  finally { updateEstimate(); }
});
$('cancel-review').addEventListener('click', () => { if (!submitting) { $('review-dialog').close(); review = null; } });
$('review-dialog').addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
$('confirm-order').addEventListener('click', async () => {
  if (!review || submitting) return;
  if (Date.now() > review.expires_at * 1000) { $('review-error').textContent = 'Review expired. Go back and review again.'; $('confirm-order').disabled = true; return; }
  submitting = true; $('confirm-order').disabled = true; $('cancel-review').disabled = true;
  rememberPending(review.review_id);
  try {
    const result = await api('/api/orders', {method: 'POST', body: {review_id: review.review_id}});
    rememberPending(''); $('review-dialog').close(); review = null;
    message(`Paper order ${result.status || 'submitted'}: ${result.side} ${result.qty} ${result.symbol}. Activity shows the broker’s latest status.`);
  } catch (error) {
    $('review-dialog').close();
    message(`${error.message} Use Reconcile in Activity to verify this review before making another order.`, true);
  } finally {
    submitting = false; $('cancel-review').disabled = false; updateEstimate(); await refresh();
  }
});
$('connect-api').addEventListener('click', () => { $('api-url').value = apiBase; $('api-token').value = apiToken; $('connection-error').textContent = ''; $('connection-dialog').showModal(); });
$('close-connection').addEventListener('click', () => $('connection-dialog').close());
$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (submitting || refreshing) throw new Error('Wait for the current request to finish before changing connections.');
    const url = new URL($('api-url').value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter only the API origin, without credentials, paths, or query parameters.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for remote APIs. HTTP is supported only on localhost.');
    stopMarketStream(); streamTerminal = false; liveBars.clear();
    apiBase = url.origin; apiToken = $('api-token').value.trim(); quotes = {}; account = null; connected = false; marketConnected = false;
    lastRefresh = null; currentBars = [];
    ['equity', 'cash', 'invested', 'buying-power', 'realized-pl', 'unrealized-pl', 'fill-count'].forEach(id => { $(id).textContent = '—'; });
    ['holdings-content', 'activity-content', 'trades-content'].forEach(id => { $(id).replaceChildren(element('p', 'Connecting to the selected account…', 'empty-state')); });
    $('equity-line').setAttribute('d', ''); renderChart();
    storage.set('trade-api-base', apiBase); storage.set('trade-api-token', apiToken, true);
    pendingReview = storage.get(`trade-pending:${apiBase}`);
    $('connection-dialog').close(); renderWatchlist(); renderQuote(); await refresh();
  } catch (error) { $('connection-error').textContent = error.message; }
});
function manualRefresh() { streamTerminal = false; if (streamRetryTimer) { clearTimeout(streamRetryTimer); streamRetryTimer = null; } refresh(); }
$('refresh-data').addEventListener('click', manualRefresh);
$('refresh-market').addEventListener('click', manualRefresh);
function updateNavigation() {
  const hash = location.hash || '#overview';
  document.querySelectorAll('.nav-link').forEach(link => { const active = link.hash === hash; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  const active = document.querySelector('.nav-link.active'); document.querySelector('.breadcrumb b').textContent = active ? active.textContent.trim().split(' ').pop() : 'Overview';
}
window.addEventListener('hashchange', updateNavigation);
const dateFormatter = new Intl.DateTimeFormat(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
const clockFormatter = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit', second: '2-digit'});
function updateLocalClock() {
  const now = new Date();
  $('current-date').textContent = dateFormatter.format(now);
  $('current-time').textContent = clockFormatter.format(now);
  $('current-date').setAttribute('datetime', now.toISOString());
  $('current-time').setAttribute('datetime', now.toISOString());
  $('current-timezone').textContent = dateFormatter.resolvedOptions().timeZone;
}
updateLocalClock();
setInterval(updateLocalClock, 1000);
selectStock(selected.symbol); renderWatchlist(); updateNavigation(); refresh();
setInterval(() => { if (!configurationBlocked && !document.hidden && !$('review-dialog').open && !$('connection-dialog').open) refresh(); }, 30000);

window.addEventListener('pagehide', stopMarketStream);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopMarketStream(); else refresh(); });
setInterval(() => { renderQuote(); renderWatchlist(); }, 5000);
