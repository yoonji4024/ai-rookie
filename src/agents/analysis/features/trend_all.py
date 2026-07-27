"""Kang + 임상 데이터 통합 — 정상/MCI/치매 3단계 음향 경향.

Kang(HC 37 / MCI 40) + 임상(N/M/D) 합쳐서, 중증도 순으로 음향 피처가
어떻게 변하는지 본다. Kang엔 없던 **치매(D)** 를 임상이 채운다.

⚠️ 경향 참고용. 통계적 결론 아님:
   - 임상은 4명뿐 (특히 D 1명)
   - Kang=인터뷰 / 임상=전화 통화 → 녹음 환경 차이가 교란 (음질이 병 때문인지 전화 때문인지)
   - 임상은 화자 분리가 부정확해 조사자 음성이 섞였을 수 있음

사용:
    python3 -m src.agents.analysis.features.trend_all
"""
from __future__ import annotations

import numpy as np

from src.agents.analysis.features.extract_acoustic import extract_acoustic

# 중증도 순서: 0 정상 → 1 MCI → 2 치매
STAGE = {0: "정상", 1: "MCI", 2: "치매"}

# 경향을 볼 음질·발화 피처 (STT 무관, 원본 파형)
KEYS = ["hnr", "cpp", "shimmer_local", "jitter_local", "f0_mean",
        "pause_ratio", "voiced_seg_rate", "voiced_run_mean"]


def collect() -> list[dict]:
    rows = []

    # Kang: HC=정상(0), MCI(1). 인터뷰라 발화 타임스탬프로 참가자 구간 지정 가능.
    from src.preprocessing.kang_loader import load_kang
    for r in load_kang():
        segs = [(w["startTime"], w["endTime"]) for w in r.word_timings]
        ac = extract_acoustic(r.wav_path, segments=segs or None)
        rows.append({"src": "Kang", "stage": 0 if r.label == "HC" else 1,
                     "id": r.subject_id, **{k: ac.get(k, 0.0) for k in KEYS}})

    # 임상: N=0, M=1, D=2. 전사 세그먼트 없어 전체 사용(주의).
    from src.preprocessing.clinical_loader import load_clinical
    for r in load_clinical():
        ac = extract_acoustic(r.wav_path)
        rows.append({"src": "임상", "stage": r.y3,
                     "id": r.subject_id, **{k: ac.get(k, 0.0) for k in KEYS}})
    return rows


def main():
    rows = collect()
    arr = {k: np.array([r[k] for r in rows]) for k in KEYS}
    stage = np.array([r["stage"] for r in rows])
    src = np.array([r["src"] for r in rows])

    print("피처 경향 — 중증도 순 (정상 → MCI → 치매)\n")
    print(f"  {'피처':16}" + "".join(f"{STAGE[s]:>10}" for s in (0, 1, 2)))
    print("  " + "-" * 52)
    for k in KEYS:
        means = []
        for s in (0, 1, 2):
            v = arr[k][stage == s]
            means.append(v.mean() if len(v) else float("nan"))
        # 단조 증가/감소 여부 표시
        mono = ""
        if all(not np.isnan(m) for m in means):
            if means[0] < means[1] < means[2]:
                mono = "  ↑단조"
            elif means[0] > means[1] > means[2]:
                mono = "  ↓단조"
        print(f"  {k:16}" + "".join(f"{m:10.3f}" for m in means) + mono)

    print("\n  집단 크기:")
    for s in (0, 1, 2):
        n_kang = int(((stage == s) & (src == "Kang")).sum())
        n_clin = int(((stage == s) & (src == "임상")).sum())
        print(f"    {STAGE[s]}: {int((stage==s).sum())}명 (Kang {n_kang} / 임상 {n_clin})")

    print("\n⚠️ 치매(D)는 임상 1명뿐. 녹음환경(인터뷰 vs 전화) 교란 있음. 경향 참고용.")


if __name__ == "__main__":
    main()
