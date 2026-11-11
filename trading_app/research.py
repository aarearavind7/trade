"""Bounded server-side Financial Modeling Prep research requests."""
import json
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .alpaca_client import AlpacaClient
from .service import TradeError


def finite(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


class ResearchData:
    def __init__(self, key=None, opener=urlopen, monotonic=time.monotonic):
        self.key = (os.getenv('FMP_API_KEY', '') if key is None else key).strip()
        self.opener, self.monotonic = opener, monotonic
        self.cache, self.lock = {}, threading.Lock()

    @property
    def configured(self):
        return bool(self.key and not self.key.lower().startswith(('your_', 'replace', 'example')))

    def fetch(self, endpoint, params, ttl=300):
        if not self.configured:
            raise TradeError('Add FMP_API_KEY to the server .env and restart the app. Financial Modeling Prep access to these endpoints is required.', 503)
        cache_key = endpoint, tuple(sorted(params.items()))
        with self.lock:
            saved = self.cache.get(cache_key)
            if saved and self.monotonic() - saved[0] < ttl:
                return saved[1]
        url = 'https://financialmodelingprep.com/stable/' + endpoint + '?' + urlencode({**params, 'apikey': self.key})
        try:
            with self.opener(Request(url, headers={'Accept': 'application/json', 'User-Agent': 'TradeResearch/1.0'}), timeout=15) as response:
                raw = response.read(4000001)
            if len(raw) > 4000000:
                raise ValueError('Response too large')
            data = json.loads(raw)
            if not isinstance(data, list) or any(not isinstance(row, dict) for row in data):
                raise ValueError('Invalid research response')
        except (HTTPError, URLError, OSError, ValueError, TypeError) as exc:
            # Never propagate an upstream URL/body containing the API key.
            raise TradeError('Financial Modeling Prep is unavailable or denied this endpoint. Check the server key, subscription access, and request limits.', 502) from exc
        with self.lock:
            if len(self.cache) >= 128:
                self.cache.pop(next(iter(self.cache)))
            self.cache[cache_key] = self.monotonic(), data
        return data

    def fundamentals(self, symbol):
        symbol = AlpacaClient.symbol(symbol)
        if not self.configured:
            self.fetch('profile', {'symbol': symbol})
        requests = [('profile', {'symbol': symbol}), ('income-statement', {'symbol': symbol, 'period': 'annual', 'limit': 1}),
                    ('balance-sheet-statement', {'symbol': symbol, 'period': 'annual', 'limit': 1}), ('ratios-ttm', {'symbol': symbol}),
                    ('earnings-calendar', {'from': date.today().isoformat(), 'to': (date.today() + timedelta(days=90)).isoformat()})]
        errors, values = [], {}
        def read(item):
            endpoint, params = item
            try:
                return endpoint, self.fetch(endpoint, params, 3600), None
            except TradeError as exc:
                return endpoint, [], exc
        with ThreadPoolExecutor(max_workers=5) as executor:
            for endpoint, rows, error in executor.map(read, requests):
                values[endpoint] = rows
                if error:
                    errors.append(endpoint)
        if len(errors) == len(requests):
            raise TradeError('Add a valid FMP_API_KEY with financial-statement, ratios, profile and earnings-calendar access in the server .env, then restart. The provider is unavailable or access was denied.', 503 if not self.configured else 502)
        first = lambda key: next((row for row in values[key] if row.get('symbol') == symbol), {})
        profile, income, balance, ratios = (first(key) for key in ['profile', 'income-statement', 'balance-sheet-statement', 'ratios-ttm'])
        earnings = []
        for row in values['earnings-calendar']:
            if row.get('symbol') != symbol:
                continue
            try:
                day = date.fromisoformat(str(row.get('date'))[:10])
            except ValueError:
                continue
            if date.today() <= day <= date.today() + timedelta(days=90):
                earnings.append(day.isoformat())
        earnings.sort()
        return {'symbol': symbol, 'name': str(profile.get('companyName') or symbol)[:200], 'source': 'Financial Modeling Prep',
                'retrieved_at': datetime.now(timezone.utc).isoformat(), 'currency': income.get('reportedCurrency') or profile.get('currency'),
                'revenue': finite(income.get('revenue')), 'net_income': finite(income.get('netIncome')),
                'pe_ttm': finite(ratios.get('priceToEarningsRatioTTM')), 'total_debt': finite(balance.get('totalDebt')),
                'income_date': income.get('date'), 'debt_date': balance.get('date'), 'period': 'Annual',
                'next_earnings_date': earnings[0] if earnings else None, 'earnings_window_days': 90,
                'sector': str(profile.get('sector') or '')[:100], 'market_cap': finite(profile.get('marketCap')),
                'unavailable_sections': errors}

    def screen(self, filters):
        params = {'country': 'US', 'isActivelyTrading': 'true', 'limit': 100}
        fields = {'min_price': 'priceMoreThan', 'max_price': 'priceLowerThan', 'min_volume': 'volumeMoreThan',
                  'min_cap': 'marketCapMoreThan', 'max_cap': 'marketCapLowerThan', 'sector': 'sector'}
        for field, key in fields.items():
            if filters.get(field) is not None and filters[field] != '':
                params[key] = filters[field]
        candidates = self.fetch('company-screener', params, 60)
        symbols, seen = [], set()
        for row in candidates[:100]:
            if row.get('country') not in (None, 'US'):
                continue
            try:
                symbol = AlpacaClient.symbol(row.get('symbol', ''))
            except (ValueError, AttributeError):
                continue
            if symbol not in seen:
                symbols.append(symbol); seen.add(symbol)
        quotes = self.fetch('batch-quote', {'symbols': ','.join(symbols)}, 60) if symbols else []
        by_symbol = {row.get('symbol'): row for row in quotes}
        results = []
        for row in candidates[:100]:
            symbol = row.get('symbol')
            if symbol not in seen:
                continue
            seen.remove(symbol)
            quote = by_symbol.get(symbol, {})
            result = {'symbol': symbol, 'name': str(row.get('companyName') or symbol)[:200], 'sector': str(row.get('sector') or '')[:100],
                      'price': finite(quote.get('price', row.get('price'))), 'volume': finite(quote.get('volume', row.get('volume'))),
                      'market_cap': finite(quote.get('marketCap', row.get('marketCap'))), 'change_pct': finite(quote.get('changePercentage')),
                      'timestamp': quote.get('timestamp')}
            checks = [('min_price', 'price', True), ('max_price', 'price', False), ('min_volume', 'volume', True),
                      ('min_cap', 'market_cap', True), ('max_cap', 'market_cap', False), ('min_change', 'change_pct', True), ('max_change', 'change_pct', False)]
            if any(filters.get(field) is not None and (result[key] is None or (result[key] < filters[field] if minimum else result[key] > filters[field])) for field, key, minimum in checks):
                continue
            if filters.get('sector') and result['sector'].casefold() != filters['sector'].casefold():
                continue
            results.append(result)
        return {'results': results, 'source': 'Financial Modeling Prep', 'retrieved_at': datetime.now(timezone.utc).isoformat(),
                'candidate_count': len(candidates[:100]), 'candidate_limit': 100,
                'note': 'Up to 100 provider candidates; daily-change filters apply to those candidates, not the entire market. Quotes may be delayed; cached for up to 60 seconds.'}
