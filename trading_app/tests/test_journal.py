from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
from trading_app.api import create_app

DRAFT = {'symbol': 'aapl', 'trade_date': '2026-11-11', 'thesis': 'Revenue growth', 'expected': 'Hold through earnings', 'lessons': '', 'status': 'planned'}


def test_journal_create_edit_reload_conflict_and_delete_without_paper_keys(tmp_path, monkeypatch):
    monkeypatch.setenv('ALPACA_API_KEY_ID', ''); monkeypatch.setenv('ALPACA_API_SECRET_KEY', '')
    path = tmp_path / 'test.sqlite'
    app = create_app(db_path=path, access_token='', allowed_origins=[])
    with TestClient(app) as client:
        result = client.post('/api/journal', json=DRAFT)
        assert result.status_code == 201
        saved = result.json(); assert saved['symbol'] == 'AAPL' and saved['revision'] == 1
        edit = {**DRAFT, 'lessons': 'Check valuation first', 'status': 'closed', 'revision': 1}
        result = client.put('/api/journal/' + saved['id'], json=edit)
        assert result.status_code == 200 and result.json()['revision'] == 2
        assert client.put('/api/journal/' + saved['id'], json=edit).status_code == 409
        assert client.delete('/api/journal/' + saved['id'] + '?revision=1').status_code == 409
        assert client.get('/api/journal?limit=1').json()['total'] == 1
    with TestClient(create_app(db_path=path, access_token='', allowed_origins=[])) as client:
        assert client.get('/api/journal').json()['entries'][0]['lessons'] == edit['lessons']
        assert client.delete('/api/journal/' + saved['id'] + '?revision=2').status_code == 200
        assert client.get('/api/journal').json()['total'] == 0


def test_journal_auth_origin_input_and_pagination_limits(tmp_path):
    with TestClient(create_app(db_path=tmp_path / 'j.sqlite', access_token='secret', allowed_origins=[])) as client:
        assert client.get('/api/journal').status_code == 401
        assert client.post('/api/journal', json=DRAFT).status_code == 401
        headers = {'Authorization': 'Bearer secret'}
        for change in [{'symbol': '../env'}, {'thesis': ''}, {'lessons': 'x' * 4001}, {'trade_date': 'bad'}, {'status': 'filled'}]:
            assert client.post('/api/journal', json={**DRAFT, **change}, headers=headers).status_code == 422
        assert client.post('/api/journal', json=DRAFT, headers={**headers, 'Origin': 'https://bad.example'}).status_code == 403
        assert client.get('/api/journal?limit=1000', headers=headers).status_code == 422
        assert client.get('/api/journal?offset=-1', headers=headers).status_code == 422


def test_concurrent_journal_edits_do_not_overwrite_one_another(tmp_path):
    with TestClient(create_app(db_path=tmp_path / 'j.sqlite', access_token='', allowed_origins=[])) as client:
        saved = client.post('/api/journal', json=DRAFT).json()
        def edit(index): return client.put('/api/journal/' + saved['id'], json={**DRAFT, 'revision': 1, 'lessons': str(index)}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            assert sorted(executor.map(edit, range(2))) == [200, 409]
