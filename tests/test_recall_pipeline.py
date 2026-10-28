import json
from types import SimpleNamespace as S

import pytest

from src.agents.analysis import response_matcher as matcher
from src.agents.analysis.recall_pipeline import analyze_recall, recall_from_answers
from src.agents.analysis.scoring.rubric_content import score_context_match, score_memory_accuracy
from src.api import server
from src.api.schema import ReportResponse
from src.session import SessionLog, _build_report, recall_session, ScriptedResponder


@pytest.fixture
def graph():
    return S(content_id='fixture', category='test', true_order=['a', 'b'], nodes=[
        S(scene_id='a', order=0, keywords=['시장'], summary='시장에서 과일을 샀다.'),
        S(scene_id='b', order=1, keywords=['귀가'], summary='귀가했다.')])


@pytest.mark.parametrize('text,expected', [
    ('시장 장면은 나오지 않았어요.', []),
    ('시장 장면은 안 나왔어요.', []),
    ('시장 장면은 없었어요.', []),
    ('시장 장면이 있었는지 모르겠어요.', []),
    ('시장 장면을 기억해요. 귀가 장면은 기억이 안 나요.', ['a']),
    ('시장 장면이요. 아니, 앞의 말은 취소할게요. 귀가 장면이요.', ['b']),
    ('시장 장면은 기억이 안 나요. 귀가한 후에 시장에 갔어요.', ['b', 'a']),
])
def test_negation_uncertainty_and_explicit_retraction(graph, text, expected):
    assert matcher.match_response(text, graph, use_llm=False)['scene_order'] == expected


def test_llm_cannot_reintroduce_retracted_keyword(graph, monkeypatch):
    monkeypatch.setattr(matcher, 'chat_json', lambda *a, **kw: {'matches': [
        {'scene_id': 'a', 'evidence': '시장', 'confidence': .99}], 'unmatched': []})
    result = matcher.match_response('시장 장면은 나오지 않았어요.', graph)
    assert not result['scene_order']
    assert result['unmatched']


@pytest.mark.parametrize('bad', [None, 'wrong', float('nan'), float('inf'), 1.1])
def test_invalid_llm_confidence_cannot_crash_or_add_credit(graph, monkeypatch, bad):
    monkeypatch.setattr(matcher, 'chat_json', lambda *a, **kw: {'matches': [
        {'scene_id': 'b', 'evidence': '집', 'confidence': bad}], 'unmatched': ['지어낸 말']})
    out = matcher.match_response('집에 온 일만 기억나요.', graph)
    assert out['scene_order'] == []
    assert '지어낸 말' not in out['unmatched']


def test_unmatched_is_not_zero_intrusion_or_confirmed_intrusion(graph):
    result = analyze_recall('시장 장면이요. 화성에서 버스를 탔어요.', graph)
    assert result['matching']['unmatched'] == ['화성에서 버스를 탔어요.']
    assert result['errors']['intrusion'] is None
    assert result['errors']['omission'] is None
    assert result['kendall_tau'] is None
    assert score_context_match(result, 2)[0] is None
    assert score_memory_accuracy(result)[0] is None


def test_no_cue_history_differs_from_explicitly_no_cues(graph):
    text = '시장 장면이요. 귀가 장면이요.'
    assert analyze_recall(text, graph)['errors']['cue_dependency'] is None
    assert analyze_recall(text, graph, cued_events=[])['errors']['cue_dependency'] == 0
    assert analyze_recall(text, graph, cued_events=['b'])['errors']['cue_dependency'] == 1


def test_question_order_cannot_supply_recall_order(graph):
    items = [{'userAnswer': '시장 장면이요.'}, {'userAnswer': '귀가 장면이요.'}]
    assert recall_from_answers(items, graph) is None
    items.append({'responseType': 'free_recall', 'userAnswer': '귀가. 시장.', 'cuedSceneIds': []})
    out = recall_from_answers(items, graph)
    assert out['scene_order'] == ['b', 'a'] and out['kendall_tau'] == -1


@pytest.mark.parametrize('extra,reason', [
    ({'transcriptSource': 'demo'}, 'demo_transcript'),
    ({'cuedSceneIds': ['unknown']}, 'invalid_cue_history'),
    ({'cuedSceneIds': 'a'}, 'invalid_cue_history'),
])
def test_invalid_provenance_abstains(graph, extra, reason):
    out = recall_from_answers([{'responseType': 'free_recall', 'userAnswer': '시장', **extra}], graph)
    assert out == {'measurement_status': 'unavailable', 'reason': reason}


def test_empty_or_multiple_recall_turns_abstain(graph):
    item = {'responseType': 'free_recall', 'userAnswer': ''}
    assert recall_from_answers([item], graph)['measurement_status'] == 'unavailable'
    assert recall_from_answers([item, item], graph)['reason'] == 'multiple_free_recall_turns'


def test_session_report_does_not_claim_unassessed_errors_are_zero(graph, monkeypatch):
    monkeypatch.setattr(matcher, 'chat_json', lambda *a, **kw: {'matches': [], 'unmatched': []})
    log = SessionLog('fixture', 'test')
    recall_session(graph, ScriptedResponder([], '시장. 화성에서 버스를 탔어요.'), log)
    report = _build_report(log, graph)
    assert '없는 내용 0개' not in report['summary']
    assert '측정하지 않음' in report['summary']
    assert report['evidence'][0]['evidence'] == '시장'


def test_free_recall_metadata_survives_storage_and_is_not_question_scored():
    items = [{'id': 'recall', 'question': '순서대로 말해주세요', 'responseType': 'free_recall',
              'userAnswer': '대상을 받았어요', 'answerKeywords': ['대상'], 'cuedSceneIds': []}]
    stored = [q.model_dump() for q in server._rank_questions(items)]
    assert stored[0]['responseType'] == 'free_recall'
    assert stored[0]['cuedSceneIds'] == []
    assert server._score_question_answers(stored) == {}


def test_report_failure_cannot_return_mock_scores_or_create_trend(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setattr(server, 'LIVE_ROOT', tmp_path / 'live')
    monkeypatch.setattr(server, 'HISTORY_DB_PATH', tmp_path / 'history.sqlite3')
    monkeypatch.setattr(server, '_make_report', lambda *a, **kw: (_ for _ in ()).throw(RuntimeError('test')))
    client = TestClient(server.app)
    response = client.post('/api/report', data={'answers': json.dumps([{'id': 'd1', 'userAnswer': '대상'}])})
    assert response.status_code == 200
    result = ReportResponse.model_validate(response.json())
    assert result.analysisMode == 'partial'
    assert all(not f.available for f in result.speechScore.factors + result.contentScore.factors)
    assert result.trend == []
    assert all(not f.available for f in server._refresh_stored_report_derived_fields(result).contentScore.factors)
    assert not (tmp_path / 'history.sqlite3').exists() or server._load_report_history(None) == []


def test_missing_audio_returns_unavailable_not_demo(monkeypatch):
    monkeypatch.setattr(server, '_load_model', lambda: None)
    result = server._make_report('[]', None, None, [])
    assert result.analysisMode == 'partial'
    assert all(not f.available for f in result.speechScore.factors + result.contentScore.factors)


def test_explicit_mock_remains_labelled_demo_and_excluded_from_history(tmp_path):
    result = server.mock()
    assert result.analysisMode == 'demo'
    server._store_report_history('demo', result, db_path=tmp_path / 'history.sqlite3')
    assert not (tmp_path / 'history.sqlite3').exists()


@pytest.mark.parametrize('stt_mode', ['recorded', 'empty', 'failed', 'demo_fallback'])
def test_report_route_preserves_recall_and_stt_provenance(tmp_path, monkeypatch, graph, stt_mode):
    """Real HTTP handler/serialization; external STT and feature extraction are controlled stubs."""
    from fastapi.testclient import TestClient
    from src.agents.analysis.features import extract_acoustic as acoustic_module
    from src.agents.analysis.features import extract_linguistic as linguistic_module
    from src.agents.analysis.features import build_vector as vector_module
    from src.agents.analysis.scoring.score_content import ContentScoringModel
    from src.event_graph import sample_loader
    import numpy as np

    monkeypatch.setattr(server, 'LIVE_ROOT', tmp_path / 'live')
    monkeypatch.setattr(server, 'HISTORY_DB_PATH', tmp_path / 'history.sqlite3')
    monkeypatch.setenv('DEMO_FAST_MODE', '1')
    monkeypatch.setattr(server, '_load_model', lambda: S(feature_names=[], score_one=lambda x: {
        'axes': {server.SPEECH_AXES[0]: {'score': 70}}, 'total_score': 70}))
    monkeypatch.setattr(server, '_audio_signal_stats', lambda p: (2., .1, .5))
    monkeypatch.setattr(server, '_combine_audio', lambda files, tmp, **kw: next(iter(files)))
    monkeypatch.setattr(acoustic_module, 'extract_acoustic', lambda *a, **kw: {})
    monkeypatch.setattr(linguistic_module, 'extract_linguistic', lambda *a, **kw: {})
    monkeypatch.setattr(vector_module, 'build_feature_vector', lambda *a, **kw: (np.array([]), []))
    model_path = tmp_path / 'content.json'
    model_path.write_text('{}')
    monkeypatch.setattr(server, 'CONTENT_MODEL_PATH', model_path)
    monkeypatch.setattr(ContentScoringModel, 'load', lambda *a: S(feature_names=[], score_all=lambda *a, **kw: {'axes': {}}))
    monkeypatch.setattr(sample_loader, 'load_all', lambda: [graph])
    def transcribe(*a, **kw):
        if stt_mode in {'failed', 'demo_fallback'}:
            raise RuntimeError('controlled STT failure')
        return '귀가. 시장.' if stt_mode == 'recorded' else ''
    monkeypatch.setattr(server, '_stt', transcribe)
    item = {'id': 'recall', 'question': '순서 회상', 'responseType': 'free_recall',
            'userAnswer': '', 'audioFilename': 'fixture.wav', 'cuedSceneIds': []}
    if stt_mode == 'demo_fallback':
        item['fallbackAnswer'] = '시장. 귀가.'
    # Bytes are deliberately a stub; no claim of audio-feature or live STT validation.
    response = TestClient(server.app).post('/api/report', data={
        'answers': json.dumps([item]), 'contentId': 'fixture'},
        files=[('audio', ('fixture.wav', b'controlled-input', 'audio/wav'))])
    assert response.status_code == 200
    result = ReportResponse.model_validate(response.json())
    assert result.analysisVersion == 4  # excludes a caught exception/failure report
    assert result.speechScore.factors[0].available == (stt_mode in {'recorded', 'demo_fallback'})
    assert result.recallObservations is not None
    if stt_mode == 'recorded':
        assert result.recallObservations['scene_order'] == ['b', 'a']
        assert result.recallObservations['errors']['intrusion'] is None
    elif stt_mode == 'demo_fallback':
        assert result.analysisMode == 'demo'
        assert result.questions[0].transcriptSource == 'demo'
        assert result.recallObservations['reason'] == 'demo_transcript'
        assert result.trend == []
    else:
        assert result.analysisMode == 'partial'
        assert result.recallObservations['measurement_status'] == 'unavailable'
        assert result.trend == []
    assert all(not f.available for f in result.contentScore.factors)
