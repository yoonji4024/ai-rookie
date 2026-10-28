"""Narrow checks for unsupported reassurance in measurement-only reports.

These lexical checks cover explicit observed assertions, not every paraphrase.
They do not decide whether consultation is clinically required for anyone.
"""
import re
import math

_ASSERTION=re.compile(
    r'(?:상담|진료|검사)(?:은|는|이|가|을|를)?\s*'
    r'(?:(?:전혀|더\s*이상|당장)\s*)?'
    r'(?:필요(?:가)?\s*없(?:습니다|어요|다|지만|으나)'
    r'|필요하지\s*않(?:습니다|아요|다|으나)'
    r'|불필요(?:합니다|해요|하다))'
)
_DISCLAIMED=re.compile(
    r'^\s*[\"\u201d\u2019\x27]?\s*(?:고|라고|라는|는)?\s*'
    r'(?:(?:뜻|의미)(?:이|가)?\s*(?:아니|아닙|아님)|(?:단정|확정|말)할\s*수\s*없)'
)


def unsupported_reassurance_spans(text: str) -> list[str]:
    result=[]
    for match in _ASSERTION.finditer(text):
        # A sentence denying that such a conclusion can be drawn is allowed.
        if _DISCLAIMED.match(text[match.end():]):continue
        result.append(match.group(0))
    return list(dict.fromkeys(result))


def unmeasured_quality_assertions(text: str) -> list[str]:
    """Recognize narrow complete assertions of unmeasured input sufficiency.

    This scoring contract has no measured recording-quality or utterance-length
    sufficiency result. Do not infer one from successful feature extraction.
    Full-clause matching deliberately leaves quotes, conditions, denials and
    other paraphrases unresolved for the verifier instead of rejecting keywords.
    """
    prefix = r'(?:(?:이번|현재)\s*)?'
    quality = r'(?:녹음(?:의)?\s*(?:품질|음질)|음질)(?:이|가|은|는)?\s*'
    plain = r'(?:충분|양호)(?:합니다|해요|했습니다|했어요|하다|했다|함)'
    confirmation = (
        r'(?:충분|양호)(?:하다고\s*|했다는\s*사실이\s*(?:이번\s*기록에서\s*)?)'
        r'확인(?:되었습니다|됐습니다|됩니다)'
    )
    sufficiency = (
        r'(?:충분한\s*발화량이\s*확보(?:되었|됐)으므로|'
        + prefix + r'발화량(?:이|은)\s*충분하므로)\s*'
        r'(?:(?:이\s*)?측정(?:\s*결과)?|결과)(?:를|는|은)?\s*'
        r'신뢰할\s*수\s*(?:있습니다|있어요)'
    )
    patterns = [prefix + quality + r'(?:' + plain + '|' + confirmation + ')', sufficiency]
    clauses = re.split(r'(?<=[.!?。])\s+|\n+', text)
    return [c.strip() for c in clauses
            if any(re.fullmatch(p + r'[.!?。]?', c.strip()) for p in patterns)]


def measurement_claim_issues(report: dict, score_result: dict) -> list[str]:
    """Narrow binding/unit checks for explicit score statements, not full semantics.

    A number occurring elsewhere in the input does not support assigning it to
    another axis. Threshold discussions are left to the existing verifier.
    """
    axes = score_result.get('axes') or score_result.get('axis_scores') or {}
    expected = {}
    for axis, value in axes.items():
        raw = value.get('score') if isinstance(value, dict) else value
        available = not isinstance(value, dict) or value.get('available') is not False
        expected[axis] = (float(raw) if type(raw) in (int, float) and math.isfinite(raw) and available else None)
    issues = []
    parts = []
    for value in report.values():
        if isinstance(value, str): parts.append(value)
        elif isinstance(value, dict): parts.extend(v for v in value.values() if isinstance(v, str))
        elif isinstance(value, list): parts.extend(v for v in value if isinstance(v, str))
    text = '\n'.join(parts)
    if unmeasured_quality_assertions(text):
        issues.append('제공되지 않은 녹음 품질·발화량 충분성을 단정함')
    number = r'(-?\d+(?:\.\d+)?)\s*점'
    suffix = r'\s*(?:미만|이상|이하|초과|부터|까지)'
    point_negation = re.compile(
        r'^\s*(?:(?:이|은|는)\s*|(?:이?라는|이라는)\s*'
        r'(?:것은|것이|말은|말이)\s*(?:사실이\s*)?)'
        r'(?:아닙니다|아니에요|아니다)(?=[.!?\s]|$)'
    )
    def compare(subject, claimed, truth, negated=False):
        # A denial of a wrong value is not an affirmative measurement claim.
        # This recognizes only direct finite-point denials, not general negation.
        if negated:
            if truth is not None and abs(float(claimed) - truth) <= .051:
                issues.append(f'{subject}의 실제 측정값을 부정함')
        elif truth is None or abs(float(claimed) - truth) > .051:
            issues.append(f'{subject} 점수의 측정값 대응 불일치')
    total = score_result.get('total_score')
    total = total if type(total) in (int, float) and math.isfinite(total) else None
    for subject, truth in [('총점', total), ('전반 점수', total), *expected.items()]:
        pattern = re.escape(subject) + r'[^0-9.!?\n]{0,35}?' + number
        for match in re.finditer(pattern, text):
            if re.match(suffix, text[match.end():]): continue
            compare(subject, match.group(1), truth, bool(point_negation.match(text[match.end():])))
    comments = report.get('axis_comments', {})
    if isinstance(comments, dict):
        for axis, comment in comments.items():
            if not isinstance(comment, str): continue
            matches = list(re.finditer(number, comment))
            # Bind an implicit single score to its keyed axis only when no other
            # axis is being compared in that comment.
            if len(matches) == 1 and not any(a != axis and a in comment for a in expected):
                match = matches[0]
                if not re.match(suffix, comment[match.end():]):
                    compare(axis, match.group(1), expected.get(axis), bool(point_negation.match(comment[match.end():])))
    if re.search(r'(?:휴지|침묵)\s*(?:시간\s*)?비율(?:은|는|이|가|:)?\s*\d+(?:\.\d+)?\s*(?:회|초)(?!당)', text):
        issues.append('휴지 비율을 횟수·시간 단위로 표현함')
    return list(dict.fromkeys(issues))
