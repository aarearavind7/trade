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
function renderQuote() {
  const quote = quotes[selected.symbol];
  $('quote-name').textContent = selected.name;
  $('price').textContent = money(quote?.price);
  const change = quote?.change_pct == null ? null : Number(quote.change_pct);
  $('change').textContent = change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  $('change').className = change != null && change < 0 ? 'negative' : 'positive';
  $('quote-time').textContent = quote ? `${quote.delayed ? 'Delayed / stale' : 'Latest trade'} · ${time(quote.timestamp)}` : 'No quote available';
  $('feed-label').textContent = quote ? `${quote.coverage} · ${quote.feed}` : 'Awaiting market data';
  updateEstimate();
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
  $('chart').setAttribute('aria-label', `${selected.name} ${range} historical price chart, delayed at least 16 minutes.`);
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
  if (results[0].status === 'fulfilled') quotes[symbol] = results[0].value;
  else { delete quotes[symbol]; message(results[0].reason.message, true); }
  if (results[1].status === 'fulfilled') {
    currentBars = results[1].value.bars || [];
    $('chart-data-note').textContent = `Historical bars · ≥${results[1].value.delay_minutes || 16} min delay${results[1].value.next_page_token ? ' · truncated' : ''}`;
  } else { currentBars = []; $('chart-data-note').textContent = results[1].reason.message; }
  renderQuote(); renderChart(); renderWatchlist();
}
function selectStock(symbol) {
  selected = STOCKS.find(stock => stock.symbol === symbol) || STOCKS[0];
  $('symbol').value = selected.symbol;
  document.querySelectorAll('[data-stock]').forEach(button => { const active = button.dataset.stock === symbol; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  currentBars = []; renderQuote(); renderChart();
  if (connected) loadSelected();
}
function renderWatchlist() {
  const body = $('watchlist-body'); body.replaceChildren();
  STOCKS.forEach(stock => {
    const quote = quotes[stock.symbol], row = element('tr'), asset = element('div', null, 'asset-cell');
    const name = element('div', null, 'asset-name'); name.append(element('strong', stock.symbol), element('small', stock.name));
    asset.append(element('span', stock.icon, 'asset-icon'), name);
    const change = quote?.change_pct == null ? null : Number(quote.change_pct);
    const timestamp = element('span', quote ? new Date(quote.timestamp).toLocaleTimeString() : '—');
    if (quote) timestamp.append(element('small', quote.delayed ? 'Delayed / stale' : quote.coverage, 'quote-state'));
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
async function refresh() {
  if (refreshing || submitting) return;
  refreshing = true; $('refresh-data').disabled = true;
  const results = await Promise.allSettled([api('/api/account'), api('/api/positions'), api('/api/market/clock'), api('/api/orders'), api('/api/risk'), api('/api/performance'), api('/api/trades')]);
  try {
    connected = results.slice(0, 3).every(result => result.status === 'fulfilled');
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
    else { lastRefresh = new Date().toISOString(); banner(`Connected to Alpaca paper trading · Updated ${time(lastRefresh)}. Quotes are timestamped; IEX covers one exchange. Historical bars are delayed at least 16 minutes.`); }
    updateEstimate();
    if (connected) {
      await Promise.allSettled(STOCKS.map(async stock => { try { quotes[stock.symbol] = await api(`/api/market/${stock.symbol}/quote`); } catch { delete quotes[stock.symbol]; } }));
      renderWatchlist(); await loadSelected();
    }
  } catch (error) { banner(error.message, true); }
  finally { refreshing = false; $('refresh-data').disabled = false; updateEstimate(); }
}

STOCKS.forEach(stock => {
  const tab = element('button', stock.symbol); tab.type = 'button'; tab.dataset.stock = stock.symbol; tab.addEventListener('click', () => selectStock(stock.symbol)); $('stock-tabs').append(tab);
  const option = element('option', `${stock.symbol} · ${stock.name}`); option.value = stock.symbol; $('symbol').append(option);
});
$('symbol').addEventListener('change', event => selectStock(event.target.value));
['quantity', 'limit-price'].forEach(id => $(id).addEventListener('input', updateEstimate));
$('order-type').addEventListener('change', updateEstimate);
document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => { range = button.dataset.range; document.querySelectorAll('[data-range]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); }); if (connected) loadSelected(); }));
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
    apiBase = url.origin; apiToken = $('api-token').value.trim(); quotes = {}; account = null; connected = false;
    lastRefresh = null; currentBars = [];
    ['equity', 'cash', 'invested', 'buying-power', 'realized-pl', 'unrealized-pl', 'fill-count'].forEach(id => { $(id).textContent = '—'; });
    ['holdings-content', 'activity-content', 'trades-content'].forEach(id => { $(id).replaceChildren(element('p', 'Connecting to the selected account…', 'empty-state')); });
    $('equity-line').setAttribute('d', ''); renderChart();
    storage.set('trade-api-base', apiBase); storage.set('trade-api-token', apiToken, true);
    pendingReview = storage.get(`trade-pending:${apiBase}`);
    $('connection-dialog').close(); renderWatchlist(); renderQuote(); await refresh();
  } catch (error) { $('connection-error').textContent = error.message; }
});
$('refresh-data').addEventListener('click', refresh);
function updateNavigation() {
  const hash = location.hash || '#overview';
  document.querySelectorAll('.nav-link').forEach(link => { const active = link.hash === hash; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  const active = document.querySelector('.nav-link.active'); document.querySelector('.breadcrumb b').textContent = active ? active.textContent.trim().split(' ').pop() : 'Overview';
}
window.addEventListener('hashchange', updateNavigation);
selectStock(selected.symbol); renderWatchlist(); updateNavigation(); refresh();
setInterval(() => { if (!document.hidden && !$('review-dialog').open && !$('connection-dialog').open) refresh(); }, 30000);
