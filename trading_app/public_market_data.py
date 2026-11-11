"""Read-only public market charts. No account credentials or order operations."""
import json
import math
import threading
import time
import re
from collections import OrderedDict
from weakref import WeakValueDictionary
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from .alpaca_client import AlpacaClient


class PublicDataError(Exception):
    pass


class PublicMarketData:
    source = 'Yahoo Finance'
    periods = {'1D': ('1d', '1m'), '1W': ('5d', '15m'), '1M': ('1mo', '1d'), '1Y': ('1y', '1d')}

    def __init__(self, opener=urlopen, monotonic=time.monotonic):
        self.opener, self.monotonic = opener, monotonic
        self.cache, self.locks = OrderedDict(), WeakValueDictionary()
        self.lock = threading.Lock()

    def key_lock(self, key):
        with self.lock:
            lock = self.locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self.locks[key] = lock
            return lock

    def cached(self, key, ttl=5):
        with self.lock:
            cached = self.cache.get(key)
            if cached and self.monotonic() - cached[0] < ttl:
                self.cache.move_to_end(key)
                return cached[1]
        return None

    def remember(self, key, value):
        with self.lock:
            self.cache[key] = self.monotonic(), value
            self.cache.move_to_end(key)
            while len(self.cache) > 128:
                self.cache.popitem(last=False)

    def chart(self, symbol, period='1D', *, benchmark=False):
        symbol = '^GSPC' if benchmark else AlpacaClient.symbol(symbol)
        key = symbol, period
        with self.key_lock(key):
            cached = self.cached(key)
            if cached is not None:
                return cached
            span, interval = self.periods[period]
            url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + quote(symbol.replace('.', '-'), safe='')
            url += '?' + urlencode({'range': span, 'interval': interval, 'includePrePost': 'false'})
            request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
            try:
                with self.opener(request, timeout=10) as response:
                    raw = response.read(2000001)
                    if len(raw) > 2000000:
                        raise PublicDataError('Public market-data response was too large.')
                    payload = json.loads(raw)
                result = payload['chart']['result'][0]
                if not isinstance(result, dict) or not isinstance(result.get('meta'), dict):
                    raise ValueError('Invalid chart')
            except HTTPError as exc:
                if exc.code == 429:
                    raise PublicDataError('Public market data is rate-limited. Wait a minute and click Refresh prices.') from exc
                raise PublicDataError('Public market data is unavailable for this symbol. Try again later or connect Alpaca.') from exc
            except (URLError, OSError, TimeoutError, ValueError, TypeError, KeyError, IndexError) as exc:
                raise PublicDataError('Could not load public market data. Check internet access and retry; Alpaca is available as an alternative.') from exc
            self.remember(key, result)
            return result

    def search(self, query):
        key = 'search', query.casefold()
        with self.key_lock(key):
            cached = self.cached(key, ttl=60)
            if cached is not None:
                return cached
            provider_query = query.upper().replace('.', '-') if re.fullmatch(r'[A-Z]{1,5}\.[A-Z]', query.upper()) else query
            url = 'https://query1.finance.yahoo.com/v1/finance/search?' + urlencode({'q': provider_query, 'quotesCount': 20, 'newsCount': 0})
            try:
                request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
                with self.opener(request, timeout=10) as response:
                    raw = response.read(2000001)
                if len(raw) > 2000000:
                    raise ValueError('Response too large')
                quotes = json.loads(raw)['quotes']
                if not isinstance(quotes, list):
                    raise ValueError('Invalid search response')
            except (HTTPError, URLError, OSError, TimeoutError, ValueError, KeyError, TypeError) as exc:
                raise PublicDataError('Stock search is temporarily unavailable. Wait a moment and search again, or check Connection setup.') from exc
            rows, seen = [], set()
            exchanges = {'NMS', 'NYQ', 'NGM', 'NCM', 'PCX', 'ASE', 'BTS'}
            for row in quotes:
                if not isinstance(row, dict) or row.get('quoteType') not in {'EQUITY', 'ETF'} or row.get('exchange') not in exchanges:
                    continue
                try:
                    symbol = row['symbol']
                    if re.fullmatch(r'[A-Z]{1,5}-[A-Z]', symbol):
                        symbol = symbol.replace('-', '.')
                    symbol = AlpacaClient.symbol(symbol)
                except (KeyError, ValueError, TypeError, AttributeError):
                    continue
                if symbol in seen:
                    continue
                seen.add(symbol)
                rows.append({'symbol': symbol, 'name': str(row.get('shortname') or row.get('longname') or symbol)[:200],
                             'exchange': str(row.get('exchDisp') or row.get('exchange'))[:30]})
            self.remember(key, rows[:10])
            return rows[:10]

    @staticmethod
    def price(value):
        try:
            result = float(value)
        except (ValueError, TypeError) as exc:
            raise PublicDataError('The public source returned an invalid price.') from exc
        if not math.isfinite(result) or result <= 0:
            raise PublicDataError('The public source returned an invalid price.')
        return result

    def quote(self, symbol):
        data = self.chart(symbol)
        meta = data['meta']
        price = self.price(meta.get('regularMarketPrice'))
        try:
            stamp = datetime.fromtimestamp(meta['regularMarketTime'], timezone.utc)
        except (ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise PublicDataError('The public source returned no usable quote timestamp.') from exc
        previous = meta.get('chartPreviousClose') or meta.get('previousClose')
        try:
            previous = self.price(previous) if previous else None
        except PublicDataError:
            previous = None
        return {'symbol': AlpacaClient.symbol(symbol), 'price': str(price), 'timestamp': stamp.isoformat(),
                'age_seconds': max(0, round((datetime.now(timezone.utc) - stamp).total_seconds())),
                'previous_close': str(previous) if previous else None,
                'change_pct': str((price / previous - 1) * 100) if previous else None,
                'feed': 'public', 'source': self.source, 'coverage': self.source,
                'delayed': True, 'timing_verified': False, 'currency': meta.get('currency', 'USD')}

    def bars(self, symbol, period='1D'):
        data = self.chart(symbol, period)
        try:
            timestamps = data.get('timestamp') or []
            quote = data['indicators']['quote'][0]
            closes = quote['close']
            bars = []
            for index, (stamp, close) in enumerate(zip(timestamps, closes)):
                if close is None:
                    continue
                bar = {'t': datetime.fromtimestamp(stamp, timezone.utc).isoformat(), 'c': self.price(close)}
                for field, key in [('open', 'o'), ('high', 'h'), ('low', 'l')]:
                    values = quote.get(field) or []
                    try:
                        bar[key] = self.price(values[index])
                    except (IndexError, PublicDataError):
                        pass  # Missing OHLC stays missing; the chart can show a close-only line.
                volumes = quote.get('volume') or []
                if index < len(volumes) and isinstance(volumes[index], (int, float)) and math.isfinite(volumes[index]) and volumes[index] >= 0:
                    bar['v'] = volumes[index]
                bars.append(bar)
        except (KeyError, TypeError, IndexError, ValueError, OSError, OverflowError) as exc:
            raise PublicDataError('The public source returned invalid chart data.') from exc
        return {'bars': bars, 'feed': 'public', 'source': self.source, 'delayed': True,
                'timing_verified': False, 'delay_minutes': None, 'next_page_token': None}

    def benchmark_history(self):
        data = self.chart('^GSPC', '1M', benchmark=True)
        if data.get('meta', {}).get('symbol') != '^GSPC':
            raise PublicDataError('The public source did not return the S&P 500 index.')
        try:
            return [{'timestamp': stamp, 'close': close} for stamp, close in zip(data.get('timestamp') or [], data['indicators']['quote'][0]['close']) if close is not None]
        except (KeyError, TypeError, IndexError) as exc:
            raise PublicDataError('S&P 500 history is unavailable.') from exc

    def clock(self):
        meta = self.chart('AAPL')['meta']
        regular = (meta.get('currentTradingPeriod') or {}).get('regular') or {}
        now = datetime.now(timezone.utc)
        start, end = regular.get('start'), regular.get('end')
        known = isinstance(start, (int, float)) and isinstance(end, (int, float))
        return {'is_open': bool(known and start <= now.timestamp() < end), 'timestamp': now.isoformat(),
                'next_open': None, 'next_close': None, 'source': self.source, 'estimated': True,
                'schedule_available': known}
