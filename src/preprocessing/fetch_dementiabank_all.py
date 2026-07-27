"""DementiaBank English 전체 다운로드 (TalkBankDB 목록 기반).

목적: 우리 음향 지표가 여러 코퍼스·과제·환경에서 치매/노화 신호를 일관되게 잡는지 검증.
      → 특정 데이터 편향이 아니라 지표의 보편성을 보이기 위해 전체를 받는다.

TalkBankDB_transcripts.xls(탭 구분 텍스트)의 경로 목록에서
  - dementia/English/ 하위
  - Pitt-orig 제외 (Pitt과 중복)
  - video 제외 (오디오만)
URL을 만들어 ?f=save 붙여 받는다 (그냥 mp3 URL은 11바이트 껍데기 = 플레이어 페이지).

인증: talkbank 쿠키 2개를 환경변수로 (노출 방지)
    export TB_SID=...       # connect.sid
    export TB_TALKBANK=...  # talkbank

사용:
    # 1) URL 목록만 생성 (다운로드 전 확인)
    python3 -m src.preprocessing.fetch_dementiabank_all --list-only
    # 2) 실제 다운로드 (tmux 권장)
    TB_SID=.. TB_TALKBANK=.. python3 -m src.preprocessing.fetch_dementiabank_all
"""
from __future__ import annotations

import argparse
import os
import subprocess
from collections import Counter
from pathlib import Path

XLS = Path("data/dementiabank_en/TalkBankDB_transcripts.xls")
OUT_ROOT = Path("data/dementiabank_en")
URL_FILE = OUT_ROOT / "_all_urls.txt"
MEDIA_BASE = "https://media.talkbank.org/"


def build_urls() -> list[str]:
    if not XLS.exists():
        raise SystemExit(f"목록 파일 없음: {XLS} (scp로 서버에 전송했는지 확인)")
    urls, seen = [], set()
    skip = Counter()
    for line in XLS.read_text(encoding="utf-8", errors="replace").splitlines():
        c = line.split("\t")
        if len(c) < 4:
            continue
        path, media = c[0], c[3]
        if not path.startswith("dementia/English/"):
            continue
        if "Pitt-orig" in path:
            skip["pitt-orig(중복)"] += 1
            continue
        if "video" in media:
            skip["video"] += 1
            continue
        if "audio" not in media:
            skip["기타"] += 1
            continue
        url = f"{MEDIA_BASE}{path}.mp3?f=save"
        if url not in seen:
            seen.add(url)
            urls.append(url)
    print(f"URL {len(urls)}개 생성 | 제외: {dict(skip)}")
    # 코퍼스별 분포
    corp = Counter(u.split("/English/")[1].split("/")[0] for u in urls)
    for k, v in corp.most_common():
        print(f"  {k}: {v}")
    return urls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-only", action="store_true", help="URL 목록만 생성")
    a = ap.parse_args()

    urls = build_urls()
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    URL_FILE.write_text("\n".join(urls) + "\n", encoding="utf-8")
    print(f"\n목록 저장: {URL_FILE}")

    if a.list_only:
        print("--list-only: 다운로드 생략")
        return

    sid, tb = os.environ.get("TB_SID"), os.environ.get("TB_TALKBANK")
    if not sid or not tb:
        raise SystemExit("TB_SID / TB_TALKBANK 환경변수 필요")

    # -x: 경로 구조 유지, --cut-dirs로 dementia/English/ 제거,
    # -nc: 이미 받은 건 건너뜀(재실행 시 이어받기), --content-disposition: ?f=save 파일명 정리
    cmd = [
        "wget", "--header", f"Cookie: connect.sid={sid}; talkbank={tb}",
        "-x", "-nH", "--cut-dirs=2", "-P", str(OUT_ROOT),
        "-i", str(URL_FILE), "-nv", "-nc", "--content-disposition",
    ]
    print(f"\n다운로드 시작 ({len(urls)}개) — tmux 권장, 재실행 시 -nc로 이어받기")
    subprocess.run(cmd, check=False)

    # 결과 요약
    got = list(OUT_ROOT.rglob("*.mp3"))
    print(f"\n받은 mp3: {len(got)}개")


if __name__ == "__main__":
    main()
