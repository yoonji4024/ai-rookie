"""음향 피처 — 원본 오디오에서 직접 추출 (STT 무관, disfluency 안전망).

CLAUDE.md §6: pause, speech/articulation, F0, jitter/shimmer, MFCC.
segments가 주어지면 참가자(PAR) 구간만 사용 (인터뷰어 음성 제외).

피처 그룹
  - pause   : 휴지 비율/빈도/길이 (발화 내부 무음)
  - tempo   : voiced-segment 분절 통계 (발화 분절/속도, 텍스트 무관)
  - voice   : F0(평균/변동/변동계수), jitter 3종, shimmer 3종, HNR, 포먼트 F1~F3, CPP  ← 음질, 발화량 무관
  - spectral: ZCR 통계 (centroid/bw/rolloff/rms는 판별력 낮아 제거)
  - mfcc    : MFCC13 평균/표준편차
  - duration: phonation_time, total_speech_dur  ← 발화량 계열(교란 주의, ablation으로 분리 검증)
"""
from __future__ import annotations

import numpy as np
import librosa

try:
    import parselmouth
    from parselmouth.praat import call
    _HAS_PRAAT = True
except ImportError:  # 미설치 시 음질 피처는 0으로 채움 (fallback)
    _HAS_PRAAT = False

SR = 16000


def _par_audio(y: np.ndarray, sr: int, segments: list[tuple[float, float]] | None):
    """PAR 구간 오디오 목록. segments 없으면 전체 1개."""
    if not segments:
        return [y]
    out = []
    for s, e in segments:
        a, b = int(s * sr), min(int(e * sr), len(y))
        if b - a > int(0.1 * sr):
            out.append(y[a:b])
    return out or [y]


def _pause_features(chunks: list[np.ndarray], sr: int) -> dict:
    """발화 구간 내부의 휴지(무음) 분석.

    top_db=30 (35→30 완화, 더 많은 휴지 포착), 최소 100ms.
    0비율을 낮추기 위해 전체 녹음 기준 통계도 함께 산출.
    """
    total_dur = sum(len(c) for c in chunks) / sr
    voiced_dur = 0.0
    pauses: list[float] = []
    for c in chunks:
        intervals = librosa.effects.split(c, top_db=30)
        voiced_dur += sum((b - a) for a, b in intervals) / sr
        for i in range(1, len(intervals)):
            gap = (intervals[i][0] - intervals[i - 1][1]) / sr
            if gap >= 0.10:
                pauses.append(gap)
    pause_dur_total = float(np.sum(pauses)) if pauses else 0.0
    long_pauses = [p for p in pauses if p >= 0.5]
    return {
        "pause_ratio": 1.0 - voiced_dur / total_dur if total_dur else 0.0,
        "pause_rate": len(pauses) / voiced_dur if voiced_dur else 0.0,   # 발화시간당 휴지 수
        "pause_dur_mean": float(np.mean(pauses)) if pauses else 0.0,
        "pause_dur_std": float(np.std(pauses)) if pauses else 0.0,
        "pause_time_ratio": pause_dur_total / total_dur if total_dur else 0.0,
        "long_pause_rate": len(long_pauses) / voiced_dur if voiced_dur else 0.0,  # ≥0.5s 휴지 빈도
        "phonation_time": voiced_dur,
    }


def _tempo_features(chunks: list[np.ndarray], sr: int) -> dict:
    """발화 분절 통계 — voiced 구간 개수/길이 (텍스트 무관 발화 속도·분절성).

    조음 단위 근사. MCI는 분절이 짧고 잦아질 수 있음(word-finding 곤란).
    """
    voiced_runs: list[float] = []
    voiced_dur = 0.0
    for c in chunks:
        for a, b in librosa.effects.split(c, top_db=30):
            d = (b - a) / sr
            voiced_runs.append(d)
            voiced_dur += d
    n = len(voiced_runs)
    return {
        "voiced_seg_rate": n / voiced_dur if voiced_dur else 0.0,   # 초당 발화 분절 수
        "voiced_run_mean": float(np.mean(voiced_runs)) if voiced_runs else 0.0,
        "voiced_run_std": float(np.std(voiced_runs)) if voiced_runs else 0.0,
    }


def _voice_features(y: np.ndarray, sr: int) -> dict:
    """음질 패널 — F0, jitter 3종, shimmer 3종, HNR, 포먼트 F1~F3, CPP. 전부 발화량 무관."""
    keys = [
        "f0_mean", "f0_std", "f0_range", "f0_cv",
        "jitter_local", "jitter_rap", "jitter_ppq5",
        "shimmer_local", "shimmer_apq3", "shimmer_apq5",
        "hnr",
        "f1_mean", "f1_std", "f2_mean", "f2_std", "f3_mean", "f3_std",
        "cpp",
    ]
    if not _HAS_PRAAT:
        return {k: 0.0 for k in keys}

    snd = parselmouth.Sound(y.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch(pitch_floor=60, pitch_ceiling=400)
    f0 = pitch.selected_array["frequency"]
    f0 = f0[f0 > 0]
    f0_mean = float(np.mean(f0)) if len(f0) else 0.0
    f0_std = float(np.std(f0)) if len(f0) else 0.0

    def _safe(fn):
        try:
            v = fn()
            return float(v) if v == v else 0.0   # NaN 방어
        except Exception:
            return 0.0

    pp = call(snd, "To PointProcess (periodic, cc)", 60, 400)
    hnr = _safe(lambda: call(
        call(snd, "To Harmonicity (cc)", 0.01, 60, 0.1, 1.0), "Get mean", 0, 0))

    # 포먼트 F1~F3 (성도 형태 — 조음 정확도 관련)
    formant = call(snd, "To Formant (burg)", 0.0, 5, 5500, 0.025, 50)

    def _fmean(n):
        return _safe(lambda: call(formant, "Get mean", n, 0, 0, "hertz"))

    def _fstd(n):
        return _safe(lambda: call(formant, "Get standard deviation", n, 0, 0, "hertz"))

    # CPP (cepstral peak prominence — 음성 명료도/주기성). praat 버전별 시그니처 방어.
    def _cpp():
        pc = call(snd, "To PowerCepstrogram", 60, 0.002, 5000, 50)
        return call(pc, "Get CPPS", "no", 0.02, 0.0005, 60, 330, 0.05,
                    "Parabolic", 0.001, 0, "Straight", "Robust")

    return {
        "f0_mean": f0_mean,
        "f0_std": f0_std,
        "f0_range": float(np.ptp(f0)) if len(f0) else 0.0,
        "f0_cv": f0_std / f0_mean if f0_mean else 0.0,           # 변동계수(정규화)
        "jitter_local": _safe(lambda: call(pp, "Get jitter (local)", 0, 0, 0.0001, 0.02, 1.3)),
        "jitter_rap": _safe(lambda: call(pp, "Get jitter (rap)", 0, 0, 0.0001, 0.02, 1.3)),
        "jitter_ppq5": _safe(lambda: call(pp, "Get jitter (ppq5)", 0, 0, 0.0001, 0.02, 1.3)),
        "shimmer_local": _safe(lambda: call([snd, pp], "Get shimmer (local)", 0, 0, 0.0001, 0.02, 1.3, 1.6)),
        "shimmer_apq3": _safe(lambda: call([snd, pp], "Get shimmer (apq3)", 0, 0, 0.0001, 0.02, 1.3, 1.6)),
        "shimmer_apq5": _safe(lambda: call([snd, pp], "Get shimmer (apq5)", 0, 0, 0.0001, 0.02, 1.3, 1.6)),
        "hnr": hnr,
        "f1_mean": _fmean(1), "f1_std": _fstd(1),
        "f2_mean": _fmean(2), "f2_std": _fstd(2),
        "f3_mean": _fmean(3), "f3_std": _fstd(3),
        "cpp": _safe(_cpp),
    }


def _spectral_features(y: np.ndarray, sr: int) -> dict:
    """스펙트럼 — ZCR만 유지 (centroid/bw/rolloff/rms는 판별력 낮고 MFCC와 중복이라 제거)."""
    zcr = librosa.feature.zero_crossing_rate(y)[0]
    return {"spec_zcr_mean": float(np.mean(zcr)), "spec_zcr_std": float(np.std(zcr))}


def _mfcc_features(y: np.ndarray, sr: int, n_mfcc: int = 13) -> dict:
    m = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=n_mfcc)
    out = {}
    for i in range(n_mfcc):
        out[f"mfcc{i}_mean"] = float(np.mean(m[i]))
        out[f"mfcc{i}_std"] = float(np.std(m[i]))
    return out


def extract_acoustic(
    audio_path: str,
    segments: list[tuple[float, float]] | None = None,
) -> dict:
    """음향 피처 딕셔너리. segments = PAR 발화 (start_s, end_s) 목록."""
    y, sr = librosa.load(audio_path, sr=SR, mono=True)
    chunks = _par_audio(y, sr, segments)
    par = np.concatenate(chunks)

    feats = {}
    feats.update(_pause_features(chunks, sr))
    feats.update(_tempo_features(chunks, sr))
    feats.update(_voice_features(par, sr))
    feats.update(_spectral_features(par, sr))
    feats.update(_mfcc_features(par, sr))
    feats["total_speech_dur"] = len(par) / sr
    return feats
