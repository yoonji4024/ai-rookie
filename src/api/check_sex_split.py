"""성별 분리 참조분포가 필요한지 확인.

배경
    현재 참조분포(configs/scoring_model.json)는 **남녀 통합 1개**다.
    그런데 음질 지표(HNR·jitter·shimmer·CPP)와 F0는 성별 차이가 크다.
    남녀를 섞으면 표준편차가 부풀고 → z가 눌리고 → 누구를 넣어도 비슷한 점수가 나온다.
    (어제 임상 3명이 CDR 0/0.5/1인데 모두 85~100으로 뭉개진 현상과 관련 가능)

확인 방법
    Kang HC를 성별로 나눠 각 피처의 평균·표준편차를 비교한다.
    - 두 집단 평균 차이가 통합 표준편차 대비 크면(|d| ≥ 0.5) 분리가 필요하다.
    - 분리 시 표준편차가 얼마나 줄어드는지(= 판별력이 얼마나 회복되는지)도 본다.

사용:
    python3 -m src.api.check_sex_split
"""
from __future__ import annotations

import numpy as np

from src.agents.analysis.features.build_vector import build_feature_vector
from src.agents.analysis.features.extract_acoustic import extract_acoustic
from src.agents.analysis.scoring.rubric import AXES, EXCLUDED_FEATURES


def main():
    from src.preprocessing.kang_loader import load_kang

    recs = load_kang()
    print(f"DementiaBank Korean {len(recs)}명 — 피처 추출")

    X, y, sex, names = [], [], [], None
    for i, r in enumerate(recs, 1):
        segs = [(w["startTime"], w["endTime"]) for w in r.word_timings]
        ac = extract_acoustic(r.wav_path, segments=segs or None)
        try:
            from src.agents.analysis.features.extract_linguistic import extract_linguistic
            lg = extract_linguistic(r.par_text, r.word_timings)
        except Exception:
            lg = {}
        vec, names = build_feature_vector(ac, lg)
        X.append(vec)
        y.append(0 if r.label == "HC" else 1)
        sex.append((r.sex or "?").lower()[:1])
        if i % 20 == 0:
            print(f"  {i}/{len(recs)}")

    X, y, sex = np.vstack(X), np.array(y), np.array(sex)
    idx = {n: i for i, n in enumerate(names)}

    hc = y == 0
    male = hc & (sex == "m")
    female = hc & (sex == "f")
    print(f"\nHC 성별: 남 {male.sum()}명 / 여 {female.sum()}명 "
          f"/ 불명 {int(hc.sum() - male.sum() - female.sum())}명")
    if male.sum() < 5 or female.sum() < 5:
        print("⚠️ 한쪽 표본이 5명 미만 — 성별 분리 참조분포는 신뢰하기 어렵다.")

    # 루브릭이 실제로 쓰는 피처만
    feats = [f for members in AXES.values() for f in members
             if f in idx and f not in EXCLUDED_FEATURES]
    feats = sorted(set(feats))

    print(f"\n{'피처':26s} {'남평균':>9s} {'여평균':>9s} {'통합SD':>8s} {'효과크기':>8s} {'SD감소':>7s}")
    print("─" * 76)
    need = []
    for f in feats:
        i = idx[f]
        m_, f_ = X[male, i], X[female, i]
        if len(m_) < 3 or len(f_) < 3:
            continue
        pooled_sd = float(X[hc, i].std())
        if pooled_sd < 1e-9:
            continue
        d = abs(float(m_.mean() - f_.mean())) / pooled_sd        # 효과크기(Cohen's d 근사)
        # 성별 분리 시 평균 표준편차
        split_sd = float(np.mean([m_.std(), f_.std()]))
        drop = (1 - split_sd / pooled_sd) * 100
        mark = "  ★" if d >= 0.5 else ""
        print(f"{f:26s} {m_.mean():9.3f} {f_.mean():9.3f} {pooled_sd:8.3f} {d:8.2f} {drop:6.1f}%{mark}")
        if d >= 0.5:
            need.append((f, d, drop))

    print("\n" + "─" * 76)
    if need:
        print(f"★ 성별 차이가 큰 피처 {len(need)}개 (효과크기 ≥ 0.5)")
        for f, d, drop in sorted(need, key=lambda t: -t[1]):
            print(f"   {f:26s} d={d:.2f}  분리 시 SD {drop:.0f}% 감소")
        print("\n→ 성별 분리 참조분포 필요. 통합 사용 시 z가 눌려 판별력이 떨어진다.")
    else:
        print("성별 차이가 큰 피처 없음 → 통합 참조분포로 충분.")


if __name__ == "__main__":
    main()
