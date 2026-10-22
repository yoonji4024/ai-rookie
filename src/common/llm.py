"""국내 LLM 통합 클라이언트 (대회 제약: 국내 기업 모델만).

지원
  ax     : SKT A.X K2        — 타이밍 게이트 draft, 실시간 질문 생성
  exaone : LG EXAONE         — 타이밍 게이트 judge, 교차검증   (Friendli)
  solar  : Upstage Solar Pro2 — 요약·매칭·리포트
  midm   : KT 믿:음 2.5 Pro   — 탐지 근거 제시                (KT 직접 API)

⚠️ Friendli(exaone)는 `model` 필드에 모델명이 아니라 **엔드포인트 ID**를 넣는다.
⚠️ KT 결선 API는 2026-09-21 정정 안내의 주소와 모델 ID를 사용한다.
⚠️ A.X는 2026-10-11 전달된 운영 공지에 따라 K2를 사용한다. 과거 K1 평가와 구분한다.
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
import time
from dataclasses import dataclass

import requests

# ── .env 로딩 (python-dotenv 없으면 직접 파싱) ──────────────
def load_env(path: str = ".env") -> None:
    """.env를 환경변수로 로딩. 다른 모듈(tts 등)에서도 재사용."""
    try:
        from dotenv import load_dotenv
        load_dotenv(path)
        return
    except ImportError:
        pass
    from pathlib import Path

    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()


def is_mock() -> bool:
    return os.environ.get("LLM_MOCK", "").strip() in {"1", "true", "True"}


@dataclass
class ModelSpec:
    key_env: str
    base_url: str
    model: str
    model_env: str | None = None    # 모델 ID 또는 Friendli 엔드포인트 ID 재정의

    def resolved_model(self) -> str:
        if self.model_env:
            v = os.environ.get(self.model_env)
            if v:
                return v
        return self.model


MODELS: dict[str, ModelSpec] = {
    "ax": ModelSpec("AX_API_KEY", "https://awf-gw.adot.ai/v1", "A.X-K2"),
    "solar": ModelSpec("SOLAR_API_KEY", "https://api.upstage.ai/v1", "solar-pro2"),
    "exaone": ModelSpec(
        "EXAONE_API_KEY", "https://api.friendli.ai/dedicated/v1",
        "", model_env="EXAONE_ENDPOINT_ID"),
    "midm": ModelSpec(
        "MIDM_API_KEY", "https://midm.kt.com/v1",
        "midm-pro-fp8-kaic", model_env="MIDM_MODEL_ID"),
}


class LLMError(RuntimeError):
    pass


# ── Rate limit (A.X: 팀당 RPS 3, 429 시 Retry-After 미제공) ──
# ⚠️ 팀원들과 **공유하는** 한도다. 배치 작업이 한도를 독점하면 다른 팀원 호출이 막힌다.
#    → 클라이언트에서 간격을 강제하고, 429는 지수 백오프로 재시도한다.
RPS_LIMIT = {"ax": 3.0}          # 모델별 초당 요청 상한
_MIN_INTERVAL = {m: 1.0 / r for m, r in RPS_LIMIT.items()}
_last_call: dict[str, float] = {}


def _throttle(model: str) -> None:
    interval = _MIN_INTERVAL.get(model)
    if interval is None:
        return
    prev = _last_call.get(model)
    if prev is not None:
        wait = interval - (time.monotonic() - prev)
        if wait > 0:
            time.sleep(wait)
    _last_call[model] = time.monotonic()


MAX_CHARS = 120_000              # 기존 앱 입력 상한 유지; K2 제공사 컨텍스트 한도와는 별개


def _completion_text(body, model: str) -> str:
    """Validate one final message without leaking provider bodies or reasoning.

    We request one text answer. Multiple choices and nonfinal/tool/refusal
    messages cannot be silently treated as that answer. Legacy responses with
    no finish_reason remain compatible when the message is otherwise valid.
    """
    if not isinstance(body, dict):
        raise LLMError(f"{model} 응답 본문 형식 오류")
    choices = body.get('choices')
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise LLMError(f"{model} 단일 응답 후보 형식 오류")
    choice = choices[0]
    finish = choice.get('finish_reason')
    if finish == 'length':
        raise LLMError(f"{model} 최종 응답이 토큰 한도로 잘림")
    if finish is not None and finish != 'stop':
        raise LLMError(f"{model} 완료되지 않았거나 거절된 응답")
    message = choice.get('message')
    if not isinstance(message, dict):
        raise LLMError(f"{model} 응답 메시지 형식 오류")
    if message.get('refusal'):
        raise LLMError(f"{model} 생성 거절 응답")
    content = message.get('content')
    if not isinstance(content, str) or not content.strip():
        raise LLMError(f"{model} 최종 응답이 비어 있음 — reasoning 설정·토큰 한도 확인")
    return content


def chat(
    model: str,
    system: str,
    user: str,
    temperature: float = 0.0,
    # 90초: Friendli 전용 엔드포인트(EXAONE)는 콜드 스타트가 있어 30초로는
    # 첫 호출이 자주 타임아웃된다. 검증 단계가 이것 때문에 실패하면 리포트 전체가
    # 미검증으로 떨어지므로 넉넉히 잡는다.
    timeout: int = 90,
    max_tokens: int | None = None,
    retries: int = 3,
    thinking: bool | None = None,
    response_format: dict | None = None,
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

    if len(system) + len(user) > MAX_CHARS:
        user = user[: MAX_CHARS - len(system)]

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
    if thinking is not None and model in {"ax", "exaone"}:
        # Friendli 전용 엔드포인트의 reasoning 모델은 이 값을 생략하면
        # 최종 답변 없이 reasoning_content만 수천 토큰 생성할 수 있다.
        # 호출 목적에 따라 명시적으로 켜고 끄되, 내부 추론은 응답에 포함하지 않는다.
        payload["chat_template_kwargs"] = {"enable_thinking": thinking}
        if model == "exaone":
            payload["parse_reasoning"] = True
            payload["include_reasoning"] = False
    if response_format is not None:
        payload["response_format"] = response_format

    last: Exception | None = None
    for attempt in range(retries + 1):
        _throttle(model)
        try:
            r = requests.post(
                f"{spec.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json; charset=UTF-8"},
                json=payload, timeout=timeout,
            )
            if r.status_code == 429:                    # Rate limit — 지수 백오프
                last = LLMError(f"{model} 429 Rate Limit")
                if attempt < retries:
                    time.sleep(2 ** attempt)            # 1s → 2s → 4s
                    continue
                raise last
            r.raise_for_status()
            return _completion_text(r.json(), model)
        except requests.RequestException as e:
            last = e
            if attempt < retries and _retryable(e):
                time.sleep(2 ** attempt)
                continue
            raise LLMError(f"{model} 호출 실패: {e}") from e
    raise LLMError(f"{model} 재시도 소진: {last}")


def _retryable(e: Exception) -> bool:
    """일시적 오류만 재시도 (5xx·타임아웃). 4xx는 즉시 실패."""
    resp = getattr(e, "response", None)
    if resp is not None:
        return resp.status_code >= 500
    return isinstance(e, (requests.Timeout, requests.ConnectionError))


def chat_json(model: str, system: str, user: str, **kw) -> dict:
    """객체 JSON 응답 전용. 배열 응답 경로는 chat/parse_json을 따로 사용한다."""
    raw = chat(model, system, user, **kw)
    value = parse_json(raw)
    if not isinstance(value, dict):
        raise LLMError("JSON 객체 응답이 필요함")
    return value


def _repair_json(s: str) -> str:
    """LLM이 흔히 내는 JSON 오류 보정."""
    s = re.sub(r",\s*([}\]])", r"\1", s)          # 후행 쉼표
    s = s.replace("“", '"').replace("”", '"')      # 한글 따옴표
    s = s.replace("‘", "'").replace("’", "'")
    # 문자열 안의 실제 줄바꿈 → \n
    s = re.sub(r'(?<!\\)\n(?=(?:[^"]*"[^"]*")*[^"]*"[^"]*$)', r"\\n", s)
    return s


def parse_json(text: str) -> dict | list:
    """설명 속 괄호와 JSON 경계를 구분하며 문자열 값은 수정하지 않는다.

    잘림·중복 키·비유한수·여러 JSON·문법 보정이 필요한 응답은 LLMError다.
    형식 복구는 스키마/내용의 정확성이나 개인정보 제거 완료를 보증하지 않는다.
    """
    from src.common.json_contract import bounded_container
    try:
        return bounded_container(text)
    except (ValueError, TypeError, RecursionError) as exc:
        # The caller can report failure without copying source text into logs.
        raise LLMError("JSON 파싱 실패: 단일 유효 구조가 필요함") from exc


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
