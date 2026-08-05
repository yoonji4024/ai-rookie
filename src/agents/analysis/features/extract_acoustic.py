"""음향 피처 — 원본 오디오에서 직접 추출 (STT 무관, disfluency 안전망).

CLAUDE.md §6: pause, speech/articulation, F0, jitter/shimmer, MFCC.
segments가 주어지면 참가자(PAR) 구간만 사용 (인터뷰어 음성 제외).

피처 그룹
  - pause   : 휴지 비율/빈도/길이 (발화 내부 무음)
  - tempo   : voiced-segment 분절 통계 (발화 분절/속도, 텍스트 무관)
  - voice   : F0(평균/변동/변동계수), jitter 3종, shimmer 3종, HNR, CPP  ← 음질, 발화량 무관
              (포먼트 F1~F3는 Kang에서 판별력 낮아(0.50~0.65) 제거, CPP만 유지)
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
CPP_MAX_S = 60          # CPP 계산에 쓸 최대 오디오 길이(초) — 속도/안정성 절충


# VAD 파라미터 — Kang의 '발화(utterance)' 단위를 흉내내기 위한 값
VAD_TOP_DB = 30          # 무음 판정 기준 (_pause_features와 동일)
VAD_MERGE_GAP = 1.0      # 이보다 짧은 간격은 한 발화 내부 휴지로 본다(초)
VAD_MIN_DUR = 0.3        # 이보다 짧은 조각은 버린다(잡음)


def vad_segments(y: np.ndarray, sr: int) -> list[tuple[float, float]]:
    """음성 구간을 '발화' 단위로 묶어 반환.

    왜 필요한가 — **참조분포와 입력 조건을 맞추기 위해서다.**
      학습 참조분포(Kang)는 CHAT 전사의 발화 타임스탬프로 **참가자 발화 구간만**
      잘라서 계산했다. 조사자가 말하는 동안과 긴 무음은 애초에 빠져 있다.
      반면 런타임 오디오는 전체를 통째로 넣는다 → 휴지 비율이 3~7배로 튄다
      (Kang HC 0.08~0.15 vs 임상 0.33 vs 실제 녹음 0.57).
      이 차이는 인지 상태가 아니라 **입력을 다르게 만들어 넣은 결과**다.

    발화 단위로 묶는 방식
      - 음성 구간을 찾고,
      - 간격이 VAD_MERGE_GAP 미만이면 한 발화 안의 휴지로 보아 합치고,
      - VAD_MIN_DUR 미만 조각은 버린다.
      → 발화 '내부' 휴지는 보존되고(측정 대상), 발화 '사이' 공백은 제외된다.
    """
    intervals = librosa.effects.split(y, top_db=VAD_TOP_DB)
    if len(intervals) == 0:
        return []
    merged: list[list[int]] = [list(intervals[0])]
    gap_n = int(VAD_MERGE_GAP * sr)
    for a, b in intervals[1:]:
        if a - merged[-1][1] < gap_n:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    min_n = int(VAD_MIN_DUR * sr)
    return [(a / sr, b / sr) for a, b in merged if b - a >= min_n]


def _par_audio(y: np.ndarray, sr: int, segments: list[tuple[float, float]] | None):
    """참가자 발화 구간 오디오 목록.

    segments가 주어지면(학습: CHAT 타임스탬프) 그대로 사용.
    없으면(런타임) VAD로 발화 구간을 추정한다 — 전체를 통째로 쓰면 참조분포와
    조건이 어긋나 점수가 뭉개진다.
    """
    if not segments:
        segments = vad_segments(y, sr)
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
    """음질 패널 — F0, jitter 3종, shimmer 3종, HNR, CPP. 전부 발화량 무관."""
    keys = [
        "f0_mean", "f0_std", "f0_range", "f0_cv",
        "jitter_local", "jitter_rap", "jitter_ppq5",
        "shimmer_local", "shimmer_apq3", "shimmer_apq5",
        "hnr",
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

    # CPP (cepstral peak prominence — 음성 명료도/주기성). praat 버전별 시그니처 방어.
    # 속도: 전체 오디오는 너무 느려(파일당 수십만 프레임) 중간 CPP_MAX_S초만 사용,
    #       cepstrogram 간격 2ms→10ms. 평균 CPP는 이 샘플로도 안정적.
    def _cpp():
        yv = y
        cap = int(CPP_MAX_S * sr)
        if len(yv) > cap:
            start = (len(yv) - cap) // 2
            yv = yv[start:start + cap]
        sc = parselmouth.Sound(yv.astype(np.float64), sampling_frequency=sr)
        pc = call(sc, "To PowerCepstrogram", 60, 0.01, 5000, 50)
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


def _load_audio(path: str) -> tuple["np.ndarray", int]:
    """오디오 로드. **이미 목표 샘플레이트인 wav는 soundfile로 직접 읽는다.**

    librosa.load는 파일이 이미 16kHz여도 디코딩·리샘플 경로를 타서 느리다
    (60초 wav 기준 2.9초 — 전체 추출 시간 4.5초의 65%가 여기였다).
    soundfile은 같은 파일을 0.01초대에 읽는다. 포맷이 다르면 librosa로 폴백.
    """
    try:
        import soundfile as sf
        info = sf.info(path)
        if info.samplerate == SR:
            y, sr = sf.read(path, dtype="float32", always_2d=False)
            if getattr(y, "ndim", 1) > 1:
                y = y.mean(axis=1)
            return np.asarray(y, dtype=np.float32), sr
    except Exception:
        pass
    return librosa.load(path, sr=SR, mono=True)


def extract_acoustic(
    audio_path: str,
    segments: list[tuple[float, float]] | None = None,
    use_vad: bool = True,
    vad_mode: str = "hybrid",
) -> dict:
    """음향 피처 딕셔너리.

    segments : 학습 시 CHAT 전사의 PAR 발화 (start_s, end_s) 목록. 있으면 그대로 사용.
    use_vad  : segments가 없을 때 VAD로 발화 구간을 추정할지.
    vad_mode : segments 없이 VAD를 쓸 때 **어디에 적용할지**.

      "hybrid" (기본) — 휴지·템포는 **원본 전체**, 음질·스펙트럼·MFCC는 **발화 구간**.
      "all"           — 전부 발화 구간 (VAD 전면 적용)
      "none"          — 전부 원본 전체 (VAD 미적용)

    왜 hybrid인가 — 두 피처군이 서로 반대 방향을 요구한다.
      · 휴지·템포: **긴 휴지 자체가 진단 신호다.** VAD가 이를 '발화 사이 공백'으로
        잘라내면 신호가 사라진다. 실측 — Pitt(n=503) 휴지비율 단변량 AUC 0.687 → 0.523,
        유성구간율 0.656 → 0.506, 전체 AUC 0.765 → 0.699로 하락.
      · 음질(HNR·CPP·jitter·shimmer·f0): **무음이 섞이면 값이 오염된다.**
        VAD 적용 시 f0 단변량 AUC 0.563 → 0.640으로 개선. 실제 녹음에서
        발음 정확도 47점 → 95점(무음 때문에 낮았던 것).

    ⚠️ segments가 주어지면(학습) vad_mode는 무시된다. 학습·런타임의 정의를 맞추려면
       참조분포도 같은 방식으로 만들어야 한다.
    """
    y, sr = _load_audio(audio_path)

    if segments:
        chunks = _par_audio(y, sr, segments)
        voiced = chunks
    elif not use_vad or vad_mode == "none":
        chunks = voiced = [y]
    elif vad_mode == "all":
        chunks = voiced = _par_audio(y, sr, None)
    else:                                   # hybrid
        chunks = [y]                        # 휴지·템포 — 원본 전체
        voiced = _par_audio(y, sr, None)    # 음질·스펙트럼·MFCC — 발화 구간

    par = np.concatenate(voiced)

    feats = {}
    feats.update(_pause_features(chunks, sr))
    feats.update(_tempo_features(chunks, sr))
    feats.update(_voice_features(par, sr))
    feats.update(_spectral_features(par, sr))
    feats.update(_mfcc_features(par, sr))
    feats["total_speech_dur"] = len(par) / sr
    return feats
