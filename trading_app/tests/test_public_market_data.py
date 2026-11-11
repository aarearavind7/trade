import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from io import BytesIO

import pytest
from fastapi.testclient import TestClient

from trading_app.api import create_app
from trading_app.public_market_data import PublicMarketData, PublicDataError


def payload():
    now = int(datetime.now(timezone.utc).timestamp())
    return {'chart': {'result': [{'meta': {'symbol': 'AAPL', 'regularMarketPrice': 101.25,
        'regularMarketTime': now, 'chartPreviousClose': 100, 'currency': 'USD',
        'currentTradingPeriod': {'regular': {'start': now - 60, 'end': now + 300}}},
        'timestamp': [now - 120, now - 60, now],
        'indicators': {'quote': [{'close': [100, None, 101.25]}]}}]}}


class Response:
    def __init__(self, content): self.content = content
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, count): return self.content[:count]


class Opener:
    def __init__(self, content=None): self.content = json.dumps(payload()).encode() if content is None else content; self.calls = []
    def __call__(self, request, **kwargs): self.calls.append(request); return Response(self.content)


def test_public_quotes_bars_schedule_and_cache_have_real_source_labels():
    opener = Opener()
    now = [0]
    provider = PublicMarketData(opener, monotonic=lambda: now[0])
    quote = provider.quote('aapl')
    assert quote['price'] == '101.25' and float(quote['change_pct']) == pytest.approx(1.25)
    assert quote['source'] == 'Yahoo Finance' and quote['feed'] == 'public'
    assert quote['timing_verified'] is False and quote['delayed']
    assert quote['timestamp'] and quote['currency'] == 'USD'
    assert len(provider.bars('AAPL')['bars']) == 2
    assert provider.clock()['is_open'] and provider.clock()['estimated']
    assert len(opener.calls) == 1
    assert opener.calls[0].full_url.startswith('https://query1.finance.yahoo.com/')
    assert not any('alpaca' in key.lower() for key in opener.calls[0].headers)
    now[0] = 4.9
    provider.quote('AAPL')
    assert len(opener.calls) == 1
    now[0] = 5
    provider.quote('AAPL')
    assert len(opener.calls) == 2


def test_concurrent_requests_share_public_cache_and_periods_map_correctly():
    opener = Opener()
    provider = PublicMarketData(opener)
    with ThreadPoolExecutor(max_workers=5) as pool:
        quotes = list(pool.map(lambda _: provider.quote('AAPL'), range(5)))
    assert len(opener.calls) == 1 and all(row['price'] == '101.25' for row in quotes)
    provider.bars('AAPL', '1W')
    assert 'range=5d' in opener.calls[-1].full_url and 'interval=15m' in opener.calls[-1].full_url
    with pytest.raises(ValueError): provider.quote('../secret')


@pytest.mark.parametrize('content', [b'not-json', b'{"chart":{"result":[]}}', b'{"chart":{"result":[null]}}', b'x' * 2000001])
def test_bad_public_responses_do_not_become_market_prices(content):
    with pytest.raises(PublicDataError): PublicMarketData(Opener(content)).quote('AAPL')


@pytest.mark.parametrize('value', [None, 0, -1, 'NaN', 'Infinity', 'invalid'])
def test_invalid_public_prices_are_rejected(value):
    with pytest.raises(PublicDataError): PublicMarketData.price(value)


def test_public_outages_and_rate_limit_messages_are_actionable():
    def failing(request, **kwargs): raise HTTPError(request.full_url, 429, 'limited', {}, BytesIO(b''))
    with pytest.raises(PublicDataError, match='rate-limited'): PublicMarketData(failing).quote('AAPL')
    def unavailable(request, **kwargs): raise URLError('private upstream internals')
    with pytest.raises(PublicDataError, match='internet access') as error: PublicMarketData(unavailable).quote('AAPL')
    assert 'private upstream' not in str(error.value)


def test_no_keys_serves_public_market_data_but_never_account_or_order_data(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', '')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', '')
    monkeypatch.setenv('PUBLIC_MARKET_DATA', 'true')
    provider = PublicMarketData(Opener())
    app = create_app(db_path=tmp_path / 'public.sqlite3', access_token='', allowed_origins=[], public_client=provider)
    with TestClient(app) as client:
        health = client.get('/api/health').json()
        assert health['public_market_data'] and not health['broker_configured'] and not health['market_stream']
        assert client.get('/api/market/AAPL/quote').json()['source'] == 'Yahoo Finance'
        assert len(client.get('/api/market/AAPL/bars').json()['bars']) == 2
        assert client.get('/api/market/clock').json()['estimated']
        assert client.get('/api/account').status_code == 503
        assert client.get('/api/positions').status_code == 503
        assert client.get('/api/performance').status_code == 503
        assert client.get('/api/exports/trades.csv').status_code == 503
        assert client.get('/api/exports/performance.csv').status_code == 503
        assert client.post('/api/orders/review', json={'symbol': 'AAPL', 'side': 'buy', 'qty': '1'}).status_code == 503
        assert client.get('/api/market/stream').status_code == 503
        assert app.state.broker is None


def test_public_mode_can_be_disabled_and_remains_authenticated(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', '')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', '')
    monkeypatch.setenv('PUBLIC_MARKET_DATA', 'false')
    with TestClient(create_app(db_path=tmp_path / 'off.sqlite3', access_token='', allowed_origins=[])) as client:
        assert not client.get('/api/health').json()['public_market_data']
        assert client.get('/api/market/AAPL/quote').status_code == 503
    monkeypatch.setenv('PUBLIC_MARKET_DATA', 'true')
    with TestClient(create_app(db_path=tmp_path / 'auth.sqlite3', access_token='app-token', allowed_origins=[], public_client=PublicMarketData(Opener()))) as client:
        assert client.get('/api/market/AAPL/quote').status_code == 401
        assert client.get('/api/market/AAPL/quote', headers={'Authorization': 'Bearer app-token'}).status_code == 200


def test_public_upstream_failure_returns_json_instead_of_fabricated_data(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', '')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', '')
    monkeypatch.setenv('PUBLIC_MARKET_DATA', 'true')
    with TestClient(create_app(db_path=tmp_path / 'bad.sqlite3', access_token='', allowed_origins=[], public_client=PublicMarketData(Opener(b'bad')))) as client:
        response = client.get('/api/market/AAPL/quote')
        assert response.status_code == 502 and response.json()['source'] == 'Yahoo Finance'
        assert 'price' not in response.json()


def test_connection_guide_shows_optional_paper_keys_and_public_prices(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', '')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', '')
    monkeypatch.setenv('PUBLIC_MARKET_DATA', 'true')
    with TestClient(create_app(db_path=tmp_path / 'guide.sqlite3', access_token='', allowed_origins=[], public_client=PublicMarketData(Opener()))) as client:
        report = client.get('/api/connection').json()
        assert report['server']['status'] == 'connected'
        assert report['market_data']['status'] == 'delayed'
        assert report['market_data']['provider'] == 'Yahoo Finance'
        assert report['paper_account']['status'] == 'not_configured'
    monkeypatch.setenv('PUBLIC_MARKET_DATA', 'false')
    with TestClient(create_app(db_path=tmp_path / 'no-data.sqlite3', access_token='', allowed_origins=[])) as client:
        report = client.get('/api/connection').json()
        assert report['market_data']['status'] == 'disabled'


def test_public_chart_preserves_provider_ohlc_and_volume_without_making_up_missing_fields():
    data = payload()
    data['chart']['result'][0]['indicators']['quote'][0].update(
        open=[99, 100, None], high=[101, 102, 103], low=[98, 99, 100], volume=[12345, 100, None])
    provider = PublicMarketData(Opener(json.dumps(data).encode()))
    bars = provider.bars('AAPL')['bars']
    assert bars[0]['o'] == 99 and bars[0]['h'] == 101 and bars[0]['l'] == 98
    assert bars[0]['v'] == 12345
    assert 'o' not in bars[1] and 'v' not in bars[1]
