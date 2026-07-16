"""음향 피처 — 원본 오디오에서 직접 추출 (STT 무관, disfluency 안전망).

CLAUDE.md §6: pause, speech/articulation, F0, jitter/shimmer, MFCC.
segments가 주어지면 참가자(PAR) 구간만 사용 (인터뷰어 음성 제외).

피처 그룹
  - pause   : 휴지 비율/빈도/길이 (발화 내부 무음)
  - voice   : F0(평균/변동/변동계수), jitter 3종, shimmer 3종, HNR  ← 음질, 발화량 무관
  - spectral: centroid/bandwidth/rolloff/ZCR/RMS 통계
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


def _voice_features(y: np.ndarray, sr: int) -> dict:
    """음질 패널 — F0, jitter 3종, shimmer 3종, HNR. 전부 발화량 무관."""
    keys = [
        "f0_mean", "f0_std", "f0_range", "f0_cv",
        "jitter_local", "jitter_rap", "jitter_ppq5",
        "shimmer_local", "shimmer_apq3", "shimmer_apq5",
        "hnr",
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
    }


def _spectral_features(y: np.ndarray, sr: int) -> dict:
    """스펙트럼 형태 — centroid/bandwidth/rolloff/ZCR/RMS 평균·표준편차."""
    cent = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    bw = librosa.feature.spectral_bandwidth(y=y, sr=sr)[0]
    roll = librosa.feature.spectral_rolloff(y=y, sr=sr)[0]
    zcr = librosa.feature.zero_crossing_rate(y)[0]
    rms = librosa.feature.rms(y=y)[0]
    out = {}
    for name, v in [("centroid", cent), ("bandwidth", bw), ("rolloff", roll), ("zcr", zcr), ("rms", rms)]:
        out[f"spec_{name}_mean"] = float(np.mean(v))
        out[f"spec_{name}_std"] = float(np.std(v))
    return out


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
    feats.update(_voice_features(par, sr))
    feats.update(_spectral_features(par, sr))
    feats.update(_mfcc_features(par, sr))
    feats["total_speech_dur"] = len(par) / sr
    return feats
