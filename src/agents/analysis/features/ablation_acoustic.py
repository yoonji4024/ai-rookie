"""음향 ablation — 피처 그룹별 기여도, 특히 '발화량 교란' 분리 검증.

캐시(data/kang_features.npz)의 피처를 그룹으로 나눠 각각/조합으로 CV AUC 측정.
  - 발화량 계열(phonation_time, total_speech_dur, pause_* 일부)을 빼도
    음질(voice)·스펙트럼·MFCC만으로 얼마나 나오는지 확인 → 교란 방어 근거.

사용:
    python -m src.agents.analysis.features.ablation_acoustic
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from src.agents.analysis.classifier import make_xgb
from src.agents.analysis.evaluate import cross_validate

CACHE = Path("data/kang_features.npz")

# 발화량(길이) 계열 — 교란 의심. 이름 접미사로 매칭.
DURATION_KEYS = {"ac_phonation_time", "ac_total_speech_dur"}


def _auc(X, y, idx):
    if not idx:
        return float("nan")
    return cross_validate(make_xgb, X[:, idx], y, n_splits=5)["auc_oof"]


def main():
    if not CACHE.exists():
        raise SystemExit("캐시 없음 — 먼저 run_kang_baseline 실행")
    d = np.load(CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], list(d["names"])

    def sel(pred):
        return [i for i, n in enumerate(names) if pred(n)]

    groups = {
        "전체(음향+언어)":      sel(lambda n: True),
        "음향 전체(ac_*)":       sel(lambda n: n.startswith("ac_")),
        "  음질(voice: f0/jitter/shimmer/hnr)":
            sel(lambda n: any(k in n for k in ("f0", "jitter", "shimmer", "hnr"))),
        "  pause":               sel(lambda n: "pause" in n),
        "  spectral":            sel(lambda n: n.startswith("ac_spec_")),
        "  mfcc":                sel(lambda n: "mfcc" in n),
        "  발화량(duration만)":  [i for i, n in enumerate(names) if n in DURATION_KEYS],
        "음향 − 발화량 제거":     [i for i, n in enumerate(names)
                                   if n.startswith("ac_") and n not in DURATION_KEYS],
    }

    print(f"{'피처 그룹':38s} {'차원':>4s} {'CV AUC':>8s}")
    print("-" * 54)
    for name, idx in groups.items():
        a = _auc(X, y, idx)
        print(f"{name:38s} {len(idx):>4d} {a:>8.3f}")

    print("\n해석: '음향 − 발화량 제거' AUC가 높게 유지되면 발화량 교란 없이도 음향 신호가 실재.")


if __name__ == "__main__":
    main()
