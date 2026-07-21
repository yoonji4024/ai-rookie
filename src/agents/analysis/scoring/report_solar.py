"""솔라 해석·리포트 에이전트 (Upstage Solar Pro 2).

역할 분담
  - **점수 산출은 규칙(score.py)이 한다.** 재현·방어 가능해야 하므로 LLM이 채점하지 않는다.
  - **솔라는 해석만 한다.** 산출된 점수·측정값을 받아 보호자용 진단 요약과 축별 코멘트를 생성.

철칙 (CLAUDE.md §3, §12)
  - 입력에 없는 내용 생성 금지 (근거성). 점수·수치는 주어진 값만 인용.
  - 진단명 단정 금지. "참고용·의료진 상담 권유" 톤.
  - 항상 JSON 스키마로 받아 파싱.

사용:
    from src.agents.analysis.scoring.report_solar import generate_speech_report
    report = generate_speech_report(score_result)
"""
from __future__ import annotations

import json
import os
import re

import requests

try:  # python-dotenv 없으면 .env를 직접 파싱 (서버 최소 환경 대비)
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    from pathlib import Path

    _env = Path(".env")
    if _env.exists():
        for _line in _env.read_text(encoding="utf-8").splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

API_URL = "https://api.upstage.ai/v1/chat/completions"
MODEL = "solar-pro2"
TIMEOUT = 30

SYSTEM_PROMPT = """당신은 어르신의 발화(말하기) 분석 결과를 보호자에게 설명하는 助手입니다.

반드시 지킬 규칙:
1. 진단명을 말하지 마세요. "치매", "경도인지장애", "MCI", "질환", "환자"라는 단어를 쓰지 마세요.
   대신 "이런 신호가 관찰됩니다", "참고 지표입니다"처럼 관찰 사실만 전달하세요.
2. 입력으로 받은 점수와 측정값에만 근거하세요.
   - 숫자는 **입력에 적힌 값을 그대로만** 인용하세요.
   - 새 숫자를 계산하거나(평균, 차이, 백분율 등) 추정해서 쓰지 마세요.
   - 확실하지 않으면 숫자를 쓰지 말고 말로만 설명하세요.
3. 단정하지 말고, 마지막에 전문의 상담을 권유하세요.
4. 보호자(비전문가)가 이해할 쉬운 한국어로 쓰세요.
5. 반드시 아래 JSON 형식으로만 답하세요. 다른 텍스트를 붙이지 마세요.

{
  "summary": "2~3문장 요약. 낮은 점수 축을 점수와 함께 언급.",
  "axis_comments": {"축이름": "그 축이 무엇을 재는지와 이 결과의 의미를 1~2문장", ...},
  "recommendation": "보호자가 할 수 있는 다음 행동 1~2문장. 전문의 상담 권유 포함."
}"""


def _build_user_prompt(score_result: dict) -> str:
    """점수 결과 → 솔라 입력 텍스트. 측정값 근거를 함께 제공."""
    lines = [
        f"총점: {score_result['total_score']}점 (등급: {score_result['grade']})",
        f"가장 낮은 축: {', '.join(score_result.get('weakest', []))}",
        "",
        "축별 점수와 근거 측정값:",
    ]
    for axis, v in score_result["axes"].items():
        lines.append(f"- {axis}: {v['score']}점")
        for f, d in v["features"].items():
            lines.append(
                f"    · {f}: 측정 {d['value']} / 정상군 평균 {d['hc_mean']} "
                f"({d['direction']})"
            )
    lines += [
        "",
        "위 결과를 보호자에게 설명하는 JSON을 작성하세요.",
        "점수는 100점 만점이며 높을수록 정상군에 가깝습니다.",
    ]
    return "\n".join(lines)


def _parse_json(text: str) -> dict:
    """LLM 출력에서 JSON 추출 (코드펜스·잡텍스트 방어)."""
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def call_solar(system: str, user: str, temperature: float = 0.2) -> str:
    key = os.environ.get("SOLAR_API_KEY")
    if not key:
        raise RuntimeError("SOLAR_API_KEY 미설정 — .env 확인")
    resp = requests.post(
        API_URL,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        },
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def generate_speech_report_verified(
    score_result: dict, max_retries: int = 2, temperature: float = 0.0
) -> dict:
    """에이전트 루프: 생성 → 검증 → 실패 시 지적사항 피드백하며 재생성.

    검증(validate_solar.check_report)을 통과할 때까지 최대 max_retries회 재시도한다.
    반환 리포트에 '_attempts', '_verified' 메타를 붙인다.
    """
    from src.agents.analysis.scoring.validate_solar import check_report  # 순환참조 회피

    base_user = _build_user_prompt(score_result)
    user = base_user
    last: dict = {}

    for attempt in range(1, max_retries + 2):
        last = generate_speech_report(score_result, temperature=temperature, _user=user)
        res = check_report(last, score_result)
        if res["ok"]:
            last["_attempts"] = attempt
            last["_verified"] = True
            return last
        # 실패 → 무엇이 틀렸는지 알려주고 다시 요청
        user = (
            base_user
            + "\n\n[이전 응답의 문제점 — 반드시 고쳐서 다시 작성하세요]\n"
            + "\n".join(f"- {i}" for i in res["issues"])
            + "\n숫자는 위 입력에 적힌 값만 그대로 인용하고, 없는 수치는 절대 쓰지 마세요."
        )

    last["_attempts"] = max_retries + 1
    last["_verified"] = False
    last["_last_issues"] = res["issues"]
    return last


def generate_speech_report(
    score_result: dict, temperature: float = 0.0, _user: str | None = None
) -> dict:
    """점수 결과 → 보호자용 리포트 JSON.

    반환: {'summary', 'axis_comments', 'recommendation'} (+ 실패 시 'error')
    """
    user = _user if _user is not None else _build_user_prompt(score_result)
    raw = call_solar(SYSTEM_PROMPT, user, temperature=temperature)
    try:
        report = _parse_json(raw)
    except Exception as e:
        return {"error": f"JSON 파싱 실패: {e}", "raw": raw}
    report["_input_digest"] = {
        "total_score": score_result["total_score"],
        "grade": score_result["grade"],
        "axis_scores": {a: v["score"] for a, v in score_result["axes"].items()},
    }
    return report
