"""Configuration presence only; no provider calls or secrets in health output."""
import json
import pytest
from src.api import server


@pytest.mark.parametrize('tts,stt,expected', [
    ('', '', (False, False)),
    ('fictional-tts-key', '', (True, False)),
    ('', 'fictional-stt-key', (False, True)),
    ('fictional-tts-key', 'fictional-stt-key', (True, True)),
    ('  ', '\n', (False, False)),
])
def test_health_reports_key_presence_without_values(monkeypatch, tts, stt, expected):
    monkeypatch.setenv('VARCO_API_KEY', tts)
    monkeypatch.setenv('AX_API_KEY', stt)
    health = server._health()
    assert (health['tts'], health['stt']) == expected
    assert 'fictional-tts-key' not in json.dumps(health)
    assert 'fictional-stt-key' not in json.dumps(health)
