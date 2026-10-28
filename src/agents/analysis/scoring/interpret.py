"""해석 생성기 — 루브릭 + 검색된 근거를 주입해 점수를 해석한다 (Solar).

기존 report_solar.py와의 차이
    report_solar : 점수·측정값만 주고 설명하게 함 → 해석이 모델 상식에서 나옴
    interpret(여기): 루브릭(축이 무엇을 재는지) + 검색된 문헌·실험 근거를 함께 줌
                    → 해석이 근거에 매인다. 인용 ID를 달게 해 검증 가능.

루브릭을 주면 모델이 점수를 다시 매기려 든다("62점인데 70점이 맞다").
이를 프롬프트에서 명시적으로 차단하고, verify_agent가 점수 불변을 기계적으로 재확인한다.
(프롬프팅이 1차 방어, 규칙 검사가 잔여분을 받는 그물)

인용은 **주어진 근거 ID로만** 하게 한다. 목록에 없는 ID를 쓰면 검증에서 걸린다.

사용:
    from src.agents.analysis.scoring.interpret import interpret_scores
    out = interpret_scores(score_result)      # {'report':..., 'evidence':..., 'verify':...}
"""
from __future__ import annotations

import json
import math
import os
import re

from src.agents.analysis.scoring.rubric import AXES
from src.agents.analysis.scoring.verify_agent import verify_report
from src.rag.corpus import Evidence
from src.rag.retriever import format_for_prompt, retrieve_for_scores

INTERPRET_SYSTEM = """당신은 어르신의 말하기 분석 결과를 보호자에게 설명하는 해석자입니다.

■ 당신이 하지 않는 일
  - 점수를 매기거나 바꾸지 않습니다. 점수는 이미 규칙으로 산출되었습니다.
    입력에 적힌 점수를 그대로 인용하세요. "이 점수는 더 낮아야/높아야 한다"고 쓰지 마세요.
  - 진단하지 않습니다. "치매", "알츠하이머", "경도인지장애", "확진", "정상입니다" 같은
    단정 표현을 쓰지 마세요. 관찰된 신호만 전달합니다.
  - 입력 등급이 '정상'이어도 이를 "정상 범위", "정상적인 말하기 능력"처럼 건강 상태로
    확대 해석하지 않습니다. 한 시점 결과를 변화·저하·악화라고 표현하지 않습니다.
  - 주어지지 않은 지식을 쓰지 않습니다. 아래 [근거]에 없는 내용은 쓰지 마세요.

■ 당신이 하는 일
  - [루브릭]으로 각 축이 무엇을 재는지 파악하고,
  - [근거]에 근거해 그 점수가 무엇을 시사하는지 보호자가 이해할 말로 풀어씁니다.
  - 근거를 쓸 때는 반드시 괄호 안에 근거 ID를 답니다. 예: (clin-pause-wordfinding)
  - [근거] 목록에 없는 ID를 지어내지 마세요.
  - 수치는 입력에 적힌 값만 그대로 인용합니다. 새로 계산하지 마세요.
  - 재검사 주기처럼 입력에 없는 기간·횟수·수치를 새로 제안하지 마세요.
  - 입력에 발화량 적정 기준이 없으므로 발화량이 충분하다거나 길이 영향이 없다고 판단하지 마세요.
  - 낮은 점수도 단정적으로 말하지 말고, 교란 요인(녹음 환경, 컨디션, 개인차)을 함께 언급하세요.
  - 근거가 점수의 재진술뿐이면 해석도 그 범위에 한정합니다. 신체·인지 기능이
    양호하다거나 어떤 어려움이 있다는 주장을 덧붙이지 마세요.
  - 축의 구성 지표를 이번에 모두 측정했다고 가정하지 마세요. 제시된 하위 지표를
    다른 능력(예: 문법적 정확성)으로 바꾸어 설명하지 마세요.
  - 한 축의 설명은 해당 점수·측정값과 근거가 직접 뒷받침하는 짧은 문장으로 씁니다.

■ 출력 — 아래 JSON만. 다른 텍스트 금지.
{
  "summary": "2~3문장. 전반 요약과 가장 낮은 축 언급.",
  "axis_comments": {"축이름": "이 축이 무엇을 재는지 + 결과의 의미 + 근거 ID 1~2개. 2~3문장."},
  "caveats": "이 결과를 해석할 때 주의할 점 1~2문장 (교란 요인).",
  "recommendation": "보호자가 할 수 있는 다음 행동. 점수가 양호하면 같은 조건의 반복 관찰만 안내하고, 낮은 점수가 반복되거나 실제 생활에서 걱정이 있을 때만 전문 상담을 선택지로 제시. 1~2문장."
}"""


def _rubric_block(axes_in_score: list[str]) -> str:
    """루브릭 — 축이 무엇으로 구성되는지. 점수 재계산이 아니라 '의미 파악'용."""
    lines = ["각 축이 무엇을 재는지 (해석에만 사용, 재채점 금지):"]
    for axis in axes_in_score:
        feats = AXES.get(axis, [])
        lines.append(f"  [{axis}] 구성 지표: {', '.join(feats) if feats else '—'}")
    return "\n".join(lines)


def _scores_block(score_result: dict) -> str:
    lines = []
    if "total_score" in score_result:
        grade = {"정상": "양호"}.get(
            str(score_result.get("grade", "—")), str(score_result.get("grade", "—")),
        )
        lines.append(f"총점: {score_result['total_score']}점"
                     f" (관찰 안내: {grade})")
    weak = score_result.get("weakest") or []
    if weak:
        lines.append(f"가장 낮은 축: {', '.join(weak)}")
    lines.append("")
    lines.append("축별 점수와 측정값 (이 숫자만 인용 가능):")
    for axis, v in (score_result.get("axes") or {}).items():
        from src.agents.analysis.scoring.measurement_context import measured_axis_score
        score = measured_axis_score(v)
        if score is None:
            lines.append(f"- {axis}: 측정 불가 (0점이 아니며 수치 해석을 하지 않음)")
            continue
        lines.append(f"- {axis}: {score}점")
        feats = (v.get("features") if isinstance(v, dict) else None) or {}
        for f, d in feats.items():
            if isinstance(d, dict):
                lines.append(f"    · {f}: 측정 {d.get('value')} / 정상군 평균 {d.get('hc_mean')}")
            else:
                lines.append(f"    · {f}: {d}")
    return "\n".join(lines)


def _build_prompt(score_result: dict, ev_by_axis: dict[str, list[Evidence]]) -> str:
    axes = list((score_result.get("axes") or {}).keys())
    return (
        f"[루브릭]\n{_rubric_block(axes)}\n\n"
        f"[점수]\n{_scores_block(score_result)}\n\n"
        f"[근거] — 이 목록의 ID로만 인용하세요:\n{format_for_prompt(ev_by_axis)}\n"
        f"위 결과를 보호자용 JSON으로 해석하세요. 점수는 100점 만점, 높을수록 정상군에 가깝습니다."
    )


def _parse_json(text: str) -> dict:
    from src.common.json_contract import bounded_container
    value = bounded_container(text)
    if not isinstance(value, dict):
        raise ValueError("Object root required")
    return value


def _mock_report(score_result: dict, ev_by_axis: dict[str, list[Evidence]]) -> dict:
    """LLM_MOCK=1 — 파이프라인 검증용. 근거 ID를 실제로 달아 검증기까지 통과시킨다."""
    axes = score_result.get("axes") or {}
    comments = {}
    for axis, v in axes.items():
        score = v.get("score") if isinstance(v, dict) else v
        ids = [e.id for e in ev_by_axis.get(axis, [])][:1]
        cid = f" ({ids[0]})" if ids else ""
        comments[axis] = f"{axis} 축은 {score}점으로 관찰되었습니다{cid}."
    return {
        "summary": f"전반 점수는 {score_result.get('total_score','—')}점으로 관찰되었습니다.",
        "axis_comments": comments,
        "caveats": "녹음 환경과 그날의 컨디션이 결과에 영향을 줄 수 있습니다.",
        "recommendation": "결과가 걱정되시면 전문의와 상담해 보시기를 권합니다.",
    }


def _factual_report(score_result: dict) -> dict:
    """Copy finite computed scores only; never promote this fallback to LLM-verified."""
    comments = {}
    for axis, value in (score_result.get('axes') or {}).items():
        score = value.get('score') if isinstance(value, dict) else value
        if isinstance(value, dict) and value.get('available') is False:
            continue
        if type(score) in (int, float) and math.isfinite(score):
            comments[axis] = f"{axis} 축에서 계산된 점수는 {score:g}점입니다."
    total = score_result.get('total_score')
    valid_total = type(total) in (int, float) and math.isfinite(total)
    return {
        'summary': (f"이번 기록에서 계산된 총점은 {total:g}점입니다." if valid_total else
                    '이번 기록에서 계산 가능한 항목의 점수만 표시합니다.' if comments else
                    '표시할 수 있는 측정값이 없어 점수를 제공하지 않습니다.'),
        'axis_comments': comments,
        'caveats': '자동 해석의 검증을 완료하지 못해 계산된 점수만 제공합니다. 건강 상태나 시간에 따른 변화를 판정한 결과가 아닙니다.',
        'recommendation': '실제 녹음과 응답을 함께 확인해 주세요.',
    }


def interpret_scores(score_result: dict, k: int = 3,
                     verify: bool = True, max_retries: int = 2) -> dict:
    """점수 → 근거 검색 → 해석 생성 → 검증. 실패 시 지적사항 피드백하며 재생성.

    반환: {'report':..., 'evidence': {축: [id]}, 'verify':..., 'attempts': n}
    """
    try:
        ev_by_axis = retrieve_for_scores(score_result, k=k)
    except Exception as exc:
        return {'report': _factual_report(score_result), 'evidence': {}, 'attempts': 0,
                'mode': 'factual', 'verify': {'pass': False, 'issues': ['근거 검색 실패: ' + type(exc).__name__]}}
    user = _build_prompt(score_result, ev_by_axis)

    last_v: dict = {}
    report: dict = {}
    for attempt in range(1, max_retries + 2):
        if os.environ.get("LLM_MOCK") == "1":
            report = _mock_report(score_result, ev_by_axis)
        else:
            from src.common.llm import chat
            fb = ""
            if last_v.get("issues"):
                fb = ("\n\n[이전 시도의 문제 — 반드시 수정하세요]\n"
                      + "\n".join(f"- {i}" for i in last_v["issues"]))
            # timeout·retries를 명시한다. chat()의 기본 retries=3과 긴 timeout이
            # 곱해지면 한 호출에 수 분이 걸려 전체가 멈춘다(실제 10분 초과 발생).
            try:
                report = _parse_json(chat("solar", INTERPRET_SYSTEM, user + fb,
                                          temperature=0.0, timeout=40, retries=1))
                from src.agents.analysis.scoring.interpretation_schema import shape_issues
                if shape_issues(report):
                    raise ValueError('Invalid interpretation fields')
                if report.get('error') or report.get('_error'):
                    raise ValueError('Incomplete generator response')
            except Exception as exc:
                last_v = {'pass': False, 'issues': ['해석 생성 실패: ' + type(exc).__name__]}
                break

        if not verify:
            return {"report": report, "evidence": {a: [e.id for e in v] for a, v in ev_by_axis.items()},
                    "verify": None, "attempts": attempt, "mode": "unverified"}

        try:
            last_v = verify_report(report, score_result, ev_by_axis,
                                  use_llm=os.environ.get("LLM_MOCK") != "1")
        except Exception as exc:
            last_v = {'pass': False, 'issues': ['해석 검증 실패: ' + type(exc).__name__]}
            break
        if last_v["pass"]:
            break

    accepted = bool(last_v.get('pass'))
    return {
        "report": report if accepted else _factual_report(score_result),
        "evidence": {a: [e.id for e in v] for a, v in ev_by_axis.items()},
        "verify": last_v,
        "attempts": attempt,
        "mode": "generated_verified" if accepted else "factual",
    }


if __name__ == "__main__":
    score = {
        "total_score": 66.5, "grade": "관찰 필요",
        "weakest": ["침묵 시간"],
        "axes": {
            "침묵 시간": {"score": 62.0,
                       "features": {"ac_pause_ratio": {"value": 0.51, "hc_mean": 0.41}}},
            "버벅임": {"score": 71.0,
                    "features": {"lg_filler_rate": {"value": 0.08, "hc_mean": 0.05}}},
            "발음 정확도": {"score": 84.0,
                       "features": {"ac_hnr": {"value": 12.9, "hc_mean": 12.1}}},
        },
    }
    out = interpret_scores(score)
    print(json.dumps(out["report"], ensure_ascii=False, indent=2))
    print("\n검색된 근거:", json.dumps(out["evidence"], ensure_ascii=False))
    v = out["verify"]
    print(f"검증: {'통과' if v and v['pass'] else '실패'} (시도 {out['attempts']}회)")
    if v and v["issues"]:
        for i in v["issues"]:
            print(f"  · {i}")
