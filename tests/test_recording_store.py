import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import requests
from fastapi.testclient import TestClient

from src.api import server
from src.api.recording_store import save_recordings, bind_recordings, read_recordings
from src.agents.analysis.features import extract_acoustic, extract_linguistic, build_vector
from src.agents.analysis.scoring import interpret


def upload(name, data):
    return SimpleNamespace(filename=name, file=io.BytesIO(data), content_type='audio/wav')


@pytest.mark.parametrize('names', [
    ['같은 이름.wav', '같은 이름.wav'], ['dir/같은.wav', 'else/같은.wav'],
    ['report.json', 'session_combined.wav'], ['upload_manifest.json', '.upload_manifest.tmp'],
    ['../../a.wav', 'a.wav'], ['recording-0001-a.wav', 'a.wav'],
])
def test_storage_never_overwrites_and_keeps_original_identity(tmp_path, names):
    saved = save_recordings([upload(names[0], b'first'), upload(names[1], b'second')], tmp_path)
    records = read_recordings(tmp_path)
    assert len(saved) == 2 and {p.read_bytes() for p in saved.values()} == {b'first', b'second'}
    assert [r['original_filename'] for r in records] == names
    assert all(r['complete'] and r['sha256'] == hashlib.sha256(saved[r['stored_filename']].read_bytes()).hexdigest() for r in records)
    (tmp_path / 'report.json').write_text('generated report')
    (tmp_path / 'session_combined.wav').write_bytes(b'generated mixture')
    assert {p.read_bytes() for p in saved.values()} == {b'first', b'second'}
    mapped, partial = bind_recordings([{'audioFilename': n} for n in names], tmp_path)
    assert partial == (names[0] == names[1])
    assert all((m['audioFilename'] == '') == partial for m in mapped)


def test_repeat_storage_does_not_erase_previous_original_or_manifest(tmp_path):
    saved = save_recordings([upload('a.wav', b'original')], tmp_path)
    before = (tmp_path / 'upload_manifest.json').read_bytes()
    with pytest.raises(FileExistsError): save_recordings([upload('a.wav', b'new')], tmp_path)
    assert (tmp_path / 'upload_manifest.json').read_bytes() == before
    assert next(iter(saved.values())).read_bytes() == b'original'


@pytest.mark.parametrize('second_name', ['a.wav', 'b.wav'])
def test_partial_copy_failure_keeps_completed_bytes_without_false_unique_link(tmp_path, second_name):
    class Broken:
        def read(self, *_): raise OSError('injected read failure')
    second = upload(second_name, b''); second.file = Broken()
    with pytest.raises(OSError): save_recordings([upload('a.wav', b'complete'), second], tmp_path)
    records = read_recordings(tmp_path)
    assert [r['complete'] for r in records] == [True, False]
    assert (tmp_path / records[0]['stored_filename']).read_bytes() == b'complete'
    mapped, partial = bind_recordings([{'audioFilename': 'a.wav'}, {'audioFilename': second_name}], tmp_path)
    assert partial and mapped[1]['audioFilename'] == ''
    assert bool(mapped[0]['audioFilename']) == (second_name != 'a.wav')


@pytest.fixture
def http(monkeypatch, tmp_path):
    monkeypatch.setattr(requests.sessions.Session, 'request', lambda *a, **k: pytest.fail('Network forbidden'))
    monkeypatch.setattr(server, 'LIVE_ROOT', tmp_path / 'live')
    monkeypatch.setattr(server, 'HISTORY_DB_PATH', tmp_path / 'history.sqlite3')
    monkeypatch.setattr(server, 'CONTENT_MODEL_PATH', tmp_path / 'absent.json')
    monkeypatch.setenv('DEMO_FAST_MODE', '0')
    monkeypatch.setattr(server, '_load_model', lambda: SimpleNamespace(feature_names=[], score_one=lambda x: {'axes': {server.SPEECH_AXES[0]: {'score': 70}}, 'total_score': 70}))
    monkeypatch.setattr(server, '_combine_audio', lambda files, tmp, **kw: next(iter(files)))
    monkeypatch.setattr(server, '_audio_signal_stats', lambda p: (2., .1, .5))
    monkeypatch.setattr(extract_acoustic, 'extract_acoustic', lambda *a, **k: {})
    monkeypatch.setattr(extract_linguistic, 'extract_linguistic', lambda *a, **k: {})
    monkeypatch.setattr(build_vector, 'build_feature_vector', lambda *a, **k: (np.array([]), []))
    def blocked(*a, **k): raise RuntimeError('injected generation failure')
    monkeypatch.setattr(interpret, 'interpret_scores', blocked)
    seen = []
    def stt(path, **kwargs): seen.append(Path(path).read_bytes()); return '주입한 전사'
    monkeypatch.setattr(server, '_stt', stt)
    return TestClient(server.app, raise_server_exceptions=False), seen


@pytest.mark.parametrize('names,links,expected_stt', [
    (['x/same.wav', 'y/same.wav'], ['x/same.wav', 'y/same.wav'], [b'first', b'second']),
    (['same.wav', 'same.wav'], ['same.wav', 'same.wav'], []),
    (['a.wav', 'b.wav'], ['missing.wav', 'b.wav'], [b'second']),
])
def test_stt_uses_only_uniquely_resolved_file(http, names, links, expected_stt):
    client, seen = http
    items = [{'id': str(i), 'audioFilename': ref, 'userAnswer': ''} for i, ref in enumerate(links)]
    response = client.post('/api/report', data={'answers': json.dumps(items)}, files=[
        ('audio', (names[1], b'second', 'audio/wav')), ('audio', (names[0], b'first', 'audio/wav'))])
    assert response.status_code == 200 and seen == expected_stt
    if len(expected_stt) < 2: assert response.json()['analysisMode'] == 'partial'


@pytest.mark.parametrize('duplicate', [False, True])
def test_outer_failure_preserves_bytes_and_replays_only_unambiguous_audio(http, monkeypatch, duplicate):
    client, _ = http
    def fail(): raise RuntimeError('post-storage failure')
    monkeypatch.setattr(server, '_load_model', fail)
    names = ['same.wav', 'same.wav'] if duplicate else ['report.json', 'b.wav']
    response = client.post('/api/report', data={'answers': json.dumps([
        {'id': str(i), 'audioFilename': n, 'userAnswer': '원래 답변'} for i, n in enumerate(names)])},
        files=[('audio', (names[0], b'first', 'audio/wav')), ('audio', (names[1], b'second', 'audio/wav'))])
    assert response.status_code == 200
    report = response.json(); assert report['analysisMode'] == 'partial'
    records = read_recordings(next(server.LIVE_ROOT.iterdir()))
    assert len(records) == 2 and all(r['complete'] for r in records)
    for i, question in enumerate(report['questions']):
        url = question['recordingUrl']
        if duplicate: assert url is None
        else:
            # /api/score is the frontend proxy prefix; the internal route is /api.
            audio = client.get(url.replace('/api/score/report/', '/api/report/', 1))
            assert audio.status_code == 200 and audio.content == [b'first', b'second'][i]
            assert audio.headers['content-type'].startswith('audio/')
