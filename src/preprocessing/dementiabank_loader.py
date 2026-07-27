"""DementiaBank 통합 로더 (Pitt·Delaware·Lu) — 라벨은 CSV(@ID)로 매칭.

폴더 라벨에 의존하지 않는다. dementiabank_labels.py가 각 .cha의 @ID에서 뽑은
label3(0 정상/1 MCI/2 치매)를 corpus+stem 키로 오디오에 붙인다.

오디오 경로(서버):
    Pitt      data/dementiabank_en/Pitt/{Control|Dementia}/{task}/{stem}.mp3
    Delaware  data/dementiabank_en/Protocol/Delaware/{Control|...}/{stem}.mp3
    Lu        data/dementiabank_en/Lu/{Control|Dementia}/{stem}.mp3

화자ID = corpus + stem 앞부분(숫자/영숫자). 종단·복수과제라 화자 단위 분할 필수.
Pitt은 과제가 여러 개 → 기본 cookie(그림설명)만. Delaware·Lu는 단일 과제라 전체.

사용:
    from src.preprocessing.dementiabank_loader import load_dementiabank
    recs = load_dementiabank(["Pitt", "Delaware", "Lu"])
"""
from __future__ import annotations

import argparse
import csv
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("data/dementiabank_en")
LABELS = Path("data/dementiabank_en_labels.csv")

# 코퍼스별 오디오 루트 (ROOT 기준 상대)
AUDIO_ROOT = {
    "Pitt": "Pitt",
    "Delaware": "Protocol/Delaware",
    "Lu": "Lu",
}
LABEL3_NAME = {0: "정상", 1: "MCI", 2: "치매"}


@dataclass
class DBRecord:
    corpus: str
    speaker_id: str     # 화자 단위 분할 키 (corpus 접두)
    stem: str
    label3: int         # 0 정상 / 1 MCI / 2 치매
    mp3_path: str

    @property
    def y_bin(self) -> int:
        """정상(0) vs 치매(1). MCI 제외 대상은 호출부에서 거른다."""
        return 0 if self.label3 == 0 else 1


def _speaker(corpus: str, stem: str) -> str:
    """stem 앞부분을 화자ID로. '121-0'→121, '01-2'→01, 'F37'→F37."""
    m = re.match(r"([A-Za-z]*\d+)", stem)
    key = m.group(1) if m else stem
    return f"{corpus}:{key}"


def _load_labels() -> dict[tuple[str, str], int]:
    if not LABELS.exists():
        raise SystemExit(f"라벨 CSV 없음: {LABELS} "
                         f"(먼저 python3 -m src.preprocessing.dementiabank_labels)")
    out = {}
    with open(LABELS, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            out[(row["corpus"], row["stem"])] = int(row["label3"])
    return out


def load_dementiabank(corpora: list[str] | None = None,
                      pitt_task: str = "cookie",
                      root: Path = ROOT) -> list[DBRecord]:
    corpora = corpora or ["Pitt", "Delaware", "Lu"]
    labels = _load_labels()
    recs: list[DBRecord] = []
    for corpus in corpora:
        adir = root / AUDIO_ROOT[corpus]
        for mp3 in sorted(adir.rglob("*.mp3")):
            # Pitt은 과제 폴더(cookie/recall/...) 중 지정 과제만
            if corpus == "Pitt" and pitt_task:
                if f"/{pitt_task}/" not in str(mp3).replace("\\", "/"):
                    continue
            stem = mp3.stem
            lab = labels.get((corpus, stem))
            if lab is None:               # 라벨 없는 파일(불명/제외군)은 스킵
                continue
            recs.append(DBRecord(
                corpus=corpus, speaker_id=_speaker(corpus, stem),
                stem=stem, label3=lab, mp3_path=str(mp3),
            ))
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpora", nargs="+", default=["Pitt", "Delaware", "Lu"])
    ap.add_argument("--pitt-task", default="cookie")
    a = ap.parse_args()

    recs = load_dementiabank(a.corpora, pitt_task=a.pitt_task)
    print(f"총 {len(recs)}건 / 화자 {len({r.speaker_id for r in recs})}명\n")
    for c in a.corpora:
        cr = [r for r in recs if r.corpus == c]
        if not cr:
            print(f"  {c}: 0 (오디오 없음?)")
            continue
        d = Counter(LABEL3_NAME[r.label3] for r in cr)
        spk = len({r.speaker_id for r in cr})
        print(f"  {c:10s} {len(cr):4d}건 · 화자 {spk:3d}명 · {dict(d)}")


if __name__ == "__main__":
    main()
