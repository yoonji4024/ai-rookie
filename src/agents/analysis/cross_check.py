"""EXAONE 교차검증 — 다른 모델로 독립 재확인 (CLAUDE.md §8).

왜 필요한가
  솔라가 만든 리포트를 솔라가 검증하면 같은 편향을 공유한다.
  **생성 모델과 검증 모델을 분리**해야 환각·왜곡을 잡을 수 있다.
    - 생성: Solar (리포트) / Solar (장면 매칭)
    - 검증: EXAONE (독립 판정)

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
    """솔라 리포트를 EXAONE이 검증."""
    facts = {
        "total_score": score_result.get("total_score"),
        "grade": score_result.get("grade"),
        "axis_scores": {a: v["score"] for a, v in score_result.get("axes", {}).items()},
    }
    text = {k: report.get(k) for k in ("summary", "axis_comments", "recommendation")}
    try:
        return chat_json(
            "exaone", REPORT_SYSTEM,
            f"[실제 측정값]\n{json.dumps(facts, ensure_ascii=False)}\n\n"
            f"[검토할 리포트]\n{json.dumps(text, ensure_ascii=False)}\n\n판정하세요.",
            temperature=0.0,
        )
    except LLMError as e:
        return _fallback(str(e)[:200])


def check_matching(response_text: str, matching: dict, event_graph) -> dict:
    """장면 매칭을 EXAONE이 검증."""
    scenes = [
        {"scene_id": n.scene_id, "summary": n.summary[:100], "keywords": n.keywords[:6]}
        for n in sorted(event_graph.nodes, key=lambda x: x.order)
    ]
    try:
        return chat_json(
            "exaone", MATCH_SYSTEM,
            f"[어르신 회상 발화]\n{response_text}\n\n"
            f"[영상 장면 목록]\n{json.dumps(scenes, ensure_ascii=False)}\n\n"
            f"[매칭 결과]\n{json.dumps(matching.get('matches', []), ensure_ascii=False)}\n\n"
            "매칭이 타당한지 판정하세요.",
            temperature=0.0,
        )
    except LLMError as e:
        return _fallback(str(e)[:200])


def summarize(checks: dict[str, dict]) -> dict:
    """여러 검증 결과 종합."""
    failed = [k for k, v in checks.items() if v.get("verdict") == "fail"]
    unknown = [k for k, v in checks.items() if v.get("verdict") == "unknown"]
    return {
        "all_pass": not failed and not unknown,
        "failed": failed,
        "unknown": unknown,
        "detail": checks,
    }


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
