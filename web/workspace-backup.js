(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./price-alerts.js'));
  else root.TradeBackup = factory(root.TradePriceAlerts);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (alerts) {
  'use strict';
  function validate(data) {
    if (!data || data.type !== 'trade-workspace' || data.version !== 1 || !Array.isArray(data.watchlist) || data.watchlist.length > 1000) throw new Error('Use a version 1 Trade workspace backup (up to 1,000 stocks).');
    const symbols = new Set();
    const watchlist = data.watchlist.map(row => {
      if (!row || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(row.symbol) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || symbols.has(row.symbol)) throw new Error('The backup contains an invalid or duplicate stock.');
      symbols.add(row.symbol); return {symbol: row.symbol, name: row.name.trim()};
    });
    const value = data.price_alerts;
    if (!value || value.version !== 1 || !Array.isArray(value.alerts) || !Array.isArray(value.notifications) || value.alerts.length > 50 || value.notifications.length > 100) throw new Error('Invalid alerts backup or capacity exceeded.');
    const book = new alerts.AlertBook(value);
    if (book.alerts.length !== value.alerts.length || book.notifications.length !== value.notifications.length || book.alerts.some((row, i) => row.status !== value.alerts[i].status)) throw new Error('The backup contains invalid alerts or exceeds 20 active symbols.');
    const rules = new Set();
    for (const row of book.alerts) {
      const key = `${row.symbol}:${row.condition}:${row.target}`;
      if (rules.has(key)) throw new Error('The backup contains duplicate alert rules.');
      rules.add(key);
    }
    return {type: 'trade-workspace', version: 1, watchlist, price_alerts: JSON.parse(book.serialize())};
  }
  function parse(raw) {
    if (typeof raw !== 'string' || raw.length > 2000000) throw new Error('Backup must be a JSON file smaller than 2 MB.');
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('The backup is not valid JSON.'); }
    return validate(value);
  }
  function prepare(incoming, current, mode) {
    const value = validate(incoming), saved = validate(current);
    if (!['merge', 'replace'].includes(mode)) throw new Error('Choose merge or replace.');
    const result = mode === 'replace' ? value : saved;
    const reset = row => ({...row, lastQuote: null});
    if (mode === 'replace') result.price_alerts.alerts = result.price_alerts.alerts.map(reset);
    else {
      const symbols = new Set(result.watchlist.map(row => row.symbol));
      value.watchlist.forEach(row => { if (!symbols.has(row.symbol)) { result.watchlist.push(row); symbols.add(row.symbol); } });
      const rules = new Set(result.price_alerts.alerts.map(row => `${row.symbol}:${row.condition}:${row.target}`));
      const ids = new Set(result.price_alerts.alerts.map(row => row.id));
      value.price_alerts.alerts.forEach((row, index) => {
        const rule = `${row.symbol}:${row.condition}:${row.target}`;
        if (rules.has(rule)) return;
        let id = row.id;
        while (ids.has(id)) id = 'import-' + Date.now().toString(36) + '-' + index + '-' + Math.random().toString(36).slice(2, 8);
        result.price_alerts.alerts.push(reset({...row, id})); ids.add(id); rules.add(rule);
      });
      const notificationIds = new Set(result.price_alerts.notifications.map(row => row.id));
      value.price_alerts.notifications.forEach(row => { if (!notificationIds.has(row.id)) { result.price_alerts.notifications.push(row); notificationIds.add(row.id); } });
      result.price_alerts.notifications.sort((a, b) => b.observedAt - a.observedAt);
      result.price_alerts.notifications = result.price_alerts.notifications.slice(0, 100);
    }
    return validate(result);
  }
  return {validate, parse, prepare};
});
