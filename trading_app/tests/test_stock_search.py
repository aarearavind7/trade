import json
from datetime import datetime, timezone
from types import SimpleNamespace
from fastapi.testclient import TestClient
import pytest

from trading_app.api import create_app
from trading_app.alpaca_client import AlpacaClient
from trading_app.public_market_data import PublicMarketData
from trading_app.stock_search import StockSearch, query_text
from trading_app.tests.test_public_market_data import Opener


def search_payload():
    return {'quotes': [
        {'symbol': 'AMZN', 'shortname': 'Amazon.com, Inc.', 'exchange': 'NMS', 'quoteType': 'EQUITY'},
        {'symbol': 'AMZN', 'shortname': 'Duplicate', 'exchange': 'NMS', 'quoteType': 'EQUITY'},
        {'symbol': 'AMZN.TO', 'shortname': 'Canadian listing', 'exchange': 'TOR', 'quoteType': 'EQUITY'},
        {'symbol': 'AMZN=F', 'exchange': 'CME', 'quoteType': 'FUTURE'},
        {'symbol': 'BRK-B', 'shortname': 'Berkshire Hathaway', 'exchange': 'NYQ', 'quoteType': 'EQUITY'},
        {'symbol': 'SPY', 'shortname': 'S&P 500 ETF', 'exchange': 'PCX', 'quoteType': 'ETF'},
        {'symbol': '../BAD', 'exchange': 'NYQ', 'quoteType': 'EQUITY'}]}


def test_public_search_filters_us_equities_deduplicates_and_maps_class_shares():
    opener = Opener(json.dumps(search_payload()).encode())
    provider = PublicMarketData(opener)
    rows = StockSearch(provider).search('Amazon')['results']
    assert [row['symbol'] for row in rows] == ['AMZN', 'BRK.B', 'SPY']
    assert rows[0]['name'] == 'Amazon.com, Inc.'
    StockSearch(provider).search('Amazon')
    assert len(opener.calls) == 1 and 'q=Amazon' in opener.calls[0].full_url


def test_alpaca_catalogue_search_and_cache_prioritize_exact_symbols():
    calls = []
    def assets():
        calls.append(True)
        return [
            {'symbol': 'AMZN', 'name': 'Amazon.com', 'class': 'us_equity', 'status': 'active', 'tradable': True, 'exchange': 'NASDAQ'},
            {'symbol': 'ABC', 'name': 'AMZN supplier', 'class': 'us_equity', 'status': 'active', 'tradable': True},
            {'symbol': 'BAD', 'name': 'Bad', 'class': 'crypto', 'status': 'active', 'tradable': True}]
    broker = SimpleNamespace(assets=assets)
    search = StockSearch(None)
    result = search.search('amzn', broker)
    assert result['source'] == 'Alpaca' and result['results'][0]['symbol'] == 'AMZN'
    assert search.search('amazon', broker)['results'][0]['symbol'] == 'AMZN'
    assert len(calls) == 1
    assert search.search('nonexistent', broker)['results'] == []


@pytest.mark.parametrize('value', ['', '  ', 'x' * 61, 'bad\nquery'])
def test_invalid_search_queries(value):
    with pytest.raises(ValueError): query_text(value)


def test_public_market_cache_evicts_old_searches_instead_of_permanently_filling():
    provider = PublicMarketData(Opener(json.dumps(search_payload()).encode()))
    for index in range(140): provider.search('company ' + str(index))
    assert len(provider.cache) == 128
    assert provider.search('Amazon')[0]['symbol'] == 'AMZN'
    assert len(provider.locks) == 0


def test_class_share_chart_uses_public_provider_symbol_without_changing_app_symbol():
    from trading_app.tests.test_public_market_data import payload
    provider = PublicMarketData(Opener(json.dumps(payload()).encode()))
    assert provider.quote('BRK.B')['symbol'] == 'BRK.B'
    assert '/BRK-B?' in provider.opener.calls[0].full_url


def test_search_endpoint_works_without_keys_and_requires_app_auth(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', '')
    monkeypatch.setenv('ALPACA_API_SECRET_KEY', '')
    monkeypatch.setenv('PUBLIC_MARKET_DATA', 'true')
    provider = PublicMarketData(Opener(json.dumps(search_payload()).encode()))
    app = create_app(db_path=tmp_path / 'search.sqlite3', public_client=provider, access_token='app-token', allowed_origins=[])
    with TestClient(app) as client:
        assert client.get('/api/stocks/search?q=Amazon').status_code == 401
        headers = {'Authorization': 'Bearer app-token'}
        response = client.get('/api/stocks/search?q=Amazon', headers=headers)
        assert response.status_code == 200 and response.json()['results'][0]['symbol'] == 'AMZN'
        assert client.get('/api/stocks/search?q=%20', headers=headers).status_code == 422
        assert client.get('/api/stocks/search?q=' + 'x' * 61, headers=headers).status_code == 422


def test_class_share_search_accepts_public_and_broker_notation():
    opener = Opener(json.dumps(search_payload()).encode())
    provider = PublicMarketData(opener)
    provider.search('BRK.B')
    assert 'q=BRK-B' in opener.calls[0].full_url
    broker = SimpleNamespace(assets=lambda: [{'symbol': 'BRK.B', 'name': 'Berkshire Hathaway', 'class': 'us_equity', 'status': 'active', 'tradable': True}])
    assert StockSearch(provider).search('BRK-B', broker)['results'][0]['symbol'] == 'BRK.B'
