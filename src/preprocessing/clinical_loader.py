"""익명화된 임상 음성(data/clinical) 로더.

labels.csv + wav 매핑. 전사(.cha/.txt)는 없으므로 음향 피처만 사용 가능.
(언어 피처가 필요하면 A.X STT로 전사 먼저)
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("data/clinical")

# CDR → 3분류 라벨 (정상 0 / MCI 1 / 치매 2)
CDR_TO_Y = {"0.0": 0, "0.5": 1, "1.0": 2, "2.0": 2, "3.0": 2}
DX_TO_Y = {"N": 0, "M": 1, "D": 2}


@dataclass
class ClinicalRecord:
    subject_id: str
    sex: str
    age: int | None
    cdr: float | None
    dx: str            # N / M / D
    wav_path: str
    source_sr: int

    @property
    def y3(self) -> int:
        """3분류: 0 정상 / 1 MCI / 2 치매."""
        return DX_TO_Y.get(self.dx, CDR_TO_Y.get(f"{self.cdr:.1f}" if self.cdr is not None else "", 0))


def load_clinical(root: str | Path = ROOT) -> list[ClinicalRecord]:
    root = Path(root)
    labels = root / "labels.csv"
    if not labels.exists():
        raise SystemExit(f"labels.csv 없음 — 먼저 anonymize_clinical 실행 ({root})")

    recs = []
    wavs = {p.stem.split("_")[0] + "_" + p.stem.split("_")[1]: p for p in root.glob("*.wav")}
    with open(labels, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            wav = wavs.get(row["id"])
            if wav is None:
                continue
            recs.append(ClinicalRecord(
                subject_id=row["id"], sex=row["sex"],
                age=int(row["age"]) if row["age"] else None,
                cdr=float(row["cdr"]) if row["cdr"] else None,
                dx=row["dx"], wav_path=str(wav),
                source_sr=int(row["source_sr"]),
            ))
    return recs


if __name__ == "__main__":
    for r in load_clinical():
        print(f"{r.subject_id}: {r.sex} {r.age}세 CDR {r.cdr} dx={r.dx} (y3={r.y3})")
