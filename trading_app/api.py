"""FastAPI application. Run with uvicorn trading_app.api:app --host 127.0.0.1."""
import hmac
import os
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
from starlette.middleware.trustedhost import TrustedHostMiddleware
from typing import Literal

from .alpaca_client import AlpacaClient, AlpacaError
from .service import OrderDraft, OrderStore, RiskLimits, TradeError, TradingService, fill_performance

ROOT = Path(__file__).resolve().parents[1]


class SubmitRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    review_id: UUID


def create_app(broker=None, db_path=None, limits=None, access_token=None, allowed_origins=None):
    load_dotenv(ROOT / '.env')
    token = access_token if access_token is not None else os.getenv('API_ACCESS_TOKEN', '')
    origins = allowed_origins if allowed_origins is not None else [s.strip() for s in os.getenv('ALLOWED_ORIGINS', '').split(',') if s.strip()]
    if origins and (not token or '*' in origins):
        raise ValueError('Cross-origin hosting requires API_ACCESS_TOKEN and exact ALLOWED_ORIGINS (no wildcard).')
    limits = limits or RiskLimits(Decimal(os.getenv('MAX_POSITION_PCT', '20')), Decimal(os.getenv('MAX_ORDER_NOTIONAL', '5000')), Decimal(os.getenv('MAX_DAILY_LOSS', '1000')))
    store = OrderStore(db_path or os.getenv('TRADING_DB_PATH', str(ROOT / 'trading_app/data/orders.sqlite3')))
    application = FastAPI(title='Trade Paper API', version='1.0.0', description='Single-user, long-only Alpaca paper trading. All order submissions require a short-lived server review.')
    application.state.broker = broker
    application.state.store = store
    application.state.limits = limits
    hosts = [s.strip() for s in os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1],testserver').split(',')]
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)
    if origins:
        application.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=['GET', 'POST', 'DELETE'],
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
        return {'status': 'ok', 'mode': 'paper', 'authentication_required': bool(token),
                'broker_configured': configured_broker is not None, 'setup_message': setup_message}

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
    def clock(svc=Depends(service)):
        return svc.broker.clock()

    @application.get('/api/market/{symbol}/quote')
    def quote(symbol: str, svc=Depends(service)):
        try:
            symbol = AlpacaClient.symbol(symbol)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return svc.quote(symbol)

    @application.get('/api/market/{symbol}/bars')
    def bars(symbol: str, period: Literal['1D', '1W', '1M', '1Y'] = '1D', svc=Depends(service)):
        try:
            symbol = AlpacaClient.symbol(symbol)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return svc.broker.bars(symbol, period)

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

    application.mount('/', StaticFiles(directory=ROOT / 'web', html=True), name='dashboard')
    return application


app = create_app()
