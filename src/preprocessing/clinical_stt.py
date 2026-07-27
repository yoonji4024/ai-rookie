"""임상 통화 음성 STT 전사 (A.X STT Batch, 화자 분리).

전화 인지검사는 조사자↔환자가 주고받는 대화다.
→ 화자 분리로 나눈 뒤, **어느 화자가 환자인지 사람이 확인**해야 한다.
   (Kang처럼 '최장 화자=환자' 가정이 통하지 않음 — 조사자도 많이 말함)

⚠️ 조사자 발화에는 정답·문항이 섞여 있으므로, 환자 구간만 골라내야 신호가 오염되지 않는다.

사용:
    python3 -m src.preprocessing.clinical_stt          # 전사 + 화자별 미리보기
    python3 -m src.preprocessing.clinical_stt --json   # 전사 결과 저장
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from src.common.stt import STTError, get_stt
from src.preprocessing.clinical_loader import load_clinical

OUT = Path("data/clinical/stt")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="전사 결과 JSON 저장")
    a = ap.parse_args()

    stt = get_stt()
    OUT.mkdir(parents=True, exist_ok=True)

    for r in sorted(load_clinical(), key=lambda r: r.y3):
        print(f"\n{'='*64}\n{r.subject_id}  dx={r.dx} CDR={r.cdr}  전사 중…")
        try:
            t = stt.transcribe(r.wav_path)
        except STTError as e:
            print(f"  ⚠️ {e}")
            continue

        dur = t.speaker_durations()
        total = sum(dur.values()) or 1
        print(f"  길이 {t.duration:.0f}s | 발화 {len(t.utterances)}개 | 화자 {t.speakers}")
        for s in t.speakers:
            print(f"    sp{s}: {dur[s]:6.0f}s ({dur[s]/total*100:4.1f}%)")

        # 화자별 앞부분 발화 — 누가 조사자/환자인지 사람이 판단하도록
        print("  --- 화자별 발화 샘플 (누가 환자인지 눈으로 확인) ---")
        for s in t.speakers:
            utts = [u.text for u in t.by_speaker(s) if u.text][:3]
            print(f"    sp{s}: {' / '.join(utts)[:100]}")

        if a.json:
            (OUT / f"{r.subject_id}.json").write_text(
                json.dumps({
                    "subject_id": r.subject_id, "dx": r.dx, "cdr": r.cdr,
                    "duration": t.duration,
                    "speakers": t.speakers,
                    "speaker_durations": dur,
                    "utterances": [
                        {"speaker": u.speaker, "start": u.start, "end": u.end, "text": u.text}
                        for u in t.utterances
                    ],
                }, ensure_ascii=False, indent=1), encoding="utf-8")

    if a.json:
        print(f"\n전사 저장: {OUT}")
        print("→ 각 파일에서 환자 화자 id를 확인한 뒤 labels.csv에 patient_speaker 열 추가 권장")


if __name__ == "__main__":
    main()
