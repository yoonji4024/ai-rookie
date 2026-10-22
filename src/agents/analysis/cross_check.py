"""측정값과 원문을 이용한 교차검증.

왜 필요한가
  생성 결과를 주어진 사실과 다시 대조한다. 모델이 다르다는 사실만으로
  검증의 정확성이나 독립성을 보장하지 않는다.
    - 측정값-리포트 판정: Solar (E06 비교·제품 한도 검증)
    - 장면 매칭 판정: EXAONE 일반 모드 (정확성은 추가 검증 필요)

검증 항목
  1. 리포트 근거성 — 리포트 주장이 실제 점수·측정값과 맞는가
  2. 진단 단정 — 진단처럼 읽히는 표현이 있는가
  3. 장면 매칭 — 회상 발화와 매칭된 장면이 실제로 대응하는가
"""
from __future__ import annotations

import json

from src.common.llm import LLMError, chat_json

REPORT_SYSTEM = """당신은 다른 AI가 작성한 '발화 분석 리포트'를 검토하는 독립 검증자입니다.

주어진 것: 실제 측정 점수와, 그것을 설명한 리포트 문장.
할 일: 리포트가 측정값을 왜곡하거나 과장하지 않았는지 판정.

확인 항목:
1. grounded — 리포트의 주장이 주어진 점수·측정값과 일치하는가
2. no_diagnosis — 진단명을 말하거나 단정하지 않았는가 (치매/경도인지장애/환자/진단 등)
3. no_invention — 주어지지 않은 수치나 사실을 만들지 않았는가

반드시 이 JSON만 출력 (한 줄, 문자열 안에 큰따옴표 금지):
{"grounded": true, "no_diagnosis": true, "no_invention": true,
 "issues": ["문제가 있으면 구체적으로"], "verdict": "pass" 또는 "fail"}"""

MATCH_SYSTEM = """당신은 다른 AI가 수행한 '회상 발화 → 영상 장면 매칭'을 검토하는 독립 검증자입니다.

주어진 것: 어르신의 회상 발화, 영상 장면 목록, 그리고 매칭 결과.
할 일: 각 매칭이 타당한지 판정. **틀린 매칭은 오판을 낳으므로 엄격하게** 보세요.

특히 주의:
- 근거가 약한데 매칭한 것 (어르신이 말하지 않은 장면을 매칭)
- 어르신이 분명히 말했는데 누락된 장면

반드시 이 JSON만 출력 (한 줄, 문자열 안에 큰따옴표 금지):
{"wrong_matches": [{"scene_id": "...", "reason": "..."}],
 "missed_scenes": [{"scene_id": "...", "reason": "..."}],
 "verdict": "pass" 또는 "fail"}"""


def _fallback(err: str) -> dict:
    return {"verdict": "unknown", "error": err, "issues": []}


def check_report(report: dict, score_result: dict) -> dict:
    """점수와 리포트의 일치를 Solar로 검증."""
    from src.agents.analysis.scoring.report_contract import unsupported_reassurance_spans, measurement_claim_issues

    parts = []
    for value in report.values():
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, (list, dict)):
            parts.extend(v for v in (value.values() if isinstance(value, dict) else value)
                         if isinstance(v, str))
    reassurance = unsupported_reassurance_spans("\n".join(parts))
    issues = measurement_claim_issues(report, score_result)
    if reassurance:
        issues.append(f"측정값만으로 상담·진료·검사 불필요를 단정함: {reassurance}")
    if issues:
        return {"verdict": "fail", "grounded": False, "no_invention": False,
                "issues": issues,
                "source": "rule", "llm_called": False}
    from src.agents.analysis.scoring.measurement_context import report_measurement_facts
    facts = report_measurement_facts(score_result)
    text = {k: report.get(k) for k in ("summary", "axis_comments", "recommendation")}
    try:
        result = chat_json(
            "solar", REPORT_SYSTEM,
            f"[실제 측정값]\n{json.dumps(facts, ensure_ascii=False)}\n\n"
            f"[검토할 리포트]\n{json.dumps(text, ensure_ascii=False)}\n\n판정하세요.",
            temperature=0.0,
        )
        from src.agents.analysis.cross_check_contract import valid_report_check
        return result if valid_report_check(result) else _fallback("invalid_report_check_schema")
    except LLMError as e:
        return _fallback(str(e)[:200])


def check_matching(response_text: str, matching: dict, event_graph) -> dict:
    """장면 매칭을 EXAONE이 검증."""
    scenes = [
        {"scene_id": n.scene_id, "summary": n.summary[:100], "keywords": n.keywords[:6]}
        for n in sorted(event_graph.nodes, key=lambda x: x.order)
    ]
    try:
        result = chat_json(
            "exaone", MATCH_SYSTEM,
            f"[어르신 회상 발화]\n{response_text}\n\n"
            f"[영상 장면 목록]\n{json.dumps(scenes, ensure_ascii=False)}\n\n"
            f"[매칭 결과]\n{json.dumps(matching.get('matches', []), ensure_ascii=False)}\n\n"
            "매칭이 타당한지 판정하세요.",
            temperature=0.0,
            thinking=False,
        )
        from src.agents.analysis.cross_check_contract import valid_matching_check
        return result if valid_matching_check(result, {s["scene_id"] for s in scenes}) else _fallback("invalid_matching_check_schema")
    except LLMError as e:
        return _fallback(str(e)[:200])


def summarize(checks: dict[str, dict]) -> dict:
    """필수항목과 판정이 일치하는 검증 결과만 전체 통과로 집계."""
    from src.agents.analysis.cross_check_contract import aggregate_checks
    return aggregate_checks(checks)


if __name__ == "__main__":
    import numpy as np

    from src.agents.analysis.scoring.report_solar import generate_speech_report_verified
    from src.agents.analysis.scoring.score import ScoringModel

    d = np.load("data/kang_features.npz", allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]
    model = ScoringModel.fit(X, y, names)
    idx = int(np.argmin(model.total_scores(X)))
    sr = model.score_one(X[idx])

    print(f"대상: 총점 {sr['total_score']}점 ({sr['grade']})")
    print("Solar로 리포트 생성 → EXAONE으로 교차검증\n")

    rep = generate_speech_report_verified(sr)
    res = check_report(rep, sr)
    print(f"  판정: {res.get('verdict')}")
    for k in ("grounded", "no_diagnosis", "no_invention"):
        if k in res:
            print(f"    {k}: {res[k]}")
    if res.get("issues"):
        print(f"    지적: {res['issues']}")
    if res.get("error"):
        print(f"    ⚠️ {res['error']}")
