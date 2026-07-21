"""스코어링 검증 — 등급 경계 타당성 + 축별 판별력 (규칙 파트).

솔라 관련 검증(근거성·재현성)은 validate_solar.py 참조.

⚠️ leakage 방지: 참조분포·방향을 **학습 fold에서만 fit** 하고 시험 fold를 채점한다.
   (전체 데이터로 fit하면 MCI 정보가 방향 결정에 새어 점수가 낙관적으로 나옴)

사용:
    python -m src.agents.analysis.scoring.validate
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold

from src.agents.analysis.scoring.rubric import AXES, GRADE_CUTS, grade_of
from src.agents.analysis.scoring.score import ScoringModel

CACHE = Path("data/kang_features.npz")


def cv_scores(X, y, names, n_splits: int = 5, seed: int = 42):
    """fold별로 fit→채점한 OOF 총점·축별 점수 반환."""
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    total = np.zeros(len(y))
    axis_scores = {a: np.zeros(len(y)) for a in AXES}
    for tr, te in skf.split(X, y):
        m = ScoringModel.fit(X[tr], y[tr], names)      # 학습 fold에서만 fit
        for i in te:
            r = m.score_one(X[i])
            total[i] = r["total_score"]
            for a, v in r["axes"].items():
                axis_scores[a][i] = v["score"]
    return total, axis_scores


def main():
    if not CACHE.exists():
        raise SystemExit("캐시 없음 — 먼저 run_kang_baseline 실행")
    d = np.load(CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]

    total, axis_scores = cv_scores(X, y, names)

    # ── 1) 점수가 라벨을 따라가나 (점수↓ = MCI) ──────────────
    auc = roc_auc_score(y, -total)   # 점수 낮을수록 MCI
    print("=" * 58)
    print("1) 총점의 라벨 정합성 (OOF, leakage 차단)")
    print(f"   HC 평균 {total[y==0].mean():.1f}점 | MCI 평균 {total[y==1].mean():.1f}점")
    print(f"   총점 기반 판별 AUC: {auc:.3f}")

    # ── 2) 축별 판별력 ──────────────────────────────────────
    print("\n2) 축별 판별력 (AUC, 점수↓=MCI)")
    for a, s in axis_scores.items():
        if s.any():
            a_auc = roc_auc_score(y, -s)
            print(f"   {a:10s} HC {s[y==0].mean():5.1f} | MCI {s[y==1].mean():5.1f} | AUC {a_auc:.3f}")

    # ── 3) 등급 경계 타당성 ─────────────────────────────────
    grades = np.array([grade_of(t) for t in total])
    order = [g for _, g in GRADE_CUTS]
    print(f"\n3) 등급 분포 (컷: {', '.join(f'{c}점↑={g}' for c, g in GRADE_CUTS[:-1])})")
    print(f"   {'등급':6s} {'HC':>5s} {'MCI':>5s} {'MCI비율':>8s}")
    for g in order:
        n_hc = int(((grades == g) & (y == 0)).sum())
        n_mci = int(((grades == g) & (y == 1)).sum())
        tot = n_hc + n_mci
        ratio = f"{n_mci/tot:.0%}" if tot else "-"
        print(f"   {g:6s} {n_hc:5d} {n_mci:5d} {ratio:>8s}")

    # 경계 타당성: 등급이 나빠질수록 MCI 비율이 단조 증가해야 함
    ratios = []
    for g in order:
        mask = grades == g
        ratios.append(float(y[mask].mean()) if mask.any() else np.nan)
    valid = all(
        (np.isnan(ratios[i]) or np.isnan(ratios[i + 1]) or ratios[i] <= ratios[i + 1])
        for i in range(len(ratios) - 1)
    )
    print(f"\n   등급 단조성(정상→위험→심각으로 MCI 비율 증가): {'OK' if valid else '⚠️ 위배'}")

    # ── 4) 데이터가 정한 방향 (직관과 반대인 것 표시) ────────
    m_all = ScoringModel.fit(X, y, names)
    print("\n4) 피처 방향 (데이터 기반)")
    for a, members in AXES.items():
        dirs = [f"{f.split('_',1)[1]}{'↑' if m_all.direction[f]>0 else '↓'}"
                for f in members if f in m_all.direction]
        if dirs:
            print(f"   {a:10s} 정상일수록: {', '.join(dirs)}")
    print("   (↑=값이 클수록 정상, ↓=작을수록 정상)")


if __name__ == "__main__":
    main()
