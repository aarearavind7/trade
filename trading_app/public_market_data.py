"""Read-only public market charts. No account credentials or order operations."""
import json
import math
import threading
import time
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
        self.cache, self.locks = {}, {}
        self.lock = threading.Lock()

    def chart(self, symbol, period='1D'):
        symbol = AlpacaClient.symbol(symbol)
        key = symbol, period
        with self.lock:
            if key not in self.locks:
                if len(self.locks) >= 128:
                    raise PublicDataError('Public quote capacity reached. Restart the service to clear the cache.')
                self.locks[key] = threading.Lock()
            key_lock = self.locks[key]
        with key_lock:
            cached = self.cache.get(key)
            if cached and self.monotonic() - cached[0] < 15:
                return cached[1]
            span, interval = self.periods[period]
            url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + quote(symbol, safe='')
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
            self.cache[key] = self.monotonic(), result
            return result

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
            closes = data['indicators']['quote'][0]['close']
            bars = []
            for stamp, close in zip(timestamps, closes):
                if close is None:
                    continue
                bars.append({'t': datetime.fromtimestamp(stamp, timezone.utc).isoformat(), 'c': self.price(close)})
        except (KeyError, TypeError, IndexError, ValueError, OSError, OverflowError) as exc:
            raise PublicDataError('The public source returned invalid chart data.') from exc
        return {'bars': bars, 'feed': 'public', 'source': self.source, 'delayed': True,
                'timing_verified': False, 'delay_minutes': None, 'next_page_token': None}

    def clock(self):
        meta = self.chart('AAPL')['meta']
        regular = (meta.get('currentTradingPeriod') or {}).get('regular') or {}
        now = datetime.now(timezone.utc)
        start, end = regular.get('start'), regular.get('end')
        known = isinstance(start, (int, float)) and isinstance(end, (int, float))
        return {'is_open': bool(known and start <= now.timestamp() < end), 'timestamp': now.isoformat(),
                'next_open': None, 'next_close': None, 'source': self.source, 'estimated': True,
                'schedule_available': known}
