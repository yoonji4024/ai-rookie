"""Preserve measured zero, unavailable axes, and raw units in LLM inputs."""
import math


def measured_axis_score(value):
    if isinstance(value, dict):
        if value.get('available') is False:
            return None
        value = value.get('score')
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 100 else None


def report_measurement_facts(score_result: dict, *, full: bool = True) -> dict:
    axes = score_result.get('axes') or score_result.get('axis_scores') or {}
    scores = {axis: measured_axis_score(value) for axis, value in axes.items()}
    result = {'total_score': measured_axis_score(score_result.get('total_score')),
              'grade': score_result.get('grade'), 'axis_scores': scores,
              'axis_availability': {axis: value is not None for axis, value in scores.items()}}
    if not full:
        return result
    measured = {}
    for axis, value in axes.items():
        if not isinstance(value, dict) or value.get('available') is False:
            continue
        features = {}
        for name, item in (value.get('features') or {}).items():
            raw = item.get('value') if isinstance(item, dict) else item
            if type(raw) in (int, float) and math.isfinite(raw):
                features[name] = raw
        if features:
            measured[axis] = features
    result['axis_measurements'] = measured
    result['operational_definitions'] = {
        'availability': 'available=false 또는 score=null은 측정 불가다. 유효한 0점과 다르며 수치로 바꾸지 않는다.',
        'axis_scores': '축 점수는 0~100점의 계산값이며 백분율이나 원지표 값이 아니다. 다른 축이나 총점과 바꿔 쓸 수 없다.',
        'ac_pause_ratio': '휴지 시간의 비율로 단위는 비율이다. 소수값에 100을 곱하면 백분율이며 초나 횟수가 아니다.',
        'temporal': '제공된 기록은 한 시점이다. 이전 측정값이 없으므로 시간에 따른 향상·악화·변화량을 추론하지 않는다.',
    }
    return result
