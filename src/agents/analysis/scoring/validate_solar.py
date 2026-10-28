"""솔라 출력 검증 — 근거성(groundedness) + 재현성.

검증 항목
  1. **스키마 준수**: 필수 키(summary/axis_comments/recommendation) 존재, 축 이름 일치
  2. **근거성**: 출력에 등장하는 수치가 입력에 실제로 있는 값인지 (없는 숫자 = 환각)
  3. **금지어**: 진단 단정 표현("치매", "경도인지장애", "환자", "진단됩니다" 등) 미사용
  4. **재현성**: 같은 입력 N회 호출 시 스키마·인용 점수 일관성

사용:
    python -m src.agents.analysis.scoring.validate_solar          # 1명 샘플로 N회 검증
    python -m src.agents.analysis.scoring.validate_solar 3        # 반복 횟수 지정
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np

from src.agents.analysis.scoring.report_solar import generate_speech_report_verified
from src.agents.analysis.scoring.score import ScoringModel

CACHE = Path("data/kang_features.npz")

BANNED = ["치매", "경도인지장애", "MCI", "알츠하이머", "환자", "진단됩니다", "진단된", "질환입니다"]
REQUIRED_KEYS = {"summary", "axis_comments", "recommendation"}


def _numbers_in(text: str) -> set[float]:
    return {float(n) for n in re.findall(r"\d+(?:\.\d+)?", text)}


def _allowed_numbers(score_result: dict) -> set[float]:
    """입력에 실제로 존재하는 숫자들 (점수·측정값·정상군 평균)."""
    ok = {float(score_result["total_score"]), 100.0}
    for v in score_result["axes"].values():
        ok.add(float(v["score"]))
        for d in v["features"].values():
            ok.add(float(d["value"]))
            ok.add(float(d["hc_mean"]))
            ok.add(abs(float(d["z"])))
    return ok


def check_report(report: dict, score_result: dict) -> dict:
    """리포트 1건 검증 → 결과 딕셔너리."""
    issues: list[str] = []

    if not isinstance(report, dict):
        return {"ok": False, "issues": ["리포트는 JSON 객체여야 합니다."]}
    if "error" in report:
        return {"ok": False, "issues": [report["error"]]}
    if report.get("_error"):
        return {"ok": False, "issues": [report["_error"]]}

    # 1) 스키마
    from src.agents.analysis.scoring.speech_report_schema import shape_issues
    malformed = shape_issues(report)
    if malformed:
        return {"ok": False, "issues": malformed}
    from src.agents.analysis.scoring.legacy_speech_input import input_issues
    unavailable = input_issues(score_result)
    if unavailable:
        return {"ok": False, "issues": unavailable}
    axes_in = set(score_result["axes"])
    axes_out = set(report.get("axis_comments", {}))
    if axes_out - axes_in:
        issues.append(f"입력에 없는 축 생성: {axes_out - axes_in}")

    text = " ".join([
        str(report.get("summary", "")),
        " ".join(str(v) for v in report.get("axis_comments", {}).values()),
        str(report.get("recommendation", "")),
    ])

    # 2) 근거성 — 출력 숫자가 입력에 있는지 (점수·측정값 허용, 오차 허용)
    allowed = _allowed_numbers(score_result)
    hallucinated = [
        n for n in _numbers_in(text)
        if not any(abs(n - a) < 0.51 for a in allowed)
    ]
    if hallucinated:
        issues.append(f"입력에 없는 수치 인용: {sorted(hallucinated)[:5]}")

    # 3) 금지어
    used = [w for w in BANNED if w in text]
    if used:
        issues.append(f"진단 단정/금지 표현: {used}")

    # 기존 거절 결과를 보존하고, 통과 후보의 명시적인 점수 대응을 추가 확인한다.
    if not issues:
        from src.agents.analysis.scoring.report_contract import (
            measurement_claim_issues, unsupported_reassurance_spans,
        )
        visible = {key: report[key] for key in REQUIRED_KEYS}
        # 입력 게이트를 통과한 유한 수치 문자열도 기존 계약대로 허용한다.
        # 원입력과 누락값은 변경하지 않고 비교용 뷰만 만든다.
        numeric_view = {
            "total_score": float(score_result["total_score"]),
            "axes": {axis: {**value, "score": float(value["score"])}
                     for axis, value in score_result["axes"].items()},
        }
        issues.extend(measurement_claim_issues(visible, numeric_view))
        if unsupported_reassurance_spans(text):
            issues.append("제공된 측정값만으로 상담·진료·검사 불필요를 단정함")

    return {"ok": not issues, "issues": issues, "text_len": len(text)}


def main():
    n_runs = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    if not CACHE.exists():
        raise SystemExit("캐시 없음 — 먼저 run_kang_baseline 실행")

    d = np.load(CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]
    model = ScoringModel.fit(X, y, names)

    # 낮은 점수 화자 1명으로 테스트 (리포트가 가장 어려운 케이스)
    totals = model.total_scores(X)
    idx = int(np.argmin(totals))
    sr = model.score_one(X[idx])
    print(f"테스트 대상: index {idx} (총점 {sr['total_score']}점, {sr['grade']}), 실제 라벨={'MCI' if y[idx] else 'HC'}")
    print(f"솔라 {n_runs}회 호출 검증 시작\n")

    reports, results = [], []
    for i in range(n_runs):
        rep = generate_speech_report_verified(sr)      # 생성→검증→재시도 에이전트 루프
        res = check_report(rep, sr)
        reports.append(rep)
        results.append(res)
        status = "PASS" if res["ok"] else "FAIL"
        tries = rep.get("_attempts", 1)
        print(f"[{i+1}/{n_runs}] {status} (시도 {tries}회)"
              + ("" if res["ok"] else f" — {res['issues']}"))

    # 4) 재현성 — 인용한 점수가 매번 같은지, 스키마가 일정한지
    print("\n=== 재현성 ===")
    digests = [tuple(sorted(r.get("_input_digest", {}).get("axis_scores", {}).items()))
               for r in reports if "_input_digest" in r]
    print(f"  인용 점수 일관성: {'OK (동일)' if len(set(digests)) <= 1 else '⚠️ 불일치'}")
    schema_ok = sum(1 for r in results if r["ok"])
    print(f"  스키마·근거성 통과율: {schema_ok}/{n_runs}")
    lens = [r["text_len"] for r in results]
    print(f"  출력 길이: 평균 {np.mean(lens):.0f}자 (편차 {np.std(lens):.0f})")

    # 샘플 출력
    ok_reports = [r for r, res in zip(reports, results) if res["ok"]]
    if ok_reports:
        r = ok_reports[0]
        print("\n=== 리포트 샘플 ===")
        print(f"  [요약] {r.get('summary')}")
        for a, c in list(r.get("axis_comments", {}).items())[:2]:
            print(f"  [{a}] {c}")
        print(f"  [권고] {r.get('recommendation')}")


if __name__ == "__main__":
    main()
