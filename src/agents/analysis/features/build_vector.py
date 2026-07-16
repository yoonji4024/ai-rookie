"""concat(음향, 언어) → 고정 순서 단일 벡터."""
from __future__ import annotations

import numpy as np


def build_feature_vector(acoustic: dict, linguistic: dict) -> tuple[np.ndarray, list[str]]:
    """키를 정렬해 고정 순서 벡터 생성. (벡터, 피처명 목록) 반환."""
    merged = {f"ac_{k}": v for k, v in sorted(acoustic.items())}
    merged.update({f"lg_{k}": v for k, v in sorted(linguistic.items())})
    names = list(merged.keys())
    vec = np.array([float(merged[k]) for k in names], dtype=np.float64)
    vec = np.nan_to_num(vec, nan=0.0, posinf=0.0, neginf=0.0)
    return vec, names
