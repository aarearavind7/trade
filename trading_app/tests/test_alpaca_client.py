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

