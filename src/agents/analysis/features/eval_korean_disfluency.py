"""한국어 비유창성 마커 효과 검증 — 쓸지 말지를 데이터로 결정한다.

측정
  1. 마커별 단변량 AUC (어떤 마커가 실제 신호인가)
  2. 버벅임 축: 기존 3피처 vs 마커 추가 → AUC 개선 여부
  3. 전체 분류기: 마커 추가 시 개선 여부

⚠️ 개선이 없으면 채택하지 않는다. LLM을 썼다는 사실 자체는 근거가 아니다.

사용:
    python3 -m src.agents.analysis.features.eval_korean_disfluency
    (선행: python3 -m src.agents.analysis.features.korean_disfluency --build)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

from src.agents.analysis.classifier import make_xgb
from src.agents.analysis.evaluate import cross_validate
from src.agents.analysis.features.korean_disfluency import MARKERS, load_cache

FEAT_CACHE = Path("data/kang_features.npz")
# 기존 버벅임 축 구성 (rubric.py)
BASE_DISFLUENCY = ["lg_filler_rate", "lg_repeat_rate", "ac_pause_rate"]


def main():
    kr = load_cache()
    if not kr:
        raise SystemExit(
            "한국어 마커 캐시 없음 —\n"
            "  python3 -m src.agents.analysis.features.korean_disfluency --build")
    if not FEAT_CACHE.exists():
        raise SystemExit("피처 캐시 없음 — run_kang_baseline 먼저 실행")

    d = np.load(FEAT_CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]
    ids = [str(i) for i in d["ids"]]

    kr_names = [f"kr_{m}_rate" for m in MARKERS] + ["kr_disfluency_total"]
    rows, keep = [], []
    for i, sid in enumerate(ids):
        e = kr.get(sid)
        if e is None:
            continue
        f = e["features"]
        rows.append([float(f.get(k, 0.0)) for k in kr_names])
        keep.append(i)

    if len(keep) < len(ids):
        print(f"⚠️ 마커 없는 화자 {len(ids) - len(keep)}명 제외 (캐시 미완성)")
    K = np.array(rows)
    Xk, yk = X[keep], y[keep]
    print(f"대상 {len(keep)}명 (HC {int((yk==0).sum())} / MCI {int((yk==1).sum())})\n")

    # ── 1) 마커별 단변량 AUC ──────────────────────────────
    print("1) 마커별 판별력 (단변량 AUC, 발화당 정규화)")
    for j, k in enumerate(kr_names):
        col = K[:, j]
        hc, mci = col[yk == 0].mean(), col[yk == 1].mean()
        try:
            a = roc_auc_score(yk, col)
            a = max(a, 1 - a)
        except ValueError:
            a = float("nan")
        flag = "  ← 신호" if a >= 0.60 else ""
        print(f"   {k:26s} HC {hc:.3f} | MCI {mci:.3f} | AUC {a:.3f}{flag}")

    # ── 2) 버벅임 축 개선 여부 ────────────────────────────
    idx = {n: i for i, n in enumerate(names)}
    base_idx = [idx[n] for n in BASE_DISFLUENCY if n in idx]
    base = Xk[:, base_idx]
    aug = np.hstack([base, K])

    def auc_of(M):
        return cross_validate(make_xgb, M, yk, n_splits=5)["auc_oof"]

    a_base, a_aug, a_kr = auc_of(base), auc_of(aug), auc_of(K)
    print(f"\n2) 버벅임 축 (기존 {len(base_idx)}피처 vs 마커 추가)")
    print(f"   기존만          AUC {a_base:.3f}")
    print(f"   마커만          AUC {a_kr:.3f}")
    print(f"   기존+마커       AUC {a_aug:.3f}  ({a_aug - a_base:+.3f})")

    # ── 3) 전체 분류기 개선 여부 ──────────────────────────
    f_base, f_aug = auc_of(Xk), auc_of(np.hstack([Xk, K]))
    print(f"\n3) 전체 분류기")
    print(f"   기존 {Xk.shape[1]}피처   AUC {f_base:.3f}")
    print(f"   +마커 {K.shape[1]}피처  AUC {f_aug:.3f}  ({f_aug - f_base:+.3f})")

    # ── 판정 ──────────────────────────────────────────────
    print("\n판정")
    if a_aug - a_base >= 0.02:
        print(f"   ✅ 버벅임 축 개선({a_aug - a_base:+.3f}) → 루브릭에 마커 채택 권장")
    else:
        print(f"   ❌ 버벅임 축 개선 미미({a_aug - a_base:+.3f}) → 채택 보류")
    if f_aug - f_base >= 0.01:
        print(f"   ✅ 전체 분류기 개선({f_aug - f_base:+.3f})")
    else:
        print(f"   ❌ 전체 분류기 개선 없음({f_aug - f_base:+.3f})")


if __name__ == "__main__":
    main()
