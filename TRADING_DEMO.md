# Trade paper-trading application

A FastAPI backend and responsive dashboard for one Alpaca **paper account**. The dashboard reads broker balances, positions, timestamped market data, orders, fills, and equity history. Alpaca credentials stay on the Python server. Orders require an explicit review and confirmation.

## Run locally

Requires Python 3.11+; Node.js 22+ is needed only for dashboard tests.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r trading_app/requirements.txt
cp .env.example .env
```

To enable paper trading, edit `.env` privately and replace `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` with **paper** keys from Alpaca. Prices and charts can be viewed without keys using the public market-data mode described below. The app loads `.env` automatically; never commit it. The server rejects live-trading or alternative API endpoints.

```bash
uvicorn trading_app.api:app --host 127.0.0.1 --port 8000 --no-proxy-headers
```

Open **http://localhost:8000**. Interactive API documentation is at **http://localhost:8000/docs**. A static `python -m http.server` alone cannot provide trading features. With no Alpaca credentials, the UI shows real public prices and charts from Yahoo Finance and disables orders. Account-only panels are hidden; it never substitutes fabricated balances or prices.

For a token-protected service, set `API_ACCESS_TOKEN` to a long random value, then use **Connect API** in the dashboard to enter the server URL and that application token. Never enter Alpaca keys in the browser. The app token is stored in the tab's session storage; an unfinished review ID and the API URL are stored locally for recovery.

## Fix repeated 503 responses on first startup

If the dashboard loads (`GET /` returns 200) but account, positions, orders, and market endpoints all return 503, the broker configuration has not initialized. Open `http://localhost:8000/api/health` to see `broker_configured` and a setup message. This check validates configuration without contacting Alpaca; `true` does not prove that Alpaca accepts your credentials.

1. Stop Uvicorn with **Ctrl+C**.
2. From the repository root, run `cp -n .env.example .env` to create the private file without overwriting an existing one.
3. Open `.env` in IntelliJ. Replace both `your_paper_*` placeholders with your actual **paper** key and secret from your Alpaca paper account. Keep `ALPACA_TRADING_URL=https://paper-api.alpaca.markets`, `ALPACA_DATA_URL=https://data.alpaca.markets`, and `ALPACA_DATA_FEED=iex`.
4. Restart Uvicorn, then refresh the browser. While setup is incomplete, orders remain disabled. With the default public fallback, prices and charts still load without keys; with `PUBLIC_MARKET_DATA=false`, the dashboard pauses automatic polling until setup is fixed. After correcting setup, use **Refresh** to retry.

Never post `.env` or your keys in chat, screenshots, GitHub issues, or commits. Values already exported in the shell take precedence over `.env`; remove stale exported Alpaca variables from that shell before restarting if necessary. Invalid broker credentials or data permissions produce a separate upstream error after configuration succeeds.

## Prices and charts without API keys

Run the FastAPI app normally and open `http://127.0.0.1:8000`. When Alpaca credentials are missing or still placeholders, `PUBLIC_MARKET_DATA=true` (the default) enables a read-only Yahoo Finance view automatically. The watchlist and all chart ranges populate from public market data; there is no demo-price generator.

The source and quote timestamps are shown. Public quote timing is **not verified**, so the UI says **may be delayed** and refreshes every 30 seconds rather than claiming a real-time stream. **Refresh prices** requests a manual refresh; chart responses are cached on the server for 15 seconds to reduce provider load. Public market-session status is only a provider-schedule estimate.

This public chart endpoint is an external, unauthenticated service and can change, block requests, or rate-limit your server. In those cases the app displays a provider error; it does not generate replacement prices. Your server needs HTTPS access to `query1.finance.yahoo.com`. No Alpaca credentials are sent to Yahoo Finance.

Balances, positions, P/L, and order history require an actual account and are hidden in market-only mode. Order submission, review, and Alpaca streaming remain disabled without a configured paper account. Public prices are never passed to the broker order/risk service. Once valid Alpaca configuration is loaded and the server restarted, the existing paper-trading and Alpaca streaming workflow applies. Syntactically configured but rejected Alpaca credentials still need to be corrected; broker authentication failures are not silently relabelled as public data.

Set `PUBLIC_MARKET_DATA=false` to disable the public fallback and retain the setup-required screen until Alpaca credentials are available.

## Market data

- `ALPACA_DATA_FEED=iex` is the default. It provides exchange-specific IEX data, not the consolidated US market. Quote timestamps, feed coverage, and market open/closed status are visible.
- `sip` requires the corresponding Alpaca data entitlement. `delayed_sip` is an explicitly delayed feed.
- A quote older than 120 seconds is marked delayed/stale. Orders are blocked during an open session when the reference quote is stale; use a current entitled feed for trading.
- IEX and entitled SIP historical requests now end at the current time; the previous fixed 16-minute delay is removed for these feeds. `delayed_sip` history keeps a labelled 16-minute delay. No bars may be returned overnight, on holidays, or over a weekend for the 1D range; choose 1W or longer.
- The backend authenticates to Alpaca's stock-market WebSocket at `wss://stream.data.alpaca.markets/v2/<feed>` and subscribes to trades, minute bars, and corrected bars for AAPL, MSFT, NVDA, GOOGL, and TSLA. One connection per Python process is shared across browser tabs. Alpaca credentials never reach the browser.
- Authenticated server-sent events (`GET /api/market/stream`) update watchlist prices, the selected price, and the order estimate as trades arrive. The **1D chart** updates its current minute from trades and accepts completed/corrected one-minute broker bars. Current-minute points are provisional until the broker completes that bar. Longer ranges use refreshed historical bars.
- A connection indicator shows live, delayed/stale, connecting, reconnecting, or unavailable. It never fabricates trades when a market is closed or a symbol is inactive. IEX only covers IEX trades, so it may update less frequently than consolidated SIP.
- Transport interruptions reconnect with a capped backoff. Permission, authentication, or subscription-limit denials stop automatic stream retries and show an actionable message; fix the cause and click **Refresh**. The browser cancels streams when hidden and reconnects when visible. REST account/history refresh continues every 30 seconds as a fallback; quote freshness is checked every five seconds.
- Browser SSE uses `fetch` with an `Authorization` header when an app token is configured; tokens are never placed in stream URLs. Idle heartbeats detect lost connections. Slow browsers use bounded queues and may skip intermediate ticks; this is a charting UI, not a tick archive. Partial failures display a warning; previously shown values may be stale.

## Orders and recovery

1. Select a stock, side, quantity, and order type. Market orders support up to six fractional-share decimals when the asset permits them. Limit orders use whole shares, a positive limit price, and `day` time in force.
2. Click **Review**, inspect the price timestamp and estimate, then **Confirm paper order**. Reviews expire after 60 seconds; limits and broker account state are rechecked at submission.
3. Activity shows broker states including pending, partially filled, filled, rejected, canceled, and expired. A successful API submission means accepted by the broker, not necessarily filled.
4. **Cancel** requests cancellation only. The broker can still fill an order before cancellation takes effect; refresh to see its final status.

Each review has one durable ID, used to derive Alpaca's `client_order_id`. Repeated confirmations return the same recorded order. SQLite serializes submissions across workers and records the submission intent before contacting the broker, so retries after a process restart cannot create a second order from that review.

A network failure or ambiguous broker response may leave the outcome **unknown**. The API blocks new orders until that review is reconciled. Use **Reconcile** in Activity; the app looks up the exact client ID at Alpaca. A broker `404` following a timeout does **not** prove that no order was accepted, so the app does not automatically replace it. If it stays unknown, inspect that exact `trade-<review-id>` in the paper broker dashboard or contact Alpaca. An operator must establish the final broker outcome before repairing a local record; never delete the database or blindly submit a new order to bypass this check.

The SQLite path defaults to `trading_app/data/orders.sqlite3`, configurable with `TRADING_DB_PATH`. Preserve the database, WAL files, and storage volume across deployments. All workers must use the same SQLite file on a local persistent filesystem. This is a single-account app, not a multi-user brokerage service. Trades made outside this app are reflected when broker state refreshes, but external trades cannot be serialized by this application's lock.

## Risk controls

Configured on the server, returned by `GET /api/risk`, and enforced for both review and submission:

| Setting | Default | Behavior |
| --- | --- | --- |
| `MAX_POSITION_PCT` | `20` | Maximum long exposure to one symbol as a percentage of current equity, including pending buys. |
| `MAX_ORDER_NOTIONAL` | `5000` | Maximum estimated value per order. |
| `MAX_DAILY_LOSS` | `1000` | Pause new buys once equity falls this many dollars below broker `last_equity` (previous close). Sells remain available, subject to order and holding limits. |

Market orders use a 2% reserve buffer. Pending buy orders reserve cash and position exposure; pending sell orders reserve shares. Buys are limited to available cash and broker buying power; this app does not intentionally use margin or open short positions. Active, tradable US equities are required. The broker applies additional checks and can reject an order after this app's validation.

The daily loss calculation includes transfers and other changes in broker equity; it is an account-equity guard rather than trading-only daily P/L. Risk checks use current snapshots and estimates, not guaranteed execution prices. Concurrent orders made directly through other Alpaca tools can change account state after validation.

## Performance and history

Positions show broker average purchase price, market value, and unrealized P/L. Portfolio performance includes the broker's last month of daily equity history. Trade history shows the latest 100 fills; Activity shows the latest 30 orders from the broker's most recent 500 orders.

Realized P/L uses **weighted-average cost accounting for long-only fills**, excluding fees, dividends, and corporate actions. The service paginates up to 10,000 fill records. It reports realized P/L as unavailable when history is truncated, a sell has no matching purchase history, or calculated quantities do not reconcile with current positions. This is educational performance reporting, not a tax statement. Historical data can lag current fills; refresh after executions settle.

## API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Service status and application-auth requirement. |
| GET | `/api/account` | Paper-account balances and status. |
| GET | `/api/positions` | Broker positions, average cost, unrealized P/L. |
| GET | `/api/market/clock` | Exchange clock and next open/close. |
| GET | `/api/market/stream` | Authenticated SSE prices, minute bars, feed/connection status, and heartbeats. |
| GET | `/api/market/{symbol}/quote` | Timestamped Alpaca trade or read-only public quote when paper configuration is unavailable. |
| GET | `/api/market/{symbol}/bars?period=1D` | Historical bars; also `1W`, `1M`, `1Y`. |
| POST | `/api/orders/review` | Validate a draft and create a 60-second review. |
| POST | `/api/orders` | Submit `{ "review_id": "..." }` idempotently. |
| GET | `/api/orders` | Recent broker orders and local recovery records. |
| GET | `/api/orders/by-review/{review_id}` | Reconcile a review with its broker order. |
| DELETE | `/api/orders/{order_id}` | Request cancellation. |
| GET | `/api/risk` | Configured controls and current daily loss. |
| GET | `/api/performance` | Realized/unrealized P/L, coverage and equity history. |
| GET | `/api/trades?limit=100` | Fill history; up to 1,000 returned records. |

Example review body:

```json
{"symbol":"AAPL","side":"buy","qty":"1","order_type":"limit","limit_price":"100.00"}
```

All account/trading endpoints require `Authorization: Bearer <API_ACCESS_TOKEN>` when configured. Requests from outside loopback are rejected if the server has no application token. Exact origin checks protect browser mutations; CORS is disabled unless explicitly configured.

## Hosting

The existing private dashboard is at https://trade-practice-aarearavind.lendtrace-9126.chatgpt.site. Its static host cannot execute Python. Deploy FastAPI to a Python/container host, then use **Connect API** on the hosted dashboard to select that backend. Or serve everything together from FastAPI on your own host.

Before exposing the backend:

- Set `API_ACCESS_TOKEN` privately in the host's secret settings and configure Alpaca paper credentials there.
- Set `ALLOWED_HOSTS` to the API hostname (without a scheme or port), plus localhost if needed. Use HTTPS at the host's ingress.
- For the existing hosted frontend, set `ALLOWED_ORIGINS=https://trade-practice-aarearavind.lendtrace-9126.chatgpt.site`. CORS configuration requires a token and exact origins; wildcards are rejected.
- Attach persistent writable storage for `TRADING_DB_PATH`. Keep one app instance/storage volume, or workers on the same local filesystem. Separate replicas with separate SQLite databases are unsupported.
- Run one Uvicorn worker for streaming (Alpaca free feeds commonly allow only one upstream market-data connection per account). Close other running Alpaca stream clients if subscription is denied. Multiple tabs share the worker connection. Configure proxies to allow long-lived SSE responses without buffering, with an idle timeout above the 15-second heartbeat.
- Run `uvicorn trading_app.api:app --host 0.0.0.0 --port 8000 --no-proxy-headers --timeout-graceful-shutdown 5`. Keeping proxy-header trust disabled prevents forwarded addresses from being treated as localhost.

A container definition is included:

```bash
docker build -t trade-paper .
docker run --rm --env-file .env -p 127.0.0.1:8000:8000 \
  --mount type=volume,source=trade-orders,target=/app/trading_app/data trade-paper
```

The container runs as an unprivileged user. `.env`, local state, Git metadata, and development dependencies are excluded from its build context. Supply secrets at runtime. Hosting the backend and entering paper credentials remain required before the published frontend can fetch data or place orders.

## Tests and CI

```bash
python -m pip install -r trading_app/requirements-dev.txt
python -m pytest trading_app/tests --cov=trading_app --cov-report=term-missing --cov-fail-under=80
npm ci --prefix web
npm test --prefix web
```

Tests use mocked broker responses and browser DOM/network adapters; they never contact Alpaca. They cover order validation, duplicate/concurrent submissions, crash and timeout recovery, risk reservations, quote staleness, API authorization/failures, fill accounting, review/confirmation, browser recovery after uncertain submissions, shared stream connections, reconnection/denials, fragmented SSE parsing, and stale snapshot protection.

`.github/workflows/trading-tests.yml` runs the Python suite on 3.11, 3.12, and 3.13 with an 80% coverage floor, checks JavaScript syntax, and runs dashboard tests. Existing repository-validation workflows remain in place. DOM tests do not replace full visual browser testing or an integration check with your own paper account.

## Original CLI

The low-level CLI remains available:

```bash
set -a
source .env
set +a
python -m trading_app.cli account
python -m trading_app.cli price AAPL
python -m trading_app.cli order AAPL buy 1
python -m trading_app.cli order AAPL buy 1 --type limit --limit-price 100
```

The CLI calls the broker client directly; use the dashboard/API for reviewed, idempotent orders and configured application risk controls.
