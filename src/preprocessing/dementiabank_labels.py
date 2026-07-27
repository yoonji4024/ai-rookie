"""DementiaBank 영어/중국어 코퍼스 라벨 추출 (로컬 전사 zip → CSV).

라벨은 각 .cha의 @ID 줄 6번째 필드에 있다:
    @ID: eng|Pitt|PAR|70;|female|Control||Participant|30||
    필드:  0    1    2    3     4      5(진단)      7        8(MMSE)

폴더가 아니라 @ID를 진실원본으로 쓴다 (WLS처럼 폴더에 라벨 없는 코퍼스 대응).
오디오 파일명 = 전사 파일명(stem) → 서버 오디오와 corpus+stem으로 매칭.

산출: data/dementiabank_en_labels.csv
    corpus, stem, group, label3, mmse, age, sex
    label3: 0 정상 / 1 MCI / 2 치매  (그 외/불명은 행 제외)

사용:
    python3 -m src.preprocessing.dementiabank_labels          # 전체
    python3 -m src.preprocessing.dementiabank_labels --show   # 요약만
"""
from __future__ import annotations

import argparse
import csv
import zipfile
from collections import Counter
from pathlib import Path

DATA = Path("data")
OUT = DATA / "dementiabank_en_labels.csv"

# 검증에 쓸 코퍼스 (정상+환자 존재). 라벨없음/환자only는 제외
CORPORA = ["Pitt", "Delaware", "Lu"]

# @ID 진단 → 3분류. 여기 없는 값(Memory/Other/빈칸 등)은 불명 → 행 제외
GROUP_TO_LABEL3 = {
    "Control": 0,
    "MCI": 1,
    "ProbableAD": 2, "PossibleAD": 2, "AD": 2, "Alzheimer's": 2,
    "Dementia": 2, "Vascular": 2, "Pick's": 2, "Probable": 2,
}


def par_id_fields(cha_text: str) -> list[str] | None:
    """PAR(참가자) @ID 줄의 | 분리 필드. 없으면 None."""
    for line in cha_text.splitlines():
        if line.startswith("@ID") and "|PAR|" in line:
            body = line.split("\t", 1)[-1] if "\t" in line else line[len("@ID"):]
            return body.split("|")
    return None


def rows_from_zip(zip_path: Path, corpus: str) -> list[dict]:
    out = []
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if not name.endswith(".cha"):
                continue
            txt = zf.read(name).decode("utf-8", "replace")
            f = par_id_fields(txt)
            if not f or len(f) < 6:
                continue
            group = f[5].strip()
            if group not in GROUP_TO_LABEL3:
                continue
            age = f[3].strip().rstrip(";").split(".")[0] if len(f) > 3 else ""
            sex = f[4].strip() if len(f) > 4 else ""
            mmse = f[8].strip() if len(f) > 8 else ""
            out.append({
                "corpus": corpus,
                "stem": Path(name).stem,      # 오디오 파일명과 매칭 키
                "group": group,
                "label3": GROUP_TO_LABEL3[group],
                "mmse": mmse,
                "age": age,
                "sex": sex,
            })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="CSV 저장 없이 요약만")
    a = ap.parse_args()

    rows = []
    for c in CORPORA:
        zp = DATA / f"{c}.zip"
        if not zp.exists():
            print(f"⚠️  {zp} 없음 — 건너뜀")
            continue
        r = rows_from_zip(zp, c)
        rows.extend(r)
        dist = Counter(x["group"] for x in r)
        print(f"{c:10s} {len(r):4d}건  {dict(dist)}")

    n3 = Counter(x["label3"] for x in rows)
    name3 = {0: "정상", 1: "MCI", 2: "치매"}
    print("\n3분류 합계:", {name3[k]: n3[k] for k in sorted(n3)})

    if not a.show:
        with open(OUT, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["corpus", "stem", "group", "label3", "mmse", "age", "sex"])
            w.writeheader()
            w.writerows(rows)
        print(f"\n저장: {OUT}  ({len(rows)}행)")


if __name__ == "__main__":
    main()
