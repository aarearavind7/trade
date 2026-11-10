"""Small, dependency-light client for Alpaca's paper-trading APIs."""

import os
import json
from typing import Any, Dict, Optional
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


DEFAULT_TRADING_URL = "https://paper-api.alpaca.markets"
DEFAULT_DATA_URL = "https://data.alpaca.markets"


class AlpacaError(RuntimeError):
    """Raised when Alpaca rejects a request or returns an invalid response."""


class _Response:
    def __init__(self, status_code: int, body: bytes) -> None:
        self.status_code = status_code
        self.body = body
        self.text = body.decode("utf-8", errors="replace")

    def json(self) -> Dict[str, Any]:
        return json.loads(self.text) if self.text else {}


class _UrllibSession:
    """Tiny session adapter so the demo has no third-party runtime dependency."""

    def request(self, method: str, url: str, **kwargs: Any) -> _Response:
        params = kwargs.get("params") or {}
        if params:
            url = "{}?{}".format(url, urlencode(params))

        body = None
        if kwargs.get("json") is not None:
            body = json.dumps(kwargs["json"]).encode("utf-8")

        headers = dict(kwargs.get("headers") or {})
        if body is not None:
            headers["Content-Type"] = "application/json"

        request = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=kwargs.get("timeout", 15)) as response:
                return _Response(response.status, response.read())
        except HTTPError as exc:
            return _Response(exc.code, exc.read())


class AlpacaClient:
    """Minimal client for account, latest-trade, and paper-order operations."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        trading_url: Optional[str] = None,
        data_url: Optional[str] = None,
        session: Optional[Any] = None,
        timeout: int = 15,
    ) -> None:
        self.api_key = api_key or os.getenv("ALPACA_API_KEY_ID")
        self.secret_key = secret_key or os.getenv("ALPACA_API_SECRET_KEY")
        if not self.api_key or not self.secret_key:
            raise ValueError(
                "Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY before running the demo."
            )

        self.trading_url = (trading_url or os.getenv("ALPACA_TRADING_URL") or DEFAULT_TRADING_URL).rstrip("/")
        self.data_url = (data_url or os.getenv("ALPACA_DATA_URL") or DEFAULT_DATA_URL).rstrip("/")
        self.session = session or _UrllibSession()
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        return {
            "APCA-API-KEY-ID": self.api_key,
            "APCA-API-SECRET-KEY": self.secret_key,
            "Accept": "application/json",
        }

    def _request(self, method: str, url: str, **kwargs: Any) -> Dict[str, Any]:
        response = self.session.request(
            method,
            url,
            headers=self._headers(),
            timeout=self.timeout,
            **kwargs,
        )
        try:
            payload = response.json()
        except ValueError:
            payload = {}

        if response.status_code >= 400:
            message = payload.get("message") or getattr(response, "text", "Request failed")
            raise AlpacaError("Alpaca request failed ({}): {}".format(response.status_code, message))

        return payload

    def account(self) -> Dict[str, Any]:
        """Return the paper account summary."""
        return self._request("GET", "{}/v2/account".format(self.trading_url))

    def latest_trade(self, symbol: str) -> Dict[str, Any]:
        """Return the latest IEX trade for a US stock symbol."""
        symbol = symbol.strip().upper()
        if not symbol:
            raise ValueError("symbol cannot be empty")
        encoded_symbol = quote(symbol, safe="")
        url = "{}/v2/stocks/{}/trades/latest".format(self.data_url, encoded_symbol)
        return self._request("GET", url, params={"feed": "iex"})

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str = "market",
        time_in_force: str = "day",
    ) -> Dict[str, Any]:
        """Submit a simple paper order."""
        symbol = symbol.strip().upper()
        side = side.strip().lower()
        order_type = order_type.strip().lower()
        time_in_force = time_in_force.strip().lower()

        if not symbol:
            raise ValueError("symbol cannot be empty")
        if side not in {"buy", "sell"}:
            raise ValueError("side must be buy or sell")
        if order_type not in {"market", "limit", "stop", "stop_limit", "trailing_stop"}:
            raise ValueError("unsupported order type")
        if time_in_force not in {"day", "gtc", "opg", "cls", "ioc", "fok"}:
            raise ValueError("unsupported time in force")
        if float(qty) <= 0:
            raise ValueError("qty must be greater than zero")

        payload = {
            "symbol": symbol,
            "qty": str(qty),
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
        }
        return self._request(
            "POST",
            "{}/v2/orders".format(self.trading_url),
            json=payload,
        )

