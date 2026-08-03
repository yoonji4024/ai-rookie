"""축별 근거 검색 — 점수 결과에 붙일 문헌·실험 근거를 고른다.

자유 검색이 아니라 **고정 코퍼스(corpus.ALL) 안에서만** 고른다.
검색 결과로 나온 원문이 그대로 검증 에이전트의 대조 기준이 되므로,
여기서 나오지 않은 근거는 리포트에 인용될 수 없다.

2단 전략
  1) Solar Embedding 코사인 유사도 (기본)
  2) 키워드 겹침 폴백 — API 실패·오프라인·LLM_MOCK=1일 때. 결정적이라 테스트에도 유리.

축 필터가 1차 게이트다. 임베딩은 그 안에서 순위만 정한다.
→ '발음 정확도' 점수에 '순서 회상' 근거가 붙는 사고를 구조적으로 차단.

사용:
    from src.rag.retriever import retrieve_for_axis
    ev = retrieve_for_axis("침묵 시간", k=3)
"""
from __future__ import annotations

import math
import os
import re

from src.rag.corpus import Evidence, for_axis

_EMB_CACHE: dict[str, list[float]] = {}

# 축 이름 ↔ 코퍼스 용어가 다르다 (축 '침묵 시간' vs 근거 '휴지').
# 축 이름만으로 검색하면 어휘 불일치로 못 찾으므로 동의어를 붙여 질의를 넓힌다.
AXIS_QUERY: dict[str, str] = {
    "침묵 시간": "침묵 휴지 pause 멈춤 지연 단어찾기 인출",
    "버벅임": "버벅임 비유창성 간투사 반복 어미 미완성 지시어 머뭇거림",
    "발화 속도": "발화속도 speech rate 말 빠르기 분절 운동실행",
    "발음 정확도": "발음 음질 명료도 HNR CPP jitter shimmer 발성 안정성",
    "문장 완성도": "문장 완성도 어휘다양성 통사 복잡도 내용어 구조",
    "순서 회상": "순서 회상 일화기억 실행기능 누락 뒤바뀜 삽입",
}


def _tokens(s: str) -> set[str]:
    """한글·영문·숫자 토큰. 2글자 미만 제거."""
    return {t for t in re.findall(r"[가-힣A-Za-z0-9.]+", s.lower()) if len(t) >= 2}


def _keyword_score(query: str, e: Evidence) -> float:
    """키워드 겹침 (폴백). 태그는 가중치 2배 — 축약된 핵심어라 신호가 강함."""
    q = _tokens(query)
    if not q:
        return 0.0
    body = _tokens(e.text)
    tags = _tokens(" ".join(e.tags))
    return (len(q & body) + 2.0 * len(q & tags)) / len(q)


def _embed(texts: list[str]) -> list[list[float]] | None:
    """Solar Embedding. 실패하면 None → 키워드 폴백."""
    if os.environ.get("LLM_MOCK") == "1":
        return None
    try:
        import requests
        from src.common.llm import load_env
        load_env()
        key = os.environ.get("UPSTAGE_API_KEY")
        if not key:
            return None
        r = requests.post(
            "https://api.upstage.ai/v1/embeddings",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": "embedding-query", "input": texts},
            timeout=20,
        )
        r.raise_for_status()
        return [d["embedding"] for d in r.json()["data"]]
    except Exception:
        return None


def _cos(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def retrieve_for_axis(axis: str, k: int = 3, query: str | None = None) -> list[Evidence]:
    """축에 붙는 근거 중 상위 k건. query 없으면 축 이름으로 검색."""
    cands = for_axis(axis)
    if not cands:
        return []
    q = query or AXIS_QUERY.get(axis, axis)

    vecs = _embed([q] + [e.text for e in cands])
    if vecs and len(vecs) == len(cands) + 1:
        qv, evs = vecs[0], vecs[1:]
        ranked = sorted(zip(cands, evs), key=lambda p: -_cos(qv, p[1]))
        out = [e for e, _ in ranked]
    else:
        out = sorted(cands, key=lambda e: -_keyword_score(q, e))

    # 실험 근거(exp)를 최소 1건은 포함 — 우리 데이터가 가장 방어하기 쉬운 근거
    top = out[:k]
    if not any(e.kind == "exp" for e in top):
        exp = next((e for e in out if e.kind == "exp"), None)
        if exp and k > 0:
            top = [exp] + top[: k - 1]
    return top


def retrieve_for_scores(score_result: dict, k: int = 3) -> dict[str, list[Evidence]]:
    """점수 결과의 모든 축에 대해 근거 검색. {축: [Evidence]}"""
    axes = score_result.get("axes") or score_result.get("axis_scores") or {}
    return {axis: retrieve_for_axis(axis, k=k) for axis in axes}


def format_for_prompt(by_axis: dict[str, list[Evidence]]) -> str:
    """LLM 프롬프트용 근거 블록. ID를 명시해 그 ID로만 인용하게 한다."""
    lines = []
    for axis, evs in by_axis.items():
        lines.append(f"[{axis}]")
        for e in evs:
            src = e.cite or "일반 임상 소견 (특정 논문 인용 불가)"
            lines.append(f"  - ({e.id}) {e.text}")
            lines.append(f"    출처: {src}")
        lines.append("")
    return "\n".join(lines)


def allowed_ids(by_axis: dict[str, list[Evidence]]) -> set[str]:
    """검증용 — 이번 리포트에서 인용이 허용되는 근거 ID 집합."""
    return {e.id for evs in by_axis.values() for e in evs}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--axis", default="침묵 시간")
    ap.add_argument("-k", type=int, default=3)
    a = ap.parse_args()

    evs = retrieve_for_axis(a.axis, k=a.k)
    print(f"[{a.axis}] 근거 {len(evs)}건\n")
    for e in evs:
        print(f"  ({e.id}) [{e.kind}]")
        print(f"    {e.text[:90]}…")
        print(f"    출처: {e.cite or '— (미기재)'}\n")
