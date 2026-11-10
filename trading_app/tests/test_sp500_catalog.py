import csv
import io
from types import SimpleNamespace
from urllib.error import URLError

import pytest
from fastapi.testclient import TestClient

from trading_app.api import create_app
from trading_app.public_market_data import PublicDataError
from trading_app.sp500_catalog import SP500Catalog, SOURCE_URL
from trading_app.tests.test_public_market_data import Opener


def membership(count=503):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['Symbol', 'Security', 'GICS Sector'])
    for index in range(count):
        writer.writerow(['BRK-B' if index == 0 else 'S' + str(index), 'Company ' + str(index), 'Technology'])
    return output.getvalue().encode()


def test_complete_membership_list_is_normalized_cached_and_attributed():
    opener = Opener(membership())
    clock = [0]
    catalog = SP500Catalog(opener, monotonic=lambda: clock[0])
    result = catalog.constituents()
    assert result['count'] == 503 and len(result['results']) == 503
    assert result['results'][0]['symbol'] == 'BRK.B'
    assert result['source_url'] == SOURCE_URL and result['fetched_at']
    assert catalog.constituents() is result and len(opener.calls) == 1
    clock[0] = 86401
    catalog.constituents()
    assert len(opener.calls) == 2
    assert all('alpaca' not in key.lower() for key in opener.calls[0].headers)


@pytest.mark.parametrize('raw', [b'not,csv\nwrong,columns\n', membership(5), membership(650), b'X' * 1000001])
def test_incomplete_or_malformed_membership_never_becomes_a_bulk_list(raw):
    with pytest.raises(PublicDataError, match='unavailable or incomplete'):
        SP500Catalog(Opener(raw)).constituents()


def test_membership_network_failure_is_actionable():
    def offline(*args, **kwargs): raise URLError('internal network details')
    with pytest.raises(PublicDataError) as error: SP500Catalog(offline).constituents()
    assert 'internal network details' not in str(error.value)


def test_membership_endpoint_is_read_only_and_obeys_app_auth(tmp_path):
    catalog = SP500Catalog(Opener(membership(500)))
    app = create_app(db_path=tmp_path / 'members.sqlite3', access_token='app-token', allowed_origins=[], sp500_catalog=catalog)
    with TestClient(app) as client:
        assert client.get('/api/stocks/sp500').status_code == 401
        result = client.get('/api/stocks/sp500', headers={'Authorization': 'Bearer app-token'})
        assert result.status_code == 200 and result.json()['count'] == 500
        assert 'price' not in result.json()['results'][0]


@pytest.mark.parametrize('replacement', ['../BAD,Invalid,Technology', 'S0,,Technology'])
def test_one_invalid_member_does_not_silently_produce_a_partial_bulk_list(replacement):
    data = membership(500).decode().splitlines()
    data[1] = replacement
    with pytest.raises(PublicDataError):
        SP500Catalog(Opener(('\n'.join(data) + '\n').encode())).constituents()
