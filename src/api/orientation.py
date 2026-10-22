"""Place-expression evidence, never independent verification of whereabouts."""
from __future__ import annotations

import re


CONCRETE_PLACES = frozenset({
    "집", "자택", "방", "침실", "침대", "거실", "안방", "부엌", "주방", "학교",
    "대학교", "공학관", "강의실", "연구실", "사무실", "회사", "병원",
    "요양원", "복지관", "카페", "식당", "도서관", "교회", "성당", "공원",
    "아파트", "기숙사", "숙소", "호텔", "센터", "경로당",
})


def has_terminal_copular_denial(compact_assertion: str) -> bool:
    """Narrow orientation-only supplement for polite terminal denial forms.

    The caller first removes correction prefixes and punctuation. Interior
    mentions of these words are not enough; broader negation scope is not
    resolved by this spelling rule.
    """
    return compact_assertion.endswith((
        "아니에요", "아니예요", "아닙니다", "아니죠", "아니거든요", "아니네요",
    ))


def matches_date_keyword(raw_answer: str, keyword: str) -> bool:
    """Compare a supplied date key without matching inside a longer number.

    Preserve compact Korean spelling/spacing comparison. The raw-number
    alternative keeps a separated year in '2026 1 5' from becoming part of
    the concatenated number202615. This does not parse calendar validity or
    resolve multiple conflicting dates in an answer.
    """
    if not keyword:
        return False
    corrections = list(re.finditer(
        r"아[^0-9a-zA-Z가-힣]*니[^0-9a-zA-Z가-힣]*[라고]", raw_answer,
    ))
    assertion = raw_answer[corrections[-1].end():] if corrections else raw_answer
    compact = re.sub(r"[^0-9a-zA-Z가-힣]", "", assertion).lower()
    left = r"(?<![0-9])" if keyword[0].isdigit() else ""
    right = r"(?![0-9])" if keyword[-1].isdigit() else ""
    if re.search(left + re.escape(keyword) + right, compact):
        return True
    numeric = re.fullmatch(r"([0-9]+)([년월일]?)", keyword)
    if numeric:
        number, unit = numeric.groups()
        pattern = r"(?<![0-9])" + re.escape(number) + r"(?![0-9])"
        if unit:
            pattern += r"\s*" + unit
        return re.search(pattern, assertion) is not None
    return False


def detect_place_expression(raw_answer: str) -> tuple[bool | None, str]:
    """Return noun-expression presence, or None when it cannot be measured.

    Use the native tokenizer, not its approximate fallback. Noun boundaries
    distinguish 집/방 from 집중/방금. Proper-name suffixes permit named facilities;
    a following attached noun/suffix excludes compounds such as 센터장.
    This is lexical evidence only: it does not establish current time, location,
    speaker truthfulness or clinical orientation.
    """
    from src.agents.analysis.features import extract_linguistic as linguistic

    if not linguistic._HAS_KIWI or linguistic._kiwi is None:
        return None, "place_tokenizer_unavailable"
    # Same correction markers as the answer rules, retaining spaces needed by
    # the tokenizer. Punctuation/spacing inside the marker is ignored there too.
    corrections = list(re.finditer(
        r"아[^0-9a-zA-Z가-힣]*니[^0-9a-zA-Z가-힣]*[라고]", raw_answer,
    ))
    assertion = raw_answer[corrections[-1].end():] if corrections else raw_answer
    try:
        tokens = linguistic._kiwi.tokenize(assertion)
        for i, token in enumerate(tokens):
            if token.tag not in {"NNG", "NNP"}:
                continue
            known_place = token.form in CONCRETE_PLACES
            named_facility = token.tag == "NNP" and any(
                len(place) >= 2 and token.form.endswith(place)
                for place in CONCRETE_PLACES
            )
            if not (known_place or named_facility):
                continue
            if i + 1 < len(tokens):
                following = tokens[i + 1]
                if (following.start == token.start + token.len
                        and following.tag.startswith(("NN", "XSN"))):
                    continue
            return True, "kiwi_noun_boundary"
    except Exception:
        # A missing or failing measurement must not turn into a wrong answer.
        return None, "place_tokenizer_failed"
    return False, "kiwi_noun_boundary"
