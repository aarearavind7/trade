"""Search eligible US stocks/ETFs without exposing account credentials."""
import threading
import time
import re
from .alpaca_client import AlpacaClient, AlpacaError


def query_text(value):
    value = value.strip()
    if not 1 <= len(value) <= 60 or any(ord(char) < 32 for char in value):
        raise ValueError('Enter a stock symbol or company name (1–60 characters).')
    return value


class StockSearch:
    def __init__(self, public_client, monotonic=time.monotonic):
        self.public_client, self.monotonic = public_client, monotonic
        self.catalog = []
        self.broker = None
        self.expires = 0
        self.lock = threading.Lock()

    def search(self, query, broker=None):
        query = query_text(query)
        if broker is None:
            return {'results': self.public_client.search(query), 'source': 'Yahoo Finance'}
        with self.lock:
            if broker is not self.broker or self.monotonic() >= self.expires:
                assets = broker.assets()
                if not isinstance(assets, list):
                    raise AlpacaError('Invalid asset catalogue response.')
                rows = []
                for asset in assets:
                    if not isinstance(asset, dict) or asset.get('status') != 'active' or not asset.get('tradable') or asset.get('class') != 'us_equity':
                        continue
                    try:
                        symbol = AlpacaClient.symbol(asset['symbol'])
                    except (KeyError, ValueError, AttributeError):
                        continue
                    rows.append({'symbol': symbol, 'name': str(asset.get('name') or symbol)[:200],
                                 'exchange': str(asset.get('exchange') or 'US equity')[:30]})
                self.catalog, self.broker, self.expires = rows, broker, self.monotonic() + 3600
            needle = query.casefold()
            symbol_needle = needle.replace('-', '.') if re.fullmatch(r'[a-z]{1,5}-[a-z]', needle) else needle
            matches = [row for row in self.catalog if symbol_needle in row['symbol'].casefold() or needle in row['name'].casefold()]
            matches.sort(key=lambda row: (row['symbol'].casefold() != symbol_needle, not row['symbol'].casefold().startswith(symbol_needle), row['symbol']))
            return {'results': matches[:10], 'source': 'Alpaca'}
