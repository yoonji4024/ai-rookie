"""음향 피처 — 원본 오디오에서 직접 추출 (STT 무관, disfluency 안전망).

CLAUDE.md §6: pause, speech/articulation, F0, jitter/shimmer, MFCC.
segments가 주어지면 참가자(PAR) 구간만 사용 (인터뷰어 음성 제외).
"""
from __future__ import annotations

import numpy as np
import librosa

try:
    import parselmouth
    from parselmouth.praat import call
    _HAS_PRAAT = True
except ImportError:  # 소스 빌드 지연 대비 — F0/jitter/shimmer는 0으로 채움
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
    """발화 구간 내부의 휴지(무음) 분석 — energy 기반."""
    total_dur = sum(len(c) for c in chunks) / sr
    voiced_dur = 0.0
    pauses: list[float] = []
    for c in chunks:
        intervals = librosa.effects.split(c, top_db=35)
        v = sum((b - a) for a, b in intervals) / sr
        voiced_dur += v
        # 발화 내부 무음 간격
        for i in range(1, len(intervals)):
            gap = (intervals[i][0] - intervals[i - 1][1]) / sr
            if gap >= 0.15:  # 150ms 이상만 휴지로 간주
                pauses.append(gap)
    return {
        "pause_ratio": 1.0 - voiced_dur / total_dur if total_dur else 0.0,
        "pause_rate": len(pauses) / total_dur if total_dur else 0.0,   # 휴지 횟수/초
        "pause_dur_mean": float(np.mean(pauses)) if pauses else 0.0,
        "pause_dur_std": float(np.std(pauses)) if pauses else 0.0,
        "phonation_time": voiced_dur,
    }


def _voice_features(y: np.ndarray, sr: int) -> dict:
    if not _HAS_PRAAT:
        return {"f0_mean": 0.0, "f0_std": 0.0, "f0_range": 0.0, "jitter": 0.0, "shimmer": 0.0}
    snd = parselmouth.Sound(y.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch(pitch_floor=60, pitch_ceiling=400)
    f0 = pitch.selected_array["frequency"]
    f0 = f0[f0 > 0]
    pp = call(snd, "To PointProcess (periodic, cc)", 60, 400)
    try:
        jitter = call(pp, "Get jitter (local)", 0, 0, 0.0001, 0.02, 1.3)
        shimmer = call([snd, pp], "Get shimmer (local)", 0, 0, 0.0001, 0.02, 1.3, 1.6)
    except Exception:
        jitter = shimmer = np.nan
    return {
        "f0_mean": float(np.mean(f0)) if len(f0) else 0.0,
        "f0_std": float(np.std(f0)) if len(f0) else 0.0,
        "f0_range": float(np.ptp(f0)) if len(f0) else 0.0,
        "jitter": float(jitter) if jitter == jitter else 0.0,
        "shimmer": float(shimmer) if shimmer == shimmer else 0.0,
    }


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
    feats.update(_mfcc_features(par, sr))
    feats["total_speech_dur"] = len(par) / sr
    return feats
