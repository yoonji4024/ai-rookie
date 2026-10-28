"""Free-recall observations with explicit unmeasured fields.

Matching cannot establish absence of intrusion or clinical impairment. Keep
raw ID arithmetic in recall.py separate from uncertain text interpretation.
"""
from __future__ import annotations

from src.agents.analysis.recall import score_recall_order
from src.agents.analysis.response_matcher import match_response


def analyze_recall(text, graph, *, use_llm=False, cued_events=None):
    matching = match_response(text, graph, use_llm=use_llm)
    score = score_recall_order(matching['scene_order'], graph, cued_events)
    # These are observations on matched IDs, not an exhaustive semantic verdict.
    score['matching'] = matching
    score['scene_order'] = matching['scene_order']
    score['matched_coverage'] = score['coverage']
    score['unmatched_scene_ids'] = list(score['details']['omitted'])
    score['errors']['omission'] = None
    score['errors']['intrusion'] = None
    if cued_events is None:
        score['errors']['cue_dependency'] = None
    order_available = score['n_correct'] >= 2
    if not order_available:
        score['kendall_tau'] = None
        score['errors']['reversal'] = None
    score['measurement_status'] = 'partial' if text.strip() else 'unavailable'
    score['metric_available'] = {
        'matched_coverage': bool(text.strip()), 'matched_order': order_available,
        'omission': False, 'intrusion': False, 'cue_dependency': cued_events is not None,
    }
    score['limitations'] = [
        '매칭되지 않은 내용은 누락·침입·의미 매칭 실패를 구분하지 못하므로 오류 개수로 확정하지 않습니다.',
        '순서 일치도와 커버리지는 매칭된 장면에 대한 관찰이며 임상 점수가 아닙니다.',
    ]
    return score


def recall_from_answers(items, graph):
    """Question-list ordering must never be interpreted as free-recall order."""
    turns = [it for it in items if it.get('responseType') == 'free_recall']
    if not turns:
        return None
    if len(turns) != 1:
        return {'measurement_status': 'unavailable', 'reason': 'multiple_free_recall_turns'}
    item = turns[0]
    if item.get('transcriptSource') == 'demo':
        return {'measurement_status': 'unavailable', 'reason': 'demo_transcript'}
    cues = item.get('cuedSceneIds')
    if cues is not None and (not isinstance(cues, list) or any(
            not isinstance(s, str) or s not in graph.true_order for s in cues)):
        return {'measurement_status': 'unavailable', 'reason': 'invalid_cue_history'}
    text = item.get('userAnswer', '')
    if not isinstance(text, str):
        return {'measurement_status': 'unavailable', 'reason': 'invalid_transcript'}
    return analyze_recall(text, graph, cued_events=cues)
