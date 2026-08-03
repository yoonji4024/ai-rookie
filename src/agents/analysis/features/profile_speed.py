"""음향 피처 추출 속도 측정 — KPI(분류 지연 ≤ 5초) 달성 여부 확인.

교수님 지적: "음성에서 피처 뽑는 게 느리지 않냐"
    실제로 praat 계산(HNR·jitter·shimmer·CPP)이 파일당 병목이다.
    어느 항목이 얼마나 먹는지 재야 무엇을 줄일지 정할 수 있다.

측정 대상
    · 항목별 소요 시간 (로드 / pitch / jitter / shimmer / HNR / CPP / MFCC)
    · 오디오 길이에 따른 증가 추세 (선형인가, 그보다 나쁜가)
    · fast 모드(구간 캡) 적용 시 단축폭과 값 오차

사용:
    python3 -m src.agents.analysis.features.profile_speed <wav>
    python3 -m src.agents.analysis.features.profile_speed <wav> --scaling
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import librosa
import numpy as np
import parselmouth
from parselmouth.praat import call


def _t(label: str, fn, out: dict) -> float:
    t = time.perf_counter()
    try:
        fn()
    except Exception as e:
        print(f"  {label:18s} 실패: {type(e).__name__}")
        return 0.0
    d = time.perf_counter() - t
    out[label] = d
    print(f"  {label:18s} {d:7.2f}초")
    return d


def warmup() -> float:
    """librosa(numba) JIT 컴파일을 미리 끝낸다.

    첫 호출에 수 초가 붙는데 이는 계산이 아니라 컴파일 비용이다. 서버처럼
    프로세스가 유지되는 환경에서는 최초 1회만 발생하므로, 정상 상태 성능을
    재려면 워밍업 후 측정해야 한다.
    """
    t = time.perf_counter()
    d = np.zeros(16000, dtype=np.float32)
    librosa.feature.mfcc(y=d, sr=16000, n_mfcc=13)
    librosa.feature.zero_crossing_rate(d)
    librosa.feature.rms(y=d)
    return time.perf_counter() - t


def profile(wav: str, cap_s: float | None = None) -> dict:
    times: dict[str, float] = {}
    # 실제 파이프라인과 같은 로더를 쓴다(soundfile 우선 → librosa 폴백).
    from src.agents.analysis.features.extract_acoustic import _load_audio
    t0 = time.perf_counter()
    y, sr = _load_audio(wav)
    times["load"] = time.perf_counter() - t0
    dur = len(y) / sr
    print(f"\n대상: {Path(wav).name}  {dur:.1f}초"
          + (f"  (praat 입력 {cap_s}초로 제한)" if cap_s else ""))
    print(f"  {'load':18s} {times['load']:7.2f}초")

    yp = y
    if cap_s and dur > cap_s:
        st = (len(y) - int(cap_s * sr)) // 2      # 가운데 구간
        yp = y[st:st + int(cap_s * sr)]

    snd = parselmouth.Sound(yp.astype(np.float64), sampling_frequency=sr)
    _t("pitch(F0)", lambda: snd.to_pitch(pitch_floor=60, pitch_ceiling=400), times)

    pp = call(snd, "To PointProcess (periodic, cc)", 60, 400)
    _t("PointProcess", lambda: call(snd, "To PointProcess (periodic, cc)", 60, 400), times)
    _t("jitter", lambda: call(pp, "Get jitter (local)", 0, 0, 1e-4, 0.02, 1.3), times)
    _t("shimmer", lambda: call([snd, pp], "Get shimmer (local)", 0, 0, 1e-4, 0.02, 1.3, 1.6), times)
    _t("HNR", lambda: call(call(snd, "To Harmonicity (cc)", 0.01, 60, 0.1, 1.0),
                           "Get mean", 0, 0), times)
    _t("CPP", lambda: call(call(snd, "To PowerCepstrogram", 60, 0.01, 5000, 50),
                           "Get CPPS", "no", 0.02, 0.0005, 60, 330, 0.05,
                           "Parabolic", 0.001, 0, "Straight", "Robust"), times)
    _t("MFCC", lambda: librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13), times)
    _t("ZCR·RMS", lambda: (librosa.feature.zero_crossing_rate(y),
                           librosa.feature.rms(y=y)), times)

    total = sum(times.values())
    print(f"  {'─' * 28}")
    print(f"  {'합계':18s} {total:7.2f}초   (실시간 대비 {total / dur:.2f}배)")
    top = sorted(times.items(), key=lambda kv: -kv[1])[:3]
    print(f"  병목 상위: " + ", ".join(f"{k} {v:.1f}초" for k, v in top))
    return times


def scaling(wav: str):
    """길이에 따른 증가 추세 — 선형이면 자르기로 해결된다."""
    y, sr = librosa.load(wav, sr=16000)
    print("\n길이별 소요 (praat 주요 항목만)")
    for s in (10, 20, 30, 60):
        n = min(int(s * sr), len(y))
        seg = y[:n]
        snd = parselmouth.Sound(seg.astype(np.float64), sampling_frequency=sr)
        t = time.perf_counter()
        try:
            snd.to_pitch(pitch_floor=60, pitch_ceiling=400)
            call(call(snd, "To Harmonicity (cc)", 0.01, 60, 0.1, 1.0), "Get mean", 0, 0)
            call(call(snd, "To PowerCepstrogram", 60, 0.01, 5000, 50),
                 "Get CPPS", "no", 0.02, 0.0005, 60, 330, 0.05,
                 "Parabolic", 0.001, 0, "Straight", "Robust")
        except Exception as e:
            print(f"  {s:3d}초 실패 {e}")
            continue
        d = time.perf_counter() - t
        print(f"  {n/sr:5.1f}초 오디오 → {d:6.2f}초  ({d/(n/sr):.2f}배)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--cap", type=float, help="praat 입력을 N초로 제한")
    ap.add_argument("--scaling", action="store_true", help="길이별 추세 측정")
    ap.add_argument("--compare", action="store_true", help="전체 vs 30초 캡 비교")
    ap.add_argument("--cold", action="store_true", help="워밍업 없이 측정(첫 실행 비용 포함)")
    a = ap.parse_args()

    if not a.cold:
        w = warmup()
        print(f"[워밍업 {w:.2f}초 — librosa JIT 컴파일. 서버는 기동 시 1회만 발생]")

    if a.scaling:
        scaling(a.wav)
        return
    if a.compare:
        full = profile(a.wav)
        capped = profile(a.wav, cap_s=30)
        sf, sc = sum(full.values()), sum(capped.values())
        print(f"\n전체 {sf:.1f}초 → 30초 캡 {sc:.1f}초  ({(1-sc/sf)*100:.0f}% 단축)")
        print(f"KPI(5초) {'달성' if sc <= 5 else '미달'}")
        return
    profile(a.wav, cap_s=a.cap)


if __name__ == "__main__":
    main()
