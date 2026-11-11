"""FastAPI application. Run with uvicorn trading_app.api:app --host 127.0.0.1."""
import hmac
import os
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
from starlette.middleware.trustedhost import TrustedHostMiddleware
from typing import Literal

from .alpaca_client import AlpacaClient, AlpacaError
from .service import OrderDraft, OrderStore, RiskLimits, TradeError, TradingService, fill_performance
from .market_stream import MarketStream, stream_events, watch_symbols
from .public_market_data import PublicMarketData, PublicDataError
from .stock_search import StockSearch, query_text
from .sp500_catalog import SP500Catalog
from .research import ResearchData
from .journal import JournalDraft, JournalUpdate, JournalStore
from .benchmark import comparison
from .csv_export import performance_csv, trades_csv

ROOT = Path(__file__).resolve().parents[1]


class SubmitRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    review_id: UUID


def create_app(broker=None, db_path=None, limits=None, access_token=None, allowed_origins=None, public_client=None, sp500_catalog=None, research_client=None):
    load_dotenv(ROOT / '.env')
    token = access_token if access_token is not None else os.getenv('API_ACCESS_TOKEN', '')
    origins = allowed_origins if allowed_origins is not None else [s.strip() for s in os.getenv('ALLOWED_ORIGINS', '').split(',') if s.strip()]
    if origins and (not token or '*' in origins):
        raise ValueError('Cross-origin hosting requires API_ACCESS_TOKEN and exact ALLOWED_ORIGINS (no wildcard).')
    limits = limits or RiskLimits(Decimal(os.getenv('MAX_POSITION_PCT', '20')), Decimal(os.getenv('MAX_ORDER_NOTIONAL', '5000')), Decimal(os.getenv('MAX_DAILY_LOSS', '1000')))
    store = OrderStore(db_path or os.getenv('TRADING_DB_PATH', str(ROOT / 'trading_app/data/orders.sqlite3')))
    @asynccontextmanager
    async def lifespan(application):
        yield
        if application.state.market_stream is not None:
            await application.state.market_stream.close()

    application = FastAPI(title='Trade Paper API', version='1.6.0', lifespan=lifespan, description='Single-user, long-only Alpaca paper trading. All order submissions require a short-lived server review.')
    application.state.market_stream = None
    application.state.broker = broker
    application.state.public_market_data = public_client or PublicMarketData()
    application.state.stock_search = StockSearch(application.state.public_market_data)
    application.state.sp500_catalog = sp500_catalog or SP500Catalog()
    public_enabled = os.getenv('PUBLIC_MARKET_DATA', 'true').strip().lower() in {'true', '1', 'yes'}
    application.state.research = research_client or ResearchData()
    application.state.journal = JournalStore(store)
    application.state.store = store
    application.state.limits = limits
    hosts = [s.strip() for s in os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1],testserver').split(',')]
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)
    if origins:
        application.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=['GET', 'POST', 'PUT', 'DELETE'],
                                   allow_headers=['Authorization', 'Content-Type'], allow_credentials=False)

    @application.middleware('http')
    async def protect_requests(request, call_next):
        if request.url.path.startswith('/api/') and request.method != 'OPTIONS':
            if not token and request.client and request.client.host not in {'127.0.0.1', '::1', 'testclient'}:
                return JSONResponse({'detail': 'Set API_ACCESS_TOKEN before exposing this service outside localhost.'}, status_code=403)
            if request.method in {'POST', 'DELETE', 'PUT', 'PATCH'}:
                origin = request.headers.get('origin')
                same_origin = str(request.base_url).rstrip('/')
                if origin and origin != same_origin and origin not in origins:
                    return JSONResponse({'detail': 'Origin is not allowed.'}, status_code=403)
                if request.headers.get('sec-fetch-site') == 'cross-site' and origin not in origins:
                    return JSONResponse({'detail': 'Cross-site request denied.'}, status_code=403)
        response = await call_next(request)
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    def authorize(authorization: str | None = Header(default=None)):
        if token and not hmac.compare_digest(authorization or '', 'Bearer ' + token):
            raise HTTPException(401, 'Enter the application access token to connect. Never enter Alpaca API keys here.', headers={'WWW-Authenticate': 'Bearer'})

    def broker_configuration():
        if application.state.broker is None:
            try:
                application.state.broker = AlpacaClient(feed=os.getenv('ALPACA_DATA_FEED', 'iex'))
            except ValueError as exc:
                return None, ('Configure Alpaca paper trading: ' + str(exc) +
                              ' Edit .env in the project root (beside .env.example), then restart Uvicorn and refresh this page.')
        return application.state.broker, None

    def service(_=Depends(authorize)):
        configured_broker, setup_message = broker_configuration()
        if setup_message:
            raise HTTPException(503, setup_message)
        return TradingService(configured_broker, store, limits)

    def market_source(_=Depends(authorize)):
        configured_broker, setup_message = broker_configuration()
        if configured_broker is not None:
            return 'alpaca', TradingService(configured_broker, store, limits)
        if public_enabled:
            return 'public', application.state.public_market_data
        raise HTTPException(503, setup_message)

    @application.exception_handler(PublicDataError)
    async def public_data_error(request, exc):
        return JSONResponse({'detail': str(exc), 'source': 'Yahoo Finance'}, status_code=502)

    @application.exception_handler(TradeError)
    async def trade_error(request, exc):
        return JSONResponse({'detail': exc.message}, status_code=exc.status)

    @application.exception_handler(AlpacaError)
    async def broker_error(request, exc):
        # Do not return upstream bodies or credential-bearing errors to the browser.
        return JSONResponse({'detail': 'Alpaca is unavailable or denied the request. Check server credentials, data entitlement, and account status.',
                             'upstream_status': exc.status_code}, status_code=502)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # Pydantic may include non-JSON exceptions and raw request input in its error context.
        return JSONResponse({'detail': [{'loc': e['loc'], 'msg': e['msg'], 'type': e['type']} for e in exc.errors()]}, status_code=422)

    @application.get('/api/health')
    def health():
        configured_broker, setup_message = broker_configuration()
        return {'status': 'ok', 'service': 'trade-paper-api', 'mode': 'paper', 'authentication_required': bool(token),
                'broker_configured': configured_broker is not None, 'setup_message': setup_message,
                'market_stream': configured_broker is not None, 'research_configured': application.state.research.configured,
                'public_market_data': public_enabled and configured_broker is None}

    @application.get('/api/connection')
    def connection(_=Depends(authorize)):
        """Probe read access only. Never expose credentials, balances, or submit orders."""
        configured_broker, setup_message = broker_configuration()

        def check_account():
            if configured_broker is None:
                return {'status': 'not_configured', 'message': 'Paper trading is optional. No paper account is configured.',
                        'action': 'For orders, add your Alpaca paper key and secret to .env in IntelliJ. Restart the launcher after saving. Keep keys on the server.'}
            try:
                account = configured_broker.account()
                if not isinstance(account, dict):
                    raise TradeError('Invalid account response.', 502)
                blocked = account.get('status') != 'ACTIVE' or any(account.get(key) for key in ('trading_blocked', 'account_blocked', 'trade_suspended_by_user'))
                return {'status': 'blocked' if blocked else 'connected',
                        'message': 'Alpaca responded, but this account is blocked from trading.' if blocked else 'Alpaca accepted the paper credentials and the account is active.',
                        'action': 'Review account restrictions in your Alpaca paper dashboard.' if blocked else 'Orders still require review and confirmation. Market hours and risk limits apply.'}
            except (AlpacaError, TradeError) as exc:
                denied = isinstance(exc, AlpacaError) and exc.status_code in {401, 403}
                return {'status': 'unauthorized' if denied else 'error',
                        'message': 'Alpaca rejected paper-account access.' if denied else 'The paper account could not be reached or returned invalid data.',
                        'action': 'Verify paper keys in .env and restart the launcher. Live-account keys do not work here.' if denied else 'Check internet access and Alpaca availability, then run the checks again.'}

        def check_market():
            if configured_broker is None and not public_enabled:
                return {'status': 'disabled', 'message': 'No market-data source is enabled.',
                        'action': 'Set PUBLIC_MARKET_DATA=true in .env for prices without keys, or configure Alpaca paper keys. Restart the launcher.'}
            try:
                data = TradingService(configured_broker, store, limits) if configured_broker else application.state.public_market_data
                quote = data.quote('AAPL')
                delayed = quote.get('delayed') or quote.get('timing_verified') is False
                return {'status': 'delayed' if delayed else 'connected', 'provider': quote.get('source') or quote.get('coverage') or quote.get('feed'),
                        'timestamp': quote.get('timestamp'),
                        'message': 'Prices are available; the latest trade is stale or timing is not verified.' if delayed else 'Timestamped market prices are available.',
                        'action': 'Check the displayed quote time. Public prices may be delayed; inactive markets do not produce new trades.' if delayed else 'Watchlist prices and charts can load. Alpaca stream access is shown separately on the dashboard.'}
            except (AlpacaError, PublicDataError, TradeError):
                return {'status': 'error', 'message': 'The selected market-data source did not return a usable quote.',
                        'action': 'Check internet access, provider availability, and Alpaca data entitlements if configured. Wait before retrying a rate-limited public source.'}

        with ThreadPoolExecutor(max_workers=2) as checks:
            account_result = checks.submit(check_account)
            market_result = checks.submit(check_market)
            return {'service': 'trade-paper-api', 'checked_at': datetime.now(timezone.utc).isoformat(),
                    'server': {'status': 'connected', 'message': 'The Trade API is reachable and application access is accepted.',
                               'action': 'Keep the launcher Terminal open while using the app.'},
                    'market_data': market_result.result(), 'paper_account': account_result.result()}

    @application.get('/favicon.ico', include_in_schema=False)
    def favicon():
        return RedirectResponse('/favicon.svg')

    @application.get('/api/account')
    def account(svc=Depends(service)):
        data = svc.broker.account()
        return {key: data.get(key) for key in ('id', 'status', 'currency', 'cash', 'equity', 'last_equity', 'buying_power',
                  'portfolio_value', 'trading_blocked', 'account_blocked', 'pattern_day_trader')}

    @application.get('/api/positions')
    def positions(svc=Depends(service)):
        return svc.broker.positions()

    @application.get('/api/market/clock')
    def clock(source=Depends(market_source)):
        kind, data = source
        return data.broker.clock() if kind == 'alpaca' else data.clock()

    @application.get('/api/market/stream')
    async def market_stream(request: Request, symbols: str | None = Query(default=None, max_length=300), svc=Depends(service)):
        try:
            selected_symbols = watch_symbols(symbols.split(',') if symbols is not None else None)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if application.state.market_stream is None:
            application.state.market_stream = MarketStream(svc.broker)
        return StreamingResponse(stream_events(application.state.market_stream, request, selected_symbols),
                                 media_type='text/event-stream',
                                 headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})

    @application.get('/api/stocks/search')
    def stock_search(q: str = Query(min_length=1, max_length=60), _=Depends(authorize)):
        try:
            query = query_text(q)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        configured_broker, setup_message = broker_configuration()
        if configured_broker is None and not public_enabled:
            raise HTTPException(503, setup_message)
        return application.state.stock_search.search(query, configured_broker)

    @application.get('/api/stocks/sp500')
    def sp500_constituents(_=Depends(authorize)):
        return application.state.sp500_catalog.constituents()

    @application.get('/api/market/{symbol}/quote')
    def quote(symbol: str, source=Depends(market_source)):
        try:
            symbol = AlpacaClient.symbol(symbol)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return source[1].quote(symbol)

    @application.get('/api/market/{symbol}/bars')
    def bars(symbol: str, period: Literal['1D', '1W', '1M', '1Y'] = '1D', source=Depends(market_source)):
        try:
            symbol = AlpacaClient.symbol(symbol)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        kind, data = source
        return data.broker.bars(symbol, period) if kind == 'alpaca' else data.bars(symbol, period)

    @application.get('/api/orders')
    def orders(svc=Depends(service)):
        return {'orders': svc.broker.orders(), 'local': svc.unresolved(), 'limit': 500}

    @application.post('/api/orders/review')
    def review(draft: OrderDraft, svc=Depends(service)):
        return svc.review(draft)

    @application.post('/api/orders')
    def submit(body: SubmitRequest, svc=Depends(service)):
        return svc.submit(str(body.review_id))

    @application.get('/api/orders/by-review/{review_id}')
    def reconcile(review_id: UUID, svc=Depends(service)):
        return svc.reconcile(str(review_id))

    @application.delete('/api/orders/{order_id}')
    def cancel(order_id: UUID, svc=Depends(service)):
        svc.broker.cancel_order(str(order_id))
        return {'status': 'cancel_requested', 'message': 'Cancellation requested; the broker may still fill the order. Refresh Activity for its final status.'}

    @application.get('/api/risk')
    def risk(svc=Depends(service)):
        account = svc.broker.account()
        loss = max(Decimal(0), Decimal(account['last_equity']) - Decimal(account['equity']))
        return {**limits.public(), 'daily_loss': str(loss), 'buys_paused': loss >= limits.max_daily_loss,
                'basis': 'Decline from broker last_equity (previous close); includes account transfers.'}

    @application.get('/api/performance')
    def performance(svc=Depends(service)):
        fills, complete = svc.broker.fills()
        return {**fill_performance(fills, svc.broker.positions(), complete), 'portfolio_history': svc.broker.portfolio_history()}

    @application.get('/api/trades')
    def trades(limit: int = Query(default=100, ge=1, le=1000), svc=Depends(service)):
        fills, complete = svc.broker.fills()
        return {'trades': sorted(fills, key=lambda f: (f['transaction_time'], f['id']), reverse=True)[:limit],
                'coverage_complete': complete, 'returned_limit': limit}

    @application.get('/api/exports/trades.csv')
    def export_trades(svc=Depends(service)):
        fills, complete = svc.broker.fills()
        return trades_csv(fills, complete)

    @application.get('/api/exports/performance.csv')
    def export_performance(svc=Depends(service)):
        return performance_csv(performance(svc))

    @application.get('/api/research/{symbol}/fundamentals')
    def fundamentals(symbol: str, _=Depends(authorize)):
        try:
            symbol = AlpacaClient.symbol(symbol)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return application.state.research.fundamentals(symbol)

    @application.get('/api/screener')
    def screener(min_price: float | None = Query(None, ge=0, le=10000000), max_price: float | None = Query(None, ge=0, le=10000000),
                 min_volume: float | None = Query(None, ge=0, le=1e15), min_cap: float | None = Query(None, ge=0, le=1e16),
                 max_cap: float | None = Query(None, ge=0, le=1e16), sector: str | None = Query(None, max_length=100),
                 min_change: float | None = Query(None, ge=-100, le=100000), max_change: float | None = Query(None, ge=-100, le=100000), _=Depends(authorize)):
        filters = dict(min_price=min_price, max_price=max_price, min_volume=min_volume, min_cap=min_cap, max_cap=max_cap,
                       sector=sector, min_change=min_change, max_change=max_change)
        for low, high in [('min_price', 'max_price'), ('min_cap', 'max_cap'), ('min_change', 'max_change')]:
            if filters[low] is not None and filters[high] is not None and filters[low] > filters[high]:
                raise HTTPException(422, 'Minimum values must not exceed maximum values.')
        return application.state.research.screen(filters)

    @application.get('/api/benchmark')
    def benchmark(svc=Depends(service)):
        return comparison(svc.broker.portfolio_history(), application.state.public_market_data.benchmark_history())

    @application.get('/api/journal')
    def journal(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=5000), _=Depends(authorize)):
        return application.state.journal.list(limit, offset)

    @application.post('/api/journal', status_code=201)
    def create_journal(draft: JournalDraft, _=Depends(authorize)):
        return application.state.journal.save(draft)

    @application.put('/api/journal/{entry_id}')
    def update_journal(entry_id: UUID, draft: JournalUpdate, _=Depends(authorize)):
        return application.state.journal.save(draft, str(entry_id))

    @application.delete('/api/journal/{entry_id}')
    def delete_journal(entry_id: UUID, revision: int = Query(..., ge=1), _=Depends(authorize)):
        application.state.journal.delete(str(entry_id), revision)
        return {'deleted': True}

    application.mount('/', StaticFiles(directory=ROOT / 'web', html=True), name='dashboard')
    return application


app = create_app()
