"""언어 피처 — 전사/STT 텍스트에서 추출 (kiwipiepy 형태소 기반).

CLAUDE.md §6: 어휘 다양성, 통사 복잡도, disfluency, word-finding, 발화량.
"""
from __future__ import annotations

import re

import numpy as np

try:
    from kiwipiepy import Kiwi

    _kiwi = Kiwi()
    _HAS_KIWI = True
except ImportError:  # 형태소기 미설치 시 정규식 fallback (근사 피처)
    _kiwi = None
    _HAS_KIWI = False


class _Tok:
    __slots__ = ("form", "tag")

    def __init__(self, form, tag):
        self.form = form
        self.tag = tag


def _fallback_tokenize(text: str):
    """kiwi 없을 때 공백/음절 근사 토큰화. 태그는 대략치."""
    toks = []
    for w in re.findall(r"[가-힣]+|[a-zA-Z]+", text):
        tag = "IC" if w in FILLERS else ("NP" if w in {"그거", "저거", "이거", "여기", "거기"} else "NNG")
        toks.append(_Tok(w, tag))
    return toks


def _tokenize(text: str):
    return _kiwi.tokenize(text) if _HAS_KIWI else _fallback_tokenize(text)

FILLERS = {"음", "어", "아", "에", "그", "저", "뭐"}
CONTENT_TAGS = {"NNG", "NNP", "VV", "VA", "MAG", "XR"}   # 내용어
PRONOUN_TAGS = {"NP"}
PREDICATE_TAGS = {"VV", "VA", "VX", "XSV", "XSA"}        # idea density 근사


def _mattr(tokens: list[str], window: int = 50) -> float:
    if len(tokens) < window:
        return len(set(tokens)) / len(tokens) if tokens else 0.0
    ttrs = [
        len(set(tokens[i : i + window])) / window
        for i in range(len(tokens) - window + 1)
    ]
    return float(np.mean(ttrs))


def extract_linguistic(
    transcript: str,
    word_timings: list[dict] | None = None,
    utterance_texts: list[str] | None = None,
) -> dict:
    """언어 피처 딕셔너리.

    transcript: 참가자 발화 전체 텍스트.
    word_timings: [{'text', 'startTime', 'endTime'}, ...] 발화 단위 타이밍(초).
    """
    # 질문별 답변 경계를 알고 있을 때는 이를 발화 단위로 보존한다. 여러 답변을
    # 공백으로 합치면 전체 세션이 '한 문장'이 되어 문장 길이 점수가 포화된다.
    utt_texts = (
        [text for text in (utterance_texts or []) if text.strip()]
        if utterance_texts is not None
        else [w["text"] for w in word_timings]
        if word_timings else [transcript]
    )

    morphs_all: list[str] = []
    tags_all: list[str] = []
    utt_lens: list[int] = []
    fillers = repeats = 0

    for text in utt_texts:
        toks = _tokenize(text)
        forms = [t.form for t in toks if t.tag[0] not in "SJ"]  # 기호/조사 제외 단위는 아래서 별도
        morphs = [t.form for t in toks if not t.tag.startswith("S")]
        tags = [t.tag for t in toks if not t.tag.startswith("S")]
        morphs_all += morphs
        tags_all += tags
        utt_lens.append(len(morphs))
        # disfluency: filler(간투사·필러 후보), 인접 반복
        fillers += sum(1 for t in toks if t.tag == "IC" or t.form in FILLERS)
        words = re.findall(r"[가-힣]+", text)
        repeats += sum(1 for i in range(1, len(words)) if words[i] == words[i - 1])

    n = len(morphs_all)
    content = sum(1 for t in tags_all if t in CONTENT_TAGS)
    pronouns = sum(1 for t in tags_all if t in PRONOUN_TAGS)
    predicates = sum(1 for t in tags_all if t in PREDICATE_TAGS)
    nouns = sum(1 for t in tags_all if t.startswith("NN"))

    feats = {
        "n_utterances": len(utt_texts),
        "n_morphemes": n,
        "utt_len_mean": float(np.mean(utt_lens)) if utt_lens else 0.0,
        # 발화가 1개뿐이면 '발화 간 편차'는 정의되지 않는다 → 결측(NaN).
        # 0으로 두면 채점기가 '편차 0'인 실측값으로 받아들여 z가 -4까지 내려간다.
        "utt_len_std": (float(np.std(utt_lens)) if len(utt_lens) >= 2
                        else float("nan")),
        "ttr": len(set(morphs_all)) / n if n else 0.0,
        "mattr": _mattr(morphs_all),
        "content_ratio": content / n if n else 0.0,
        "pronoun_ratio": pronouns / n if n else 0.0,
        "pronoun_noun_ratio": pronouns / nouns if nouns else 0.0,  # word-finding 신호
        "idea_density": predicates / n if n else 0.0,
        "filler_rate": fillers / n if n else 0.0,
        "repeat_rate": repeats / n if n else 0.0,
    }

    # 한국어 비유창성 (규칙 기반, 형태소당 정규화)
    # 길이 편향 검사를 통과한 3종만 사용 — 상세 근거는 korean_disfluency_rule.py
    try:
        from src.agents.analysis.features.korean_disfluency_rule import (
            ROBUST_FEATURES, analyze as _kr_analyze, to_features as _kr_feats,
        )
        _utts = utt_texts
        _krf = _kr_feats(_kr_analyze(_utts), _utts)
        feats.update({k: _krf[k] for k in ROBUST_FEATURES})
    except Exception:
        feats.update({k: float("nan") for k in
                      ("krr_incomplete_ending_rate", "krr_fragment_repeat_rate",
                       "krr_demonstrative_rate")})

    # 내용 표현 카운터: 한글 연속구간당 정규화. 위 Kiwi 형태소 지표와 분모가 다름.
    try:
        from src.agents.analysis.features.content_features import extract_content
        feats.update(extract_content(utt_texts if word_timings else [transcript]))
    except Exception:
        from src.agents.analysis.features.content_features import FEATURE_NAMES as _CF
        feats.update({k: float("nan") for k in _CF})

    # 타이밍 기반: 발화 속도, 응답 특성
    if word_timings:
        durs, sylls, gaps = [], [], []
        prev_end = None
        for w in word_timings:
            d = w["endTime"] - w["startTime"]
            if d > 0:
                durs.append(d)
                sylls.append(len(re.findall(r"[가-힣]", w["text"])))
            if prev_end is not None:
                gap = w["startTime"] - prev_end
                if 0 <= gap <= 30:
                    gaps.append(gap)
            prev_end = w["endTime"]
        total_d, total_s = sum(durs), sum(sylls)
        feats["speech_rate"] = total_s / total_d if total_d else 0.0     # 음절/초
        feats["utt_dur_mean"] = float(np.mean(durs)) if durs else 0.0
        feats["turn_gap_mean"] = float(np.mean(gaps)) if gaps else 0.0   # 발화 간 간격(응답 지연 근사)
        feats["turn_gap_std"] = float(np.std(gaps)) if gaps else 0.0
    else:
        # 단어 타임스탬프가 없으면 시간 기반 지표를 **계산할 수 없다** → 결측(NaN).
        # 0으로 두면 "말을 전혀 안 했다"는 실측값처럼 처리되어 z가 -8까지 내려간다.
        # (STT가 타임스탬프를 주면 자동으로 채워진다)
        feats.update({k: float("nan") for k in
                      ("speech_rate", "utt_dur_mean", "turn_gap_mean", "turn_gap_std")})

    return feats
