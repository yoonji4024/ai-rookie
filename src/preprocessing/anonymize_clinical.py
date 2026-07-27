"""임상 음성 데이터 익명화 + 표준화.

⚠️ 개인정보: 원본 파일명이 성별_이름_나이_CDR_진단 형식이라 **이름이 그대로 노출**된다.
   제공자 요청에 따라 이름을 제거하고 익명 ID로 치환한다.
   - 이름-ID 매핑은 저장하지 않는다 (역추적 방지).
   - 원본은 처리 후 별도 보관/삭제 (이 스크립트는 원본을 지우지 않음 — 사용자가 판단).

파일명 규약 (입력): {성별}_{이름}_{만연령}_{CDR}_{진단}.{확장자}
   예: F_OHN_70_CDR1_D.wav, M_PEW_68_CDR0.5_M.wav
   - 성별: F/M
   - CDR: CDR0(정상) / CDR0.5(MCI) / CDR1(치매)   ※ 'CDR' 접두 있을 수도/없을 수도
   - 진단: N(normal) / M(MCI) / D(dementia)   ※ 일부 파일엔 진단 라벨이 없을 수 있음

출력: {익명ID}_{성별}_{나이}_{CDR}_{진단}.wav  (이름만 제거, 라벨은 보존)
   예: KCL_001_F_70_1.0_D.wav
   + labels.csv (id, sex, age, cdr, dx, source_sr, orig_channels)

표준화: 16kHz mono PCM (우리 파이프라인 규격). 원본 SR/채널은 labels.csv에 기록.

사용:
    python3 -m src.preprocessing.anonymize_clinical --src data/_clinical_raw --out data/clinical
"""
from __future__ import annotations

import argparse
import csv
import re
import subprocess
from pathlib import Path

AUDIO_EXT = {".wav", ".mp3", ".m4a", ".flac"}
TARGET_SR = 16000

# 진단 라벨 정규화
DX_MAP = {"N": "N", "M": "M", "D": "D", "NORMAL": "N", "MCI": "M", "DEMENTIA": "D"}
# CDR → 표준 표기
CDR_MAP = {"0": "0.0", "0.5": "0.5", "1": "1.0", "2": "2.0", "3": "3.0"}


def parse_name(stem: str) -> dict | None:
    """파일명 → 메타. 이름 필드는 버린다(익명화)."""
    parts = stem.split("_")
    if len(parts) < 4:
        return None
    sex = parts[0].upper()
    if sex not in {"F", "M"}:
        return None
    # 뒤에서부터: 진단(선택), CDR, 나이
    fields = parts[1:]
    dx = ""
    if fields and fields[-1].upper() in DX_MAP:
        dx = DX_MAP[fields[-1].upper()]
        fields = fields[:-1]
    # CDR 찾기 (CDR0.5 / 0.5 형태)
    cdr = ""
    if fields:
        m = re.search(r"(\d+(?:\.\d+)?)", fields[-1])
        if m and ("CDR" in fields[-1].upper() or fields[-1].replace(".", "").isdigit()):
            cdr = CDR_MAP.get(m.group(1), m.group(1))
            fields = fields[:-1]
    # 나이 찾기
    age = ""
    for f in reversed(fields):
        if f.isdigit():
            age = f
            break
    # dx가 비었으면 CDR로 추정
    if not dx and cdr:
        dx = {"0.0": "N", "0.5": "M", "1.0": "D", "2.0": "D", "3.0": "D"}.get(cdr, "")
    return {"sex": sex, "age": age, "cdr": cdr, "dx": dx}


def probe(path: Path) -> tuple[int, int]:
    """(sample_rate, channels)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    ).stdout.split()
    return (int(out[0]), int(out[1])) if len(out) >= 2 else (0, 0)


def convert(src: Path, dst: Path) -> None:
    """16kHz mono wav로 변환."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-ac", "1", "-ar", str(TARGET_SR), "-f", "wav", str(dst)],
        check=True,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="data/_clinical_raw", help="원본 폴더")
    ap.add_argument("--out", default="data/clinical", help="익명화 출력 폴더")
    ap.add_argument("--prefix", default="KCL", help="익명 ID 접두")
    a = ap.parse_args()

    src, out = Path(a.src), Path(a.out)
    files = sorted(f for f in src.rglob("*") if f.suffix.lower() in AUDIO_EXT)
    if not files:
        raise SystemExit(f"오디오 없음: {src}")

    out.mkdir(parents=True, exist_ok=True)
    rows, skipped = [], []
    for i, f in enumerate(files, 1):
        meta = parse_name(f.stem)
        if meta is None:
            skipped.append(f.name)
            continue
        sr, ch = probe(f)
        aid = f"{a.prefix}_{i:03d}"
        # ⚠️ 출력 파일명에 이름 없음. 라벨만.
        name = f"{aid}_{meta['sex']}_{meta['age']}_{meta['cdr']}_{meta['dx']}.wav"
        convert(f, out / name)
        rows.append({
            "id": aid, "sex": meta["sex"], "age": meta["age"],
            "cdr": meta["cdr"], "dx": meta["dx"],
            "source_sr": sr, "orig_channels": ch, "target_sr": TARGET_SR,
        })
        print(f"  [{i}/{len(files)}] → {name}  (원본 {sr}Hz {ch}ch)")

    with open(out / "labels.csv", "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"\n익명화 완료: {len(rows)}개 → {out}")
    print(f"라벨: {out}/labels.csv")
    from collections import Counter
    print("진단 분포:", dict(Counter(r["dx"] for r in rows)))
    sr_mix = Counter(r["source_sr"] for r in rows)
    if len(sr_mix) > 1:
        print(f"⚠️ 원본 샘플레이트 혼재: {dict(sr_mix)} — 라벨과 교란 여부 점검 필요")
    if skipped:
        print(f"⚠️ 파일명 파싱 실패(제외): {skipped}")
    print("\n⚠️ 원본(이름 포함)은 확인 후 별도 삭제하세요. 이 스크립트는 원본을 지우지 않습니다.")


if __name__ == "__main__":
    main()
