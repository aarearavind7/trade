import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from trading_app.market_stream import MarketStream, SYMBOLS, SubscriptionDenied, normalize_event, stream_events


NOW = datetime.now(timezone.utc)


def trade(**changes):
    return {'T': 't', 'S': 'AAPL', 'p': 201.25, 't': NOW.isoformat(), **changes}


@pytest.mark.parametrize('changes', [{'S': 'UNKNOWN'}, {'T': 'error'}, {'p': float('nan')}, {'p': -1}, {'t': 'bad'}, {'t': 12}, {'t': (NOW + timedelta(minutes=5)).isoformat()}])
def test_invalid_stream_events_are_ignored(changes):
    assert normalize_event(trade(**changes), 'iex', NOW) is None


def test_stream_fields_timestamps_feed_and_bar_corrections():
    event = normalize_event(trade(secret='never-forward'), 'iex', NOW)
    assert event['price'] == '201.25' and event['type'] == 'quote'
    assert event['coverage'] == 'IEX exchange only' and not event['delayed']
    assert 'secret' not in event
    assert normalize_event(trade(), 'delayed_sip', NOW)['delayed']
    assert normalize_event(trade(t=(NOW - timedelta(minutes=5)).isoformat()), 'sip', NOW)['delayed']
    bar = normalize_event(trade(T='u', c=202), 'iex', NOW)
    assert bar['type'] == 'bar' and bar['updated'] and bar['bar']['c'] == 202
    assert normalize_event(None, 'iex', NOW) is None


class Socket:
    def __init__(self, frames):
        self.frames = asyncio.Queue()
        for frame in frames: self.frames.put_nowait(json.dumps(frame))
        self.sent = []
        self.closed = False

    async def recv(self): return await self.frames.get()
    async def send(self, text): self.sent.append(json.loads(text))
    def __aiter__(self): return self
    async def __anext__(self): return await self.recv()


class Connector:
    def __init__(self, socket, fail_once=False):
        self.socket, self.calls, self.fail_once = socket, [], fail_once

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.fail_once and len(self.calls) == 1: raise OSError('network offline')
        return self

    async def __aenter__(self): return self.socket
    async def __aexit__(self, *args): self.socket.closed = True


def broker(): return SimpleNamespace(api_key='private-test-key', secret_key='private-test-secret', feed='iex')


def frames(extra=None):
    return [[{'T': 'success', 'msg': 'connected'}], [{'T': 'success', 'msg': 'authenticated'}],
            [{'T': 'subscription', 'trades': list(SYMBOLS)}], [extra or trade()]]


async def until(queue, predicate):
    async with asyncio.timeout(2):
        while True:
            event = await queue.get()
            if predicate(event): return event


def test_two_browser_subscribers_share_one_authenticated_upstream_connection():
    async def scenario():
        socket = Socket(frames())
        connector = Connector(socket)
        hub = MarketStream(broker(), connector=connector)
        async with hub.subscribe() as one:
            async with hub.subscribe() as two:
                first = await until(one, lambda event: event['type'] == 'quote')
                second = await until(two, lambda event: event['type'] == 'quote')
                assert first == second and len(connector.calls) == 1
                assert connector.calls[0][0] == 'wss://stream.data.alpaca.markets/v2/iex'
                assert socket.sent[0]['action'] == 'auth'
                assert set(socket.sent[1]['trades']) == set(SYMBOLS)
                assert set(socket.sent[1]['updatedBars']) == set(SYMBOLS)
                async with hub.subscribe() as late:
                    assert (await until(late, lambda event: event['type'] == 'quote'))['price'] == '201.25'
            assert hub.task and not hub.task.done()
        assert hub.task is None and socket.closed and not hub.subscribers
    asyncio.run(scenario())


def test_denied_authentication_is_reported_without_retry_or_secret_leak():
    async def scenario():
        socket = Socket([[{'T': 'error', 'code': 401, 'msg': 'private-test-secret'}]])
        connector = Connector(socket)
        hub = MarketStream(broker(), connector=connector)
        async with hub.subscribe() as queue:
            status = await until(queue, lambda event: event.get('state') == 'unavailable')
            assert not status['retryable'] and '401' in status['message']
            assert 'private-test' not in json.dumps(status)
        assert len(connector.calls) == 1
    asyncio.run(scenario())


def test_reconnects_after_transport_failure():
    async def scenario():
        connector = Connector(Socket(frames()), fail_once=True)
        delays = []
        async def sleep(delay): delays.append(delay); await asyncio.sleep(0)
        hub = MarketStream(broker(), connector=connector, sleep=sleep)
        async with hub.subscribe() as queue:
            await until(queue, lambda event: event['type'] == 'quote')
            assert len(connector.calls) == 2 and delays == [1]
        assert hub.task is None
    asyncio.run(scenario())


def test_slow_clients_have_bounded_queues():
    async def scenario():
        hub = MarketStream(broker(), connector=Connector(Socket(frames())))
        async with hub.subscribe() as queue:
            for index in range(500): hub.broadcast({'type': 'quote', 'symbol': 'AAPL', 'price': str(index)})
            assert queue.qsize() == 128 and hub.latest['AAPL']['price'] == '499'
    asyncio.run(scenario())


def test_incomplete_subscriptions_fail_explicitly():
    async def scenario():
        data = frames()
        data[2] = [{'T': 'subscription', 'trades': ['AAPL']}]
        hub = MarketStream(broker(), connector=Connector(Socket(data)))
        async with hub.subscribe() as queue:
            status = await until(queue, lambda event: event.get('state') == 'unavailable')
            assert 'incomplete_subscription' in status['message']
    asyncio.run(scenario())


def test_malformed_frames_and_unsafe_error_codes():
    for value in ('{}', '[null]', 'not-json'):
        with pytest.raises(ValueError): MarketStream.decode(value)
    with pytest.raises(SubscriptionDenied) as caught:
        MarketStream.decode('[{"T":"error","code":"private-secret"}]')
    assert caught.value.code == 'unknown'


def test_sse_uses_public_json_and_stops_on_terminal_error():
    async def scenario():
        hub = MarketStream(broker(), connector=Connector(Socket([[{'T': 'error', 'code': 406}]])))
        class Request:
            async def is_disconnected(self): return False
        events = [event async for event in stream_events(hub, Request())]
        assert events and all(event.startswith('data: ') and event.endswith('\n\n') for event in events)
        assert 'unavailable' in events[-1]
        assert 'private-test-key' not in ''.join(events)
        assert hub.task is None
    asyncio.run(scenario())


def test_watchlist_symbol_validation_and_custom_event_filtering():
    from trading_app.market_stream import watch_symbols
    assert watch_symbols([' amzn ', 'AMZN', 'BRK.B']) == ('AMZN', 'BRK.B')
    for values in ([], ['../BAD'], ['X' + str(index) for index in range(21)]):
        with pytest.raises(ValueError): watch_symbols(values)
    assert normalize_event(trade(S='AMZN'), 'iex', NOW, symbols={'AMZN'})['symbol'] == 'AMZN'
    assert normalize_event(trade(S='AAPL'), 'iex', NOW, symbols={'AMZN'}) is None


def test_distinct_tab_watchlists_restart_one_connection_and_route_only_requested_symbols():
    async def scenario():
        sockets, active = [], [0, 0]
        hub = None
        class Factory:
            def __call__(self, *args, **kwargs):
                desired = sorted(hub.desired)
                data = [[{'T': 'success', 'msg': 'authenticated'}], [{'T': 'subscription', 'trades': desired}], [trade(S=symbol) for symbol in desired]]
                socket = Socket(data)
                sockets.append(socket)
                @asynccontextmanager
                async def connection():
                    active[0] += 1; active[1] = max(active[1], active[0])
                    try: yield socket
                    finally: active[0] -= 1; socket.closed = True
                return connection()
        hub = MarketStream(broker(), connector=Factory())
        async with hub.subscribe(['AAPL']) as one:
            await until(one, lambda event: event['type'] == 'quote')
            async with hub.subscribe(['AMZN']) as two:
                result = await until(two, lambda event: event['type'] == 'quote')
                assert result['symbol'] == 'AMZN'
                rows = []
                while not one.empty(): rows.append(one.get_nowait())
                assert all(event.get('symbol') in {None, 'AAPL'} for event in rows)
                assert set(sockets[-1].sent[1]['trades']) == {'AAPL', 'AMZN'}
                assert sockets[0].closed
            assert hub.desired == {'AAPL'}
            await until(one, lambda event: event['type'] == 'quote')
        assert len(sockets) == 3 and active[1] == 1
        assert all(socket.closed for socket in sockets)
    asyncio.run(scenario())


def test_stream_capacity_error_is_delivered_as_terminal_sse():
    async def scenario():
        hub = MarketStream(broker(), connector=Connector(Socket(frames())))
        class Request:
            async def is_disconnected(self): return False
        async with hub.subscribe(['A' + str(index) for index in range(20)]):
            async with hub.subscribe(['B' + str(index) for index in range(20)]):
                events = [event async for event in stream_events(hub, Request(), ['C' + str(index) for index in range(20)])]
                assert len(events) == 1 and '50 distinct' in events[0] and '"retryable":false' in events[0]
    asyncio.run(scenario())
