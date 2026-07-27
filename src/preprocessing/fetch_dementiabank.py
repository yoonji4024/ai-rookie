"""DementiaBank media 재귀 다운로더 (talkbank 인증 쿠키 사용).

wget 재귀가 이 사이트에서 안 먹는다:
  - 폴더 링크가 절대 URL + `:443` 포함 (href="https://media.talkbank.org:443/.../Control")
  - 파일 확장자 없는 폴더 링크라 -A 필터가 재귀 진입을 막음
→ HTML의 <a href>를 직접 파싱해 폴더는 재귀, 원하는 확장자만 저장.

⚠️ 쿠키는 인자로 받지 말고 환경변수로 (노출 방지):
    export TB_SID='...'      # connect.sid 값
    export TB_TALKBANK='...' # talkbank 값
  (export는 히스토리에 남으니, 쓰고 나면 `history -c` 또는 새 셸 권장.
   더 안전하게는 read -s 로 넣은 뒤 이 스크립트에 넘기기)

사용:
    TB_SID=... TB_TALKBANK=... python3 -m src.preprocessing.fetch_dementiabank \
        --url https://media.talkbank.org/dementia/English/Pitt/ \
        --out data/dementiabank_en/Pitt --ext mp3 wav
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

HREF = re.compile(r'href="([^"]+)"')


def cookie_header() -> str:
    sid = os.environ.get("TB_SID", "")
    tb = os.environ.get("TB_TALKBANK", "")
    if not sid or not tb:
        sys.exit("TB_SID / TB_TALKBANK 환경변수 필요 (connect.sid, talkbank 쿠키값)")
    return f"connect.sid={sid}; talkbank={tb}"


def is_auth_page(html: str) -> bool:
    return "initPageAuth" in html or "initAuthModals" in html


def list_links(url: str, sess: requests.Session) -> list[str]:
    """디렉토리 HTML → 절대 URL 링크 목록 (부모/자기 제외)."""
    r = sess.get(url, timeout=60)
    r.raise_for_status()
    if is_auth_page(r.text) and "href=" not in r.text:
        sys.exit("⚠️ 인증 실패 — 쿠키 확인 (로그인 페이지만 반환됨)")
    out = []
    base_path = urlparse(url).path
    for href in HREF.findall(r.text):
        if "authUI" in href or href.startswith(("#", "mailto:")):
            continue
        absu = urljoin(url, href)
        p = urlparse(absu).path.rstrip("/")
        if p and p != base_path.rstrip("/") and p in urlparse(url + "x").path or True:
            # 부모 디렉토리(상위 경로) 제외
            if len(p) > len(base_path.rstrip("/")):
                out.append(absu)
    # 중복 제거, 정규화(:443 제거)
    seen, res = set(), []
    for u in out:
        u = u.replace(":443", "")
        if u not in seen:
            seen.add(u)
            res.append(u)
    return res


def crawl(url: str, out_dir: Path, exts: tuple[str, ...], sess: requests.Session,
          base: str, stats: dict):
    """폴더면 재귀, 파일이면 확장자 맞을 때 저장."""
    path = urlparse(url).path
    if path.endswith("/"):                       # 디렉토리
        for link in list_links(url, sess):
            lp = urlparse(link).path
            if not lp.startswith(urlparse(base).path):   # base 밖으로 안 나감
                continue
            # 디렉토리인지 파일인지: 확장자로 판단, 없으면 디렉토리로 간주
            if "." in lp.rsplit("/", 1)[-1]:
                crawl(link, out_dir, exts, sess, base, stats)
            else:
                crawl(link.rstrip("/") + "/", out_dir, exts, sess, base, stats)
    else:                                        # 파일
        ext = url.rsplit(".", 1)[-1].lower()
        if ext not in exts:
            return
        rel = urlparse(url).path[len(urlparse(base).path):].lstrip("/")
        dst = out_dir / rel
        if dst.exists():
            stats["skip"] += 1
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        with sess.get(url, stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(dst, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)
        stats["ok"] += 1
        print(f"  [{stats['ok']}] {rel} ({dst.stat().st_size/1e6:.1f}MB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="시작 디렉토리 URL (끝에 /)")
    ap.add_argument("--out", required=True, help="저장 폴더")
    ap.add_argument("--ext", nargs="+", default=["mp3", "wav", "cha"], help="받을 확장자")
    a = ap.parse_args()

    sess = requests.Session()
    sess.headers["Cookie"] = cookie_header()

    base = a.url if a.url.endswith("/") else a.url + "/"
    out = Path(a.out)
    stats = {"ok": 0, "skip": 0}
    print(f"다운로드: {base}\n확장자: {a.ext} → {out}\n")
    crawl(base, out, tuple(e.lower() for e in a.ext), sess, base, stats)
    print(f"\n완료: {stats['ok']}개 받음, {stats['skip']}개 스킵 → {out}")


if __name__ == "__main__":
    main()
