"""Read-only, cached S&P 500 membership data for bulk watchlist additions."""
import csv
import io
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .alpaca_client import AlpacaClient
from .public_market_data import PublicDataError

SOURCE_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv'


class SP500Catalog:
    def __init__(self, opener=urlopen, monotonic=time.monotonic):
        self.opener, self.monotonic = opener, monotonic
        self.result, self.expires = None, 0
        self.lock = threading.Lock()

    @staticmethod
    def parse(raw):
        reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
        if not reader.fieldnames or 'Symbol' not in reader.fieldnames or not ({'Security', 'Name'} & set(reader.fieldnames)):
            raise ValueError('Invalid membership columns')
        rows, seen = [], set()
        for row in reader:
            try:
                symbol = AlpacaClient.symbol((row.get('Symbol') or '').replace('-', '.'))
            except ValueError as exc:
                raise ValueError('Invalid constituent ticker') from exc
            name = (row.get('Security') or row.get('Name') or '').strip()
            if not name:
                raise ValueError('Missing constituent name')
            if symbol in seen:
                continue
            seen.add(symbol)
            rows.append({'symbol': symbol, 'name': name[:200], 'sector': (row.get('GICS Sector') or row.get('Sector') or '')[:80], 'exchange': 'S&P 500 constituent'})
        if not 400 <= len(rows) <= 600:
            raise ValueError('Incomplete membership list')
        return sorted(rows, key=lambda row: row['symbol'])

    def constituents(self):
        with self.lock:
            if self.result is not None and self.monotonic() < self.expires:
                return self.result
            try:
                request = Request(SOURCE_URL, headers={'User-Agent': 'TradeDashboard/1.0', 'Accept': 'text/csv'})
                with self.opener(request, timeout=15) as response:
                    raw = response.read(1000001)
                if len(raw) > 1000000:
                    raise ValueError('Membership response too large')
                rows = self.parse(raw)
            except (HTTPError, URLError, OSError, TimeoutError, ValueError, TypeError) as exc:
                raise PublicDataError('The S&P 500 company list is unavailable or incomplete. Please try again later. Your watchlist has not been changed.') from exc
            self.result = {'results': rows, 'count': len(rows), 'source': 'DataHub / datasets S&P 500 companies',
                           'source_url': SOURCE_URL, 'fetched_at': datetime.now(timezone.utc).isoformat(),
                           'description': 'Constituent listings may exceed 500 because some companies have multiple share classes. Membership follows the referenced dataset, not a real-time official index feed.'}
            self.expires = self.monotonic() + 86400
            return self.result
