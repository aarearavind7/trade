/* Browser-local alert state and quote evaluation. No brokerage/order operations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TradePriceAlerts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_ALERTS = 50, MAX_SYMBOLS = 20, MAX_NOTIFICATIONS = 100;
  const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,9}$/;
  const ID = /^[A-Za-z0-9_\-]{1,80}$/;
  const CONDITIONS = new Set(['above', 'below']);
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  function targetPrice(value) {
    const raw = String(value).trim();
    const price = Number(raw);
    if (!/^(?:\d+\.?\d{0,4}|\.\d{1,4})$/.test(raw) || !Number.isFinite(price) || price < .0001 || price > 10000000) {
      throw new Error('Enter a target from $0.0001 to $10,000,000 with up to four decimal places.');
    }
    return price;
  }
  function quoteStamp(value) {
    if (typeof value !== 'string') return null;
    const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!match) return null;
    // Parse a standard millisecond ISO string; preserve the extra digits separately.
    const normalized = value.replace(/\.\d+(?=Z|[+-])/i, '.' + (match[1] || '').padEnd(3, '0').slice(0, 3)).replace(/z$/i, 'Z');
    const ms = Date.parse(normalized);
    if (!Number.isFinite(ms) || ms < 0) return null;
    const sub = (match[1] || '').padEnd(9, '0').slice(3);
    return {ms, key: String(ms).padStart(15, '0') + sub};
  }
  function normalizeQuote(quote, now, allowFuture = false) {
    if (!quote || typeof quote !== 'object') return null;
    const price = Number(quote.price), stamp = quoteStamp(quote.timestamp);
    if (!Number.isFinite(price) || price <= 0 || !stamp || (!allowFuture && stamp.ms > now + 60000)) return null;
    const source = text(quote.source || quote.coverage || quote.feed, 120) || 'Market data';
    const feed = text(quote.feed, 30);
    return {price, timestamp: quote.timestamp, key: stamp.key, source, feed,
      sourceKey: feed + '|' + source, delayed: !!quote.delayed, timing_verified: quote.timing_verified !== false};
  }
  function validRule(value) {
    if (!value || typeof value !== 'object' || typeof value.symbol !== 'string') throw new Error('Select a valid stock.');
    const symbol = value.symbol.trim().toUpperCase();
    if (!SYMBOL.test(symbol)) throw new Error('Select a valid US stock symbol.');
    if (!CONDITIONS.has(value.condition)) throw new Error('Choose at or above, or at or below.');
    return {symbol, name: text(value.name, 200) || symbol, condition: value.condition, target: targetPrice(value.target)};
  }
  class AlertBook {
    constructor(raw = '', options = {}) {
      this.now = options.now || Date.now;
      this.makeId = options.id || (() => 'alert-' + this.now().toString(36) + '-' + Math.random().toString(36).slice(2));
      this.alerts = []; this.notifications = [];
      try {
        const data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
        const ids = new Set(), activeSymbols = new Set();
        for (const value of Array.isArray(data.alerts) ? data.alerts : []) {
          try {
            const rule = validRule(value);
            if (typeof value.id !== 'string' || !ID.test(value.id) || ids.has(value.id) || !['active', 'paused', 'triggered'].includes(value.status)) continue;
            if (this.alerts.length >= MAX_ALERTS) break;
            ids.add(value.id);
            let status = value.status;
            if (status === 'active' && !activeSymbols.has(rule.symbol) && activeSymbols.size >= MAX_SYMBOLS) status = 'paused';
            if (status === 'active') activeSymbols.add(rule.symbol);
            this.alerts.push({...rule, id: value.id, status,
              cycle: Number.isSafeInteger(value.cycle) && value.cycle > 0 ? value.cycle : 1,
              createdAt: Number.isFinite(value.createdAt) ? value.createdAt : this.now(),
              triggeredAt: Number.isFinite(value.triggeredAt) ? value.triggeredAt : null,
              lastQuote: normalizeQuote(value.lastQuote, this.now(), true)});
          } catch { /* Ignore malformed saved records without executing their content. */ }
        }
        const notificationIds = new Set();
        for (const value of Array.isArray(data.notifications) ? data.notifications : []) {
          try {
            const rule = validRule(value), quote = normalizeQuote(value.quote, this.now(), true);
            if (typeof value.id !== 'string' || !/^[A-Za-z0-9_:\-]{1,110}$/.test(value.id) || notificationIds.has(value.id) || !quote || !Number.isFinite(value.observedAt)) continue;
            notificationIds.add(value.id);
            this.notifications.push({...rule, id: value.id, observedAt: value.observedAt, quote, read: value.read === true});
            if (this.notifications.length === MAX_NOTIFICATIONS) break;
          } catch { /* Ignore invalid notification history. */ }
        }
      } catch { /* Fresh state if browser storage is missing or corrupt. */ }
    }
    serialize() { return JSON.stringify({version: 1, alerts: this.alerts, notifications: this.notifications}); }
    activeSymbols() { return [...new Set(this.alerts.filter(alert => alert.status === 'active').map(alert => alert.symbol))].slice(0, MAX_SYMBOLS); }
    assertCapacity(symbol, excludeId) {
      const active = new Set(this.alerts.filter(alert => alert.status === 'active' && alert.id !== excludeId).map(alert => alert.symbol));
      active.add(symbol);
      if (active.size > MAX_SYMBOLS) throw new Error('Monitor up to 20 distinct symbols at once. Pause another symbol’s alerts first.');
    }
    add(value, baseline) {
      const rule = validRule(value);
      if (this.alerts.length >= MAX_ALERTS) throw new Error('You have 50 saved alerts. Delete an older alert to make room.');
      if (this.alerts.some(alert => alert.symbol === rule.symbol && alert.condition === rule.condition && alert.target === rule.target)) {
        throw new Error('This target already has an alert. Resume or re-arm the existing one.');
      }
      this.assertCapacity(rule.symbol);
      const alert = {...rule, id: this.makeId(), status: 'active', cycle: 1, createdAt: this.now(), triggeredAt: null,
        lastQuote: normalizeQuote(baseline, this.now())};
      this.alerts.push(alert); return alert;
    }
    find(id) {
      const alert = this.alerts.find(item => item.id === id);
      if (!alert) throw new Error('Alert no longer exists.');
      return alert;
    }
    pause(id) { const alert = this.find(id); if (alert.status === 'active') alert.status = 'paused'; }
    arm(id, baseline) {
      const alert = this.find(id); this.assertCapacity(alert.symbol, id);
      alert.status = 'active'; alert.cycle++; alert.triggeredAt = null;
      alert.lastQuote = normalizeQuote(baseline, this.now()); return alert;
    }
    remove(id) { this.alerts = this.alerts.filter(alert => alert.id !== id); }
    accept(symbol, value) {
      const quote = normalizeQuote(value, this.now());
      if (!quote) return [];
      const fired = [];
      for (const alert of this.alerts) {
        if (alert.status !== 'active' || alert.symbol !== symbol) continue;
        const previous = alert.lastQuote;
        if (!previous || previous.sourceKey !== quote.sourceKey) { alert.lastQuote = quote; continue; }
        if (quote.key <= previous.key) continue;
        alert.lastQuote = quote;
        const matches = alert.condition === 'above' ? quote.price >= alert.target : quote.price <= alert.target;
        if (!matches) continue;
        alert.status = 'triggered'; alert.triggeredAt = this.now();
        const id = alert.id + ':' + alert.cycle;
        if (this.notifications.some(item => item.id === id)) continue;
        const notification = {id, symbol: alert.symbol, name: alert.name, condition: alert.condition, target: alert.target,
          observedAt: this.now(), quote, read: false};
        this.notifications.unshift(notification); fired.push(notification);
      }
      this.notifications = this.notifications.slice(0, MAX_NOTIFICATIONS);
      return fired;
    }
    markRead(id) { this.notifications.forEach(item => { if (!id || item.id === id) item.read = true; }); }
    dismiss(id) { this.notifications = this.notifications.filter(item => item.id !== id); }
  }
  return {AlertBook, targetPrice, quoteStamp, MAX_ALERTS, MAX_SYMBOLS};
});
