"""전사 텍스트 개인정보(PII) 마스킹.

⚠️ 파일명만 익명화해선 부족하다. 전화 인지검사 음성/전사에는 내용 자체에 PII가 박혀 있다:
   실명("오현녀님"), 기관·교수명("보라매병원 이준영 교수님 연구실"), 생년월일 등.
   → STT 전사 JSON의 text 필드에서 이들을 마스킹한다.

한계
   - 규칙 기반이라 100%는 아니다. 새로운 이름/기관은 패턴으로만 잡는다.
   - 음성 파형 자체의 PII(말소리)는 이 스크립트로 못 지운다 → 발화 구간 자르기로 별도 처리.
   - 마스킹 후에도 사람이 한 번 검수할 것.

사용:
    python3 -m src.preprocessing.mask_pii --dir data/clinical/stt
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# 호칭 앞의 한국 이름 (2~4자) — "오현녀님", "오현녀님댁", "전광남씨"
# ⚠️ 한글은 \b 경계가 제대로 안 먹어("오현녀님댁" 누락) → lookahead에서 호칭만 확인
NAME_HONORIFIC = re.compile(r"[가-힣]{2,4}(?=(?:님|씨|할머니|할아버지|어르신))")
# 기관 + 교수/센터/병원/연구실
ORG = re.compile(
    r"[가-힣]+(?:병원|의료원|대학교|대학|센터|연구실|연구소|보건소|안심\s*센터)"
    r"|[가-힣]{2,4}\s*교수(?:님)?"
)
# 생년월일·나이 노출 — "47년생", "6월 2일", "1947년"
BIRTH = re.compile(r"\d{2,4}\s*년\s*생|\d{4}\s*년(?:\s*\d{1,2}\s*월)?(?:\s*\d{1,2}\s*일)?|\d{1,2}\s*월\s*\d{1,2}\s*일")
# 전화번호
PHONE = re.compile(r"01[016789]\D?\d{3,4}\D?\d{4}")


def mask_text(text: str) -> tuple[str, int]:
    """PII 마스킹. (마스킹된 텍스트, 마스킹 건수)."""
    n = 0

    def sub(pat, tag, s):
        nonlocal n
        def _r(m):
            nonlocal n
            n += 1
            return tag
        return pat.sub(_r, s)

    text = sub(ORG, "[기관]", text)
    text = sub(NAME_HONORIFIC, "[이름]", text)
    text = sub(PHONE, "[전화]", text)
    text = sub(BIRTH, "[생년월일]", text)
    return text, n


def mask_file(path: Path) -> int:
    d = json.loads(path.read_text(encoding="utf-8"))
    total = 0
    for u in d.get("utterances", []):
        u["text"], k = mask_text(u.get("text", ""))
        total += k
    path.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="data/clinical/stt")
    a = ap.parse_args()

    files = sorted(Path(a.dir).glob("*.json"))
    if not files:
        raise SystemExit(f"전사 JSON 없음: {a.dir}")

    for f in files:
        k = mask_file(f)
        print(f"  {f.name}: {k}건 마스킹")

    print("\n마스킹 완료. ⚠️ 규칙 기반이라 누락 가능 — 사람이 한 번 검수하세요.")
    print("검수: grep -oE '\\[이름\\]|\\[기관\\]|\\[생년월일\\]' 로 치환 확인,")
    print("      원문에 남은 실명은 수동 확인")


if __name__ == "__main__":
    main()
