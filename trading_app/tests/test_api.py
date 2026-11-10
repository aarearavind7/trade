"""Offline contract/risk tests. No real credentials or broker requests."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from threading import Lock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from trading_app.alpaca_client import AlpacaError
from trading_app.api import create_app
from trading_app.service import OrderDraft, OrderStore, RiskLimits, TradeError, TradingService, fill_performance


class FakeBroker:
    feed = 'iex'

    def __init__(self):
        self.account_data = {'id': 'paper-account', 'status': 'ACTIVE', 'cash': '100000', 'equity': '100000',
                             'last_equity': '100000', 'buying_power': '200000', 'currency': 'USD'}
        self.position_data = []
        self.open_orders = []
        self.all_orders = []
        self.fill_data = []
        self.submissions = 0
        self.submission_error = None
        self.submit_after_accept_error = False
        self.market_open = True
        self.quote_time = datetime.now(timezone.utc)
        self.price = '100'
        self.fractionable = True
        self.tradable = True
        self.lock = Lock()

    def account(self): return deepcopy(self.account_data)
    def positions(self): return deepcopy(self.position_data)
    def asset(self, symbol): return {'symbol': symbol, 'class': 'us_equity', 'status': 'active', 'tradable': self.tradable, 'fractionable': self.fractionable}
    def clock(self): return {'is_open': self.market_open, 'timestamp': datetime.now(timezone.utc).isoformat(), 'next_open': '2026-11-11T09:30:00-05:00', 'next_close': '2026-11-11T16:00:00-05:00'}
    def snapshot(self, symbol): return {'latestTrade': {'p': self.price, 't': self.quote_time.isoformat()}, 'prevDailyBar': {'c': '99'}}
    def orders(self, status='all'): return deepcopy(self.open_orders if status == 'open' else self.all_orders)
    def bars(self, symbol, period): return {'bars': [{'c': 99, 't': '2026-11-09T15:00:00Z'}, {'c': 100, 't': '2026-11-10T15:00:00Z'}], 'feed': 'iex', 'delayed': True, 'delay_minutes': 16}
    def fills(self): return deepcopy(self.fill_data), True
    def portfolio_history(self): return {'timestamp': [1794236400, 1794322800], 'equity': [99000, 100000]}

    def submit_order(self, symbol, side, qty, order_type, limit_price=None, client_order_id=None):
        with self.lock:
            self.submissions += 1
            if self.submission_error:
                raise self.submission_error
            order = {'id': str(uuid4()), 'symbol': symbol, 'side': side, 'qty': str(qty), 'type': order_type,
                     'limit_price': str(limit_price) if limit_price is not None else None,
                     'client_order_id': client_order_id, 'status': 'new', 'filled_qty': '0',
                     'submitted_at': datetime.now(timezone.utc).isoformat()}
            self.all_orders.insert(0, order)
            self.open_orders.append(order)
            if self.submit_after_accept_error:
                raise AlpacaError('timeout')
            return deepcopy(order)

    def order_by_client_id(self, client_id):
        order = next((o for o in self.all_orders if o['client_order_id'] == client_id), None)
        if not order:
            raise AlpacaError('not found', 404)
        return deepcopy(order)

    def cancel_order(self, order_id):
        self.open_orders = [o for o in self.open_orders if o['id'] != order_id]
        for order in self.all_orders:
            if order['id'] == order_id:
                order['status'] = 'canceled'
        return {}


@pytest.fixture
def broker(): return FakeBroker()


@pytest.fixture
def app(broker, tmp_path):
    return create_app(broker=broker, db_path=tmp_path / 'orders.sqlite3', access_token='', allowed_origins=[])


@pytest.fixture
def client(app):
    with TestClient(app) as result:
        yield result


DRAFT = {'symbol': 'AAPL', 'side': 'buy', 'qty': '2', 'order_type': 'market'}


def reviewed(client, **changes):
    result = client.post('/api/orders/review', json={**DRAFT, **changes})
    assert result.status_code == 200, result.text
    return result.json()


def test_market_account_and_static_endpoints(client):
    assert client.get('/').status_code == 200
    assert client.get('/app.js').status_code == 200
    assert client.get('/api/health').json()['mode'] == 'paper'
    assert client.get('/api/account').json()['cash'] == '100000'
    assert client.get('/api/positions').json() == []
    assert client.get('/api/market/clock').json()['is_open']
    quote = client.get('/api/market/aapl/quote').json()
    assert quote['symbol'] == 'AAPL' and quote['timestamp'] and quote['feed'] == 'iex'
    assert not quote['delayed']
    assert client.get('/api/market/AAPL/bars?period=1W').json()['delay_minutes'] == 16
    assert client.get('/api/market/AAPL/bars?period=bogus').status_code == 422
    assert client.get('/api/market/!bad/quote').status_code == 422
    assert client.get('/api/market/!bad/bars').status_code == 422
    assert client.get('/api/account').headers['cache-control'] == 'no-store'


def test_review_then_idempotent_submit_and_cancel(client, broker):
    review = reviewed(client)
    assert review['estimated_total'] == '200'
    assert review['reserved_total'] == '204.00'
    assert broker.submissions == 0
    first = client.post('/api/orders', json={'review_id': review['review_id']})
    second = client.post('/api/orders', json={'review_id': review['review_id']})
    assert first.json()['id'] == second.json()['id']
    assert broker.submissions == 1
    assert client.get('/api/orders').json()['orders'][0]['status'] == 'new'
    status = client.get('/api/orders/by-review/' + review['review_id'])
    assert status.json()['status'] == 'new'
    result = client.delete('/api/orders/' + first.json()['id'])
    assert result.json()['status'] == 'cancel_requested'
    assert client.get('/api/orders').json()['orders'][0]['status'] == 'canceled'


def test_fractional_market_and_whole_limit_orders(client, broker):
    fractional = reviewed(client, qty='0.125')
    assert fractional['estimated_total'] == '12.500'
    assert client.post('/api/orders', json={'review_id': fractional['review_id']}).status_code == 200
    broker.market_open = False
    limit = reviewed(client, order_type='limit', limit_price='98.25')
    assert limit['estimated_total'] == '196.50'
    result = client.post('/api/orders', json={'review_id': limit['review_id']})
    assert result.status_code == 200 and result.json()['limit_price'] == '98.25'


@pytest.mark.parametrize('changes', [
    {'qty': '0'}, {'qty': '-1'}, {'qty': 'NaN'}, {'qty': 'Infinity'}, {'qty': '0.0000001'}, {'qty': '1000001'},
    {'symbol': '../secret'}, {'side': 'short'}, {'order_type': 'stop'}, {'order_type': 'limit'},
    {'order_type': 'limit', 'limit_price': 'NaN'}, {'order_type': 'limit', 'limit_price': '0'},
    {'order_type': 'limit', 'limit_price': '10.123'}, {'order_type': 'limit', 'limit_price': '10', 'qty': '.5'},
    {'limit_price': '100'}, {'unexpected_field': 'ignore-me'},
])
def test_invalid_orders_never_reach_broker(client, broker, changes):
    assert client.post('/api/orders/review', json={**DRAFT, **changes}).status_code == 422
    assert broker.submissions == 0


def test_expired_missing_and_wrong_account_reviews(client, broker, app):
    assert client.post('/api/orders', json={'review_id': str(uuid4())}).status_code == 404
    assert client.post('/api/orders', json={'review_id': 'invalid'}).status_code == 422
    review = reviewed(client)
    with app.state.store.connect(write=True) as db:
        db.execute('UPDATE reviews SET expires=0 WHERE id=?', (review['review_id'],))
    assert client.post('/api/orders', json={'review_id': review['review_id']}).status_code == 409
    another = reviewed(client)
    broker.account_data['id'] = 'different-account'
    assert client.post('/api/orders', json={'review_id': another['review_id']}).status_code == 409
    assert client.get('/api/orders/by-review/' + another['review_id']).status_code == 409
    assert broker.submissions == 0


def test_risk_rechecked_between_review_and_submit(client, broker):
    review = reviewed(client)
    broker.account_data['cash'] = '10'
    result = client.post('/api/orders', json={'review_id': review['review_id']})
    assert result.status_code == 409 and 'cash' in result.json()['detail']
    assert broker.submissions == 0
    assert client.get('/api/orders/by-review/' + review['review_id']).json()['status'] == 'not_submitted'


def test_position_and_order_limits(client, broker):
    assert client.post('/api/orders/review', json={**DRAFT, 'qty': '50'}).status_code == 409
    broker.position_data = [{'symbol': 'AAPL', 'qty': '199', 'market_value': '19900', 'unrealized_pl': '0'}]
    assert 'position' in client.post('/api/orders/review', json=DRAFT).json()['detail']


def test_daily_loss_pauses_buys_but_allows_sells(client, broker):
    broker.account_data['equity'] = '98999'
    assert client.get('/api/risk').json()['buys_paused']
    assert 'loss' in client.post('/api/orders/review', json=DRAFT).json()['detail']
    broker.position_data = [{'symbol': 'AAPL', 'qty': '10', 'unrealized_pl': '-1001'}]
    assert reviewed(client, side='sell')['order']['side'] == 'sell'


def test_pending_orders_reserve_cash_and_shares(client, broker):
    broker.account_data['cash'] = '500'
    broker.open_orders = [{'symbol': 'MSFT', 'side': 'buy', 'qty': '4', 'filled_qty': '0', 'limit_price': '100'}]
    assert 'cash' in client.post('/api/orders/review', json=DRAFT).json()['detail']
    broker.position_data = [{'symbol': 'AAPL', 'qty': '5'}]
    broker.open_orders = [{'symbol': 'AAPL', 'side': 'sell', 'qty': '4', 'filled_qty': '0'}]
    assert 'shares' in client.post('/api/orders/review', json={**DRAFT, 'side': 'sell'}).json()['detail']
    broker.account_data['cash'] = '100000'
    broker.position_data = [{'symbol': 'AAPL', 'qty': '190'}]
    broker.open_orders = [{'symbol': 'AAPL', 'side': 'buy', 'qty': '9', 'filled_qty': '0', 'limit_price': '100'}]
    assert 'position' in client.post('/api/orders/review', json=DRAFT).json()['detail']


def test_stale_quotes_closed_market_and_blocked_assets(client, broker):
    broker.quote_time -= timedelta(minutes=5)
    assert client.get('/api/market/AAPL/quote').json()['delayed']
    assert client.post('/api/orders/review', json=DRAFT).status_code == 503
    broker.quote_time = datetime.now(timezone.utc)
    broker.market_open = False
    assert 'open regular' in client.post('/api/orders/review', json=DRAFT).json()['detail']
    broker.market_open = True
    broker.tradable = False
    assert client.post('/api/orders/review', json=DRAFT).status_code == 422
    broker.tradable = True
    broker.fractionable = False
    assert client.post('/api/orders/review', json={**DRAFT, 'qty': '.5'}).status_code == 422
    broker.account_data['trading_blocked'] = True
    assert 'blocked' in client.post('/api/orders/review', json=DRAFT).json()['detail']


def test_unknown_submission_is_never_automatically_resubmitted(client, broker):
    review = reviewed(client)
    broker.submission_error = AlpacaError('socket timeout')
    assert client.post('/api/orders', json={'review_id': review['review_id']}).status_code == 503
    assert client.post('/api/orders', json={'review_id': review['review_id']}).status_code == 409
    assert client.get('/api/orders/by-review/' + review['review_id']).json()['status'] == 'unknown'
    assert 'unknown' in client.post('/api/orders/review', json=DRAFT).json()['detail']
    assert broker.submissions == 1
    assert client.get('/api/orders').json()['local'][0]['status'] == 'unknown'


def test_timeout_after_broker_acceptance_reconciles(client, broker):
    review = reviewed(client)
    broker.submit_after_accept_error = True
    assert client.post('/api/orders', json={'review_id': review['review_id']}).status_code == 503
    assert client.get('/api/orders/by-review/' + review['review_id']).json()['status'] == 'new'
    assert client.post('/api/orders', json={'review_id': review['review_id']}).status_code == 200
    assert broker.submissions == 1


def test_rejections_and_upstream_failures_are_sanitized(client, broker):
    review = reviewed(client)
    broker.submission_error = AlpacaError('secret upstream text', 422)
    response = client.post('/api/orders', json={'review_id': review['review_id']})
    assert response.status_code == 422 and 'secret' not in response.text
    assert client.post('/api/orders', json={'review_id': review['review_id']}).status_code == 422
    assert client.get('/api/orders/by-review/' + review['review_id']).json()['status'] == 'rejected'
    broker.account = lambda: (_ for _ in ()).throw(AlpacaError('secret upstream text', 401))
    assert client.get('/api/account').status_code == 502
    assert 'secret' not in client.get('/api/account').text


def test_concurrent_duplicate_submit_and_process_restart(tmp_path, broker):
    path = tmp_path / 'durable.sqlite3'
    svc = TradingService(broker, OrderStore(path))
    review = svc.review(OrderDraft(**DRAFT))
    def submit(_): return TradingService(broker, OrderStore(path)).submit(review['review_id'])
    with ThreadPoolExecutor(max_workers=4) as pool:
        orders = list(pool.map(submit, range(4)))
    assert len({order['id'] for order in orders}) == 1
    assert broker.submissions == 1
    assert TradingService(broker, OrderStore(path)).submit(review['review_id'])['id'] == orders[0]['id']


def test_crash_after_persisted_intent_does_not_resubmit(tmp_path, broker):
    svc = TradingService(broker, OrderStore(tmp_path / 'state.sqlite3'))
    review = svc.review(OrderDraft(**DRAFT))
    with svc.store.connect(write=True) as db:
        db.execute("UPDATE reviews SET state='submitting' WHERE id=?", (review['review_id'],))
    with pytest.raises(TradeError, match='unknown'):
        svc.submit(review['review_id'])
    assert broker.submissions == 0
    assert svc.unresolved()[0]['status'] == 'unknown'


def test_application_auth_cors_and_csrf(tmp_path, broker):
    app = create_app(broker, tmp_path / 'auth.sqlite3', access_token='test-app-token', allowed_origins=['https://dashboard.example.com'])
    with TestClient(app) as client:
        assert client.get('/api/account').status_code == 401
        assert client.get('/api/account', headers={'Authorization': 'Bearer wrong'}).status_code == 401
        headers = {'Authorization': 'Bearer test-app-token'}
        assert client.get('/api/account', headers=headers).status_code == 200
        assert client.post('/api/orders/review', json=DRAFT, headers={**headers, 'Origin': 'https://evil.example.com'}).status_code == 403
        assert client.post('/api/orders/review', json=DRAFT, headers={**headers, 'Origin': 'https://dashboard.example.com'}).status_code == 200
        preflight = client.options('/api/orders', headers={'Origin': 'https://dashboard.example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'})
        assert preflight.headers['access-control-allow-origin'] == 'https://dashboard.example.com'
    with pytest.raises(ValueError):
        create_app(broker, tmp_path / 'bad.sqlite3', access_token='', allowed_origins=['https://example.com'])


def test_missing_credentials_return_configuration_message(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', '')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', '')
    with TestClient(create_app(db_path=tmp_path / 'empty.sqlite3', access_token='', allowed_origins=[])) as client:
        response = client.get('/api/account')
        assert response.status_code == 503
        assert 'Configure Alpaca' in response.json()['detail']


def fill(id, side, qty, price, stamp):
    return {'id': id, 'symbol': 'AAPL', 'side': side, 'qty': str(qty), 'price': str(price), 'transaction_time': stamp}


def test_weighted_average_realized_unrealized_and_trade_history(client, broker):
    broker.fill_data = [fill('3', 'sell', 5, 150, '2026-11-10T15:03:00Z'), fill('2', 'buy', 10, 120, '2026-11-10T15:02:00Z'), fill('1', 'buy', 10, 100, '2026-11-10T15:01:00Z')]
    broker.position_data = [{'symbol': 'AAPL', 'qty': '15', 'unrealized_pl': '300', 'avg_entry_price': '110', 'market_value': '1950'}]
    result = client.get('/api/performance').json()
    assert Decimal(result['realized_pl']) == Decimal('200')
    assert result['unrealized_pl'] == '300' and result['realized_complete']
    assert result['portfolio_history']['equity'] == [99000, 100000]
    trades = client.get('/api/trades?limit=2').json()['trades']
    assert len(trades) == 2 and trades[0]['side'] == 'sell'
    assert client.get('/api/trades?limit=0').status_code == 422


def test_incomplete_fills_and_corporate_actions_do_not_invent_realized_pl():
    result = fill_performance([fill('1', 'sell', 10, 150, '2026-11-10T15:00:00Z')], [])
    assert result['realized_pl'] is None and not result['realized_complete']
    buys = [fill('1', 'buy', 10, 100, '2026-11-10T15:00:00Z')]
    assert not fill_performance(buys, [{'symbol': 'AAPL', 'qty': '20'}])['realized_complete']
    assert fill_performance([], [])['realized_pl'] == '0'
    assert fill_performance([], [], complete=False)['realized_pl'] is None


def test_setup_health_avoids_errors_until_credentials_are_configured(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', 'your_paper_api_key')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', 'your_paper_secret_key')
    app = create_app(db_path=tmp_path / 'setup.sqlite3', access_token='', allowed_origins=[])
    with TestClient(app) as client:
        response = client.get('/api/health')
        assert response.status_code == 200
        health = response.json()
        assert not health['broker_configured']
        assert 'ALPACA_API_KEY_ID' in health['setup_message']
        assert '.env' in health['setup_message'] and 'restart Uvicorn' in health['setup_message']
        assert 'your_paper_api_key' not in response.text
        assert client.get('/api/account').status_code == 503
        assert client.get('/favicon.ico').status_code == 200
        assert client.get('/favicon.svg').headers['content-type'].startswith('image/svg+xml')
        monkeypatch.setenv('ALPACA_API_KEY_ID', 'unit-test-key-not-a-real-secret')
        monkeypatch.setenv('ALPACA_API_SECRET_KEY', 'unit-test-secret-not-a-real-secret')
        assert client.get('/api/health').json()['broker_configured']


def test_health_reports_invalid_endpoint_without_disclosing_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', 'unit-test-key')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', 'unit-test-secret')
    monkeypatch.setenv('ALPACA_TRADING_URL', 'https://api.alpaca.markets')
    with TestClient(create_app(db_path=tmp_path / 'endpoint.sqlite3', access_token='', allowed_origins=[])) as client:
        response = client.get('/api/health')
        assert not response.json()['broker_configured']
        assert 'official Alpaca paper-trading' in response.json()['setup_message']
        assert 'unit-test-secret' not in response.text
