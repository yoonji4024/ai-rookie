"""한국어 비유창성 — 규칙 기반 탐지 (LLM 대안).

배경
  믿:음(LLM)으로 같은 과제를 시도했으나 실제 Kang 대화체 전사에서 실패했다:
    - MCI 발화의 명백한 비유창성을 못 찾고 (AUC 0.50~0.55)
    - HC 발화에서 없는 마커를 만들어냄 (긴 문장을 '조사 오류'로 인용)
  → 실제 관찰된 패턴이 규칙적이므로 정규식으로 직접 잡는다.
     API 호출 불필요 · 완전 재현 · 근거 명시 가능.

관찰된 실제 패턴 (Kang MCI_63)
  "아니 , 이제 우리 , 저기 뭐야 거기 내 , 저기 뭐야 으 , 제가 즈 , 나 , 제 , 제가 저기 , 거기서 일하는 거 있어요 ."
    - 단어 찾기 : "저기 뭐야" 반복
    - 파편 반복 : "제가 즈 , 나 , 제 , 제가" (단음절 조각을 늘어놓음)
    - 지시어    : "저기" 과다
"""
from __future__ import annotations

import re

# 단어 찾기 실패 표현
WORD_FINDING = [
    r"뭐야", r"뭐더라", r"뭐지", r"뭐라(고|더라)", r"그거\s*뭐", r"이름이\s*뭐",
    r"생각이?\s*안\s*나", r"기억이?\s*안\s*나",
]
# 지시어 (구체 명사 대신 쓰이는 것)
DEMONSTRATIVES = [r"저기", r"거기", r"그거", r"저거", r"이거", r"그것", r"저것"]
# 간투사 / 채움말
FILLERS = [r"^음$", r"^어$", r"^에$", r"^그$", r"^저$", r"^아$", r"^으$"]

_WF = re.compile("|".join(WORD_FINDING))
_DEMO = re.compile("|".join(DEMONSTRATIVES))
_FILLER = re.compile("|".join(FILLERS))
_TOKEN = re.compile(r"[가-힣]+")


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text)


def analyze_utterance(text: str) -> dict:
    """발화 1개 → 마커 카운트 + 근거."""
    toks = _tokens(text)
    out = {k: {"count": 0, "evidence": []} for k in
           ("word_finding", "demonstrative", "fragment_repeat",
            "immediate_repeat", "filler", "incomplete_ending")}

    # 단어 찾기
    for m in _WF.finditer(text):
        out["word_finding"]["count"] += 1
        out["word_finding"]["evidence"].append(_around(text, m.start()))

    # 지시어
    for m in _DEMO.finditer(text):
        out["demonstrative"]["count"] += 1
        out["demonstrative"]["evidence"].append(_around(text, m.start()))

    # 간투사
    out["filler"]["count"] = sum(1 for t in toks if _FILLER.match(t))

    # 인접 단어 반복 ("제가 ... 제가", "옛날 옛날")
    for i in range(1, len(toks)):
        if toks[i] == toks[i - 1] and len(toks[i]) >= 1:
            out["immediate_repeat"]["count"] += 1
            out["immediate_repeat"]["evidence"].append(f"{toks[i-1]} {toks[i]}")

    # 파편 반복: 1음절 조각이 쉼표로 연달아 나열됨 ("즈 , 나 , 제 ,")
    frags = re.findall(r"(?:(?:^|,)\s*[가-힣]{1}\s*(?=,))", text)
    if len(frags) >= 2:
        out["fragment_repeat"]["count"] = len(frags)
        out["fragment_repeat"]["evidence"].append(text[:60])

    # 어미 미완성: 종결어미 없이 끝나거나 말줄임
    stripped = text.strip().rstrip(" .?!")
    if stripped and not re.search(r"(요|다|까|죠|네|군|어|아|지)$", stripped):
        out["incomplete_ending"]["count"] = 1
        out["incomplete_ending"]["evidence"].append(text[-30:])

    for v in out.values():
        v["evidence"] = v["evidence"][:3]
    return out


def _around(text: str, pos: int, w: int = 12) -> str:
    return text[max(0, pos - w): pos + w].strip()


def analyze(utterances: list[str]) -> dict:
    """발화 목록 → 합산 마커."""
    total = {k: {"count": 0, "evidence": []} for k in
             ("word_finding", "demonstrative", "fragment_repeat",
              "immediate_repeat", "filler", "incomplete_ending")}
    for u in utterances:
        r = analyze_utterance(u)
        for k, v in r.items():
            total[k]["count"] += v["count"]
            for e in v["evidence"]:
                if len(total[k]["evidence"]) < 5 and e not in total[k]["evidence"]:
                    total[k]["evidence"].append(e)
    return total


def to_features(markers: dict, utterances: list[str]) -> dict:
    """**형태소(토큰) 기준** 정규화.

    ⚠️ 발화당(per-utterance) 정규화는 길이 편향에 오염된다.
       Kang 실측: 발화당 형태소가 HC 27.5 vs MCI 15.8로 거의 2배 →
       발화당으로 세면 길게 말하는 HC가 무엇이든 많이 나온다.
       실제로 간투사는 발화당 AUC 0.785였으나 형태소당 0.578로 무너졌다(=길이 아티팩트).
       살아남은 신호: 어미미완성 0.736 · 파편반복 0.726 · 지시어 0.692.
    """
    n_tok = sum(len(_tokens(u)) for u in utterances) or 1
    f = {f"krr_{k}_rate": v["count"] / n_tok for k, v in markers.items()}
    f["krr_total_rate"] = sum(v["count"] for v in markers.values()) / n_tok
    return f


# 길이 편향 검사를 통과한 신호 (형태소당 AUC ≥ 0.65)
ROBUST_FEATURES = [
    "krr_incomplete_ending_rate",   # 0.736
    "krr_fragment_repeat_rate",     # 0.726
    "krr_demonstrative_rate",       # 0.692
]

FEATURE_NAMES = [
    "krr_word_finding_rate", "krr_demonstrative_rate", "krr_fragment_repeat_rate",
    "krr_immediate_repeat_rate", "krr_filler_rate", "krr_incomplete_ending_rate",
    "krr_total_rate",
]


if __name__ == "__main__":
    from src.preprocessing.kang_loader import load_kang

    demo = "아니 , 이제 우리 , 저기 뭐야 거기 내 , 저기 뭐야 으 , 제가 즈 , 나 , 제 , 제가 저기 , 거기서 일하는 거 있어요 ."
    print("[검증용 실제 MCI 발화]")
    print(f"  {demo}\n")
    for k, v in analyze_utterance(demo).items():
        if v["count"]:
            print(f"  {k}: {v['count']}회 | {v['evidence'][:2]}")

    print("\n[집단 평균 — 형태소당 비율(길이 편향 제거)]")
    import numpy as np
    from sklearn.metrics import roc_auc_score

    recs = load_kang()
    rows, y = [], []
    for r in recs:
        utts = [u.text for u in r.par_utterances if u.text]
        f = to_features(analyze(utts), utts)
        rows.append([f[k] for k in FEATURE_NAMES])
        y.append(1 if r.label == "MCI" else 0)
    K, y = np.array(rows), np.array(y)

    print(f"  {'마커':26s} {'HC':>8s} {'MCI':>8s} {'AUC':>7s}")
    for j, k in enumerate(FEATURE_NAMES):
        c = K[:, j]
        a = roc_auc_score(y, c)
        a = max(a, 1 - a)
        mark = "  ← 채택" if k in ROBUST_FEATURES else ""
        print(f"  {k:26s} {c[y==0].mean():8.4f} {c[y==1].mean():8.4f} {a:7.3f}{mark}")
