"""One Alpaca WebSocket per process, shared by authenticated SSE subscribers."""
import asyncio
import json
import math
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone

from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException
from .alpaca_client import AlpacaClient

SYMBOLS = ('AAPL', 'MSFT', 'NVDA', 'GOOGL', 'TSLA')


def watch_symbols(symbols=None):
    values = SYMBOLS if symbols is None else symbols
    result = tuple(dict.fromkeys(AlpacaClient.symbol(value) for value in values))
    if not 1 <= len(result) <= 20:
        raise ValueError('Choose between 1 and 20 stocks for a watchlist stream.')
    return result


class SubscriptionDenied(Exception):
    def __init__(self, code):
        self.code = code


def normalize_event(event, feed, now=None, symbols=None):
    """Whitelist public fields; never relay broker authentication/error payloads."""
    if not isinstance(event, dict) or event.get('S') not in (SYMBOLS if symbols is None else symbols) or event.get('T') not in {'t', 'b', 'u'}:
        return None
    try:
        stamp = datetime.fromisoformat(event['t'].replace('Z', '+00:00'))
        age = ((now or datetime.now(timezone.utc)) - stamp).total_seconds()
        price = float(event['p'] if event['T'] == 't' else event['c'])
        if not math.isfinite(price) or price <= 0 or age < -5:
            return None
    except (ValueError, TypeError, KeyError, AttributeError):
        return None
    base = {'symbol': event['S'], 'timestamp': event['t'], 'feed': feed,
            'delayed': feed == 'delayed_sip' or age > 120,
            'coverage': 'IEX exchange only' if feed == 'iex' else feed.upper()}
    if event['T'] == 't':
        return {'type': 'quote', **base, 'price': str(event['p']), 'age_seconds': max(0, round(age))}
    bar = {'t': event['t'], 'c': price}
    for key in ('o', 'h', 'l', 'v'):
        value = event.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and (value >= 0 if key == 'v' else value > 0):
            bar[key] = value
    return {'type': 'bar', **base, 'bar': bar, 'updated': event['T'] == 'u'}


class MarketStream:
    def __init__(self, broker, connector=connect, sleep=asyncio.sleep):
        self.broker, self.connector, self.sleep = broker, connector, sleep
        self.subscribers = {}
        self.task = None
        self.latest = {}
        self.lock = asyncio.Lock()
        self.state = self.status('connecting', 'Connecting to Alpaca market data.')

    def status(self, state, message, retryable=True):
        return {'type': 'status', 'state': state, 'message': message, 'retryable': retryable,
                'feed': self.broker.feed, 'timestamp': datetime.now(timezone.utc).isoformat()}

    def broadcast(self, event):
        if event['type'] == 'status':
            self.state = event
        elif event['type'] == 'quote':
            self.latest[event['symbol']] = event
        for queue, symbols in tuple(self.subscribers.items()):
            if event['type'] in {'quote', 'bar'} and event.get('symbol') not in symbols:
                continue
            if queue.full():
                queue.get_nowait()  # Bound memory for slow browsers; keep the most recent events.
            queue.put_nowait(event)

    @property
    def desired(self):
        return set().union(*self.subscribers.values()) if self.subscribers else set()

    async def restart(self):
        # Close before reconnecting: free Alpaca feeds may allow only one connection.
        await self.close()
        desired = self.desired
        self.latest = {symbol: event for symbol, event in self.latest.items() if symbol in desired}
        self.broadcast(self.status('connecting', 'Connecting the current watchlist to Alpaca market data.'))
        self.task = asyncio.create_task(self.run())

    @asynccontextmanager
    async def subscribe(self, symbols=None):
        selected = frozenset(watch_symbols(symbols))
        queue = asyncio.Queue(maxsize=128)
        async with self.lock:
            previous = self.desired
            if len(previous | selected) > 50:
                raise ValueError('At most 50 distinct streaming symbols are supported across open tabs. Close an unused tab and retry.')
            self.subscribers[queue] = selected
            if self.desired != previous or self.task is None or self.task.done():
                await self.restart()
            else:
                queue.put_nowait(self.state)
            for symbol, event in self.latest.items():
                if symbol in selected:
                    queue.put_nowait(event)
        try:
            yield queue
        finally:
            async with self.lock:
                previous = self.desired
                self.subscribers.pop(queue, None)
                if not self.subscribers:
                    await self.close()
                    self.latest.clear()
                elif self.desired != previous:
                    await self.restart()

    async def close(self):
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        self.state = self.status('connecting', 'Connecting to Alpaca market data.')

    @staticmethod
    def decode(raw):
        events = json.loads(raw)
        if not isinstance(events, list):
            raise ValueError('Invalid market stream frame.')
        for event in events:
            if not isinstance(event, dict):
                raise ValueError('Invalid market stream event.')
            if event.get('T') == 'error':
                code = event.get('code')
                raise SubscriptionDenied(code if isinstance(code, int) else 'unknown')
        return events

    async def run(self):
        retry = 1
        while True:
            desired = self.desired
            try:
                self.broadcast(self.status('connecting', 'Connecting to Alpaca market data.'))
                url = 'wss://stream.data.alpaca.markets/v2/' + self.broker.feed
                # websockets 15 honors inherited proxy configuration and normal TLS verification.
                async with self.connector(url, open_timeout=10, ping_interval=20, ping_timeout=20, max_size=1048576) as socket:
                    await socket.send(json.dumps({'action': 'auth', 'key': self.broker.api_key, 'secret': self.broker.secret_key}))
                    authenticated = False
                    async with asyncio.timeout(15):
                        while not authenticated:
                            events = self.decode(await socket.recv())
                            authenticated = any(event.get('T') == 'success' and event.get('msg') == 'authenticated' for event in events)
                    await socket.send(json.dumps({'action': 'subscribe', 'trades': sorted(desired), 'bars': sorted(desired), 'updatedBars': sorted(desired)}))
                    async for raw in socket:
                        for event in self.decode(raw):
                            if event.get('T') == 'subscription':
                                subscribed = set(event.get('trades', []))
                                if not desired.issubset(subscribed):
                                    raise SubscriptionDenied('incomplete_subscription')
                                self.broadcast(self.status('connected', 'Market stream connected. Prices update when trades arrive.'))
                                retry = 1
                            else:
                                normalized = normalize_event(event, self.broker.feed, symbols=desired)
                                if normalized:
                                    self.broadcast(normalized)
            except SubscriptionDenied as exc:
                self.broadcast(self.status('unavailable', f'Market stream denied ({exc.code}). Check paper credentials, feed entitlement, and other running Alpaca stream clients.', retryable=False))
                return
            except (OSError, TimeoutError, WebSocketException, ValueError):
                pass
            self.broadcast(self.status('reconnecting', f'Market stream disconnected. Retrying in {retry} seconds; REST refresh remains available.'))
            await self.sleep(retry)
            retry = min(30, retry * 2)


async def stream_events(hub, request, symbols=None):
    """SSE over fetch, so bearer tokens stay in headers rather than URLs."""
    try:
        async with hub.subscribe(symbols) as queue:
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    event = {**hub.state, 'type': 'heartbeat'}
                yield 'data: ' + json.dumps(event, separators=(',', ':')) + '\n\n'
                if event.get('retryable') is False:
                    break
    except ValueError as exc:
        event = hub.status('unavailable', str(exc), retryable=False)
        yield 'data: ' + json.dumps(event, separators=(',', ':')) + '\n\n'
