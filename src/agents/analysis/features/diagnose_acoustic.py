"""음향 피처 진단 — 재추출 없이 캐시(data/kang_features.npz)만 분석.

각 음향(ac_*) 피처에 대해:
  - HC 평균 / MCI 평균 / 차이
  - 0값 비율 (praat·pause 죽었는지 탐지)
  - 단변량 AUC (그 피처 하나로 HC vs MCI 얼마나 갈리나)

사용:
    python -m src.agents.analysis.features.diagnose_acoustic
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

CACHE = Path("data/kang_features.npz")


def main():
    if not CACHE.exists():
        raise SystemExit("캐시 없음 — 먼저 run_kang_baseline 실행")
    d = np.load(CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], list(d["names"])

    rows = []
    for i, n in enumerate(names):
        if not n.startswith("ac_"):
            continue
        col = X[:, i]
        hc, mci = col[y == 0], col[y == 1]
        zero_frac = float(np.mean(col == 0))
        # 단변량 AUC (양방향 중 큰 값)
        try:
            auc = roc_auc_score(y, col)
            auc = max(auc, 1 - auc)
        except ValueError:
            auc = float("nan")
        rows.append((n, hc.mean(), mci.mean(), zero_frac, auc))

    rows.sort(key=lambda r: (-r[4] if r[4] == r[4] else 0))  # AUC 내림차순

    print(f"{'feature':22s} {'HC':>10s} {'MCI':>10s} {'0비율':>6s} {'단변량AUC':>9s}")
    print("-" * 62)
    for n, h, m, z, a in rows:
        flag = "  ⚠️죽음" if z > 0.9 else ("  ⚠️상수" if abs(h - m) < 1e-9 else "")
        print(f"{n:22s} {h:10.3f} {m:10.3f} {z:6.2f} {a:9.3f}{flag}")

    # praat 피처 생존 여부 요약
    praat = [r for r in rows if any(k in r[0] for k in ("f0", "jitter", "shimmer"))]
    dead = [r[0] for r in praat if r[3] > 0.9]
    print("\n[praat 피처 진단]", "정상 동작" if not dead else f"죽음: {dead}")
    pause = [r for r in rows if "pause" in r[0]]
    print("[pause 피처] " + ", ".join(f"{r[0]}=AUC{r[4]:.2f}(0비율{r[3]:.0%})" for r in pause))


if __name__ == "__main__":
    main()
