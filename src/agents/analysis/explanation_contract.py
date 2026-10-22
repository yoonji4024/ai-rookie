"""Numeric availability and shape checks for the standalone explanation role.

These checks do not establish the semantic correctness of generated text.
"""
import math
from numbers import Real


def finite_number(value):
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    return float(value) if math.isfinite(value) else None


def observation_item(item):
    """Keep observed zero distinct from missing data; never infer a normal range."""
    value = finite_number(item.get('value'))
    if item.get('value_available') is False or item.get('available') is False:
        value = None
    reference = finite_number(item.get('reference_mean', item.get('정상군_평균')))
    if item.get('reference_available') is False:
        reference = None
    importance = finite_number(item.get('importance'))
    result = {key: item[key] for key in ('feature', '설명', 'unit') if isinstance(item.get(key), str)}
    result.update(value=value, value_available=value is not None,
                  reference_mean=reference, reference_available=reference is not None,
                  reference_scope='provided_mean_only_not_normal_range',
                  importance=importance, importance_available=importance is not None,
                  importance_scope='global_model' if item.get('importance_scope') == 'global_model' else 'unspecified',
                  individual_contribution_available=False)
    return result


def explanation_payload(prediction, contributions):
    if not isinstance(prediction, dict) or not isinstance(contributions, list):
        raise ValueError('prediction must be a mapping and contributions must be a list')
    if any(not isinstance(item, dict) for item in contributions):
        raise ValueError('each contribution must be a mapping')
    probabilities = prediction.get('prob')
    if probabilities is not None and not isinstance(probabilities, dict):
        raise ValueError('probabilities must be a mapping or absent')
    probabilities = {str(k): finite_number(v) for k, v in (probabilities or {}).items()}
    label = prediction.get('label')
    return {
        '모델_출력': {'label': label if isinstance(label, str) else None,
                    '확률': probabilities,
                    'probability_available': {k: v is not None for k, v in probabilities.items()}},
        '관찰_항목': [observation_item(item) for item in contributions],
        '개별_기여_계산됨': False,
    }


def validated_explanation(output):
    fields = ('observation', 'meaning', 'value_note')
    if (not isinstance(output, dict) or output.get('error')
            or not isinstance(output.get('overall'), str)
            or not isinstance(output.get('evidence'), list)
            or any(not isinstance(item, dict) or any(not isinstance(item.get(k), str) for k in fields)
                   for item in output['evidence'])):
        return {'error': 'invalid_explanation_schema', 'evidence': [], 'overall': ''}
    # Only the declared evidence contract is returned, not arbitrary extra fields.
    return {'evidence': [{k: item[k] for k in fields} for item in output['evidence']],
            'overall': output['overall']}
