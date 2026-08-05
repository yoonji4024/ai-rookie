"""VAD 적용이 도메인 시프트를 실제로 줄이는지 검증.

문제
    참조분포(Kang)는 CHAT 타임스탬프로 **참가자 발화 구간만** 잘라 계산했다.
    런타임은 전체 오디오를 통째로 넣었다 → 휴지 비율이 3~7배로 튀고, z가 포화되어
    임상 3명(CDR 0 / 0.5 / 1)이 모두 85~100점으로 뭉개졌다.

검증
    같은 오디오를 VAD 적용/미적용으로 채점해 비교한다.
    기대: ① 휴지 계열 값이 Kang HC 범위(0.08~0.15)에 가까워지고
          ② 점수가 CDR 순서(정상 > MCI > 치매)로 벌어진다.

⚠️ 임상 3명은 표본이 아니라 **동작 확인용**이다. 통계적 결론을 내지 않는다.
   (D 1명, 녹음 환경이 전화라 Kang 인터뷰와 여전히 다름)

사용:
    python3 -m src.api.check_vad_effect
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

from src.agents.analysis.features.build_vector import build_feature_vector
from src.agents.analysis.features.extract_acoustic import extract_acoustic, vad_segments
from src.agents.analysis.scoring.score import ScoringModel

CLINICAL = Path("data/_clinical_raw")
MODEL = Path("configs/scoring_model.json")

# 파일명: 성별_이름_나이_CDR_진단  (예: F_JHB_73_CDR0_N)
FNAME = re.compile(r"^([FM])_([A-Z]+)_(\d+)_CDR([\d.]+)_([NMD])")

# Kang HC 참조 범위 — 조건이 맞았는지 눈으로 보기 위한 기준
KANG_HC_PAUSE_RATIO = (0.080, 0.149)      # 여성 / 남성 평균


def _subjects() -> list[dict]:
    out = []
    for w in sorted(CLINICAL.glob("*.wav")):
        m = FNAME.match(w.stem)
        if not m:
            continue
        sex, _, age, cdr, dx = m.groups()
        out.append({"path": str(w), "sex": sex, "age": int(age),
                    "cdr": float(cdr), "dx": dx, "name": w.stem})
    return sorted(out, key=lambda d: d["cdr"])


def main():
    if not MODEL.exists():
        raise SystemExit(f"참조분포 없음: {MODEL} (python3 -m src.api.build_model)")
    model = ScoringModel.load(str(MODEL))

    subs = _subjects()
    if not subs:
        raise SystemExit(f"임상 오디오 없음: {CLINICAL}")
    print(f"임상 {len(subs)}명 (CDR 순)\n")

    DX = {"N": "정상", "M": "MCI", "D": "치매"}
    rows = []
    for s in subs:
        rec = {"주체": f"{DX[s['dx']]}(CDR{s['cdr']:g}) {s['sex']}{s['age']}"}
        # 참조분포는 음향51+언어26=77차원. 음향만 넣으면 인덱스가 어긋난다.
        from src.agents.analysis.features.extract_linguistic import extract_linguistic
        lg = extract_linguistic("", [])
        for label, use_vad in (("전체", False), ("VAD", True)):
            ac = extract_acoustic(s["path"], use_vad=use_vad)
            vec, names = build_feature_vector(ac, lg)
            sc = model.score_one(vec)
            rec[label] = {
                "total": sc["total_score"],
                "axes": {a: v["score"] for a, v in sc["axes"].items()},
                "pause_ratio": ac.get("pause_ratio", 0.0),
                "voiced_seg_rate": ac.get("voiced_seg_rate", 0.0),
            }
        segs = vad_segments(*_load(s["path"]))
        rec["n_seg"] = len(segs)
        rec["voiced_s"] = sum(e - b for b, e in segs)
        rows.append(rec)

    # ① 조건이 맞춰졌나 — 휴지 비율이 Kang HC 범위에 가까워졌는가
    lo, hi = KANG_HC_PAUSE_RATIO
    print(f"① 휴지 비율 (Kang HC 참조 {lo:.3f}~{hi:.3f})")
    print(f"   {'대상':22s} {'전체':>8s} {'VAD':>8s}   {'발화구간':>8s}")
    for r in rows:
        print(f"   {r['주체']:22s} {r['전체']['pause_ratio']:8.3f} {r['VAD']['pause_ratio']:8.3f}"
              f"   {r['n_seg']:3d}개 {r['voiced_s']:5.0f}초")

    # ② 점수가 CDR 순서로 갈리는가
    print(f"\n② 총점 (높을수록 정상)")
    print(f"   {'대상':22s} {'전체':>6s} {'VAD':>6s}")
    for r in rows:
        print(f"   {r['주체']:22s} {r['전체']['total']:6d} {r['VAD']['total']:6d}")

    for tag in ("전체", "VAD"):
        tot = [r[tag]["total"] for r in rows]
        spread = max(tot) - min(tot)
        mono = all(tot[i] >= tot[i + 1] for i in range(len(tot) - 1))
        print(f"   [{tag}] 점수 폭 {spread:3d}점 · CDR 순 단조감소 {'O' if mono else 'X'}")

    # ③ 축별 — 어느 축이 갈리는지
    print(f"\n③ 축별 점수 (VAD 적용)")
    axes = list(rows[0]["VAD"]["axes"])
    print("   " + " " * 22 + "".join(f"{a[:6]:>8s}" for a in axes))
    for r in rows:
        print(f"   {r['주체']:22s}" + "".join(f"{r['VAD']['axes'][a]:8d}" for a in axes))

    print("\n⚠️ 3명은 동작 확인용. 통계적 결론 불가(치매 1명, 전화녹음이라 Kang과 환경 상이).")


def _load(path: str):
    from src.agents.analysis.features.extract_acoustic import _load_audio
    return _load_audio(path)


if __name__ == "__main__":
    main()
