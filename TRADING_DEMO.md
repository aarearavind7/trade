# Trade paper-trading application

A FastAPI backend and responsive dashboard for one Alpaca **paper account**. The dashboard reads broker balances, positions, timestamped market data, orders, fills, and equity history. Alpaca credentials stay on the Python server. Orders require an explicit review and confirmation.

## Start on your Mac (recommended)

Install Python 3.11 or newer once from python.org. In IntelliJ’s Terminal, from the project folder:

```bash
git pull origin main
./start.command
```

You can also double-click **start.command** in Finder. The launcher finds a supported Python, creates the project `.venv` if needed, installs missing/changed runtime dependencies, and creates a private `.env` template only when one does not already exist. It preserves existing keys and trading state. The first setup may need internet access to download dependencies.

The browser opens **after** the API is ready. Leave the launcher Terminal open; use **Ctrl+C** to stop it. Stop any older server first when applying backend updates. An already running compatible Trade server is reused. If an unrelated process occupies the default port, the launcher automatically tries ports 8001–8019 without stopping that process.

To select an exact port, use `./start.command --port 8001`; an occupied explicit port produces instructions instead of switching ports. The browser opens `/?local=1` on the chosen address so stale saved remote API settings cannot redirect the dashboard to another server. If that changes the saved API origin, its old session token is cleared; enter the local application token in Connection setup if required. To suppress browser opening, add `--no-browser`. If the executable permission was lost while copying files, run `chmod +x start.command` once. Python older than 3.11 and older existing virtual environments produce setup instructions rather than being deleted automatically.

## Guided connection setup

Click **Connection setup** in the dashboard header. Choose **Use local server** for the current local page origin (including its port), or `http://127.0.0.1:8000` when viewing a hosted page. You can also enter the address printed by your launcher. A hosted API can still use its own HTTPS origin.

**Check connection** performs three read-only checks:

1. **API server:** confirms the address is this application and validates any app access token.
2. **Market data:** requests a timestamped AAPL quote from the selected source and reports data availability or uncertain/stale timing.
3. **Paper account (optional):** verifies paper-account access and reports inactive or restricted accounts separately from a market-data failure.

Each result includes a next action. These checks never submit orders and do not return brokerage credentials, account identifiers, or balances. The screen accepts only the optional **application access token**; brokerage keys remain in the server’s `.env`. No API settings are saved unless the Trade API responds to the check and you click **Connect workspace**. Provider/account warnings can remain visible even when the API connection itself succeeds.

For a local server, open the launcher’s own dashboard address directly. A hosted frontend connecting to another origin also needs the explicit CORS configuration described below. Public market prices remain usable without a paper account; the setup screen explains how to enable paper orders when you are ready.

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

The source and quote timestamps are shown. Public quote timing is **not verified**, so the UI says **may be delayed** and refreshes prices and charts every 10 seconds while visible rather than claiming a real-time stream. **Refresh prices** requests a manual refresh; chart responses are cached on the server for 5 seconds to reduce provider load. Public market-session status is only a provider-schedule estimate.

This public chart endpoint is an external, unauthenticated service and can change, block requests, or rate-limit your server. In those cases the app displays a provider error; it does not generate replacement prices. Your server needs HTTPS access to `query1.finance.yahoo.com`. No Alpaca credentials are sent to Yahoo Finance.

Balances, positions, P/L, and order history require an actual account and are hidden in market-only mode. Order submission, review, and Alpaca streaming remain disabled without a configured paper account. Public prices are never passed to the broker order/risk service. Once valid Alpaca configuration is loaded and the server restarted, the existing paper-trading and Alpaca streaming workflow applies. Syntactically configured but rejected Alpaca credentials still need to be corrected; broker authentication failures are not silently relabelled as public data.

Set `PUBLIC_MARKET_DATA=false` to disable the public fallback and retain the setup-required screen until Alpaca credentials are available.

## Candlesticks, volume, and moving averages

The market chart starts in **Candles** mode; choose **Line** for closing prices. Green candles close at or above their open, red candles close below it, and wicks show each bar's high and low. **Volume** adds separately scaled bars beneath prices. **SMA 20** (gold) and **SMA 50** (purple) are simple averages of the last 20 / 50 bar closes at the selected chart timeframe, not necessarily calendar days. A moving-average line begins only once enough real bars are available. Each indicator has its own toggle.

Hover or tap the chart for a crosshair with cursor price and bar time. The readout shows that bar's open, high, low, close, volume, and enabled averages. Times use your browser's local timezone. Focus the chart and use **← / →**, **Home**, or **End** to inspect bars; **Escape** clears the selection.

OHLC and volume come from Alpaca historical/stream bars or Yahoo Finance chart fields. Missing fields are never synthesized: incomplete candles show close dots, a close-only series falls back to a line, and missing volume is marked unavailable. Live trade ticks supply provisional close dots until the broker supplies the complete minute bar. Longer ranges refresh historical bars normally. Delay/source labels still apply; these indicators do not make delayed data real-time. At most 1,500 recent bars are drawn, with averages calculated from the available returned history before that display cutoff.

## Download CSV records

Use **Download CSV** in **Trade history** or **Portfolio performance**. These account-only downloads require configured Alpaca paper credentials and the same API access token as other account routes. Public-price mode cannot supply account records.

- Trade history exports all available broker fills (up to the existing 10,000-fill retrieval bound), rather than only the latest 100 displayed rows. Columns include fill/order IDs, broker timestamp, symbol, side, quantity, price, decimal-calculated value, currency, and `fill_history_complete`. A false coverage flag means the provider history was truncated; it is not a complete lifetime ledger.
- Performance exports the broker's last month of daily equity observations: UTC timestamp, equity, provider P/L and P/L ratio, base value, and timeframe. Current realized/unrealized P/L and fill-accounting coverage are repeated as explicitly named **current** summary columns; they are not historical daily realized P/L. Unreconciled realized P/L and missing provider values remain blank. `broker_profit_loss_ratio` uses 0.01 for 1%.

Files are UTF-8 CSV with a BOM for spreadsheet compatibility. Empty history produces column headings with no records. Text fields that could be interpreted as spreadsheet formulas are escaped. Export failures appear beside the button; an error page is never downloaded as a CSV. Read-only routes are `GET /api/exports/trades.csv` and `GET /api/exports/performance.csv`.

## Stock search and custom watchlist

Use **+ Add stocks** in the watchlist header. Search by ticker or company name (for example, `AMZN`, `Amazon`, or `Berkshire`). Results are limited to eligible US stocks and ETFs. Click **Add** to save a result and open its chart. The chart tabs and order asset selector update immediately. The **×** action beside a watchlist row removes that stock.

The default five symbols are only starting selections. You can save up to **1,000** unique listings, remove every stock, and build a new list. The watchlist table and chart tabs show **20 listings per page**. Use Previous, Next, or the page selector to browse. The order asset selector includes your complete saved list. Searching for an already saved stock offers **View** to jump directly to its page and chart. Changes are saved in this browser's local storage for this dashboard origin and survive reloads. Different browser profiles or different origins (`localhost` versus `127.0.0.1`, or different ports) keep separate selections. If storage is unavailable, the UI reports that changes last only for the current session. Watchlist edits do not submit order requests.

**+ Add S&P 500** adds the complete constituent list in one action and preserves stocks you already saved. The list can contain more than 500 securities because some companies have multiple share classes (for example, Alphabet and Berkshire Hathaway). Additions are deduplicated; repeating the action does not create extra rows. The source is the DataHub / `datasets/s-and-p-500-companies` public dataset, fetched from its referenced CSV and cached on the server for 24 hours. The response and import message include the source/fetch time; membership follows that dataset rather than a real-time official index-membership feed.

The bulk action downloads **names and symbols only**. Prices refresh and streaming subscriptions follow the **visible 20-symbol page**, including when a saved stock is selected through search or the order dropdown. Other listings remain saved and load when their page is opened. This keeps hundreds of symbols from triggering hundreds of simultaneous provider requests. No orders are submitted by the import.

The importer validates the CSV schema, symbol/name fields, uniqueness, and plausible list size. Source errors or a list that cannot fit within 1,000 saved entries leave the current watchlist intact. It adds source constituents without deleting older saved entries; it is not an automatic index-rebalancing tool. Your server needs HTTPS access to `raw.githubusercontent.com` for the membership CSV.

Search uses Alpaca's active, tradable US-equity catalogue when paper credentials are configured (cached for one hour), or Yahoo Finance search in public market-only mode (cached for one minute). Foreign listings, futures, and duplicate public results are filtered out. US class-share notation is normalized, such as `BRK.B` in the application and `BRK-B` for Yahoo chart requests. The public response cache evicts older entries rather than requiring a restart after many different searches.

The Alpaca stream follows the visible watchlist page. Tabs share the union of their visible requested symbols through one upstream connection; changing that union closes the old connection before reconnecting with the new symbols. Each tab receives only its requested prices and bars. Up to **50 distinct symbols across open tabs** are supported; an explicit connection message explains when that limit or a provider subscription limit is reached. Without streaming access, periodic REST updates still load the visible page of the saved watchlist.

## Market data

- `ALPACA_DATA_FEED=iex` is the default. It provides exchange-specific IEX data, not the consolidated US market. Quote timestamps, feed coverage, and market open/closed status are visible.
- `sip` requires the corresponding Alpaca data entitlement. `delayed_sip` is an explicitly delayed feed.
- A quote older than 120 seconds is marked delayed/stale. Orders are blocked during an open session when the reference quote is stale; use a current entitled feed for trading.
- IEX and entitled SIP historical requests now end at the current time; the previous fixed 16-minute delay is removed for these feeds. `delayed_sip` history keeps a labelled 16-minute delay. No bars may be returned overnight, on holidays, or over a weekend for the 1D range; choose 1W or longer.
- The backend authenticates to Alpaca's stock-market WebSocket at `wss://stream.data.alpaca.markets/v2/<feed>` and subscribes to trades, minute bars, and corrected bars for the current watchlists (AAPL, MSFT, NVDA, GOOGL, and TSLA are the initial defaults). One connection per Python process is shared across browser tabs. Alpaca credentials never reach the browser.
- Authenticated server-sent events (`GET /api/market/stream`) update watchlist prices, the selected price, and the order estimate as trades arrive. The **1D chart** updates its current minute from trades and accepts completed/corrected one-minute broker bars. Current-minute points are provisional until the broker completes that bar. Longer ranges use refreshed historical bars.
- A connection indicator shows live, delayed/stale, connecting, reconnecting, or unavailable. It never fabricates trades when a market is closed or a symbol is inactive. IEX only covers IEX trades, so it may update less frequently than consolidated SIP.
- Transport interruptions reconnect with a capped backoff. Permission, authentication, or subscription-limit denials stop automatic stream retries and show an actionable message; fix the cause and click **Refresh**. The browser cancels streams when hidden and reconnects when visible. REST prices and charts refresh every 10 seconds while visible; account/history refresh continues every 30 seconds; quote freshness is checked every five seconds.
- Browser SSE uses `fetch` with an `Authorization` header when an app token is configured; tokens are never placed in stream URLs. Idle heartbeats detect lost connections. Slow browsers use bounded queues and may skip intermediate ticks; this is a charting UI, not a tick archive. Partial failures display a warning; previously shown values may be stale.

## In-app price alerts

Click **Set alert** beside the chart controls, or **+ Create alert** in the **Price alerts** panel. Select a watchlist stock, choose **at or above** / **at or below**, and enter a USD target. Targets support up to four decimal places. Alerts can be created in public market-data mode without Alpaca paper keys.

An alert establishes a baseline from the latest available quote and triggers **once** when a newer quote meets the inclusive condition. An older/already displayed quote does not fire a newly created alert. Without an initial reference quote, the first successful quote establishes the baseline. Duplicate and out-of-order timestamps are ignored, including nanosecond ordering within a millisecond. Switching the market-data provider establishes a new baseline instead of treating a provider-price difference as a target hit.

A hit shows an in-app toast and adds a notification to the **Alerts** button in the header. Notifications include the observed price, provider, quote timestamp, observation time, and uncertain/delayed timing when applicable. Open the notification history to mark items read, remove them, or mark all read. The latest 100 notifications and unread state are saved. A triggered alert remains triggered across reloads until you explicitly **Re-arm** it. Use **Pause**, **Resume**, or **Delete** to manage alerts; repeated target rules point you to the existing alert instead of creating duplicates.

Monitoring checks up to **20 distinct active symbols** about every **10 seconds**, independently of watchlist pagination and open order-review dialogs. Visible Alpaca trade events can trigger sooner. Removing a stock from the watchlist does not remove its existing alerts; their quotes are still polled. Save up to **50 alert records**, including paused and triggered alerts. Pausing a symbol's alerts frees an active monitoring slot. A resumed/re-armed alert starts from the current reference quote again.

These are browser-side, in-app alerts: keep the dashboard and browser running. Hidden-tab timers can be throttled or suspended, and a closed page does not monitor prices or send email/OS push notifications. Reopening checks newer available quotes; it does not reconstruct every historical crossing. Delayed/public data and sampling intervals can miss brief moves. Quote errors or unavailable prices never imply a target hit.

Settings, last observed quotes, and notification history are stored under `trade-price-alerts-v1` in this browser's local storage for the dashboard origin, separately from the watchlist. They are not shared across devices. Storage failures show a session-only message. Same-origin tabs reload shared state before mutations, use Web Locks where available, and deduplicate notification IDs by alert/re-arm cycle. Alerts never invoke the order API.

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
| GET | `/api/health` | Service identity, configuration status, and application-auth requirement (no provider requests). |
| GET | `/api/connection` | Authenticated read-only server, market-data, and paper-account connection checks. |
| GET | `/api/account` | Paper-account balances and status. |
| GET | `/api/positions` | Broker positions, average cost, unrealized P/L. |
| GET | `/api/market/clock` | Exchange clock and next open/close. |
| GET | `/api/market/stream?symbols=AAPL,AMZN` | Authenticated SSE for 1–20 validated symbols, with prices, minute bars, connection status and heartbeats. Omit `symbols` for the original defaults. |
| GET | `/api/stocks/search?q=Amazon` | Search US stocks/ETFs by name or ticker; up to 10 results. |
| GET | `/api/stocks/sp500` | Cached S&P 500 constituent listings with source and fetch time; no prices or orders. |
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
python -m pytest trading_app/tests --cov=trading_app --cov=scripts.start_local --cov-report=term-missing --cov-fail-under=80
npm ci --prefix web
npm test --prefix web
```

Tests use mocked broker responses and browser DOM/network adapters; they never contact Alpaca. They cover order validation, duplicate/concurrent submissions, crash and timeout recovery, risk reservations, quote staleness, API authorization/failures, fill accounting, review/confirmation, browser recovery after uncertain submissions, shared stream connections, reconnection/denials, fragmented SSE parsing, stale snapshot protection, connection diagnostics, rejected settings, launcher setup, automatic port selection and local-origin recovery, orderly startup/shutdown, OHLC/volume propagation, SMA/crosshair calculations and controls, authenticated CSV export/coverage/precision, stock search/filtering, watchlist persistence and empty states, stale search responses, dynamic stream isolation across tabs, full S&P 500 imports, membership-source failures, duplicate prevention, and page-bounded price/stream requests, above/below alerts, stale/duplicate quote rejection, cross-tab notification deduplication, off-page monitoring, persistence, and alert management.

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
