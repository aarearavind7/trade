import unittest

from trading_app.alpaca_client import AlpacaClient, AlpacaError


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self.payload = payload or {}
        self.text = text

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.response


class AlpacaClientTests(unittest.TestCase):
    def client(self, response):
        session = FakeSession(response)
        return AlpacaClient(
            api_key="test-key",
            secret_key="test-secret",
            session=session,
        ), session

    def test_account_sends_authentication_headers(self):
        client, session = self.client(FakeResponse(payload={"status": "ACTIVE"}))

        result = client.account()

        self.assertEqual({"status": "ACTIVE"}, result)
        self.assertEqual("GET", session.calls[0][0])
        self.assertEqual(
            "test-key",
            session.calls[0][2]["headers"]["APCA-API-KEY-ID"],
        )

    def test_latest_trade_uses_iex_feed(self):
        client, session = self.client(FakeResponse(payload={"symbol": "AAPL"}))

        client.latest_trade(" aapl ")

        self.assertIn("/v2/stocks/AAPL/trades/latest", session.calls[0][1])
        self.assertEqual({"feed": "iex"}, session.calls[0][2]["params"])

    def test_submit_order_builds_paper_order_payload(self):
        client, session = self.client(FakeResponse(payload={"id": "order-1"}))

        result = client.submit_order("aapl", "buy", 2)

        self.assertEqual("order-1", result["id"])
        self.assertEqual(
            {
                "symbol": "AAPL",
                "qty": "2",
                "side": "buy",
                "type": "market",
                "time_in_force": "day",
            },
            session.calls[0][2]["json"],
        )

    def test_invalid_quantity_is_rejected_before_request(self):
        client, session = self.client(FakeResponse())

        with self.assertRaises(ValueError):
            client.submit_order("AAPL", "buy", 0)

        self.assertEqual([], session.calls)

    def test_api_error_is_reported(self):
        client, _ = self.client(
            FakeResponse(status_code=401, payload={"message": "unauthorized"})
        )

        with self.assertRaisesRegex(AlpacaError, "unauthorized"):
            client.account()


if __name__ == "__main__":
    unittest.main()



class ExtendedClientTests(unittest.TestCase):
    def client(self, payload=None, status=200):
        session = FakeSession(FakeResponse(status, payload))
        return AlpacaClient(api_key='test-key', secret_key='test-secret', session=session), session

    def test_live_or_untrusted_endpoints_are_rejected(self):
        for settings in [{'trading_url': 'https://api.alpaca.markets'}, {'data_url': 'https://example.com'}, {'feed': 'untrusted'}]:
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                AlpacaClient(api_key='test', secret_key='test', **settings)

    def test_orders_positions_clock_assets_and_cancellation(self):
        client, session = self.client({'ok': True})
        client.positions(); client.clock(); client.asset('aapl'); client.orders('open')
        client.order_by_client_id('trade-123'); client.cancel_order('order-id'); client.portfolio_history()
        self.assertIn('/v2/positions', session.calls[0][1])
        self.assertIn('/v2/clock', session.calls[1][1])
        self.assertIn('/v2/assets/AAPL', session.calls[2][1])
        self.assertEqual('open', session.calls[3][2]['params']['status'])
        self.assertEqual('trade-123', session.calls[4][2]['params']['client_order_id'])
        self.assertEqual('DELETE', session.calls[5][0])
        self.assertEqual('1M', session.calls[6][2]['params']['period'])

    def test_bars_snapshot_and_limit_order(self):
        client, session = self.client({'bars': [{'c': 100}]})
        self.assertEqual([{'c': 100}], client.bars('aapl', '1M')['bars'])
        self.assertEqual('1Day', session.calls[0][2]['params']['timeframe'])
        client.snapshot('aapl')
        self.assertIn('/AAPL/snapshot', session.calls[1][1])
        client.submit_order('aapl', 'buy', 2, 'limit', limit_price=100, client_order_id='trade-review')
        payload = session.calls[-1][2]['json']
        self.assertEqual('100', payload['limit_price'])
        self.assertEqual('trade-review', payload['client_order_id'])
        for kwargs in [{'side': 'short'}, {'order_type': 'stop'}, {'time_in_force': 'gtc'}, {'qty': float('inf')}, {'order_type': 'limit'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                client.submit_order(**{'symbol': 'AAPL', 'side': 'buy', 'qty': 1, **kwargs})

    def test_malformed_responses_raise_instead_of_returning_empty_success(self):
        client, session = self.client()
        session.response.payload = 'not-an-object'
        with self.assertRaises(AlpacaError): client.account()
        session.response.json = lambda: (_ for _ in ()).throw(ValueError('bad JSON'))
        with self.assertRaises(AlpacaError): client.account()

    def test_fill_history_pagination_is_complete(self):
        client, session = self.client()
        pages = [[{'id': str(i)} for i in range(100)], [{'id': 'last'}]]
        def request(method, url, **kwargs):
            session.calls.append((method, url, kwargs))
            return FakeResponse(payload=pages.pop(0))
        session.request = request
        rows, complete = client.fills()
        self.assertTrue(complete)
        self.assertEqual(101, len(rows))
        self.assertEqual('99', session.calls[1][2]['params']['page_token'])

    def test_fill_pagination_loop_and_bad_shape_mark_incomplete(self):
        client, session = self.client([{'id': str(i)} for i in range(100)])
        self.assertFalse(client.fills()[1])
        session.response.payload = {'unexpected': True}
        with self.assertRaises(AlpacaError): client.fills()

    def test_urllib_transport_and_timeout(self):
        from unittest.mock import patch
        from trading_app.alpaca_client import _UrllibSession, _Response
        from urllib.error import HTTPError, URLError
        from io import BytesIO
        session = _UrllibSession()
        with patch('trading_app.alpaca_client.urlopen') as open_url:
            open_url.return_value.__enter__.return_value.status = 200
            open_url.return_value.__enter__.return_value.read.return_value = b'{"ok":true}'
            result = session.request('POST', 'https://paper-api.alpaca.markets/v2/orders', params={'feed': 'iex'}, json={'symbol': 'AAPL'}, headers={'Accept': 'application/json'})
            self.assertTrue(result.json()['ok'])
            request = open_url.call_args.args[0]
            self.assertIn('?feed=iex', request.full_url)
            self.assertIn(b'AAPL', request.data)
        with patch('trading_app.alpaca_client.urlopen', side_effect=URLError('timeout')):
            with self.assertRaises(AlpacaError): session.request('GET', 'https://data.alpaca.markets')
        error = HTTPError('https://data.alpaca.markets', 429, 'limited', {}, BytesIO(b'{"message":"limited"}'))
        with patch('trading_app.alpaca_client.urlopen', side_effect=error):
            self.assertEqual(429, session.request('GET', 'https://data.alpaca.markets').status_code)
        self.assertEqual({}, _Response(204, b'').json())


class ConfigurationTests(unittest.TestCase):
    def test_placeholder_or_whitespace_secret_is_not_accepted(self):
        for secret in ('your_paper_secret_key', '  ', 'YOUR_SECRET'):
            with self.subTest(secret=secret), self.assertRaises(ValueError):
                AlpacaClient(api_key='test-key', secret_key=secret)

    def test_copy_paste_whitespace_is_trimmed(self):
        client = AlpacaClient(api_key=' test-key ', secret_key=' test-secret ',
                              trading_url=' https://paper-api.alpaca.markets/ ')
        self.assertEqual('test-key', client.api_key)
        self.assertEqual('test-secret', client.secret_key)
        self.assertEqual('https://paper-api.alpaca.markets', client.trading_url)
