from unittest.mock import MagicMock, patch
import pytest
from trading_app import cli
from trading_app.alpaca_client import AlpacaError


@pytest.mark.parametrize('args,method', [(['account'], 'account'), (['price', 'AAPL'], 'latest_trade'), (['order', 'AAPL', 'buy', '2'], 'submit_order'), (['order', 'AAPL', 'buy', '2', '--type', 'limit', '--limit-price', '99'], 'submit_order')])
def test_cli_commands(args, method, capsys):
    with patch('trading_app.cli.AlpacaClient') as factory:
        getattr(factory.return_value, method).return_value = {'status': 'ok'}
        assert cli.main(args) == 0
        assert 'ok' in capsys.readouterr().out
        if '--limit-price' in args:
            assert factory.return_value.submit_order.call_args.kwargs['limit_price'] == 99


def test_cli_reports_broker_failure(capsys):
    with patch('trading_app.cli.AlpacaClient', side_effect=AlpacaError('unavailable')):
        assert cli.main(['account']) == 1
        assert 'unavailable' in capsys.readouterr().err
