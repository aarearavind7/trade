import json
from datetime import date, timedelta
from io import BytesIO
from urllib.error import HTTPError
from urllib.parse import urlparse, parse_qs

import pytest
from fastapi.testclient import TestClient
from trading_app.research import ResearchData
from trading_app.benchmark import comparison
from trading_app.api import create_app
from trading_app.service import TradeError
from trading_app.tests.test_api import FakeBroker


class Response:
    def __init__(self, data): self.data = json.dumps(data).encode()
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size): return self.data[:size]


class Provider:
    def __init__(self): self.calls = []; self.failed = set()
    def __call__(self, request, **kwargs):
        self.calls.append(request.full_url)
        endpoint = urlparse(request.full_url).path.split('/')[-1]
        if endpoint in self.failed:
            raise HTTPError(request.full_url, 403, 'SECRET-KEY upstream denial', {}, BytesIO(b'SECRET-KEY'))
        values = {
            'profile': [{'symbol': 'AAPL', 'companyName': 'Apple', 'currency': 'USD', 'sector': 'Technology', 'marketCap': 3000}],
            'income-statement': [{'symbol': 'AAPL', 'date': '2025-09-30', 'reportedCurrency': 'USD', 'revenue': 123, 'netIncome': 40}],
            'balance-sheet-statement': [{'symbol': 'AAPL', 'date': '2025-09-30', 'totalDebt': 12}],
            'ratios-ttm': [{'symbol': 'AAPL', 'priceToEarningsRatioTTM': 24}],
            'earnings-calendar': [{'symbol': 'AAPL', 'date': (date.today() + timedelta(days=8)).isoformat()}, {'symbol': 'MSFT', 'date': date.today().isoformat()}],
            'company-screener': [{'symbol': 'AAPL', 'companyName': 'Apple', 'country': 'US', 'sector': 'Technology', 'price': 100, 'volume': 5000, 'marketCap': 3000}, {'symbol': 'MSFT', 'country': 'US', 'price': 50, 'sector': 'Technology'}],
            'batch-quote': [{'symbol': 'AAPL', 'price': 101, 'volume': 6000, 'marketCap': 3100, 'changePercentage': 2.1, 'timestamp': 1794411000}, {'symbol': 'MSFT', 'price': 50, 'changePercentage': -3}]
        }
        return Response(values[endpoint])


def test_fundamentals_preserve_financial_periods_and_cache_server_side():
    provider = Provider(); data = ResearchData('SECRET-KEY', provider)
    first = data.fundamentals('aapl')
    assert first['symbol'] == 'AAPL' and first['revenue'] == 123 and first['net_income'] == 40
    assert first['pe_ttm'] == 24 and first['total_debt'] == 12
    assert first['income_date'] == '2025-09-30' and first['period'] == 'Annual'
    assert first['next_earnings_date'] == (date.today() + timedelta(days=8)).isoformat()
    assert 'SECRET-KEY' not in json.dumps(first)
    data.fundamentals('AAPL'); assert len(provider.calls) == 5


def test_partial_financial_failure_is_missing_instead_of_zero_and_secrets_are_not_returned():
    provider = Provider(); provider.failed.add('income-statement')
    data = ResearchData('SECRET-KEY', provider).fundamentals('AAPL')
    assert data['revenue'] is None and data['net_income'] is None
    assert data['unavailable_sections'] == ['income-statement']
    provider.failed = {'profile', 'income-statement', 'balance-sheet-statement', 'ratios-ttm', 'earnings-calendar'}
    with pytest.raises(TradeError) as error: ResearchData('SECRET-KEY', provider).fundamentals('AAPL')
    assert error.value.status == 502 and 'SECRET-KEY' not in error.value.message
    with pytest.raises(TradeError) as error: ResearchData('').fundamentals('AAPL')
    assert error.value.status == 503


def test_screener_enforces_all_filters_against_actual_quotes_and_labels_bounded_universe():
    provider = Provider()
    data = ResearchData('SECRET-KEY', provider).screen(dict(min_price=100, max_price=102, min_volume=5500, min_cap=3000, max_cap=3200, sector='Technology', min_change=2, max_change=3))
    assert [row['symbol'] for row in data['results']] == ['AAPL']
    assert data['results'][0]['price'] == 101 and data['results'][0]['change_pct'] == 2.1
    assert data['candidate_limit'] == 100 and data['candidate_count'] == 2
    query = parse_qs(urlparse(provider.calls[0]).query)
    assert query['country'] == ['US'] and query['priceMoreThan'] == ['100']


@pytest.mark.parametrize('payload', [{}, None, 'SECRET-KEY', [{'symbol': 'AAPL'}, None]])
def test_bad_provider_responses_are_sanitized(payload):
    with pytest.raises(TradeError, match='unavailable or denied'):
        ResearchData('SECRET-KEY', lambda *args, **kwargs: Response(payload)).screen({})


def test_benchmark_matches_dates_then_normalizes_common_start_without_zero_filling():
    history = {'timestamp': [1794236400, 1794322800, 1794409200], 'equity': [100, 110, 120]}
    data = comparison(history, [{'timestamp': 1794322800, 'close': 200}, {'timestamp': 1794409200, 'close': 210}])
    assert len(data['points']) == 2
    assert data['points'][0]['portfolio_pct'] == 0
    assert data['portfolio_return_pct'] == pytest.approx((120 / 110 - 1) * 100)
    assert data['benchmark_return_pct'] == pytest.approx(5)
    assert 'deposits' in data['note'] and 'excludes dividends' in data['note']
    with pytest.raises(TradeError, match='two matching'):
        comparison(history, [{'timestamp': 1794322800, 'close': 0}, {'timestamp': 'bad', 'close': 100}])


def test_research_and_benchmark_routes_are_authorized_and_validate_filters(tmp_path):
    public = type('Public', (), {'benchmark_history': lambda self: [{'timestamp': 1794236400, 'close': 100}, {'timestamp': 1794322800, 'close': 102}]})()
    app = create_app(broker=FakeBroker(), db_path=tmp_path / 'test.sqlite', access_token='app-token', allowed_origins=[], research_client=ResearchData('SECRET-KEY', Provider()), public_client=public)
    with TestClient(app) as client:
        for path in ['/api/research/AAPL/fundamentals', '/api/screener', '/api/benchmark']:
            assert client.get(path).status_code == 401
            assert client.get(path, headers={'Authorization': 'Bearer app-token'}).status_code == 200
        for query in ['min_price=100&max_price=10', 'min_volume=-1', 'min_change=-101', 'min_cap=20&max_cap=10']:
            assert client.get('/api/screener?' + query, headers={'Authorization': 'Bearer app-token'}).status_code == 422


def test_invalid_fundamentals_symbol_returns_validation_error_not_server_failure(tmp_path):
    app = create_app(db_path=tmp_path / 'research.sqlite', access_token='', allowed_origins=[], research_client=ResearchData(''))
    with TestClient(app) as client:
        assert client.get('/api/research/invalid!/fundamentals').status_code == 422
