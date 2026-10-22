"""전사 텍스트 개인정보(PII) 마스킹.

⚠️ 파일명만 익명화해선 부족하다. 전사 본문에도 이름·기관명·생년월일 등이 포함될 수 있다.

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

# 호칭 앞의 한국 이름 (2~4자) — "홍길동님", "홍길동님댁", "김가상씨"
# ⚠️ 한글은 \b 경계가 제대로 안 먹어("홍길동님댁" 누락) → lookahead에서 호칭만 확인
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


# ── LLM 보조 마스킹 (믿:음) — 기본 비활성 ────────────────────
# ⚠️ 이 경로는 전사 텍스트를 외부 API로 전송한다.
#    로컬 규칙에도 이름·주소 등의 누락이 남을 수 있으므로 제거 완료로 간주하지 않는다.
#    외부 전송 가능한 자료에만 사용하며 **기본은 규칙만** 쓴다.
#    (규칙이 놓친 걸 꼭 LLM으로 잡아야 할 때만, 규칙 1차 마스킹 후 옵트인으로 사용)
LLM_SYSTEM = """다음 텍스트에서 개인정보를 찾아 정해진 태그로 바꾸세요.

- 사람 이름 → [이름]
- 병원·기관·연구실·센터·교수명 → [기관]
- 생년월일·나이 노출(예: 47년생, 6월 2일) → [생년월일]
- 전화번호·주소 → [연락처]

규칙:
- 이미 [이름], [기관] 등으로 치환된 부분은 그대로 두세요.
- 개인정보가 아닌 일반 단어는 절대 바꾸지 마세요.
- 원문의 다른 내용은 한 글자도 바꾸지 말고, 개인정보만 태그로 교체하세요.

반드시 이 JSON만 출력: {"masked": "치환된 전체 텍스트"}"""


def mask_text_llm(text: str) -> str:
    """규칙으로 1차 마스킹된 텍스트를 믿:음이 재검. 실패 시 입력 그대로 반환.

    ⚠️ 먼저 규칙을 적용해도 개인정보 잔류가 가능하다. 허용된 자료에만 사용한다.
       출력 무결성 검사와 실패 시 원문 반환 모두 개인정보 제거 완료를 보증하지 않는다.
    """
    from src.common.llm import LLMError, chat_json
    try:
        out = chat_json("midm", LLM_SYSTEM, text, temperature=0.0)
        m = out.get("masked")
        from src.preprocessing.masking_contract import is_masking_only
        return m if is_masking_only(text, m) else text
    except (LLMError, Exception):
        return text


def mask_file_hybrid(path: Path) -> tuple[int, int]:
    """규칙 → LLM 2단계. (규칙 마스킹 건수, LLM이 추가 변경한 발화 수)."""
    d = json.loads(path.read_text(encoding="utf-8"))
    rule_n, llm_changed = 0, 0
    for u in d.get("utterances", []):
        t1, k = mask_text(u.get("text", ""))     # 1차: 규칙 (로컬)
        rule_n += k
        t2 = mask_text_llm(t1)                    # 2차: 믿:음 (규칙 누락 가능)
        if t2 != t1:
            llm_changed += 1
        u["text"] = t2
    path.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    return rule_n, llm_changed


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
