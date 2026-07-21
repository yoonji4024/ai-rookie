"""국내 LLM 통합 클라이언트 (대회 제약: 국내 기업 모델만).

지원
  ax     : SKT A.X K1        — 타이밍 게이트 draft, 실시간 질문 생성
  exaone : LG EXAONE         — 타이밍 게이트 judge, 교차검증   (Friendli)
  solar  : Upstage Solar Pro2 — 요약·매칭·리포트
  midm   : KT 믿:음 2.0       — 탐지 근거 제시                (Friendli)

⚠️ Friendli(exaone·midm)는 `model` 필드에 모델명이 아니라 **엔드포인트 ID**를 넣는다.
⚠️ 키는 .env에서만 읽는다(하드코딩 금지).

mock 모드
  네트워크 없는 환경(로컬 샌드박스 등)에서도 파이프라인 전체를 돌릴 수 있도록
  LLM_MOCK=1 이면 실제 호출 없이 규칙 기반 가짜 응답을 돌려준다.
  → 구조 검증은 로컬에서, 실제 품질 검증은 서버에서.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

import requests

# ── .env 로딩 (python-dotenv 없으면 직접 파싱) ──────────────
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    from pathlib import Path

    _env = Path(".env")
    if _env.exists():
        for _l in _env.read_text(encoding="utf-8").splitlines():
            _l = _l.strip()
            if _l and not _l.startswith("#") and "=" in _l:
                _k, _v = _l.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))


def is_mock() -> bool:
    return os.environ.get("LLM_MOCK", "").strip() in {"1", "true", "True"}


@dataclass
class ModelSpec:
    key_env: str
    base_url: str
    model: str
    model_env: str | None = None    # Friendli: 엔드포인트 ID를 env에서

    def resolved_model(self) -> str:
        if self.model_env:
            v = os.environ.get(self.model_env)
            if v:
                return v
        return self.model


MODELS: dict[str, ModelSpec] = {
    "ax": ModelSpec("AX_API_KEY", "https://awf-gw.adot.ai/v1", "A.X-K1"),
    "solar": ModelSpec("SOLAR_API_KEY", "https://api.upstage.ai/v1", "solar-pro2"),
    "exaone": ModelSpec(
        "EXAONE_API_KEY", "https://api.friendli.ai/dedicated/v1",
        "", model_env="EXAONE_ENDPOINT_ID"),
    "midm": ModelSpec(
        "MIDM_API_KEY", "https://api.friendli.ai/dedicated/v1",
        "", model_env="MIDM_ENDPOINT_ID"),
}


class LLMError(RuntimeError):
    pass


def chat(
    model: str,
    system: str,
    user: str,
    temperature: float = 0.0,
    timeout: int = 30,
    max_tokens: int | None = None,
) -> str:
    """LLM 호출 → 응답 텍스트. model: 'ax'|'exaone'|'solar'|'midm'."""
    if is_mock():
        return _mock_response(model, system, user)

    spec = MODELS.get(model)
    if spec is None:
        raise LLMError(f"알 수 없는 모델: {model}")
    key = os.environ.get(spec.key_env)
    if not key:
        raise LLMError(f"{spec.key_env} 미설정 — .env 확인")

    payload = {
        "model": spec.resolved_model(),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
    }
    if max_tokens:
        payload["max_tokens"] = max_tokens

    try:
        r = requests.post(
            f"{spec.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload, timeout=timeout,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]
    except requests.RequestException as e:
        raise LLMError(f"{model} 호출 실패: {e}") from e


def chat_json(model: str, system: str, user: str, **kw) -> dict:
    """JSON 응답 전용 — 코드펜스·잡텍스트 방어 후 파싱 (CLAUDE.md §12)."""
    raw = chat(model, system, user, **kw)
    return parse_json(raw)


def _repair_json(s: str) -> str:
    """LLM이 흔히 내는 JSON 오류 보정."""
    s = re.sub(r",\s*([}\]])", r"\1", s)          # 후행 쉼표
    s = s.replace("“", '"').replace("”", '"')      # 한글 따옴표
    s = s.replace("‘", "'").replace("’", "'")
    # 문자열 안의 실제 줄바꿈 → \n
    s = re.sub(r'(?<!\\)\n(?=(?:[^"]*"[^"]*")*[^"]*"[^"]*$)', r"\\n", s)
    return s


def parse_json(text: str) -> dict:
    """LLM 출력 → dict. 실패는 항상 LLMError로 올려 호출부가 처리하게 한다.

    ⚠️ json.JSONDecodeError를 그대로 올리면 호출부의 `except LLMError`를 빠져나가
       파이프라인 전체가 죽는다(실제로 A.X K1의 깨진 JSON 때문에 세션이 중단됨).
    """
    raw = text
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()

    for candidate in (text, _repair_json(text)):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
        m = re.search(r"[\{\[].*[\}\]]", candidate, re.S)
        if m:
            for c in (m.group(0), _repair_json(m.group(0))):
                try:
                    return json.loads(c)
                except json.JSONDecodeError:
                    pass

    raise LLMError(f"JSON 파싱 실패: {raw[:300]}")


def health_check() -> dict[str, str]:
    """전 모델 연결 확인 — 서버에서 API 점검용."""
    out = {}
    for name in MODELS:
        try:
            r = chat(name, "한 단어로 답하세요.", "안녕", timeout=15)
            out[name] = f"OK ({r.strip()[:20]})"
        except Exception as e:
            out[name] = f"FAIL — {str(e)[:80]}"
    return out


# ── mock ────────────────────────────────────────────────────
def _mock_response(model: str, system: str, user: str) -> str:
    """네트워크 없이 구조 검증용 가짜 응답. 스키마는 실제와 동일하게."""
    s = (system + user).lower()

    # ⚠️ 분기 순서 주의: judge 프롬프트에도 "질문 후보"가 들어가므로 judge를 먼저 판별
    if "심판" in system or "판정하세요" in user:
        return json.dumps({
            "action": "ask", "best_index": 0,
            "reason": "(mock) 장면 전환 직후라 시청 방해가 적음",
        }, ensure_ascii=False)

    if "질문 후보" in system or "draft" in s:
        return json.dumps({
            "candidates": [
                {"question": "지금 나온 내용 어떠세요?", "reason": "장면 전환 직후"},
                {"question": "저 부분 기억나세요?", "reason": "핵심 장면"},
            ],
            "silence_ok": True,
        }, ensure_ascii=False)

    if "장면" in system and "매칭" in system:
        m = re.search(r'"?scene_id"?\s*[:=]\s*"?([\w.]+)', user)
        return json.dumps({
            "matches": [{"scene_id": m.group(1) if m else "unknown",
                         "evidence": "(mock) 키워드 일치", "confidence": 0.9}],
        }, ensure_ascii=False)

    if "보호자" in system or "리포트" in s:
        return json.dumps({
            "summary": "(mock) 관찰된 신호를 요약한 내용입니다.",
            "axis_comments": {"버벅임": "(mock) 코멘트"},
            "recommendation": "(mock) 전문의 상담을 권합니다.",
        }, ensure_ascii=False)

    return "(mock) 응답"


if __name__ == "__main__":
    if is_mock():
        print("MOCK 모드")
        print(chat("ax", "질문 후보를 만드세요.", "장면 전환"))
    else:
        print("API 연결 점검")
        for k, v in health_check().items():
            print(f"  {k:8s} {v}")
