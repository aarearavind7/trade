"""Validated paper orders, durable idempotency, risk checks, and fill accounting."""
import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing import Literal
from .alpaca_client import AlpacaError, AlpacaClient

D = Decimal
TERMINAL = {'filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'}


class TradeError(Exception):
    def __init__(self, message, status=409):
        self.message, self.status = message, status


def number(value):
    try:
        result = D(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise TradeError('Broker returned an invalid numeric value.', 502) from exc
    if not result.is_finite():
        raise TradeError('Broker returned a non-finite numeric value.', 502)
    return result


class OrderDraft(BaseModel):
    model_config = ConfigDict(extra='forbid')
    symbol: str = Field(min_length=1, max_length=10)
    side: Literal['buy', 'sell']
    qty: Decimal = Field(gt=0, le=1000000, max_digits=13, decimal_places=6)
    order_type: Literal['market', 'limit'] = 'market'
    limit_price: Decimal | None = Field(default=None, gt=0, le=10000000)

    @field_validator('symbol')
    @classmethod
    def validate_symbol(cls, value):
        return AlpacaClient.symbol(value)

    @model_validator(mode='after')
    def validate_limit(self):
        if self.order_type == 'limit':
            if self.limit_price is None:
                raise ValueError('Limit orders require a limit price.')
            places = 2 if self.limit_price >= 1 else 4
            if self.limit_price != self.limit_price.quantize(D(10) ** -places):
                raise ValueError('Limit price requires cents (or up to four decimals below $1).')
            if self.qty != self.qty.to_integral_value():
                raise ValueError('Use whole shares for limit orders; fractional shares require market orders.')
        elif self.limit_price is not None:
            raise ValueError('Market orders do not accept a limit price.')
        return self


@dataclass(frozen=True)
class RiskLimits:
    max_position_pct: Decimal = D('20')
    max_order_notional: Decimal = D('5000')
    max_daily_loss: Decimal = D('1000')
    max_quote_age: int = 120

    def __post_init__(self):
        if not (0 < self.max_position_pct <= 100) or not self.max_position_pct.is_finite():
            raise ValueError('MAX_POSITION_PCT must be between 0 and 100.')
        if any(not v.is_finite() or v <= 0 for v in (self.max_order_notional, self.max_daily_loss)):
            raise ValueError('Risk limits must be finite and positive.')

    def public(self):
        return {'max_position_pct': str(self.max_position_pct), 'max_order_notional': str(self.max_order_notional),
                'max_daily_loss': str(self.max_daily_loss), 'max_quote_age_seconds': self.max_quote_age}


class OrderStore:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS reviews (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL,
                created REAL NOT NULL, expires REAL NOT NULL, state TEXT NOT NULL,
                result TEXT, error TEXT)''')

    @contextmanager
    def connect(self, write=False):
        db = sqlite3.connect(self.path, timeout=45)
        db.row_factory = sqlite3.Row
        try:
            if write:
                db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()


class TradingService:
    def __init__(self, broker, store, limits=None, now=None):
        self.broker, self.store = broker, store
        self.limits = limits or RiskLimits()
        self.now = now or (lambda: datetime.now(timezone.utc))

    def quote(self, symbol):
        data = self.broker.snapshot(symbol)
        trade = data.get('latestTrade') or {}
        price = number(trade.get('p'))
        if price <= 0:
            raise TradeError('No usable trade price is available for this asset.', 503)
        timestamp = trade.get('t')
        try:
            age = max(0, (self.now() - datetime.fromisoformat(timestamp.replace('Z', '+00:00'))).total_seconds())
        except (ValueError, TypeError, AttributeError) as exc:
            raise TradeError('Market data has no valid timestamp.', 502) from exc
        previous = number((data.get('prevDailyBar') or {}).get('c') or 0)
        return {'symbol': symbol, 'price': str(price), 'timestamp': timestamp, 'age_seconds': round(age),
                'change_pct': str((price / previous - 1) * 100) if previous > 0 else None,
                'feed': self.broker.feed, 'delayed': self.broker.feed == 'delayed_sip' or age > self.limits.max_quote_age,
                'coverage': 'IEX exchange only' if self.broker.feed == 'iex' else self.broker.feed.upper()}

    def evaluate(self, draft, db, exclude_review=None):
        broker = self.broker
        account = broker.account()
        account_id = account['id']
        unresolved = db.execute("SELECT id FROM reviews WHERE account_id=? AND state IN ('submitting','unknown') AND id != ?",
                                (account_id, exclude_review or '')).fetchone()
        if unresolved:
            raise TradeError('An earlier order has an unknown outcome. Reconcile it in Activity before submitting another order.')
        if account.get('status') != 'ACTIVE' or any(account.get(k) for k in ('trading_blocked', 'account_blocked', 'trade_suspended_by_user')):
            raise TradeError('This paper account is blocked from trading.')
        asset = broker.asset(draft.symbol)
        if not asset.get('tradable') or asset.get('status') != 'active' or asset.get('class') != 'us_equity':
            raise TradeError('This asset is not an active, tradable US equity.', 422)
        if draft.qty != draft.qty.to_integral_value() and not asset.get('fractionable'):
            raise TradeError('This asset does not support fractional shares.', 422)
        clock = broker.clock()
        quote = self.quote(draft.symbol)
        if draft.order_type == 'market' and not clock['is_open']:
            raise TradeError('Market orders require an open regular trading session. Use a day limit order to queue a trade.')
        if clock['is_open'] and quote['age_seconds'] > self.limits.max_quote_age:
            raise TradeError('Market data is stale. Refresh before placing an order.', 503)
        positions = broker.positions()
        if any(number(p['qty']) < 0 for p in positions):
            raise TradeError('This dashboard supports long-only portfolios. Resolve short positions in Alpaca first.')
        pending = broker.orders('open')
        if len(pending) >= 500:
            raise TradeError('Too many open orders to evaluate risk reliably. Reduce open orders in Alpaca first.')
        holding = next((p for p in positions if p['symbol'] == draft.symbol), None)
        held = number(holding['qty']) if holding else D(0)
        cash, equity = number(account['cash']), number(account['equity'])
        reference = number(quote['price'])
        estimate_price = draft.limit_price if draft.order_type == 'limit' else reference
        # Buffer market buys for price movement; broker still enforces its own checks.
        reserve_price = draft.limit_price if draft.order_type == 'limit' else reference * D('1.02')
        reserved_cash = D(0)
        pending_buys = D(0)
        pending_sells = D(0)
        for order in pending:
            remaining = max(D(0), number(order['qty']) - number(order.get('filled_qty') or 0))
            if order['side'] == 'buy':
                if order.get('limit_price'):
                    open_price = number(order['limit_price'])
                elif order['symbol'] == draft.symbol:
                    open_price = reference * D('1.02')
                else:
                    open_price = number(self.quote(order['symbol'])['price']) * D('1.02')
                reserved_cash += remaining * open_price
                if order['symbol'] == draft.symbol:
                    pending_buys += remaining * max(open_price, reference)
            elif order['symbol'] == draft.symbol:
                pending_sells += remaining
        daily_loss = max(D(0), number(account['last_equity']) - equity)
        notional = draft.qty * reserve_price
        if notional > self.limits.max_order_notional:
            raise TradeError('Order exceeds the configured maximum order value.')
        if draft.side == 'buy':
            if daily_loss >= self.limits.max_daily_loss:
                raise TradeError('Daily practice-loss limit reached. New buys are paused; you can still sell positions.')
            available = max(D(0), min(cash - reserved_cash, number(account['buying_power'])))
            if notional > available:
                raise TradeError('Insufficient unreserved cash for this order (market buys include a 2% price buffer).')
            projected = held * reference + pending_buys + draft.qty * max(reserve_price, reference)
            if equity <= 0 or projected > equity * self.limits.max_position_pct / 100:
                raise TradeError('Order exceeds the maximum position percentage, including open buy orders.')
        elif draft.qty > max(D(0), held - pending_sells):
            raise TradeError('Insufficient unreserved shares to sell. Short selling is disabled.')
        return {'account_id': account_id, 'estimated_total': str(draft.qty * estimate_price),
                'estimated_price': str(estimate_price), 'reserved_total': str(notional), 'quote': quote,
                'market_open': clock['is_open'], 'daily_loss': str(daily_loss), 'limits': self.limits.public()}

    def review(self, draft):
        now = self.now().timestamp()
        with self.store.connect(write=True) as db:
            evaluated = self.evaluate(draft, db)
            review_id = str(uuid4())
            db.execute('INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?)',
                       (review_id, evaluated['account_id'], draft.model_dump_json(), now, now + 60, 'reviewed', None, None))
        return {'review_id': review_id, 'expires_at': now + 60, 'order': draft.model_dump(mode='json'), **evaluated}

    @staticmethod
    def client_id(review_id):
        return 'trade-' + review_id

    def _reconcile(self, db, row):
        try:
            order = self.broker.order_by_client_id(self.client_id(row['id']))
        except AlpacaError as exc:
            if exc.status_code == 404:
                return None
            raise
        db.execute("UPDATE reviews SET state='submitted',result=?,error=NULL WHERE id=?", (json.dumps(order), row['id']))
        return order

    def submit(self, review_id):
        result, failure = None, None
        # SQLite serializes submissions across threads/workers and survives restarts.
        with self.store.connect(write=True) as db:
            row = db.execute('SELECT * FROM reviews WHERE id=?', (review_id,)).fetchone()
            if row is None:
                raise TradeError('Review not found. Review this order first.', 404)
            if row['account_id'] != self.broker.account()['id']:
                raise TradeError('This review belongs to a different paper account.', 409)
            if row['state'] == 'submitted':
                return json.loads(row['result'])
            if row['state'] == 'rejected':
                raise TradeError(row['error'], 422)
            if row['state'] in {'submitting', 'unknown'}:
                result = self._reconcile(db, row)
                if result is None:
                    failure = TradeError('Order outcome is unknown. Keep this review ID and reconcile; do not submit a replacement.', 409)
            else:
                if self.now().timestamp() > row['expires']:
                    raise TradeError('Review expired. Review the order again.', 409)
                draft = OrderDraft.model_validate_json(row['payload'])
                self.evaluate(draft, db, review_id)
                db.execute("UPDATE reviews SET state='submitting' WHERE id=?", (review_id,))
                # Persist intent BEFORE the network call. A process crash must not permit a retry.
                db.commit()
                db.execute('BEGIN IMMEDIATE')
                try:
                    result = self.broker.submit_order(draft.symbol, draft.side, draft.qty, draft.order_type,
                        limit_price=draft.limit_price, client_order_id=self.client_id(review_id))
                except AlpacaError as exc:
                    if exc.status_code and 400 <= exc.status_code < 500 and exc.status_code not in {408, 409, 429}:
                        message = 'The paper broker rejected this order. Check account permissions and order details in Alpaca.'
                        db.execute("UPDATE reviews SET state='rejected',error=? WHERE id=?", (message, review_id))
                        failure = TradeError(message, 422)
                    else:
                        db.execute("UPDATE reviews SET state='unknown' WHERE id=?", (review_id,))
                        failure = TradeError('Broker connection failed. Outcome unknown; reconcile this order before trading again.', 503)
                else:
                    if not isinstance(result, dict) or not result.get('id'):
                        db.execute("UPDATE reviews SET state='unknown' WHERE id=?", (review_id,))
                        failure = TradeError('Broker response is incomplete. Reconcile this order before trading again.', 503)
                    else:
                        db.execute("UPDATE reviews SET state='submitted',result=? WHERE id=?", (json.dumps(result), review_id))
        if failure:
            raise failure
        return result

    def reconcile(self, review_id):
        with self.store.connect(write=True) as db:
            row = db.execute('SELECT * FROM reviews WHERE id=?', (review_id,)).fetchone()
            if row is None:
                raise TradeError('Review not found.', 404)
            if row['account_id'] != self.broker.account()['id']:
                raise TradeError('Review belongs to a different paper account.', 409)
            if row['state'] == 'rejected':
                return {'status': 'rejected', 'review_id': review_id, 'message': row['error']}
            if row['state'] == 'reviewed':
                return {'status': 'not_submitted', 'review_id': review_id}
            order = self._reconcile(db, row)
            return order or {'status': 'unknown', 'review_id': review_id, 'client_order_id': self.client_id(review_id)}

    def unresolved(self):
        account_id = self.broker.account()['id']
        with self.store.connect() as db:
            rows = db.execute("SELECT id,state,created FROM reviews WHERE account_id=? AND state IN ('unknown','submitting','rejected') ORDER BY CASE WHEN state='rejected' THEN 1 ELSE 0 END, created DESC LIMIT 50", (account_id,)).fetchall()
        return [{'review_id': r['id'], 'status': 'unknown' if r['state'] == 'submitting' else r['state'], 'created': r['created']} for r in rows]


def fill_performance(fills, positions, complete=True):
    """Weighted-average realized P/L for long-only fills; flag missing/split history."""
    inventory, realized = {}, D(0)
    ordered = sorted(fills, key=lambda f: (f['transaction_time'], f['id']))
    for fill in ordered:
        symbol, side = fill['symbol'], fill['side']
        qty, price = number(fill['qty']), number(fill['price'])
        if qty <= 0 or price < 0:
            complete = False
            continue
        held, cost = inventory.get(symbol, (D(0), D(0)))
        if side == 'buy':
            inventory[symbol] = (held + qty, cost + qty * price)
        elif side == 'sell':
            if qty > held or held <= 0:
                complete = False
                inventory[symbol] = (D(0), D(0))
            else:
                avg = cost / held
                realized += qty * (price - avg)
                inventory[symbol] = (held - qty, cost - qty * avg)
        else:
            complete = False
    actual = {p['symbol']: number(p['qty']) for p in positions}
    for symbol in set(actual) | set(inventory):
        if abs(actual.get(symbol, D(0)) - inventory.get(symbol, (D(0), D(0)))[0]) > D('.000001'):
            complete = False
    return {'realized_pl': str(realized) if complete else None,
            'unrealized_pl': str(sum((number(p.get('unrealized_pl', 0)) for p in positions), D(0))),
            'realized_complete': complete, 'fill_count': len(fills),
            'since': ordered[0]['transaction_time'] if ordered else None,
            'method': 'Weighted-average long-only fills; excludes fees, dividends and corporate actions. Realized P/L is unavailable when fill history cannot reconcile to positions.'}
