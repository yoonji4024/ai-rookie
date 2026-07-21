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
from pathlib import Path

import numpy as np

CACHE = Path("data/kang_stt.json")


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
def build(limit: int | None = None) -> dict:
    from src.common.stt import STTError, get_stt
    from src.preprocessing.kang_loader import load_kang

    stt = get_stt()
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    recs = load_kang()[:limit] if limit else load_kang()

    for i, r in enumerate(recs, 1):
        if r.subject_id in cache:
            continue
        try:
            t = stt.transcribe(r.wav_path)
        except STTError as e:
            print(f"  [{i}/{len(recs)}] {r.subject_id} ⚠️ {str(e)[:100]}")
            continue

        # ⚠️ Kang은 조사자(INV)+참가자(PAR) 인터뷰다. gold는 PAR만 쓰므로
        #    STT도 **주 화자(가장 오래 말한 사람 = 참가자)** 만 골라야 공정한 비교가 된다.
        main = t.main_speaker()
        stt_utts = [u.text for u in (t.by_speaker(main) if main is not None else t.utterances)
                    if u.text]

        cache[r.subject_id] = {
            "label": r.label,
            "gold_text": r.par_text,
            "gold_utterances": [u.text for u in r.par_utterances if u.text],
            "stt_text": " ".join(stt_utts),
            "stt_utterances": stt_utts,
            "stt_speakers": t.speakers,
            "stt_main_speaker": main,
            "stt_all_utterances": len(t.utterances),
        }
        print(f"  [{i}/{len(recs)}] {r.subject_id} gold {len(r.par_text)}자 / "
              f"STT {len(' '.join(stt_utts))}자 (화자 {t.speakers}, 주화자 {main})")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    return cache


# ── 분석 ────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()

    if a.build:
        c = build(a.limit)
        print(f"\n수집 완료: {len(c)}명 → {CACHE}")
        return

    if not CACHE.exists():
        raise SystemExit("STT 캐시 없음 — --build 먼저 실행")

    from sklearn.metrics import roc_auc_score

    from src.agents.analysis.features.korean_disfluency_rule import (
        FEATURE_NAMES, analyze, to_features,
    )

    cache = json.loads(CACHE.read_text(encoding="utf-8"))
    ids = sorted(cache)
    y = np.array([1 if cache[i]["label"] == "MCI" else 0 for i in ids])
    print(f"대상 {len(ids)}명 (HC {int((y==0).sum())} / MCI {int((y==1).sum())})\n")

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
    print("\n3) 판별력 유지 (단변량 AUC)")
    for j, k in enumerate(FEATURE_NAMES):
        try:
            ag = max(roc_auc_score(y, G[:, j]), 1 - roc_auc_score(y, G[:, j]))
            as_ = max(roc_auc_score(y, S[:, j]), 1 - roc_auc_score(y, S[:, j]))
        except ValueError:
            continue
        drop = ag - as_
        flag = "  ⚠️ 붕괴" if drop >= 0.10 else ("  유지" if drop < 0.05 else "")
        print(f"   {k:30s} gold {ag:.3f} → STT {as_:.3f}  ({-drop:+.3f}){flag}")

    print("\n해석: 보존율이 낮거나 AUC가 크게 떨어지는 마커는 **런타임에서 못 쓴다.**")
    print("      → 해당 신호는 STT 텍스트 대신 **음향 피처로 대체**해야 한다.")


if __name__ == "__main__":
    main()
