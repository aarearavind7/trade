'use strict';

const DEFAULT_STOCKS = [
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
const storage = {get(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key) || ''; } catch { return ''; } }, set(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); return true; } catch { return false; } }};
const MARKET_REFRESH_MS = 10000;
const WATCHLIST_KEY = 'trade-watchlist-v1';
const MAX_WATCHLIST = 1000;
const WATCHLIST_PAGE_SIZE = 20;
let watchlistPage = 0, bulkAdding = false;
function pageStocks() {
  return STOCKS.slice(watchlistPage * WATCHLIST_PAGE_SIZE, (watchlistPage + 1) * WATCHLIST_PAGE_SIZE);
}
function renderPageControls() {
  const totalPages = Math.max(1, Math.ceil(STOCKS.length / WATCHLIST_PAGE_SIZE));
  watchlistPage = Math.max(0, Math.min(watchlistPage, totalPages - 1));
  const select = $('watchlist-page-select'), key = `${STOCKS.length}:${watchlistPage}`;
  if (select.dataset.pageState !== key) {
    select.replaceChildren();
    for (let page = 0; page < totalPages; page++) {
      const option = element('option', `Page ${page + 1} of ${totalPages}`); option.value = page;
      select.append(option);
    }
    select.value = String(watchlistPage); select.dataset.pageState = key;
  }
  select.disabled = totalPages === 1;
  $('watchlist-prev').disabled = watchlistPage === 0;
  $('watchlist-next').disabled = watchlistPage >= totalPages - 1;
  const first = STOCKS.length ? watchlistPage * WATCHLIST_PAGE_SIZE + 1 : 0;
  $('watchlist-page-label').textContent = `${first}–${Math.min((watchlistPage + 1) * WATCHLIST_PAGE_SIZE, STOCKS.length)} of ${STOCKS.length} listings`;
}
async function refreshPagePrices() {
  if (!(marketConnected || connected)) return;
  await Promise.allSettled(pageStocks().map(async stock => {
    try { saveSnapshot(stock.symbol, await api(`/api/market/${stock.symbol}/quote`)); } catch { /* Timestamps remain visible for previously loaded values. */ }
  }));
  renderWatchlist();
}
function setWatchlistPage(page) {
  const total = Math.max(1, Math.ceil(STOCKS.length / WATCHLIST_PAGE_SIZE));
  watchlistPage = Math.max(0, Math.min(Number(page) || 0, total - 1));
  selectionEpoch++; selected = pageStocks()[0] || DEFAULT_STOCKS[0]; currentBars = [];
  renderStockSelectors(); renderWatchlist(); selectStock(selected.symbol);
  restartWatchlistStream(); refreshPagePrices();
}
function validStock(value) {
  if (!value || typeof value.symbol !== 'string') return null;
  const symbol = value.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) return null;
  return {symbol, name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 200) : symbol, icon: symbol[0]};
}
function loadWatchlist() {
  try {
    const raw = storage.get(WATCHLIST_KEY);
    if (!raw) return DEFAULT_STOCKS.map(stock => ({...stock}));
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('Invalid watchlist');
    const seen = new Set();
    return rows.map(validStock).filter(stock => stock && !seen.has(stock.symbol) && seen.add(stock.symbol)).slice(0, MAX_WATCHLIST);
  } catch { return DEFAULT_STOCKS.map(stock => ({...stock})); }
}
const STOCKS = loadWatchlist();
let searchEpoch = 0, searchTimer = null, searchResults = [];
let apiBase = storage.get('trade-api-base') || location.origin;
let apiToken = storage.get('trade-api-token', true);
// The Mac launcher explicitly chooses its own origin, including an alternate port.
const localLaunch = new URL(location.href || location.origin).searchParams.get('local') === '1' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(location.origin).hostname);
if (localLaunch) {
  if (apiBase !== location.origin) apiToken = '';
  apiBase = location.origin;
  storage.set('trade-api-base', apiBase); storage.set('trade-api-token', apiToken, true);
}
let selected = STOCKS[0] || DEFAULT_STOCKS[0], side = 'buy', range = '1D', review = null;
let connected = false, refreshing = false, submitting = false, selectionEpoch = 0;
let configurationBlocked = false, publicMarketMode = false, marketConnected = false;
let connectionChecking = false, lastConnectionCheck = null;
let streamSupported = false, streamController = null, streamRetryTimer = null, streamTerminal = false;
let streamGeneration = 0, streamState = 'waiting', streamRetry = 1000, streamDetail = '';
const liveBars = new Map();
const apiStatus = {lastSuccess: null, lastQuoteReceived: null, lastFailure: null, failures: new Map()};
let account = null, clock = null, quotes = {}, currentBars = [], lastRefresh = null;
let pendingReview = storage.get(`trade-pending:${apiBase}`);
const PRICE_ALERTS_KEY = 'trade-price-alerts-v1';
let alertsSavedRaw = storage.get(PRICE_ALERTS_KEY);
let priceAlerts = new TradePriceAlerts.AlertBook(alertsSavedRaw);
let alertsMonitoring = false, alertsStorageFailed = false, alertReferenceEpoch = 0, alertReference = null;
const alertQuoteFailures = new Set();
const alertMoney = value => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6}).format(Number(value));


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
async function api(path, {method = 'GET', body, base = apiBase, accessToken = apiToken} = {}) {
  const headers = {'Accept': 'application/json'};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'POST' ? 60000 : 30000);
  try {
    const response = await fetch(`${base}${path}`, {method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store', credentials: 'omit'});
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('No trading API at this address. Use Connection setup to enter your FastAPI server URL.');
    const data = await response.json();
    if (!response.ok) {
      const detail = Array.isArray(data.detail) ? data.detail.map(error => error.msg).join('; ') : data.detail;
      const error = new Error(detail || `API error (${response.status})`); error.status = response.status; throw error;
    }
    if (base === apiBase) { apiStatus.lastSuccess = new Date().toISOString(); apiStatus.failures.delete(path); }
    return data;
  } catch (error) {
    if (base === apiBase) {
      apiStatus.lastFailure = {at: new Date().toISOString(), message: error.message};
      apiStatus.failures.set(path, apiStatus.lastFailure);
      if (apiStatus.failures.size > 20) apiStatus.failures.delete(apiStatus.failures.keys().next().value);
    }
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
async function downloadCsv(kind) {
  const button = $(`export-${kind}`), status = $(`export-${kind}-status`);
  if (button.disabled) return;
  button.disabled = true; status.textContent = 'Preparing broker records…';
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
  const base = apiBase, token = apiToken;
  let objectUrl;
  try {
    const response = await fetch(`${base}/api/exports/${kind}.csv`, {headers: {Accept: 'text/csv', ...(token ? {Authorization: `Bearer ${token}`} : {})}, signal: controller.signal, cache: 'no-store', credentials: 'omit'});
    if (!response.ok) {
      const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : null;
      throw new Error(data?.detail || `CSV export failed (${response.status}).`);
    }
    if (!(response.headers.get('content-type') || '').includes('text/csv')) throw new Error('This server does not support CSV downloads. Pull the latest code and restart the server.');
    const blob = await response.blob();
    if (base !== apiBase || token !== apiToken) throw new Error('Connection changed. Download again from the selected account.');
    objectUrl = URL.createObjectURL(blob);
    const link = element('a'); link.href = objectUrl;
    link.download = `${kind === 'trades' ? 'trade-history' : 'portfolio-performance'}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link); link.click(); link.remove();
    status.textContent = kind === 'trades' ? 'CSV downloaded: all available broker fills (up to 10,000); see fill_history_complete for coverage.' : 'CSV downloaded: last month of broker equity history, with current P/L summary columns.';
  } catch (error) {
    status.textContent = error.name === 'AbortError' ? 'CSV export timed out. Try again.' : error.message;
  } finally {
    clearTimeout(timer); button.disabled = false;
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  }
}
['trades', 'performance'].forEach(kind => $(`export-${kind}`).addEventListener('click', () => downloadCsv(kind)));
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
  $('submit-order').disabled = !STOCKS.length || !connected || submitting || !!pendingReview || !quotes[selected.symbol];
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
    $('stream-status').textContent = 'Yahoo Finance · 10-second refresh · may be delayed';
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
  $('quote-name').textContent = STOCKS.length ? selected.name : 'Add a stock to start exploring';
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
let chartType = 'candles', chartModel = null, chartCursor = null;
function svgElement(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}
function inspectChart(index, cursorY) {
  if (!chartModel?.bars.length) return;
  const chart = chartModel, i = Math.max(0, Math.min(chart.bars.length - 1, index)), bar = chart.bars[i];
  chartCursor = i;
  const x = chart.x(i), y = cursorY == null ? chart.y(bar.c) : Math.max(12, Math.min(204, cursorY));
  $('chart-crosshair').setAttribute('visibility', 'visible');
  $('crosshair-lines').setAttribute('d', `M${x},12V282 M0,${y}H760`);
  $('crosshair-point').setAttribute('cx', x); $('crosshair-point').setAttribute('cy', chart.y(bar.c));
  const labelX = x > 650 ? 0 : 678;
  $('crosshair-price-bg').setAttribute('x', labelX); $('crosshair-price-bg').setAttribute('y', y - 9);
  $('crosshair-price').setAttribute('x', labelX + 41); $('crosshair-price').setAttribute('y', y + 4);
  $('crosshair-price').textContent = money(chart.priceAt(y));
  const timeX = Math.max(0, Math.min(560, x - 100));
  $('crosshair-time-bg').setAttribute('x', timeX); $('crosshair-time').setAttribute('x', timeX + 100);
  $('crosshair-time').textContent = new Date(bar.t).toLocaleString();
  const parts = [time(bar.t), `O ${money(bar.o)}`, `H ${money(bar.h)}`, `L ${money(bar.l)}`, `C ${money(bar.c)}`, `Volume ${bar.v == null ? 'unavailable' : quantity(bar.v)}`];
  chart.lines.forEach(line => parts.push(`SMA ${line.period} ${money(line.values[i])}`));
  if (bar.provisional) parts.push('Live close · OHLC/volume awaiting broker bar');
  $('chart-readout').textContent = parts.join(' · ');
  $('chart').setAttribute('aria-label', `${selected.symbol} ${range}: ${parts.join(', ')}. Use left and right arrows to inspect bars.`);
}
function clearChartCursor() {
  chartCursor = null; $('chart-crosshair').setAttribute('visibility', 'hidden');
  $('chart-readout').textContent = 'Hover, tap, or focus the chart and use ← / → to inspect a bar.';
}
function renderChart() {
  const periods = [20, 50].filter(period => $(`chart-ma${period}`).checked);
  const chart = TradeChart.model(currentBars, {averages: periods}); chartModel = chart;
  const bars = chart.bars, values = bars.map(bar => bar.c), path = TradeChart.path(values, chart);
  $('chart-line').setAttribute('d', path);
  const hasCandles = bars.some(bar => bar.o != null), candles = chartType === 'candles' && hasCandles;
  $('chart-line').setAttribute('visibility', candles ? 'hidden' : 'visible');
  $('chart-area').setAttribute('d', !candles && bars.length ? `${path} L${chart.x(bars.length - 1)},204 L${chart.x(0)},204 Z` : '');
  const candleRoot = $('chart-candles'), volumes = $('chart-volumes'), averages = $('chart-averages');
  candleRoot.replaceChildren(); volumes.replaceChildren(); averages.replaceChildren();
  const width = Math.max(.35, Math.min(12, 760 / Math.max(1, bars.length) * .7));
  bars.forEach((bar, i) => {
    const x = chart.x(i), color = (bar.o == null ? i === 0 || bar.c >= bars[i - 1].c : bar.c >= bar.o) ? '#168768' : '#c26655';
    if (candles && bar.o != null) {
      candleRoot.append(svgElement('path', {d: `M${x},${chart.y(bar.h)}V${chart.y(bar.l)}`, stroke: color, 'vector-effect': 'non-scaling-stroke'}));
      candleRoot.append(svgElement('rect', {x: x - width / 2, y: Math.min(chart.y(bar.o), chart.y(bar.c)), width, height: Math.max(.9, Math.abs(chart.y(bar.o) - chart.y(bar.c))), fill: color}));
    } else if (candles) {
      candleRoot.append(svgElement('circle', {cx: x, cy: chart.y(bar.c), r: 1.8, fill: color}));
    }
    if ($('chart-volume').checked && bar.v != null) {
      const height = bar.v / chart.maxVolume * 48;
      volumes.append(svgElement('rect', {x: x - width / 2, y: 280 - height, width, height, fill: color, opacity: .45}));
    }
  });
  chart.lines.forEach(line => averages.append(svgElement('path', {d: TradeChart.path(line.values, chart), fill: 'none', stroke: line.period === 20 ? '#bd8c32' : '#7d73b2', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke'})));
  const notes = ['SMA 20 / 50 use bar closes; each needs that many bars.'];
  if (chartType === 'candles' && !hasCandles && bars.length) notes.push('OHLC unavailable: showing closing-price line.');
  else if (candles && bars.some(bar => bar.o == null)) notes.push('Dots mark closes with incomplete OHLC.');
  if ($('chart-volume').checked) notes.push(bars.some(bar => bar.v != null) ? 'Volume scaled separately below prices.' : 'Volume unavailable for these bars.');
  if (bars.some(bar => bar.provisional)) notes.push('Live closes are provisional; complete OHLC and volume arrive with broker bars.');
  if (chart.truncated) notes.push('Showing the most recent 1,500 bars.');
  $('chart-indicator-note').textContent = notes.join(' ');
  $('chart-empty').hidden = !!bars.length;
  $('chart-empty').textContent = STOCKS.length ? 'No historical bars available for this range.' : 'Your watchlist is empty. Add a stock to see its chart.';
  $('chart').setAttribute('aria-label', `${selected.name} ${range} ${candles ? 'candlestick' : 'line'} chart. Use left and right arrows to inspect bars. Feed timestamps and delay status are shown below.`);
  $('axis-high').textContent = bars.length ? chart.high.toFixed(2) : '';
  $('axis-mid').textContent = bars.length ? ((chart.high + chart.low) / 2).toFixed(2) : '';
  $('axis-low').textContent = bars.length ? chart.low.toFixed(2) : '';
  const marks = bars.length ? [0, Math.floor((bars.length - 1) / 2), bars.length - 1] : [];
  $('chart-times').replaceChildren(...marks.map(index => element('span', new Date(bars[index].t).toLocaleString(undefined, range === '1D' ? {hour: 'numeric', minute: '2-digit'} : {month: 'short', day: 'numeric'}))));
  if (chartCursor != null && bars.length) inspectChart(chartCursor); else clearChartCursor();
}
function pointChart(event) {
  if (!chartModel?.bars.length) return;
  const box = $('chart').getBoundingClientRect();
  if (!box.width || !box.height) return;
  inspectChart(chartModel.nearest((event.clientX - box.left) / box.width * 760), (event.clientY - box.top) / box.height * 300);
}
$('chart').addEventListener('pointermove', pointChart);
$('chart').addEventListener('pointerdown', pointChart);
$('chart').addEventListener('pointerleave', clearChartCursor);
$('chart').addEventListener('focus', () => { if (chartModel?.bars.length) inspectChart(chartModel.bars.length - 1); });
$('chart').addEventListener('blur', clearChartCursor);
$('chart').addEventListener('keydown', event => {
  if (!chartModel?.bars.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') { clearChartCursor(); return; }
  const i = chartCursor ?? chartModel.bars.length - 1;
  inspectChart(event.key === 'Home' ? 0 : event.key === 'End' ? chartModel.bars.length - 1 : i + (event.key === 'ArrowLeft' ? -1 : 1));
});
document.querySelectorAll('[data-chart-type]').forEach(button => button.addEventListener('click', () => {
  chartType = button.dataset.chartType;
  document.querySelectorAll('[data-chart-type]').forEach(item => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
  renderChart();
}));
['chart-volume', 'chart-ma20', 'chart-ma50'].forEach(id => $(id).addEventListener('change', renderChart));
async function loadSelected() {
  if (!STOCKS.some(stock => stock.symbol === selected.symbol)) return;
  const epoch = ++selectionEpoch, symbol = selected.symbol, period = range;
  const results = await Promise.allSettled([api(`/api/market/${symbol}/quote`), api(`/api/market/${symbol}/bars?period=${period}`)]);
  if (epoch !== selectionEpoch) return;
  if (results[0].status === 'fulfilled') saveSnapshot(symbol, results[0].value);
  else { message(results[0].reason.message, true); }
  if (results[1].status === 'fulfilled') {
    currentBars = results[1].value.bars || [];
    if (period === '1D') mergeLiveBars(symbol);
    const delay = results[1].value.delay_minutes || 0;
    $('chart-data-note').textContent = results[1].value.source === 'Yahoo Finance' ? 'Yahoo Finance · may be delayed · refreshed every 10 seconds' : `${delay ? `Historical bars · ≥${delay} min delay` : period === '1D' ? '1-minute bars · live trade updates' : 'Historical bars · current feed'}${results[1].value.next_page_token ? ' · truncated' : ''}`;
  } else { currentBars = []; $('chart-data-note').textContent = results[1].reason.message; }
  renderQuote(); renderChart(); renderWatchlist();
}
function selectStock(symbol) {
  selected = STOCKS.find(stock => stock.symbol === symbol) || STOCKS[0] || DEFAULT_STOCKS[0];
  const index = STOCKS.findIndex(stock => stock.symbol === selected.symbol);
  const nextPage = index >= 0 ? Math.floor(index / WATCHLIST_PAGE_SIZE) : 0;
  if (watchlistPage !== nextPage) {
    watchlistPage = nextPage; renderStockSelectors(); renderWatchlist(); restartWatchlistStream(); refreshPagePrices();
  }
  $('symbol').value = selected.symbol;
  window.dispatchEvent(new window.Event('trade-stock-changed'));
  document.querySelectorAll('[data-stock]').forEach(button => { const active = button.dataset.stock === symbol; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  currentBars = []; clearChartCursor(); renderQuote(); renderChart();
  if (marketConnected || connected) loadSelected();
}
function renderWatchlist() {
  renderPageControls();
  $('watchlist-count').textContent = STOCKS.length;
  const body = $('watchlist-body'); body.replaceChildren();
  if (!STOCKS.length) {
    const row = element('tr'), cell = element('td', 'Your watchlist is empty. Use Add stocks to start.'); cell.colSpan = 5; row.append(cell); body.append(row);
  }
  pageStocks().forEach(stock => {
    const quote = quotes[stock.symbol], row = element('tr'), asset = element('div', null, 'asset-cell');
    const name = element('div', null, 'asset-name'); name.append(element('strong', stock.symbol), element('small', stock.name));
    asset.append(element('span', stock.icon, 'asset-icon'), name);
    const change = quote?.change_pct == null ? null : Number(quote.change_pct);
    const timestamp = element('span', quote ? new Date(quote.timestamp).toLocaleTimeString() : '—');
    if (quote) timestamp.append(element('small', quote.timing_verified === false ? 'May be delayed' : quoteDelayed(quote) ? 'Delayed / stale' : quote.coverage, 'quote-state'));
    const action = element('button', '↗', 'trade-link'); action.type = 'button'; action.setAttribute('aria-label', `Trade ${stock.symbol}`);
    action.addEventListener('click', () => { selectStock(stock.symbol); $('order-form').scrollIntoView({behavior: 'smooth', block: 'center'}); $('quantity').focus({preventScroll: true}); });
    const actions = element('div', null, 'watchlist-actions');
    const remove = element('button', '×', 'remove-stock'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${stock.symbol} from watchlist`); remove.dataset.removeStock = stock.symbol;
    remove.addEventListener('click', () => removeStock(stock.symbol)); actions.append(action, remove);
    [asset, money(quote?.price), change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, timestamp, actions].forEach((value, index) => {
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
  apiStatus.lastQuoteReceived = new Date().toISOString();
  receiveAlertQuote(symbol, snapshot);
  if (!STOCKS.some(stock => stock.symbol === symbol)) return;
  const existing = quotes[symbol];
  if (!existing || new Date(snapshot.timestamp) >= new Date(existing.timestamp)) quotes[symbol] = snapshot;
  else if (snapshot.previous_close) {
    existing.previous_close = snapshot.previous_close;
    existing.change_pct = (Number(existing.price) / Number(snapshot.previous_close) - 1) * 100;
  }
}
function mergeLiveBars(symbol) {
  const merged = new Map(currentBars.filter(bar => Number.isFinite(TradeChart.timestamp(bar.t))).map(bar => { const t = new Date(TradeChart.timestamp(bar.t)).toISOString(); return [t, {...bar, t}]; }));
  const first = currentBars.length ? TradeChart.timestamp(currentBars[0].t) : Date.now() - 86400000;
  for (const bar of liveBars.get(symbol)?.values() || []) {
    if (TradeChart.timestamp(bar.t) >= first) merged.set(bar.t, bar);
  }
  currentBars = [...merged.values()].sort((a, b) => new Date(a.t) - new Date(b.t)).slice(-1500);
}
function rememberLiveBar(symbol, bar, source) {
  const stamp = TradeChart.timestamp(bar.t);
  if (!Number.isFinite(stamp) || !Number.isFinite(Number(bar.c)) || Number(bar.c) <= 0) return;
  const key = new Date(Math.floor(stamp / 60000) * 60000).toISOString();
  if (!liveBars.has(symbol)) liveBars.set(symbol, new Map());
  const cache = liveBars.get(symbol), old = cache.get(key);
  // Completed/updated broker bars may correct the close; older trade ticks must not replace newer ticks.
  if (source === 'trade' && old && old._tradeTime > stamp) return;
  if (source === 'bar') {
    const corrected = {...bar, t: key, c: Number(bar.c), _tradeTime: old?._tradeTime || stamp};
    cache.set(key, corrected);
  } else {
    // A trade tick supplies only a provisional close. Do not invent a candle or volume.
    cache.set(key, {t: key, c: Number(bar.c), _tradeTime: stamp, _provisional: true});
  }
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
    apiStatus.lastQuoteReceived = new Date().toISOString();
    receiveAlertQuote(event.symbol, event);
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
  if (!STOCKS.length || !streamSupported || !connected || configurationBlocked || streamTerminal || streamController || document.hidden) return;
  const generation = ++streamGeneration, controller = new AbortController();
  streamController = controller; streamState = 'connecting'; renderStreamStatus('');
  const connectTimeout = setTimeout(() => controller.abort(), 15000);
  let idleTimeout;
  const headers = {'Accept': 'text/event-stream'};
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  try {
    const response = await fetch(`${apiBase}/api/market/stream?symbols=${encodeURIComponent(pageStocks().map(stock => stock.symbol).join(','))}`,  {headers, signal: controller.signal, cache: 'no-store', credentials: 'omit'});
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
      const quotesResult = await Promise.allSettled(pageStocks().map(async stock => {
        const quote = await api(`/api/market/${stock.symbol}/quote`); saveSnapshot(stock.symbol, quote);
      }));
      renderWatchlist(); await loadSelected();
      if (quotesResult.length && quotesResult.every(result => result.status === 'rejected')) throw quotesResult[0].reason;
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
      await Promise.allSettled(pageStocks().map(async stock => { try { saveSnapshot(stock.symbol, await api(`/api/market/${stock.symbol}/quote`)); } catch { /* Retain timestamped values until the next refresh or stream event. */ } }));
      renderWatchlist(); await loadSelected(); startMarketStream();
    }
  } catch (error) { connected = false; banner(error.message, true); }
  finally { refreshing = false; $('refresh-data').disabled = false; $('refresh-market').disabled = false; updateEstimate(); }
}

async function refreshMarketPrices() {
  if (refreshing || configurationBlocked || document.hidden || !(marketConnected || connected)) return;
  refreshing = true;
  $('refresh-data').disabled = true; $('refresh-market').disabled = true;
  try {
    await Promise.allSettled([refreshPagePrices(), loadSelected()]);
  } finally {
    refreshing = false;
    $('refresh-data').disabled = false; $('refresh-market').disabled = false;
  }
}

function renderStockSelectors() {
  renderPageControls();
  $('stock-tabs').replaceChildren(); $('symbol').replaceChildren();
  pageStocks().forEach(stock => {
    const tab = element('button', stock.symbol); tab.type = 'button'; tab.dataset.stock = stock.symbol;
    tab.classList.toggle('selected', stock.symbol === selected.symbol); tab.setAttribute('aria-pressed', String(stock.symbol === selected.symbol));
    tab.addEventListener('click', () => selectStock(stock.symbol)); $('stock-tabs').append(tab);
  });
  STOCKS.forEach(stock => {
    const option = element('option', `${stock.symbol} · ${stock.name}`); option.value = stock.symbol; $('symbol').append(option);
  });
  $('symbol').disabled = !STOCKS.length; $('symbol').value = STOCKS.length ? selected.symbol : '';
  $('new-price-alert').disabled = !STOCKS.length; $('create-selected-alert').disabled = !STOCKS.length;
}
function persistWatchlist(action) {
  const saved = storage.set(WATCHLIST_KEY, JSON.stringify(STOCKS.map(({symbol, name}) => ({symbol, name}))));
  $('watchlist-status').textContent = `${action} ${saved ? 'Saved in this browser.' : 'Browser storage is unavailable; changes last only for this session.'}`;
}
function restartWatchlistStream() {
  stopMarketStream(); streamTerminal = false;
  if (connected && STOCKS.length) startMarketStream();
}
function addStock(value) {
  const stock = validStock(value);
  if (!stock || STOCKS.some(item => item.symbol === stock.symbol)) return;
  if (STOCKS.length >= MAX_WATCHLIST) { $('stock-search-status').textContent = `Your watchlist has ${MAX_WATCHLIST} listings. Remove one before adding another.`; return; }
  const previousPage = watchlistPage;
  STOCKS.push(stock); watchlistPage = Math.floor((STOCKS.length - 1) / WATCHLIST_PAGE_SIZE); persistWatchlist(`Added ${stock.symbol}.`);
  renderStockSelectors(); renderWatchlist(); selectStock(stock.symbol); renderSearchResults(); restartWatchlistStream();
  if (previousPage !== watchlistPage) refreshPagePrices();
  $('stock-search-status').textContent = `Added ${stock.symbol}. ${STOCKS.length} of ${MAX_WATCHLIST} slots used.`;
}
function removeStock(symbol) {
  const index = STOCKS.findIndex(stock => stock.symbol === symbol);
  if (index < 0) return;
  STOCKS.splice(index, 1); delete quotes[symbol]; liveBars.delete(symbol); selectionEpoch++;
  renderPageControls();
  if (selected.symbol === symbol) selected = pageStocks()[0] || DEFAULT_STOCKS[0];
  if (!STOCKS.length) { currentBars = []; quotes = {}; }
  renderStockSelectors(); renderWatchlist(); selectStock(selected.symbol); renderSearchResults();
  persistWatchlist(`Removed ${symbol}.`); restartWatchlistStream();
  if (STOCKS.length > WATCHLIST_PAGE_SIZE) refreshPagePrices();
}
function renderSearchResults() {
  const root = $('stock-results'); root.replaceChildren();
  searchResults.forEach(stock => {
    const row = element('div', null, 'stock-result'); row.setAttribute('role', 'listitem');
    const details = element('div'); details.append(element('strong', stock.symbol), element('span', stock.name), element('small', stock.exchange || 'US equity'));
    const exists = STOCKS.some(item => item.symbol === stock.symbol);
    const button = element('button', exists ? 'Added' : 'Add', 'secondary-button'); button.type = 'button'; button.dataset.addStock = stock.symbol;
    button.disabled = exists || STOCKS.length >= MAX_WATCHLIST; button.setAttribute('aria-label', `${exists ? 'Already watching' : 'Add'} ${stock.symbol}`);
    button.addEventListener('click', () => addStock(stock));
    const actions = element('div', null, 'stock-result-actions'); actions.append(button);
    if (exists) {
      const view = element('button', 'View', 'secondary-button'); view.type = 'button'; view.dataset.viewStock = stock.symbol;
      view.addEventListener('click', () => { selectStock(stock.symbol); $('stock-dialog').close(); }); actions.append(view);
    }
    row.append(details, actions); root.append(row);
  });
}
async function searchStocks() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  const epoch = ++searchEpoch, query = $('stock-query').value.trim();
  if (!query || query.length > 60) { searchResults = []; renderSearchResults(); $('stock-search-status').textContent = 'Enter a symbol or company name (up to 60 characters).'; return; }
  searchResults = []; renderSearchResults();
  $('stock-search-status').textContent = 'Searching US stocks and ETFs…'; $('search-stocks').disabled = true;
  try {
    const data = await api(`/api/stocks/search?q=${encodeURIComponent(query)}`);
    if (epoch !== searchEpoch) return;
    searchResults = (data.results || []).map(row => { const stock = validStock(row); return stock ? {...stock, exchange: row.exchange} : null; }).filter(Boolean);
    renderSearchResults();
    $('stock-search-status').textContent = searchResults.length ? `${searchResults.length} results · ${data.source || 'market data'} · ${STOCKS.length}/${MAX_WATCHLIST} saved` : 'No matching US stocks or ETFs. Try another name or ticker.';
  } catch (error) {
    if (epoch !== searchEpoch) return;
    searchResults = []; renderSearchResults(); $('stock-search-status').textContent = error.message;
  } finally { if (epoch === searchEpoch) $('search-stocks').disabled = false; }
}
async function addSP500() {
  if (bulkAdding) return;
  bulkAdding = true; $('add-sp500').disabled = true; $('add-sp500-dialog').disabled = true;
  $('watchlist-status').textContent = 'Loading S&P 500 company listings…';
  $('stock-search-status').textContent = 'Loading S&P 500 company listings…';
  try {
    const data = await api('/api/stocks/sp500');
    const incoming = (data.results || []).map(validStock).filter(Boolean);
    const existing = new Set(STOCKS.map(stock => stock.symbol)), additions = [];
    for (const stock of incoming) { if (!existing.has(stock.symbol)) { additions.push(stock); existing.add(stock.symbol); } }
    if (incoming.length < 400 || incoming.length > 600) throw new Error('The membership list is incomplete. Your watchlist has not been changed.');
    if (STOCKS.length + additions.length > MAX_WATCHLIST) throw new Error(`The complete list would exceed ${MAX_WATCHLIST} saved listings. Remove some stocks before adding the S&P 500.`);
    STOCKS.push(...additions); watchlistPage = 0;
    selected = pageStocks().some(stock => stock.symbol === selected.symbol) ? selected : pageStocks()[0];
    selectionEpoch++; currentBars = [];
    renderStockSelectors(); renderWatchlist(); renderSearchResults(); selectStock(selected.symbol); restartWatchlistStream();
    persistWatchlist(`Added ${additions.length} S&P 500 listings; ${STOCKS.length} saved. Prices load ${WATCHLIST_PAGE_SIZE} per page.`);
    $('stock-search-status').textContent = `${data.count} source listings · ${data.source} · fetched ${time(data.fetched_at)}. Multiple share classes can make the total exceed 500.`;
    refreshPagePrices();
  } catch (error) {
    $('watchlist-status').textContent = error.message; $('stock-search-status').textContent = error.message;
  } finally { bulkAdding = false; $('add-sp500').disabled = false; $('add-sp500-dialog').disabled = false; }
}
$('add-sp500').addEventListener('click', addSP500);
$('add-sp500-dialog').addEventListener('click', addSP500);
$('watchlist-prev').addEventListener('click', () => setWatchlistPage(watchlistPage - 1));
$('watchlist-next').addEventListener('click', () => setWatchlistPage(watchlistPage + 1));
$('watchlist-page-select').addEventListener('change', event => setWatchlistPage(event.target.value));
$('open-stock-search').addEventListener('click', () => { $('stock-dialog').showModal(); $('stock-query').focus(); renderSearchResults(); });
$('close-stock-search').addEventListener('click', () => $('stock-dialog').close());
$('stock-dialog').addEventListener('close', () => { searchEpoch++; if (searchTimer) clearTimeout(searchTimer); searchTimer = null; $('search-stocks').disabled = false; });
$('stock-search-form').addEventListener('submit', event => { event.preventDefault(); searchStocks(); });
$('stock-query').addEventListener('input', () => {
  searchEpoch++; if (searchTimer) clearTimeout(searchTimer);
  if (!$('stock-query').value.trim()) { searchResults = []; renderSearchResults(); $('stock-search-status').textContent = 'Enter a symbol or company name to search.'; $('search-stocks').disabled = false; return; }
  searchTimer = setTimeout(searchStocks, 350);
});
renderStockSelectors();
$('symbol').addEventListener('change', event => selectStock(event.target.value));
['quantity', 'limit-price'].forEach(id => $(id).addEventListener('input', updateEstimate));
$('order-type').addEventListener('change', updateEstimate);
document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => { range = button.dataset.range; currentBars = []; clearChartCursor(); renderChart(); document.querySelectorAll('[data-range]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); }); if (marketConnected || connected) loadSelected(); }));
document.querySelectorAll('[data-side]').forEach(button => button.addEventListener('click', () => { side = button.dataset.side; document.querySelectorAll('[data-side]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); }); message(''); updateEstimate(); }));
$('order-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!STOCKS.length || pendingReview || submitting || !connected) return;
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
function alertLabel(alert) { return `${alert.symbol} at or ${alert.condition} ${alertMoney(alert.target)}`; }
function alertQuoteText(quote) {
  const delayed = quote.delayed || quote.timing_verified === false;
  return `${alertMoney(quote.price)} · quote ${time(TradePriceAlerts.quoteStamp(quote.timestamp)?.ms ?? quote.timestamp)} · ${quote.source}${delayed ? ' · may be delayed / stale' : ''}`;
}
function renderPriceAlerts() {
  $('price-alert-count').textContent = priceAlerts.alerts.length;
  const activeSymbols = priceAlerts.activeSymbols(), failed = activeSymbols.filter(symbol => alertQuoteFailures.has(symbol));
  $('alerts-monitor-status').textContent = !activeSymbols.length ? 'No active price alerts.'
    : !(marketConnected || connected) || configurationBlocked ? `Waiting for a data connection to monitor ${activeSymbols.length} symbol(s).`
    : failed.length ? `Quotes unavailable for ${failed.join(', ')}. Monitoring will retry; missing prices never trigger an alert.`
    : `Monitoring ${activeSymbols.length} symbol${activeSymbols.length === 1 ? '' : 's'} while this dashboard is open. Quotes are checked about every 10 seconds; visible live updates may notify sooner.`;
  const unreadItems = priceAlerts.notifications.filter(item => !item.read), unread = unreadItems.length;
  const unreadIds = new Set(unreadItems.map(item => item.id));
  [...$('alert-toasts').children].forEach(toast => { if (!unreadIds.has(toast.dataset.notificationId)) toast.remove(); });
  $('notification-count').textContent = unread; $('notification-count').hidden = !unread;
  $('open-notifications').setAttribute('aria-label', `Notifications (${unread} unread)`);
  const root = $('price-alerts-list'); root.replaceChildren();
  if (!priceAlerts.alerts.length) root.append(element('p', 'Choose a stock and target to create your first price alert.', 'empty-state'));
  priceAlerts.alerts.forEach(alert => {
    const row = element('div', null, 'price-alert-row'), details = element('div', null, 'price-alert-details');
    details.append(element('strong', alertLabel(alert)), element('small', alert.lastQuote ? alertQuoteText(alert.lastQuote) : 'Waiting for a first quote to establish a baseline.'));
    const actions = element('div', null, 'price-alert-actions'); actions.append(statusBadge(alert.status));
    const toggle = element('button', alert.status === 'active' ? 'Pause' : alert.status === 'paused' ? 'Resume' : 'Re-arm', 'secondary-button');
    toggle.type = 'button'; toggle.dataset.alertToggle = alert.id;
    const pauseRequested = alert.status === 'active';
    toggle.addEventListener('click', async () => {
      try {
        await mutatePriceAlerts(book => { const current = book.find(alert.id); if (pauseRequested) book.pause(alert.id); else book.arm(alert.id, quotes[current.symbol] || current.lastQuote); });
        $('alerts-action-status').textContent = 'Alert updated.'; monitorAlertPrices();
      } catch (error) { $('alerts-action-status').textContent = error.message; }
    });
    const remove = element('button', 'Delete', 'secondary-button'); remove.type = 'button'; remove.dataset.alertDelete = alert.id;
    remove.addEventListener('click', async () => { await mutatePriceAlerts(book => book.remove(alert.id)); $('alerts-action-status').textContent = 'Alert deleted.'; });
    actions.append(toggle, remove); row.append(details, actions); root.append(row);
  });
  if ($('notifications-dialog').open) renderPriceNotifications();
}
function renderPriceNotifications() {
  const root = $('notification-list'); root.replaceChildren();
  if (!priceAlerts.notifications.length) root.append(element('p', 'No price alerts have triggered yet.', 'empty-state'));
  priceAlerts.notifications.forEach(notification => {
    const row = element('article', null, `price-notification${notification.read ? '' : ' unread'}`);
    const details = element('div'); details.append(element('strong', alertLabel(notification)), element('p', alertQuoteText(notification.quote)), element('small', `Observed ${time(notification.observedAt)}`));
    const actions = element('div', null, 'price-notification-actions');
    if (!notification.read) {
      const read = element('button', 'Mark read', 'text-button'); read.type = 'button'; read.dataset.notificationRead = notification.id;
      read.addEventListener('click', () => mutatePriceAlerts(book => book.markRead(notification.id))); actions.append(read);
    }
    const remove = element('button', 'Remove', 'text-button'); remove.type = 'button'; remove.dataset.notificationDismiss = notification.id;
    remove.addEventListener('click', () => mutatePriceAlerts(book => book.dismiss(notification.id))); actions.append(remove);
    row.append(details, actions); root.append(row);
  });
}
function showPriceToast(notification) {
  if (!priceAlerts.notifications.some(item => item.id === notification.id && !item.read)) return;
  const root = $('alert-toasts'), toast = element('article', null, 'price-alert-toast'); toast.setAttribute('role', 'status'); toast.dataset.notificationId = notification.id;
  toast.append(element('strong', `Price alert: ${alertLabel(notification)}`), element('p', alertQuoteText(notification.quote)));
  const close = element('button', 'Dismiss', 'text-button'); close.type = 'button'; close.setAttribute('aria-label', `Dismiss ${notification.symbol} price alert`);
  close.addEventListener('click', () => { toast.remove(); mutatePriceAlerts(book => book.markRead(notification.id)); }); toast.append(close); root.append(toast);
  while (root.children.length > 3) root.firstElementChild.remove();
}
async function mutatePriceAlerts(change, render = true) {
  const run = () => {
    const saved = storage.get(PRICE_ALERTS_KEY);
    if (saved && saved !== alertsSavedRaw) { priceAlerts = new TradePriceAlerts.AlertBook(saved); alertsSavedRaw = saved; }
    const before = priceAlerts.serialize(), result = change(priceAlerts), after = priceAlerts.serialize();
    if (before !== after) {
      const persisted = storage.set(PRICE_ALERTS_KEY, after); alertsStorageFailed = !persisted;
      if (persisted) alertsSavedRaw = after;
      else $('alerts-action-status').textContent = 'Browser storage is unavailable. Alerts and notifications will last only for this session.';
    }
    if (render || (Array.isArray(result) && result.length)) renderPriceAlerts();
    return result;
  };
  // Serialize read/modify/write across same-origin tabs when Web Locks are available.
  if (globalThis.navigator?.locks?.request) return globalThis.navigator.locks.request(PRICE_ALERTS_KEY, run);
  return run();
}
function receiveAlertQuote(symbol, quote) {
  if (TradePriceAlerts.quoteStamp(quote?.timestamp) && Number.isFinite(Number(quote?.price)) && Number(quote.price) > 0) alertQuoteFailures.delete(symbol);
  if (!priceAlerts.activeSymbols().includes(symbol)) return;
  mutatePriceAlerts(book => book.accept(symbol, quote), false).then(notifications => notifications.forEach(showPriceToast)).catch(error => { $('alerts-action-status').textContent = error.message; });
}
async function monitorAlertPrices() {
  if (alertsMonitoring || configurationBlocked || !(marketConnected || connected)) return;
  const active = priceAlerts.activeSymbols();
  if (!active.length) { $('alerts-monitor-status').textContent = 'No active price alerts.'; return; }
  const symbols = active;
  $('alerts-monitor-status').textContent = `Monitoring ${active.length} symbol${active.length === 1 ? '' : 's'} while this dashboard is open. Quotes are checked about every 10 seconds; visible live updates may notify sooner.`;
  if (!symbols.length) return;
  alertsMonitoring = true;
  const origin = apiBase;
  try {
    const results = await Promise.allSettled(symbols.map(async symbol => {
      const quote = await api(`/api/market/${symbol}/quote`, {base: origin});
      if (origin === apiBase) saveSnapshot(symbol, quote);
    }));
    if (origin === apiBase) { results.forEach((result, index) => { if (result.status === 'rejected') alertQuoteFailures.add(symbols[index]); }); renderPriceAlerts(); }
  } finally { alertsMonitoring = false; }
}
async function loadAlertReference() {
  const epoch = ++alertReferenceEpoch, symbol = $('alert-symbol').value, origin = apiBase;
  alertReference = null;
  if (!symbol) return;
  const existing = quotes[symbol];
  if (existing) { alertReference = {symbol, quote: existing}; $('alert-reference-price').textContent = `Reference: ${alertMoney(existing.price)} · quote ${time(existing.timestamp)}. A newer quote is required to trigger.`; }
  else $('alert-reference-price').textContent = 'Loading a reference quote. The first available quote establishes a baseline.';
  if (!(marketConnected || connected)) return;
  try {
    const quote = await api(`/api/market/${symbol}/quote`, {base: origin});
    if (epoch !== alertReferenceEpoch || origin !== apiBase) return;
    alertReference = {symbol, quote}; saveSnapshot(symbol, quote);
    $('alert-reference-price').textContent = `Reference: ${alertMoney(quote.price)} · quote ${time(quote.timestamp)}. A newer quote is required to trigger.`;
  } catch { if (epoch === alertReferenceEpoch) $('alert-reference-price').textContent = 'A reference quote is unavailable. Monitoring will establish a baseline when data returns.'; }
}
function openPriceAlert(symbol = selected.symbol) {
  if (!STOCKS.length) { $('alerts-action-status').textContent = 'Add a stock to your watchlist before creating an alert.'; return; }
  $('alert-symbol').replaceChildren(...STOCKS.map(stock => { const option = element('option', `${stock.symbol} · ${stock.name}`); option.value = stock.symbol; return option; }));
  $('alert-symbol').value = STOCKS.some(stock => stock.symbol === symbol) ? symbol : STOCKS[0].symbol;
  $('alert-condition').value = 'above'; $('alert-target').value = ''; $('price-alert-error').textContent = '';
  $('price-alert-dialog').showModal(); loadAlertReference();
}
$('new-price-alert').addEventListener('click', () => openPriceAlert());
$('create-selected-alert').addEventListener('click', () => openPriceAlert());
$('alert-symbol').addEventListener('change', loadAlertReference);
$('cancel-price-alert').addEventListener('click', () => { alertReferenceEpoch++; $('price-alert-dialog').close(); });
function latestAlertBaseline(symbol, book) {
  const candidates = [quotes[symbol], alertReference?.symbol === symbol ? alertReference.quote : null,
    ...book.alerts.filter(alert => alert.symbol === symbol).map(alert => alert.lastQuote)];
  return candidates.filter(quote => TradePriceAlerts.quoteStamp(quote?.timestamp))
    .sort((a, b) => TradePriceAlerts.quoteStamp(b.timestamp).key.localeCompare(TradePriceAlerts.quoteStamp(a.timestamp).key))[0];
}
$('price-alert-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-price-alert').disabled = true;
  try {
    const symbol = $('alert-symbol').value, stock = STOCKS.find(item => item.symbol === symbol);
    if (!stock) throw new Error('Select a stock from your watchlist.');
    const rule = {symbol, name: stock.name, condition: $('alert-condition').value, target: $('alert-target').value};
    await mutatePriceAlerts(book => book.add(rule, latestAlertBaseline(symbol, book)));
    $('price-alert-dialog').close(); alertReferenceEpoch++;
    $('alerts-action-status').textContent = alertsStorageFailed ? 'Alert created for this session only; browser storage is unavailable.' : 'Alert saved. Waiting for a newer quote that meets your target.';
    monitorAlertPrices();
  } catch (error) { $('price-alert-error').textContent = error.message; }
  finally { $('save-price-alert').disabled = false; }
});
$('open-notifications').addEventListener('click', () => { renderPriceNotifications(); $('notifications-dialog').showModal(); });
$('close-notifications').addEventListener('click', () => $('notifications-dialog').close());
$('mark-notifications-read').addEventListener('click', () => mutatePriceAlerts(book => book.markRead()));
window.addEventListener('storage', event => {
  if (event.key === PRICE_ALERTS_KEY || event.key === null) { alertsSavedRaw = event.newValue || ''; priceAlerts = new TradePriceAlerts.AlertBook(alertsSavedRaw); renderPriceAlerts(); }
});
renderPriceAlerts();
setInterval(monitorAlertPrices, MARKET_REFRESH_MS);
function apiOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter only the API origin, without credentials, paths, or query parameters.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for remote APIs. HTTP is supported only on localhost.');
  return url.origin;
}
function connectionCheckRow(name, check) {
  const labels = {connected: 'Connected', delayed: 'Check timing', not_configured: 'Optional', disabled: 'Disabled', error: 'Needs attention', unauthorized: 'Access denied', blocked: 'Restricted', checking: 'Checking…', not_checked: 'Not checked'};
  const state = Object.hasOwn(labels, check.status) ? check.status : 'not_checked';
  $(`check-${name}`).dataset.state = state;
  $(`check-${name}-badge`).textContent = labels[state];
  $(`check-${name}-message`).textContent = check.message || '';
  $(`check-${name}-action`).textContent = check.action || '';
}
function showConnectionReport(report) {
  connectionCheckRow('server', report.server);
  connectionCheckRow('market', report.market_data);
  connectionCheckRow('account', report.paper_account);
  const pricesReady = ['connected', 'delayed'].includes(report.market_data.status);
  const paperReady = report.paper_account.status === 'connected';
  $('connection-summary').textContent = `${pricesReady ? 'Market prices are available.' : 'Market data needs attention.'} ${paperReady ? 'The paper account is connected.' : 'You can browse available prices while the paper account is disconnected.'}`;
}
async function checkConnection(force = true) {
  if (connectionChecking) return null;
  connectionChecking = true;
  $('test-connection').disabled = true; $('save-connection').disabled = true;
  $('connection-error').textContent = '';
  try {
    const origin = apiOrigin($('api-url').value), token = $('api-token').value.trim();
    if (!force && lastConnectionCheck?.origin === origin && lastConnectionCheck.token === token && Date.now() - lastConnectionCheck.checkedAt < 30000) return lastConnectionCheck;
    ['server', 'market', 'account'].forEach(name => connectionCheckRow(name, {status: 'checking', message: 'Checking read access…'}));
    $('connection-summary').textContent = 'Checking the server and data sources. No orders will be submitted.';
    const report = await api('/api/connection', {base: origin, accessToken: token});
    if (report.service !== 'trade-paper-api' || !report.server || !report.market_data || !report.paper_account) throw new Error('This address is not a compatible Trade API. Pull the latest code, stop the old server, and run ./start.command.');
    showConnectionReport(report);
    lastConnectionCheck = {origin, token, report, checkedAt: Date.now()};
    return lastConnectionCheck;
  } catch (error) {
    lastConnectionCheck = null;
    connectionCheckRow('server', {status: error.status === 401 ? 'unauthorized' : 'error', message: error.message,
      action: error.status === 401 ? 'Enter API_ACCESS_TOKEN from the server environment. This is not an Alpaca key.' : 'Start ./start.command, then open its printed browser address. For a hosted frontend, verify the API’s allowed origin.'});
    ['market', 'account'].forEach(name => connectionCheckRow(name, {status: 'not_checked', message: 'Connect to the API before checking this step.'}));
    $('connection-summary').textContent = 'Connection settings have not been saved. Fix the server address or access token and retry.';
    $('connection-error').textContent = error.message;
    return null;
  } finally {
    connectionChecking = false; $('test-connection').disabled = false; $('save-connection').disabled = false;
  }
}
$('connect-api').addEventListener('click', () => {
  $('api-url').value = apiBase; $('api-token').value = apiToken; $('connection-error').textContent = '';
  if (lastConnectionCheck?.origin === apiBase && lastConnectionCheck.token === apiToken) showConnectionReport(lastConnectionCheck.report);
  $('connection-dialog').showModal();
});
$('test-connection').addEventListener('click', () => checkConnection());
$('use-local-api').addEventListener('click', () => {
  $('api-url').value = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(location.origin).hostname) ? location.origin : 'http://127.0.0.1:8000'; $('api-token').value = ''; lastConnectionCheck = null;
  $('connection-error').textContent = ''; $('connection-summary').textContent = 'Local server selected. Run ./start.command and click Check connection.';
  ['server', 'market', 'account'].forEach(name => connectionCheckRow(name, {status: 'not_checked', message: 'Run the connection check.'}));
});
$('close-connection').addEventListener('click', () => $('connection-dialog').close());
$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (submitting || refreshing || connectionChecking) throw new Error('Wait for the current request to finish before changing connections.');
    const checked = await checkConnection(false);
    if (!checked) return;
    stopMarketStream(); streamTerminal = false; liveBars.clear();
    selectionEpoch++; alertReferenceEpoch++;
    apiBase = checked.origin; apiToken = checked.token; quotes = {}; account = null; connected = false; marketConnected = false;
    lastRefresh = null; currentBars = [];
    ['equity', 'cash', 'invested', 'buying-power', 'realized-pl', 'unrealized-pl', 'fill-count'].forEach(id => { $(id).textContent = '—'; });
    ['holdings-content', 'activity-content', 'trades-content'].forEach(id => { $(id).replaceChildren(element('p', 'Connecting to the selected account…', 'empty-state')); });
    $('equity-line').setAttribute('d', ''); renderChart();
    storage.set('trade-api-base', apiBase); storage.set('trade-api-token', apiToken, true);
    apiStatus.lastSuccess = null; apiStatus.lastQuoteReceived = null; apiStatus.lastFailure = null; apiStatus.failures.clear();
    window.dispatchEvent(new window.Event('trade-connection-changed'));
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
  const active = document.querySelector('.nav-link.active'); document.querySelector('.breadcrumb b').textContent = active ? active.textContent.trim().split(/\s+/).slice(1).join(' ') : 'Overview';
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
setInterval(refreshMarketPrices, MARKET_REFRESH_MS);
setInterval(() => { if (!configurationBlocked && !document.hidden && !$('review-dialog').open && !$('connection-dialog').open) refresh(); }, 30000);

window.addEventListener('pagehide', stopMarketStream);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopMarketStream(); else refresh(); });
setInterval(() => { renderQuote(); renderWatchlist(); renderPriceAlerts(); }, 5000);
