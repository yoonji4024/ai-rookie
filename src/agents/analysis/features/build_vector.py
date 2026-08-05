"""concat(음향, 언어) → 고정 순서 단일 벡터."""
from __future__ import annotations

import numpy as np


def build_feature_vector(acoustic: dict, linguistic: dict,
                         fill_missing: bool = False) -> tuple[np.ndarray, list[str]]:
    """키를 정렬해 고정 순서 벡터 생성. (벡터, 피처명 목록) 반환.

    fill_missing : NaN(계산 불가)을 0으로 채울지.

      False (기본) — **NaN을 그대로 둔다.** 채점기가 결측으로 인식해 축 평균에서 제외한다.
        0으로 채우면 "측정값 0"이 되어 z가 -8까지 내려간다 →
        추출 실패(praat 미설치, 단어 타임스탬프 없음 등)가 병리 신호로 둔갑한다.
        실제로 발음 정확도·발화 속도 축이 이 때문에 무너져 있었다.

      True — XGBoost 등 NaN을 못 받는 학습기에 넣을 때만.
        (XGBoost는 NaN을 지원하므로 대개 불필요)
    """
    merged = {f"ac_{k}": v for k, v in sorted(acoustic.items())}
    merged.update({f"lg_{k}": v for k, v in sorted(linguistic.items())})
    names = list(merged.keys())
    vec = np.array([float(merged[k]) for k in names], dtype=np.float64)
    if fill_missing:
        vec = np.nan_to_num(vec, nan=0.0, posinf=0.0, neginf=0.0)
    else:
        vec = np.where(np.isinf(vec), np.nan, vec)      # inf도 결측으로
    return vec, names
