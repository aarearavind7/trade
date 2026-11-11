'use strict';

let researchEpoch = 0, fundamentalsEpoch = 0, screenerEpoch = 0, journalEpoch = 0;
let journalOffset = 0, journalEdit = null, journalBusy = false, backupPreview = null;
const percent = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
function researchMoney(value, currency = 'USD') {
  if (value == null || !Number.isFinite(Number(value))) return 'Unavailable';
  try { return new Intl.NumberFormat(undefined, {style: 'currency', currency, maximumFractionDigits: 0}).format(value); }
  catch { return `${quantity(value)} ${currency || 'currency unavailable'}`; }
}
function fact(root, label, value) {
  const item = element('div', null, 'research-fact'); item.append(element('small', label), element('strong', value)); root.append(item);
}
async function loadFundamentals() {
  const epoch = ++fundamentalsEpoch, connection = researchEpoch, symbol = selected.symbol;
  $('fundamentals-symbol').textContent = symbol; $('fundamentals-content').replaceChildren();
  if (!STOCKS.length) { $('fundamentals-status').textContent = 'Add a stock to load its financial statements.'; return; }
  $('fundamentals-status').textContent = 'Loading company financials…'; $('refresh-fundamentals').disabled = true;
  try {
    const data = await api(`/api/research/${encodeURIComponent(symbol)}/fundamentals`);
    if (epoch !== fundamentalsEpoch || connection !== researchEpoch) return;
    const root = $('fundamentals-content');
    fact(root, `Revenue · annual · ${data.income_date || 'period unavailable'}`, researchMoney(data.revenue, data.currency));
    fact(root, 'Net income · annual', researchMoney(data.net_income, data.currency));
    fact(root, 'P/E · trailing 12 months', data.pe_ttm == null ? 'Unavailable' : quantity(data.pe_ttm));
    fact(root, `Total debt · ${data.debt_date || 'period unavailable'}`, researchMoney(data.total_debt, data.currency));
    fact(root, 'Next earnings · next 90 days', data.next_earnings_date || 'Not announced / unavailable');
    fact(root, data.sector || 'Sector unavailable', `Market cap ${researchMoney(data.market_cap, 'USD')}`);
    $('fundamentals-status').textContent = `${data.name} · ${data.source} · retrieved ${time(data.retrieved_at)}. Reported values may use an older fiscal period; earnings dates can change.${data.unavailable_sections?.length ? ' Unavailable sections: ' + data.unavailable_sections.join(', ') + '.' : ''}`;
  } catch (error) { if (epoch === fundamentalsEpoch && connection === researchEpoch) $('fundamentals-status').textContent = error.message; }
  finally { if (epoch === fundamentalsEpoch) $('refresh-fundamentals').disabled = false; }
}
$('refresh-fundamentals').addEventListener('click', loadFundamentals);
window.addEventListener('trade-stock-changed', loadFundamentals);

$('load-benchmark').addEventListener('click', async () => {
  const epoch = researchEpoch; $('load-benchmark').disabled = true;
  $('benchmark-status').textContent = 'Matching portfolio and index market dates…';
  $('benchmark-summary').replaceChildren(); $('benchmark-table').replaceChildren(); $('benchmark-chart').hidden = true;
  try {
    const data = await api('/api/benchmark');
    if (epoch !== researchEpoch) return;
    fact($('benchmark-summary'), 'Portfolio equity change', percent(data.portfolio_return_pct));
    fact($('benchmark-summary'), 'S&P 500 price return', percent(data.benchmark_return_pct));
    const values = data.points.flatMap(row => [row.portfolio_pct, row.benchmark_pct]);
    const low = Math.min(...values), high = Math.max(...values), spread = high - low || 1;
    const path = key => data.points.map((row, index) => `${index ? 'L' : 'M'}${(index * 760 / Math.max(1, data.points.length - 1)).toFixed(2)},${(160 - (row[key] - low) / spread * 140).toFixed(2)}`).join(' ');
    $('benchmark-portfolio').setAttribute('d', path('portfolio_pct')); $('benchmark-index').setAttribute('d', path('benchmark_pct'));
    $('benchmark-chart').hidden = false;
    $('benchmark-svg').setAttribute('aria-label', `${data.start} to ${data.end}: portfolio ${percent(data.portfolio_return_pct)}, S&P 500 ${percent(data.benchmark_return_pct)}.`);
    const details = element('details'); details.append(element('summary', `${data.matched_sessions} matched sessions · ${data.start} to ${data.end}`));
    details.append(table(['Market date', 'Portfolio equity change', 'S&P 500 price change'], data.points.map(row => [row.date, percent(row.portfolio_pct), percent(row.benchmark_pct)]), 'No common market dates.'));
    $('benchmark-table').append(details); $('benchmark-status').textContent = `${data.source} · ${data.note}`;
  } catch (error) { if (epoch === researchEpoch) $('benchmark-status').textContent = error.message; }
  finally { $('load-benchmark').disabled = false; }
});

function resetJournal() {
  journalEdit = null; $('journal-symbol').value = selected.symbol;
  const now = new Date(); $('journal-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  $('journal-state').value = 'planned'; ['thesis', 'expected', 'lessons'].forEach(key => { $(`journal-${key}`).value = ''; });
  $('save-journal').textContent = 'Save new entry'; $('cancel-journal-edit').hidden = true;
}
async function loadJournal() {
  const epoch = ++journalEpoch, connection = researchEpoch;
  $('journal-status').textContent = 'Loading server journal…';
  try {
    const data = await api(`/api/journal?limit=50&offset=${journalOffset}`);
    if (epoch !== journalEpoch || connection !== researchEpoch) return;
    if (journalOffset && !data.entries.length) { journalOffset = Math.max(0, journalOffset - 50); return loadJournal(); }
    const root = $('journal-list'); root.replaceChildren();
    data.entries.forEach(entry => {
      const row = element('article', null, 'journal-entry'); row.append(element('h3', `${entry.symbol} · ${entry.trade_date} · ${entry.status}`));
      for (const [key, label] of [['thesis', 'Reason'], ['expected', 'Expected outcome'], ['lessons', 'Lessons']]) {
        row.append(element('strong', label), element('p', entry[key] || 'No notes yet.'));
      }
      row.append(element('small', `Updated ${time(entry.updated_at)}`));
      const actions = element('div', null, 'research-actions'), edit = element('button', 'Edit', 'text-button'), remove = element('button', 'Delete entry', 'text-button');
      edit.type = remove.type = 'button';
      edit.addEventListener('click', () => {
        if (journalBusy) return;
        journalEdit = entry;
        ['symbol', 'thesis', 'expected', 'lessons'].forEach(key => { $(`journal-${key}`).value = entry[key]; });
        $('journal-date').value = entry.trade_date; $('journal-state').value = entry.status;
        $('save-journal').textContent = 'Save changes'; $('cancel-journal-edit').hidden = false; $('journal-thesis').focus();
      });
      remove.addEventListener('click', async () => {
        if (journalBusy) return;
        journalBusy = true; remove.disabled = true;
        const context = researchEpoch;
        try {
          await api(`/api/journal/${entry.id}?revision=${entry.revision}`, {method: 'DELETE'});
          if (context !== researchEpoch) return;
          if (journalEdit?.id === entry.id) resetJournal();
          await loadJournal(); $('journal-status').textContent = 'Entry deleted from the server journal.';
        } catch (error) { if (context === researchEpoch) $('journal-status').textContent = error.message; }
        finally { journalBusy = false; remove.disabled = false; }
      });
      actions.append(edit, remove); row.append(actions); root.append(row);
    });
    if (!data.entries.length) root.append(element('p', 'No journal entries yet. Record your first trading idea above.', 'research-note'));
    $('journal-prev').disabled = journalOffset === 0; $('journal-next').disabled = journalOffset + data.entries.length >= data.total;
    $('journal-page').textContent = `${data.total ? journalOffset + 1 : 0}–${journalOffset + data.entries.length} of ${data.total}`;
    $('journal-status').textContent = 'Journal loaded from this server.';
  } catch (error) { if (epoch === journalEpoch && connection === researchEpoch) $('journal-status').textContent = error.message; }
}
$('journal-form').addEventListener('submit', async event => {
  event.preventDefault(); if (journalBusy) return;
  journalBusy = true; $('save-journal').disabled = true;
  const epoch = researchEpoch, edit = journalEdit;
  const body = {symbol: $('journal-symbol').value.trim().toUpperCase(), trade_date: $('journal-date').value, status: $('journal-state').value,
    thesis: $('journal-thesis').value.trim(), expected: $('journal-expected').value.trim(), lessons: $('journal-lessons').value.trim()};
  if (edit) body.revision = edit.revision;
  try {
    await api(edit ? `/api/journal/${edit.id}` : '/api/journal', {method: edit ? 'PUT' : 'POST', body});
    if (epoch !== researchEpoch) return;
    resetJournal(); journalOffset = 0; await loadJournal(); $('journal-status').textContent = 'Journal entry saved on the server.';
  } catch (error) { if (epoch === researchEpoch) $('journal-status').textContent = error.message; }
  finally { journalBusy = false; $('save-journal').disabled = false; }
});
$('cancel-journal-edit').addEventListener('click', resetJournal);
$('refresh-journal').addEventListener('click', loadJournal);
$('journal-prev').addEventListener('click', () => { journalOffset = Math.max(0, journalOffset - 50); loadJournal(); });
$('journal-next').addEventListener('click', () => { journalOffset += 50; loadJournal(); });

$('screener-form').addEventListener('submit', async event => {
  event.preventDefault(); const epoch = ++screenerEpoch, connection = researchEpoch, params = new URLSearchParams();
  document.querySelectorAll('#screener-form [name]').forEach(input => { const value = String(input.value || '').trim(); if (value) params.set(input.name, value); });
  $('run-screener').disabled = true; $('screener-status').textContent = 'Screening provider candidates…'; $('screener-results').replaceChildren();
  try {
    const data = await api(`/api/screener?${params}`);
    if (epoch !== screenerEpoch || connection !== researchEpoch) return;
    const rows = data.results.map(row => {
      const add = element('button', 'Watch', 'text-button'); add.type = 'button'; add.setAttribute('aria-label', `Watch ${row.symbol}`);
      add.addEventListener('click', () => addStock(row));
      return [row.symbol, row.name, row.sector || 'Unavailable', money(row.price), row.volume == null ? '—' : quantity(row.volume), researchMoney(row.market_cap), percent(row.change_pct), typeof row.timestamp === 'number' ? time(new Date(row.timestamp * 1000).toISOString()) : 'Unavailable', add];
    });
    $('screener-results').append(table(['Symbol', 'Company', 'Sector', 'Price', 'Volume', 'Market cap', 'Daily change', 'Quote time', ''], rows, 'No candidates match these filters.'));
    $('screener-status').textContent = `${rows.length} results from ${data.candidate_count} candidates · ${data.source} · retrieved ${time(data.retrieved_at)}. ${data.note}`;
  } catch (error) { if (epoch === screenerEpoch && connection === researchEpoch) $('screener-status').textContent = error.message; }
  finally { if (epoch === screenerEpoch) $('run-screener').disabled = false; }
});

function renderDataStatus() {
  const quote = quotes[selected.symbol], root = $('data-status-content'); root.replaceChildren();
  fact(root, 'Provider / selected stock', `${quote?.source || (quote?.feed === 'public' || publicMarketMode ? 'Yahoo Finance' : quote ? 'Alpaca' : 'Awaiting quote')} · ${selected.symbol}`);
  fact(root, 'Exchange coverage', quote?.coverage || 'Unavailable');
  fact(root, 'Feed / timing', `${quote?.feed || 'Unavailable'} · ${quote ? quote.timing_verified === false ? 'Timing unverified' : quoteDelayed(quote) ? 'Delayed / stale' : 'Recent quote' : 'No quote'}`);
  fact(root, 'Selected quote timestamp', quote ? time(quote.timestamp) : 'No quote received');
  fact(root, 'Last quote received by dashboard', time(apiStatus.lastQuoteReceived));
  fact(root, 'Last successful API response', time(apiStatus.lastSuccess));
  fact(root, 'Outstanding failed requests', String(apiStatus.failures.size));
  fact(root, 'Last connection failure', apiStatus.lastFailure ? time(apiStatus.lastFailure.at) : 'None recorded this session');
  $('data-status-errors').textContent = [...apiStatus.failures.values()].map(row => row.message).filter((value, i, all) => all.indexOf(value) === i).join(' · ') || (apiStatus.lastFailure ? 'All previously failed endpoints have since succeeded.' : 'No request failures recorded this session.');
}
$('check-data-connection').addEventListener('click', () => $('connect-api').click());
setInterval(renderDataStatus, 2000);

function currentWorkspace() {
  return {type: 'trade-workspace', version: 1, watchlist: STOCKS.map(({symbol, name}) => ({symbol, name})), price_alerts: JSON.parse(priceAlerts.serialize())};
}
function downloadWorkspace() {
  const payload = TradeBackup.validate(currentWorkspace());
  const url = URL.createObjectURL(new Blob([JSON.stringify({...payload, exported_at: new Date().toISOString()}, null, 2)], {type: 'application/json'}));
  const link = element('a'); link.href = url; link.download = `trade-workspace-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  $('workspace-backup-status').textContent = 'Backup downloaded. Store it privately; it contains your stock selections and alert history.';
}
$('export-workspace').addEventListener('click', () => { try { downloadWorkspace(); } catch (error) { $('workspace-backup-status').textContent = error.message; } });
function invalidateBackupPreview() { backupPreview = null; $('apply-workspace').disabled = true; }
$('import-workspace-file').addEventListener('change', invalidateBackupPreview);
$('import-workspace-mode').addEventListener('change', invalidateBackupPreview);
$('preview-workspace').addEventListener('click', async () => {
  invalidateBackupPreview();
  try {
    const file = $('import-workspace-file').files[0];
    if (!file || file.size > 2000000) throw new Error('Choose a Trade JSON backup smaller than 2 MB.');
    const incoming = TradeBackup.parse(await file.text()), mode = $('import-workspace-mode').value;
    const prepared = TradeBackup.prepare(incoming, currentWorkspace(), mode);
    backupPreview = {incoming, mode, file}; $('apply-workspace').disabled = false;
    $('workspace-backup-status').textContent = `${mode === 'replace' ? 'Replace' : 'Merge'} preview: ${prepared.watchlist.length} saved stocks and ${prepared.price_alerts.alerts.length} alert rules afterward. Imported active alerts establish a fresh quote baseline. Click Apply reviewed import to save.`;
  } catch (error) { $('workspace-backup-status').textContent = error.message; }
});
$('apply-workspace').addEventListener('click', async () => {
  if (!backupPreview) return;
  $('apply-workspace').disabled = true;
  const run = () => {
    const {incoming, mode, file} = backupPreview;
    if (file !== $('import-workspace-file').files[0] || mode !== $('import-workspace-mode').value) throw new Error('The selected backup changed. Preview it again.');
    const savedAlerts = storage.get(PRICE_ALERTS_KEY), savedWatchlist = storage.get(WATCHLIST_KEY);
    const current = currentWorkspace();
    if (savedAlerts) current.price_alerts = JSON.parse(savedAlerts);
    if (savedWatchlist) current.watchlist = JSON.parse(savedWatchlist);
    const prepared = TradeBackup.prepare(incoming, current, mode), rawAlerts = JSON.stringify(prepared.price_alerts);
    if (!storage.set(WATCHLIST_KEY, JSON.stringify(prepared.watchlist))) throw new Error('Browser storage is unavailable. Import was not applied.');
    if (!storage.set(PRICE_ALERTS_KEY, rawAlerts)) {
      storage.set(WATCHLIST_KEY, savedWatchlist); throw new Error('Could not save alerts. Watchlist storage was restored; import was not applied.');
    }
    STOCKS.splice(0, STOCKS.length, ...prepared.watchlist.map(validStock));
    priceAlerts = new TradePriceAlerts.AlertBook(rawAlerts); alertsSavedRaw = rawAlerts;
    selected = STOCKS.find(stock => stock.symbol === selected.symbol) || STOCKS[0] || DEFAULT_STOCKS[0]; watchlistPage = 0;
    selectionEpoch++; currentBars = []; $('alert-toasts').replaceChildren();
    renderStockSelectors(); renderWatchlist(); selectStock(selected.symbol); restartWatchlistStream(); refreshPagePrices(); renderPriceAlerts(); renderPriceNotifications();
    $('workspace-backup-status').textContent = `Import saved: ${STOCKS.length} stocks and ${priceAlerts.alerts.length} alert rules. Imported active alerts start with a fresh quote baseline.`;
    invalidateBackupPreview();
  };
  try {
    if (globalThis.navigator?.locks?.request) await globalThis.navigator.locks.request(PRICE_ALERTS_KEY, run); else run();
  } catch (error) { $('workspace-backup-status').textContent = error.message; $('apply-workspace').disabled = !backupPreview; }
});
window.addEventListener('trade-connection-changed', () => {
  researchEpoch++; fundamentalsEpoch++; screenerEpoch++; journalEpoch++; journalOffset = 0; resetJournal();
  $('fundamentals-content').replaceChildren(); $('fundamentals-status').textContent = 'Connection changed. Load financials from this server.';
  $('journal-list').replaceChildren(); $('journal-status').textContent = 'Connection changed. Reload the server journal.';
  $('benchmark-chart').hidden = true; $('benchmark-summary').replaceChildren(); $('benchmark-table').replaceChildren(); $('benchmark-status').textContent = 'Connection changed. Compare the selected account again.';
  $('screener-results').replaceChildren(); $('screener-status').textContent = 'Connection changed. Run the screener again.';
  $('run-screener').disabled = false; $('refresh-fundamentals').disabled = false;
});
resetJournal(); renderDataStatus(); loadJournal(); loadFundamentals();
