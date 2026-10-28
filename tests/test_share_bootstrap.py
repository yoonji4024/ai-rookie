import importlib
import json
from pathlib import Path
from fastapi.testclient import TestClient


def test_portable_entrypoint_uses_an_isolated_store_and_exact_extension_origin(tmp_path, monkeypatch):
    monkeypatch.setenv('MEMFLIX_DATA_DIR', str(tmp_path / 'accounts'))
    module = importlib.import_module('src.api.portal_server')
    assert module.app.state.db_path == tmp_path / 'accounts/portal.sqlite3'
    client = TestClient(module.app, headers={'Origin': 'http://127.0.0.1:5173'})
    health = client.get('/api/health')
    assert health.status_code == 200
    assert health.json()['extension_version'] == '0.3.8'
    result = client.post('/api/account/register', json={
        'username': 'handoff-check', 'password': 'authored-test-password', 'role': 'user'})
    assert result.status_code == 200
    connection = json.loads((Path(__file__).parents[1] / 'apps/extension/extension/connection.json').read_text())
    ext = TestClient(module.app, headers={'Origin': connection['origin']})
    login = ext.post('/api/extension/login', json={'username': 'handoff-check', 'password': 'authored-test-password'})
    assert login.status_code == 200
    ext.headers['Authorization'] = 'Bearer ' + login.json()['token']
    assert len(ext.get('/api/extension/catalog').json()) == 11
    wrong = TestClient(module.app, headers={'Origin': 'https://www.youtube.com'})
    assert wrong.post('/api/extension/login', json={'username': 'handoff-check', 'password': 'authored-test-password'}).status_code == 403
