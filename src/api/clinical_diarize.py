"""임상 오디오에서 참가자 발화 구간만 추출 (A.X STT 화자 분리) → 채점 비교.

왜 필요한가
    임상 데이터는 전화 통화라 조사자 음성이 섞여 있다. VAD는 '사람이 말하는 구간'만
    찾을 뿐 **누가 말하는지는 모른다** → 조사자 발화까지 참가자 것으로 계산된다.
    (VAD 적용 후에도 임상 z가 +1.0~1.5로 남은 이유)

    참조분포(Kang)는 CHAT 전사로 참가자 발화만 골라 만들었으므로, 임상도 같은 조건이
    되려면 화자 분리가 필요하다. A.X STT batch가 화자 인덱스를 준다
    (Kang HC_01에서 참가자 98.8% / 조사자 1.2%로 정확히 분리 확인됨).

⚠️ 서버에서 실행할 것. 맥에서는 STT 업로드가 WAF에 막힌다.
⚠️ 임상 3명은 동작 확인용. 통계적 결론 불가(치매 1명).

사용:
    python3 -m src.api.clinical_diarize            # 전사 → 구간 저장 → 채점 비교
    python3 -m src.api.clinical_diarize --score-only   # 저장된 구간으로 채점만
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

CLINICAL = Path("data/_clinical_raw")
SEG_DIR = Path("data/_clinical_segments")
MODEL = Path("configs/scoring_model.json")
FNAME = re.compile(r"^([FM])_([A-Z]+)_(\d+)_CDR([\d.]+)_([NMD])")
DX = {"N": "정상", "M": "MCI", "D": "치매"}


def subjects() -> list[dict]:
    out = []
    for w in sorted(CLINICAL.glob("*.wav")):
        m = FNAME.match(w.stem)
        if not m:
            continue
        sex, _, age, cdr, dx = m.groups()
        out.append({"path": str(w), "stem": w.stem, "sex": sex,
                    "age": int(age), "cdr": float(cdr), "dx": dx})
    return sorted(out, key=lambda d: d["cdr"])


def diarize(subs: list[dict]) -> None:
    """A.X STT로 전사 → 주 화자(참가자) 구간만 JSON 저장."""
    from src.common.stt import AXSTT

    SEG_DIR.mkdir(parents=True, exist_ok=True)
    stt = AXSTT()
    for s in subs:
        out = SEG_DIR / f"{s['stem']}.json"
        if out.exists():
            print(f"  {s['stem']}: 이미 있음 — 건너뜀")
            continue
        print(f"  {s['stem']}: 전사 중…")
        try:
            tr = stt.transcribe(s["path"])
        except Exception as e:
            print(f"    실패: {type(e).__name__}: {e}")
            continue
        main = tr.main_speaker
        utts = tr.by_speaker(main) if main is not None else tr.utterances
        segs = [(u.start, u.end) for u in utts if u.end > u.start]
        dur = sum(e - b for b, e in segs)
        conf = tr.diarization_confidence
        out.write_text(json.dumps({
            "stem": s["stem"], "main_speaker": main,
            "diarization_confidence": round(float(conf), 3),
            "n_segments": len(segs), "voiced_sec": round(dur, 1),
            "segments": [[round(b, 3), round(e, 3)] for b, e in segs],
            "text": " ".join(u.text for u in utts if u.text),
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"    구간 {len(segs)}개 / {dur:.0f}초 · 주화자 비중 {conf:.0%}")


def score(subs: list[dict]) -> None:
    from scipy.stats import norm

    from src.agents.analysis.features.build_vector import build_feature_vector
    from src.agents.analysis.features.extract_acoustic import extract_acoustic
    from src.agents.analysis.scoring.score import ScoringModel

    if not MODEL.exists():
        raise SystemExit(f"참조분포 없음: {MODEL}")
    model = ScoringModel.load(str(MODEL))

    rows = []
    for s in subs:
        lab = f"{DX[s['dx']]}(CDR{s['cdr']:g})"
        rec = {"lab": lab}
        # ① 전체 오디오  ② VAD  ③ 화자분리(참가자만)
        modes = [("전체", dict(use_vad=False)), ("VAD", dict(use_vad=True))]
        segf = SEG_DIR / f"{s['stem']}.json"
        if segf.exists():
            d = json.loads(segf.read_text(encoding="utf-8"))
            modes.append(("화자분리", dict(segments=[tuple(x) for x in d["segments"]])))
            rec["conf"] = d.get("diarization_confidence")
        for name, kw in modes:
            ac = extract_acoustic(s["path"], **kw)
            vec, names = build_feature_vector(ac, {})
            sc = model.score_one(vec)
            rec[name] = {"total": sc["total_score"],
                         "pause_ratio": ac.get("pause_ratio", 0.0),
                         "axes": {a: v["score"] for a, v in sc["axes"].items()}}
        rows.append(rec)

    modes_present = [m for m in ("전체", "VAD", "화자분리") if m in rows[0]]

    print(f"\n① 휴지 비율 (Kang HC 0.080~0.149)")
    print(f"   {'대상':16s}" + "".join(f"{m:>10s}" for m in modes_present))
    for r in rows:
        print(f"   {r['lab']:16s}" + "".join(f"{r[m]['pause_ratio']:10.3f}" for m in modes_present))

    print(f"\n② 총점 (높을수록 정상)")
    print(f"   {'대상':16s}" + "".join(f"{m:>10s}" for m in modes_present))
    for r in rows:
        print(f"   {r['lab']:16s}" + "".join(f"{r[m]['total']:10d}" for m in modes_present))
    for m in modes_present:
        tot = [r[m]["total"] for r in rows]
        mono = all(tot[i] >= tot[i + 1] for i in range(len(tot) - 1))
        print(f"   [{m}] 점수 폭 {max(tot)-min(tot):3d}점 · CDR 순 단조감소 {'O' if mono else 'X'}")

    if "화자분리" in modes_present:
        print(f"\n③ 축별 (화자분리 적용)")
        axes = list(rows[0]["화자분리"]["axes"])
        print("   " + " " * 16 + "".join(f"{a[:6]:>9s}" for a in axes))
        for r in rows:
            print(f"   {r['lab']:16s}" + "".join(f"{r['화자분리']['axes'][a]:9d}" for a in axes))

    print("\n⚠️ 3명은 동작 확인용. 통계적 결론 불가(치매 1명, 전화녹음).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--score-only", action="store_true")
    a = ap.parse_args()

    subs = subjects()
    if not subs:
        raise SystemExit(f"임상 오디오 없음: {CLINICAL}")
    print(f"임상 {len(subs)}명 (CDR 순)")

    if not a.score_only:
        print("\n[1] A.X STT 화자 분리")
        diarize(subs)
    print("\n[2] 채점 비교")
    score(subs)


if __name__ == "__main__":
    main()
