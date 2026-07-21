"""STT 도메인 시프트 측정 — 런타임에서 신호가 살아남는가?

문제 (CLAUDE.md §4 리스크, §13 열린 항목)
  지금까지의 성능(분류기 AUC 0.928)은 **사람이 정성껏 만든 전사** 기준이다.
  실제 서비스는 **A.X STT 출력**으로 돌아간다.
  STT가 발화를 매끄럽게 다듬으면
    "제가 즈 , 나 , 제 , 제가"  →  "제가"
  처럼 우리가 확보한 한국어 비유창성 신호(파편반복 AUC 0.726 등)가 통째로 사라진다.

측정 (Kang: gold 전사 + 오디오가 둘 다 있는 유일한 자산)
  1. WER — STT 정확도 자체
  2. 비유창성 피처 보존율 — gold vs STT에서 각 마커가 얼마나 남는가
  3. 판별력 유지 — STT 전사로 뽑은 피처의 AUC가 얼마나 떨어지는가  ← 가장 중요

사용:
    python3 -m src.agents.analysis.features.stt_shift --build --limit 10   # STT 전사 수집
    python3 -m src.agents.analysis.features.stt_shift                      # 비교 분석
"""
from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import numpy as np

# 단일 클래스 경고는 우리가 직접 안내하므로 sklearn 경고 도배를 막는다
warnings.filterwarnings("ignore", message="Only one class is present")

CACHE = Path("data/kang_stt.json")
PAR_AUDIO_DIR = Path("data/kang_par_audio")


def extract_par_audio(record, out_dir: Path = PAR_AUDIO_DIR) -> Path:
    """gold 타임스탬프로 **참가자 구간만** 잘라 이어붙인 wav 생성.

    왜: STT 화자 분리는 턴 경계에서 새어(실측: "드라마 제목이 어떻게 돼요?"의 뒷부분이
        참가자로 오분류) 비유창성 비교를 흐린다. Kang은 .cha에 PAR 발화 시각이
        정확히 있으므로, 그 구간만 잘라 넣으면 **화자 분리 자체가 불필요**하다.
        (런타임에는 어르신 혼자 말하므로 이 문제가 없다 — Kang 인터뷰 특성)
    """
    import wave

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{record.subject_id}.wav"
    if out.exists():
        return out

    spans = [(u.start_ms, u.end_ms) for u in record.par_utterances
             if u.start_ms is not None and u.end_ms is not None]
    with wave.open(record.wav_path, "rb") as r:
        sr, sw, ch = r.getframerate(), r.getsampwidth(), r.getnchannels()
        n = r.getnframes()
        frames = []
        for s_ms, e_ms in spans:
            a = max(0, int(s_ms / 1000 * sr))
            b = min(n, int(e_ms / 1000 * sr))
            if b > a:
                r.setpos(a)
                frames.append(r.readframes(b - a))
    with wave.open(str(out), "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(sw)
        w.setframerate(sr)
        w.writeframes(b"".join(frames))
    return out


# ── WER ─────────────────────────────────────────────────────
def wer(ref: str, hyp: str) -> float:
    """단어 오류율 (편집거리 / 참조 단어수)."""
    r, h = ref.split(), hyp.split()
    if not r:
        return 0.0
    d = np.zeros((len(r) + 1, len(h) + 1), dtype=int)
    d[:, 0] = np.arange(len(r) + 1)
    d[0, :] = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1,
                          d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r), len(h)] / len(r)


# ── 수집 ────────────────────────────────────────────────────
def build(limit: int | None = None, mode: str = "par") -> dict:
    """STT 전사 수집.

    mode:
      'par'  — gold 타임스탬프로 참가자 구간만 잘라 전사 (권장, 화자 오분류 없음)
      'full' — 원본 전체를 전사하고 화자 분리로 참가자 추출 (실제 런타임에 가까움)
    """
    from src.common.stt import STTError, get_stt
    from src.preprocessing.kang_loader import load_kang

    stt = get_stt()
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    recs = load_kang()

    if limit:
        # ⚠️ 앞에서 N명을 자르면 전부 HC가 된다(정렬 순서상). 한 클래스만 모이면
        #    AUC 계산이 불가능해 결과가 전부 nan이 된다. → 양쪽에서 균등 추출.
        hc = [r for r in recs if r.label == "HC"]
        mci = [r for r in recs if r.label == "MCI"]
        half = max(1, limit // 2)
        recs = hc[:half] + mci[: limit - half]
        print(f"  (균등 추출: HC {min(half, len(hc))}명 + MCI {min(limit-half, len(mci))}명)")

    for i, r in enumerate(recs, 1):
        key = f"{r.subject_id}::{mode}"
        if key in cache:
            continue
        try:
            if mode == "par":
                wav = extract_par_audio(r)
                t = stt.transcribe(str(wav))
                stt_utts = [u.text for u in t.utterances if u.text]
                note = f"참가자 구간만 {wav.stat().st_size/1e6:.0f}MB"
            else:
                t = stt.transcribe(r.wav_path)
                main = t.main_speaker()
                stt_utts = [u.text for u in
                            (t.by_speaker(main) if main is not None else t.utterances) if u.text]
                note = f"화자 {t.speakers}, 주화자 {main}, 비중 {t.diarization_confidence():.0%}"
        except STTError as e:
            print(f"  [{i}/{len(recs)}] {r.subject_id} ⚠️ {str(e)[:100]}")
            continue

        cache[key] = {
            "mode": mode,
            "label": r.label,
            "gold_text": r.par_text,
            "gold_utterances": [u.text for u in r.par_utterances if u.text],
            "stt_text": " ".join(stt_utts),
            "stt_utterances": stt_utts,
        }
        print(f"  [{i}/{len(recs)}] {r.subject_id} gold {len(r.par_text)}자 / "
              f"STT {len(' '.join(stt_utts))}자 | {note}")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    return cache


# ── 분석 ────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--mode", choices=["par", "full"], default="par",
                    help="par=참가자구간만(권장) / full=전체+화자분리")
    a = ap.parse_args()

    if a.build:
        c = build(a.limit, a.mode)
        print(f"\n수집 완료: {len(c)}건 → {CACHE}")
        return

    if not CACHE.exists():
        raise SystemExit("STT 캐시 없음 — --build 먼저 실행")

    from sklearn.metrics import roc_auc_score

    from src.agents.analysis.features.korean_disfluency_rule import (
        FEATURE_NAMES, analyze, to_features,
    )

    cache = json.loads(CACHE.read_text(encoding="utf-8"))
    ids = sorted(k for k in cache if cache[k].get("mode", "par") == a.mode)
    if not ids:
        raise SystemExit(f"mode={a.mode} 캐시 없음 — --build --mode {a.mode} 먼저 실행")
    y = np.array([1 if cache[i]["label"] == "MCI" else 0 for i in ids])
    n_hc, n_mci = int((y == 0).sum()), int((y == 1).sum())
    print(f"[mode={a.mode}] 대상 {len(ids)}명 (HC {n_hc} / MCI {n_mci})\n")

    both_classes = n_hc > 0 and n_mci > 0
    if not both_classes:
        print("⚠️ 한 클래스만 수집됨 — 판별력(AUC) 비교는 건너뜁니다.")
        print("   두 클래스를 모으려면: --build --limit N (양쪽에서 균등 추출)\n")

    # 1) WER
    wers = [wer(cache[i]["gold_text"], cache[i]["stt_text"]) for i in ids]
    print(f"1) STT 정확도\n   WER 평균 {np.mean(wers):.3f} (중앙값 {np.median(wers):.3f})")

    # 2) 피처 보존율
    G, S = [], []
    for i in ids:
        gu, su = cache[i]["gold_utterances"], cache[i]["stt_utterances"]
        G.append([to_features(analyze(gu), gu)[k] for k in FEATURE_NAMES])
        S.append([to_features(analyze(su), su)[k] for k in FEATURE_NAMES])
    G, S = np.array(G), np.array(S)

    print("\n2) 비유창성 마커 보존율 (STT / gold)")
    for j, k in enumerate(FEATURE_NAMES):
        g, s = G[:, j].mean(), S[:, j].mean()
        keep = (s / g * 100) if g > 0 else float("nan")
        flag = "  ⚠️ 소실" if keep == keep and keep < 50 else ""
        print(f"   {k:30s} gold {g:.4f} → STT {s:.4f}  보존 {keep:5.1f}%{flag}")

    # 3) 판별력 유지 — 실전 성능의 상한
    if both_classes:
        print("\n3) 판별력 유지 (단변량 AUC)")
        for j, k in enumerate(FEATURE_NAMES):
            if len(set(G[:, j])) < 2 and len(set(S[:, j])) < 2:
                print(f"   {k:30s} (값이 전부 동일 — 비교 불가)")
                continue
            ag = max(roc_auc_score(y, G[:, j]), 1 - roc_auc_score(y, G[:, j]))
            as_ = max(roc_auc_score(y, S[:, j]), 1 - roc_auc_score(y, S[:, j]))
            drop = ag - as_
            flag = "  ⚠️ 붕괴" if drop >= 0.10 else ("  유지" if drop < 0.05 else "")
            print(f"   {k:30s} gold {ag:.3f} → STT {as_:.3f}  ({-drop:+.3f}){flag}")

    print("\n해석: 보존율이 낮거나 AUC가 크게 떨어지는 마커는 **런타임에서 못 쓴다.**")
    print("      → 해당 신호는 STT 텍스트 대신 **음향 피처로 대체**해야 한다.")


if __name__ == "__main__":
    main()
