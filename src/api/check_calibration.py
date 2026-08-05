"""참조분포 ↔ 런타임 피처 정의 정합도 측정.

문제
    점수 = 100·Φ(z+1), z = (측정 − HC평균) / HC표준편차.
    **참조분포와 런타임이 같은 방식으로 계산된 값이어야** z가 의미를 갖는다.
    현재 참조분포는 CHAT 세그먼트(발화 구간) 기준, 런타임은 전체 오디오 →
    휴지 비율 0.093 대 0.567을 비교하는 셈이라 z=+6.3으로 포화, 점수가 전부 100이 된다.

측정
    HC 집단 자신을 그 참조분포로 채점했을 때 z 분포가 0 근처인지 본다.
    (정의가 같다면 HC의 평균 z ≈ 0, 점수 ≈ 84)
    그다음 런타임 녹음의 z를 같은 참조분포로 재서, HC 범위 안에 들어오는지 확인한다.

    → |런타임 평균 z| 가 작을수록 정합이 좋다. 2를 넘으면 사실상 포화.

사용:
    python3 -m src.api.check_calibration --wav data/live/.../recall.wav
    python3 -m src.api.check_calibration --wav ... --model configs/scoring_model_full.json --mode none
"""
from __future__ import annotations

import argparse

import numpy as np

from src.agents.analysis.features.build_vector import build_feature_vector
from src.agents.analysis.features.extract_acoustic import extract_acoustic
from src.agents.analysis.scoring.rubric import AXES, EXCLUDED_FEATURES
from src.agents.analysis.scoring.score import ScoringModel

PAUSE_KEYS = ["ac_pause_ratio", "ac_pause_rate", "ac_pause_dur_mean",
              "ac_long_pause_rate", "ac_pause_time_ratio"]
VOICE_KEYS = ["ac_hnr", "ac_cpp", "ac_jitter_local", "ac_shimmer_local"]


def _z(model: ScoringModel, vec, names, keys):
    """결측(NaN)은 건너뛴다 — 계산 실패를 측정값 0으로 오해하면 z가 -8까지 내려간다."""
    idx = {n: i for i, n in enumerate(names)}
    out = {}
    for k in keys:
        if k in model.hc_mean and k in idx:
            raw = float(vec[idx[k]])
            if not np.isfinite(raw):
                continue
            z = (raw - model.hc_mean[k]) / model.hc_std[k] * model.direction[k]
            out[k] = float(np.clip(z, -8, 8))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--model", default="configs/scoring_model.json")
    ap.add_argument("--modes", nargs="+", default=["none", "hybrid", "all"])
    ap.add_argument("--text", default="")
    a = ap.parse_args()

    model = ScoringModel.load(a.model)
    from src.agents.analysis.features.extract_linguistic import extract_linguistic
    lg = extract_linguistic(a.text, [])

    print(f"참조분포: {a.model}")
    print(f"대상    : {a.wav}\n")

    rubric = [f for ms in AXES.values() for f in ms if f not in EXCLUDED_FEATURES]
    rubric = [f for f in sorted(set(rubric)) if f in model.hc_mean]

    print(f"{'모드':8s}{'총점':>6s}{'평균|z|':>9s}{'휴지 z':>9s}{'음질 z':>9s}   판정")
    print("─" * 62)
    for mode in a.modes:
        ac = extract_acoustic(a.wav, vad_mode=mode)
        vec, names = build_feature_vector(ac, lg)
        sc = model.score_one(vec)

        allz = _z(model, vec, names, rubric)
        pz = _z(model, vec, names, PAUSE_KEYS)
        vz = _z(model, vec, names, VOICE_KEYS)
        mabs = float(np.mean([abs(v) for v in allz.values()])) if allz else 0.0
        pm = float(np.mean(list(pz.values()))) if pz else 0.0
        vm = float(np.mean(list(vz.values()))) if vz else 0.0

        verdict = "정합 양호" if mabs < 1.0 else ("주의" if mabs < 2.0 else "포화 — 정의 불일치")
        print(f"{mode:8s}{sc['total_score']:6d}{mabs:9.2f}{pm:+9.2f}{vm:+9.2f}   {verdict}")

    print("\n  평균|z| — 참조분포 대비 얼마나 떨어져 있나. HC 자신이면 0.8 안팎이 정상.")
    print("  2를 넘으면 z가 클리핑에 걸려 점수가 상한/하한에 붙는다(변별 불가).")


if __name__ == "__main__":
    main()
