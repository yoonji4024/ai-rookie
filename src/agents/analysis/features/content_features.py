"""내용(semantic) 피처 — 전사 텍스트 기반, 규칙.

내용 5축 중 **전사만으로 잴 수 있는** 축의 재료를 뽑는다.
  - 단어 수준        : 어휘 다양성·내용어 밀도
  - 시간·장소 지남력 : 시간/장소 표현의 밀도·구체성
  - 논리 연결        : 접속 표현, 지시어 해소 가능성

⚠️ 정규화는 **형태소(토큰) 기준**이다.
   발화당으로 세면 길게 말하는 사람이 유리해진다(Kang: HC 27.5형태소 vs MCI 15.8).
   실제로 발화당 정규화 때문에 간투사가 가짜 최강 신호로 보인 적이 있다.
"""
from __future__ import annotations

import re

# 시간 표현 — 구체(날짜·연도) / 상대(어제·요즘) 구분
TIME_SPECIFIC = re.compile(
    r"[0-9]+\s*(년|월|일|시|분|살|세)|[일이삼사오육칠팔구십백천]+\s*(년|월|일|살|세)"
    r"|월요일|화요일|수요일|목요일|금요일|토요일|일요일|주말"
)
TIME_RELATIVE = re.compile(
    r"어제|오늘|내일|모레|그저께|아까|지난|작년|올해|내년|요즘|예전|옛날|그때|나중에"
    r"|아침|점심|저녁|밤|낮|새벽|한참|방금"
)
# 장소 표현 — 구체(고유명사·시설) / 지시(여기·거기)
PLACE_SPECIFIC = re.compile(
    r"집|병원|학교|시장|공원|교회|절|식당|가게|회사|사무실|공항|역|정류장|동네|아파트"
    r"|서울|부산|대구|인천|광주|대전|울산|경기|강원|제주|병실|방|마당|부엌"
)
PLACE_DEICTIC = re.compile(r"여기|거기|저기|이쪽|저쪽|그쪽|이곳|그곳|저곳")

# 논리 연결 표현 — 인과·대조·순서
CONNECTIVE = re.compile(
    r"그래서|그러니까|그러므로|따라서|왜냐하면|때문에"          # 인과
    r"|그런데|하지만|그렇지만|반면|그래도|근데"                 # 대조
    r"|그리고|그다음|그러고|먼저|다음에|마지막으로|우선"        # 순서
)
TOKEN = re.compile(r"[가-힣]+")


def _tok(texts: list[str]) -> int:
    return sum(len(TOKEN.findall(t)) for t in texts) or 1


def extract_content(utterances: list[str]) -> dict:
    """전사 → 내용 피처 (형태소당 정규화)."""
    joined = " ".join(utterances)
    n = _tok(utterances)

    ts = len(TIME_SPECIFIC.findall(joined))
    tr = len(TIME_RELATIVE.findall(joined))
    ps = len(PLACE_SPECIFIC.findall(joined))
    pd = len(PLACE_DEICTIC.findall(joined))
    conn = len(CONNECTIVE.findall(joined))

    return {
        # 시간·장소 지남력
        "cnt_time_specific_rate": ts / n,       # 구체적 시간(날짜·연도)
        "cnt_time_relative_rate": tr / n,       # 상대적 시간(어제·요즘)
        "cnt_place_specific_rate": ps / n,      # 구체적 장소(병원·서울)
        "cnt_place_deictic_rate": pd / n,       # 지시적 장소(여기·거기)
        # 구체성 비율 — 구체 표현이 지시 표현보다 많은가 (지남력의 핵심)
        "cnt_time_specificity": ts / (ts + tr) if (ts + tr) else 0.0,
        "cnt_place_specificity": ps / (ps + pd) if (ps + pd) else 0.0,
        # 논리 연결
        "cnt_connective_rate": conn / n,
    }


FEATURE_NAMES = [
    "cnt_time_specific_rate", "cnt_time_relative_rate",
    "cnt_place_specific_rate", "cnt_place_deictic_rate",
    "cnt_time_specificity", "cnt_place_specificity",
    "cnt_connective_rate",
]


if __name__ == "__main__":
    import numpy as np
    from sklearn.metrics import roc_auc_score

    from src.preprocessing.kang_loader import load_kang

    recs = load_kang()
    rows, y = [], []
    for r in recs:
        u = [x.text for x in r.par_utterances if x.text]
        f = extract_content(u)
        rows.append([f[k] for k in FEATURE_NAMES])
        y.append(1 if r.label == "MCI" else 0)
    K, y = np.array(rows), np.array(y)

    print("내용 피처 판별력 (형태소당 정규화, Kang HC 37 / MCI 40)\n")
    print(f"  {'피처':28s} {'HC':>8s} {'MCI':>8s} {'AUC':>7s}")
    for j, k in enumerate(FEATURE_NAMES):
        c = K[:, j]
        a = roc_auc_score(y, c)
        a = max(a, 1 - a)
        mark = "  ← 신호" if a >= 0.65 else ""
        print(f"  {k:28s} {c[y==0].mean():8.4f} {c[y==1].mean():8.4f} {a:7.3f}{mark}")
