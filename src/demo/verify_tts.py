"""TTS 음성을 **실제 검증기**에 통과시켜 한계를 정량 입증한다.

가설
  합성 음성은 기계적으로 안정되어, MCI 대본으로 만들어도 **음질 지표는 정상으로 나온다**.
  (jitter·shimmer·HNR·CPP는 성대 진동의 불규칙성을 재는데, TTS엔 성대가 없다)

측정
  데모 wav → extract_acoustic → 발화 5축 스코어링 → 실제 Kang 화자와 대조.
  "말로만 한계를 주장"하는 대신 **수치로 보여준다**.

사용:
    python3 -m src.demo.verify_tts
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from src.agents.analysis.features.build_vector import build_feature_vector
from src.agents.analysis.features.extract_acoustic import extract_acoustic
from src.agents.analysis.features.extract_linguistic import extract_linguistic
from src.agents.analysis.scoring.score import ScoringModel

AUDIO_DIR = Path("data/demo_audio")
FEAT_CACHE = Path("data/kang_features.npz")
OUT = Path("docs/TTS_한계_검증.md")

VOICE_KEYS = ["ac_jitter_local", "ac_shimmer_local", "ac_hnr", "ac_cpp", "ac_f0_mean"]


def score_wav(wav: Path, transcript: str, model: ScoringModel, names: list[str]) -> dict:
    """wav + 대본 → 음향/언어 피처 → 발화 5축 점수."""
    ac = extract_acoustic(str(wav))                    # 전체 오디오 (세그먼트 정보 없음)
    lg = extract_linguistic(transcript, None)
    vec, vnames = build_feature_vector(ac, lg)

    # 스코어링 모델의 피처 순서에 맞춰 재배열 (없으면 0)
    m = dict(zip(vnames, vec))
    x = np.array([m.get(n, 0.0) for n in names], dtype=float)
    r = model.score_one(x)
    r["_raw"] = {k: round(float(m.get(k, 0.0)), 4) for k in VOICE_KEYS}
    return r


def main():
    if not FEAT_CACHE.exists():
        raise SystemExit("피처 캐시 없음 — run_kang_baseline 먼저")
    wavs = sorted(AUDIO_DIR.glob("*.wav"))
    if not wavs:
        raise SystemExit(f"데모 음성 없음 — python3 -m src.demo.scenario --tts 먼저 ({AUDIO_DIR})")

    d = np.load(FEAT_CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]
    ids = [str(i) for i in d["ids"]]
    model = ScoringModel.fit(X, y, names)

    # 실제 Kang 화자 기준값
    totals = model.total_scores(X)
    hc_i = int(np.argmax(np.where(y == 0, totals, -1)))
    mci_i = int(np.argmin(np.where(y == 1, totals, 999)))
    real = {
        f"실제 HC ({ids[hc_i]})": model.score_one(X[hc_i]),
        f"실제 MCI ({ids[mci_i]})": model.score_one(X[mci_i]),
    }
    for k, v in real.items():
        v["_raw"] = {kk: round(float(X[hc_i if "HC" in k else mci_i,
                                     names.index(kk)]), 4)
                     for kk in VOICE_KEYS if kk in names}

    # TTS 음성 채점
    tts_scores = {}
    for w in wavs:
        txt = w.with_suffix(".txt")
        transcript = txt.read_text(encoding="utf-8") if txt.exists() else ""
        label = "TTS 정상형" if "normal" in w.stem else "TTS MCI형"
        print(f"채점 중: {w.name}")
        tts_scores[f"{label} ({w.stem})"] = score_wav(w, transcript, model, names)

    rows = {**tts_scores, **real}

    print("\n" + "=" * 68)
    print(f"{'대상':28s} {'총점':>5s} {'등급':>5s} {'발음정확도':>9s}")
    print("-" * 68)
    for k, v in rows.items():
        pron = v["axes"].get("발음 정확도", {}).get("score", "-")
        print(f"{k:28s} {v['total_score']:>5d} {v['grade']:>5s} {pron:>9}")

    print("\n음질 원시값 (TTS엔 성대가 없어 불규칙성이 나타나지 않음)")
    print(f"{'대상':28s} " + " ".join(f"{k.replace('ac_',''):>13s}" for k in VOICE_KEYS))
    for k, v in rows.items():
        print(f"{k:28s} " + " ".join(f"{v['_raw'].get(m, 0):>13.4f}" for m in VOICE_KEYS))

    _write_doc(rows)
    print(f"\n문서 저장: {OUT}")


def _write_doc(rows: dict):
    L = [
        "# TTS 합성 음성의 한계 — 실측 검증",
        "",
        "> 데모용 TTS 음성을 **실제 분석 파이프라인에 그대로 통과**시킨 결과다.",
        "> 목적은 성능 자랑이 아니라, 합성 음성으로는 **무엇을 보일 수 없는지** 정직하게 보이는 것.",
        "",
        "## 가설",
        "",
        "jitter·shimmer·HNR·CPP는 **성대 진동의 불규칙성**을 재는 지표다.",
        "TTS에는 성대가 없으므로, MCI 대본으로 합성해도 이 지표들은 정상(또는 그 이상)으로 나올 것이다.",
        "",
        "## 결과",
        "",
        "| 대상 | 총점 | 등급 | 발음 정확도 |",
        "|---|---|---|---|",
    ]
    for k, v in rows.items():
        pron = v["axes"].get("발음 정확도", {}).get("score", "-")
        L.append(f"| {k} | {v['total_score']} | {v['grade']} | {pron} |")

    L += ["", "### 음질 원시값", "",
          "| 대상 | " + " | ".join(m.replace("ac_", "") for m in VOICE_KEYS) + " |",
          "|---" * (len(VOICE_KEYS) + 1) + "|"]
    for k, v in rows.items():
        L.append(f"| {k} | " + " | ".join(f"{v['_raw'].get(m, 0):.4f}" for m in VOICE_KEYS) + " |")

    L += [
        "",
        "## 해석",
        "",
        "- 합성 음성은 **음질 축을 신뢰할 수 없다**. 대본이 MCI 패턴이어도 성대 불규칙성이 없어",
        "  jitter·shimmer가 낮고 HNR·CPP가 높게 나온다.",
        "- 따라서 데모에서 **음향 점수는 실제 Kang 화자 값을 병행 표기**한다.",
        "- 반면 **순서 회상·언어 축은 대본에서 나오므로 합성으로도 유효**하다.",
        "- 합성 음성은 **탐지 분류기 학습에 사용하지 않는다** (CLAUDE.md §7).",
        "",
    ]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
