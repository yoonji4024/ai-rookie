"""DementiaBank Pitt 로더 (영어, Cookie Theft 등).

경로: data/dementiabank_en/Pitt/{Control|Dementia}/{task}/{화자}-{회차}.mp3
  - Control = 정상(0), Dementia = 치매(2)   ← 폴더가 곧 라벨
  - 화자ID = 파일명 앞 숫자 (002), 회차 = 뒤 숫자 (0). 종단 데이터라 화자 단위 분할 필수.
  - task = cookie(그림설명) / fluency / recall / sentence

mp3라 우리 파이프라인(16kHz wav 전제)에 맞추려면 변환 필요 → prepare_wav().

⚠️ 영어라 한국어 언어 피처(kiwipiepy·krr_*)는 못 씀. **음향 피처만** 유효
   (음향은 언어 무관 — 우리 STT-무관 설계가 여기서 빛을 발함).
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("data/dementiabank_en/Pitt")
WAV_ROOT = Path("data/dementiabank_en/Pitt_wav")
TARGET_SR = 16000

LABEL_Y = {"Control": 0, "Dementia": 2}    # 0 정상 / 2 치매 (MCI 없음)
FNAME = re.compile(r"(\d+)-(\d+)")


@dataclass
class PittRecord:
    speaker_id: str        # "C002" / "D001" (라벨+화자, 화자 단위 분할 키)
    label: str             # "Control" / "Dementia"
    task: str              # cookie / fluency / recall / sentence
    visit: int             # 회차
    mp3_path: str
    wav_path: str | None = None

    @property
    def y(self) -> int:
        return LABEL_Y[self.label]


def load_pitt(root: str | Path = ROOT, task: str | None = "cookie") -> list[PittRecord]:
    """Pitt 레코드 목록. task=None이면 전체 과제, 지정하면 그 과제만."""
    root = Path(root)
    recs = []
    for mp3 in sorted(root.rglob("*.mp3")):
        parts = mp3.relative_to(root).parts      # (Control, cookie, 002-0.mp3)
        if len(parts) < 3:
            continue
        label, tsk = parts[0], parts[1]
        if label not in LABEL_Y:
            continue
        if task and tsk != task:
            continue
        m = FNAME.search(mp3.stem)
        if not m:
            continue
        spk, visit = m.group(1), int(m.group(2))
        recs.append(PittRecord(
            speaker_id=f"{label[0]}{spk}",       # C002 / D001 — 라벨 접두로 충돌 방지
            label=label, task=tsk, visit=visit, mp3_path=str(mp3),
        ))
    return recs


def prepare_wav(recs: list[PittRecord], wav_root: str | Path = WAV_ROOT) -> list[PittRecord]:
    """mp3 → 16kHz mono wav 변환 (이미 있으면 스킵). wav_path 채워서 반환."""
    wav_root = Path(wav_root)
    for i, r in enumerate(recs, 1):
        rel = Path(r.mp3_path).relative_to(ROOT).with_suffix(".wav")
        dst = wav_root / rel
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", r.mp3_path,
                 "-ac", "1", "-ar", str(TARGET_SR), "-f", "wav", str(dst)],
                check=True,
            )
        r.wav_path = str(dst)
        if i % 100 == 0:
            print(f"  변환 {i}/{len(recs)}")
    return recs


if __name__ == "__main__":
    import argparse
    from collections import Counter

    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="cookie")
    ap.add_argument("--convert", action="store_true", help="mp3→wav 변환")
    a = ap.parse_args()

    recs = load_pitt(task=a.task)
    print(f"[task={a.task}] 레코드 {len(recs)}개")
    print("  라벨:", dict(Counter(r.label for r in recs)))
    spk = {r.speaker_id for r in recs}
    print(f"  화자: {len(spk)}명 "
          f"(정상 {len({r.speaker_id for r in recs if r.label=='Control'})} / "
          f"치매 {len({r.speaker_id for r in recs if r.label=='Dementia'})})")

    if a.convert:
        print("\nmp3 → 16kHz wav 변환")
        prepare_wav(recs)
        print("변환 완료 →", WAV_ROOT)
