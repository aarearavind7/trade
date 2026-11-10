"""Small standard-library Alpaca client; credentials never leave this server."""
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

DEFAULT_TRADING_URL = 'https://paper-api.alpaca.markets'
DEFAULT_DATA_URL = 'https://data.alpaca.markets'
SYMBOL = re.compile(r'^[A-Z][A-Z0-9.\-]{0,9}$')


class AlpacaError(RuntimeError):
    def __init__(self, message, status_code=None):
        super().__init__(message)
        self.status_code = status_code


class _Response:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self.text = body.decode('utf-8', errors='replace')

    def json(self):
        return json.loads(self.text) if self.text else {}


class _UrllibSession:
    def request(self, method, url, **kwargs):
        params = kwargs.get('params') or {}
        if params:
            url += '?' + urlencode(params)
        body = None
        headers = dict(kwargs.get('headers') or {})
        if kwargs.get('json') is not None:
            body = json.dumps(kwargs['json']).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=kwargs.get('timeout', 15)) as response:
                return _Response(response.status, response.read())
        except HTTPError as exc:
            return _Response(exc.code, exc.read())
        except (URLError, TimeoutError, OSError) as exc:
            raise AlpacaError('Broker connection failed; order outcome may be unknown.') from exc


class AlpacaClient:
    def __init__(self, api_key=None, secret_key=None, trading_url=None, data_url=None,
                 session=None, timeout=15, feed='iex'):
        self.api_key = (api_key or os.getenv('ALPACA_API_KEY_ID') or '').strip()
        self.secret_key = (secret_key or os.getenv('ALPACA_API_SECRET_KEY') or '').strip()
        if any(not value or value.lower().startswith(('your_', 'paste_your_')) for value in (self.api_key, self.secret_key)):
            raise ValueError('Replace ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY with your actual Alpaca paper keys.')
        self.trading_url = (trading_url or os.getenv('ALPACA_TRADING_URL') or DEFAULT_TRADING_URL).strip().rstrip('/')
        self.data_url = (data_url or os.getenv('ALPACA_DATA_URL') or DEFAULT_DATA_URL).strip().rstrip('/')
        # This application intentionally supports only the paper endpoint.
        if self.trading_url != DEFAULT_TRADING_URL or self.data_url != DEFAULT_DATA_URL:
            raise ValueError('Only the official Alpaca paper-trading and market-data endpoints are supported.')
        if feed not in {'iex', 'sip', 'delayed_sip'}:
            raise ValueError('Unsupported market-data feed.')
        self.feed = feed
        self.session = session or _UrllibSession()
        self.timeout = timeout

    def _headers(self):
        return {'APCA-API-KEY-ID': self.api_key, 'APCA-API-SECRET-KEY': self.secret_key, 'Accept': 'application/json'}

    def _request(self, method, url, **kwargs):
        response = self.session.request(method, url, headers=self._headers(), timeout=self.timeout, **kwargs)
        try:
            payload = response.json()
        except (ValueError, TypeError) as exc:
            raise AlpacaError('Broker returned an invalid response.', response.status_code) from exc
        if response.status_code >= 400:
            message = payload.get('message', 'Request failed') if isinstance(payload, dict) else 'Request failed'
            raise AlpacaError('Alpaca request failed ({}): {}'.format(response.status_code, message), response.status_code)
        if not isinstance(payload, (dict, list)):
            raise AlpacaError('Broker returned an invalid response.')
        return payload

    @staticmethod
    def symbol(value):
        value = value.strip().upper()
        if not SYMBOL.fullmatch(value):
            raise ValueError('Enter a valid US equity symbol.')
        return value

    def account(self):
        return self._request('GET', self.trading_url + '/v2/account')

    def positions(self):
        return self._request('GET', self.trading_url + '/v2/positions')

    def clock(self):
        return self._request('GET', self.trading_url + '/v2/clock')

    def asset(self, symbol):
        return self._request('GET', self.trading_url + '/v2/assets/' + quote(self.symbol(symbol), safe=''))

    def latest_trade(self, symbol):
        symbol = quote(self.symbol(symbol), safe='')
        return self._request('GET', self.data_url + '/v2/stocks/' + symbol + '/trades/latest', params={'feed': self.feed})

    def snapshot(self, symbol):
        symbol = quote(self.symbol(symbol), safe='')
        return self._request('GET', self.data_url + '/v2/stocks/' + symbol + '/snapshot', params={'feed': self.feed})

    def bars(self, symbol, period='1D'):
        days, timeframe = {'1D': (1, '1Min'), '1W': (7, '1Hour'), '1M': (31, '1Day'), '1Y': (366, '1Day')}[period]
        delay = 16 if self.feed == 'delayed_sip' else 0
        end = datetime.now(timezone.utc) - timedelta(minutes=delay)
        start = end - timedelta(days=days)
        params = {'timeframe': timeframe, 'start': start.isoformat(), 'end': end.isoformat(),
                  'feed': self.feed, 'adjustment': 'all', 'limit': 10000, 'sort': 'asc'}
        result = self._request('GET', self.data_url + '/v2/stocks/' + quote(self.symbol(symbol), safe='') + '/bars', params=params)
        return {'bars': result.get('bars') or [], 'feed': self.feed, 'delayed': bool(delay),
                'delay_minutes': delay, 'timeframe': timeframe, 'next_page_token': result.get('next_page_token')}

    def orders(self, status='all'):
        return self._request('GET', self.trading_url + '/v2/orders', params={'status': status, 'limit': 500, 'direction': 'desc', 'nested': 'false'})

    def order_by_client_id(self, client_id):
        return self._request('GET', self.trading_url + '/v2/orders:by_client_order_id', params={'client_order_id': client_id})

    def cancel_order(self, order_id):
        return self._request('DELETE', self.trading_url + '/v2/orders/' + quote(order_id, safe=''))

    def fills(self):
        rows, token = [], None
        # Stop with explicit incomplete coverage instead of silently misreporting P/L.
        for _ in range(100):
            params = {'activity_types': 'FILL', 'direction': 'desc', 'page_size': 100}
            if token:
                params['page_token'] = token
            page = self._request('GET', self.trading_url + '/v2/account/activities', params=params)
            if not isinstance(page, list):
                raise AlpacaError('Invalid fill history response.')
            rows.extend(page)
            if len(page) < 100:
                return rows, True
            next_token = page[-1]['id']
            if next_token == token:
                break
            token = next_token
        return rows, False

    def portfolio_history(self):
        return self._request('GET', self.trading_url + '/v2/account/portfolio/history',
                             params={'period': '1M', 'timeframe': '1D', 'intraday_reporting': 'market_hours'})

    def submit_order(self, symbol, side, qty, order_type='market', time_in_force='day',
                     limit_price=None, client_order_id=None):
        symbol = self.symbol(symbol)
        side, order_type = side.strip().lower(), order_type.strip().lower()
        if side not in {'buy', 'sell'}:
            raise ValueError('side must be buy or sell')
        if order_type not in {'market', 'limit'}:
            raise ValueError('Only market and limit orders are supported.')
        if time_in_force != 'day':
            raise ValueError('Only day orders are supported.')
        if not math.isfinite(float(qty)) or float(qty) <= 0:
            raise ValueError('qty must be finite and greater than zero')
        if order_type == 'limit' and (limit_price is None or not math.isfinite(float(limit_price)) or float(limit_price) <= 0):
            raise ValueError('A positive limit_price is required for limit orders.')
        payload = {'symbol': symbol, 'qty': str(qty), 'side': side, 'type': order_type, 'time_in_force': time_in_force}
        if order_type == 'limit':
            payload['limit_price'] = str(limit_price)
        if client_order_id:
            payload['client_order_id'] = client_order_id
        return self._request('POST', self.trading_url + '/v2/orders', json=payload)
