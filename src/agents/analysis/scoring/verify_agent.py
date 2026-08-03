"""검증 에이전트 — 채점자·해석자와 분리된 독립 판정자.

역할 분리
    규칙      점수를 매긴다        (재현 가능)
    Solar     점수를 해석한다      (루브릭 + 검색된 근거)
    검증(여기) 해석을 판정한다      (원문 대조)

핵심 원칙: **검증자는 자기 지식으로 판단하지 않는다.**
    "이 인용이 사실인가?"를 모델 기억에 물으면 검증자도 환각한다.
    대신 검색된 원문을 함께 주고 "이 주장이 이 원문에서 나오는가"만 묻는다.
    → 사실 확인이 아니라 원문 대조(entailment). 검증자가 아는 게 없어도 판정 가능.

3중 검사 (+ 점수 불변)
    1) 숫자 근거성   — 리포트의 수치가 실제 점수/측정값에 있는 값인가       [규칙]
    2) 점수 불변     — 해석 과정에서 점수가 바뀌지 않았는가                 [규칙]
    3) 인용 유효성   — 허용된 근거 ID만 인용했는가                          [규칙]
    4) 원문 대조     — 각 주장이 인용한 근거 원문에서 도출되는가            [LLM · EXAONE]
    5) 진단 표현     — 진단을 단정하는 표현이 없는가                        [규칙 + LLM]

규칙 검사를 먼저 돌려 확정적인 것을 걸러내고, LLM은 판단이 필요한 것만 본다.
(규칙이 잡을 수 있는 걸 LLM에 맡기지 않는다 — 비용·불확실성 모두 손해)

사용:
    from src.agents.analysis.scoring.verify_agent import verify_report
    result = verify_report(report, score_result, evidence_by_axis)
"""
from __future__ import annotations

import json
import os
import re

from src.rag.corpus import Evidence

# 진단 단정 표현 — 선별 도구가 써서는 안 되는 말
DIAGNOSIS_PATTERNS = [
    r"치매(입니다|이다|로 진단|가 확실|임이|에 해당)",
    r"알츠하이머(입니다|이다|로 진단|가 확실)",
    r"MCI(입니다|이다|로 진단)",
    r"경도인지장애(입니다|이다|로 진단|가 확실)",
    r"진단(합니다|됩니다|결과)",
    r"확진",
    r"(치매|알츠하이머)(에 걸렸|가 있습니다|가 있음)",
    r"정상(입니다|이며 문제없)",      # 반대 방향 단정도 금지
    r"이상 없(습니다|음)",
]

VERIFY_SYSTEM = """당신은 인지 선별 리포트의 **검증자**입니다. 리포트를 새로 쓰지 않습니다.

당신에게 주어지는 것:
  (A) 검증할 리포트 문장들
  (B) 그 문장이 인용한 근거 원문

당신의 임무는 **오직 원문 대조**입니다. 당신이 알고 있는 지식은 쓰지 마세요.
각 문장에 대해, 그 문장의 주장이 주어진 근거 원문에서 도출되는지만 판정하세요.
원문에 없는 내용이면, 그것이 사실이더라도 'unsupported'입니다.

판정 기준:
  supported   — 원문이 그 주장을 뒷받침한다
  unsupported — 원문에서 도출되지 않는다 (원문에 없는 수치·인과·단정 포함)
  overreach   — 원문보다 강하게 말했다 (가능성을 확정으로, 상관을 인과로)

또한 진단을 단정하는 표현이 있으면 지적하세요. 이 리포트는 선별 참고자료이며
진단을 내려서는 안 됩니다.

반드시 아래 JSON만 출력하세요:
{"judgements": [{"sentence": "...", "verdict": "supported|unsupported|overreach", "reason": "..."}],
 "diagnosis_language": ["문제 표현", ...],
 "pass": true|false}"""


# ─────────────────────────────────────────────────────────────
# 규칙 검사 — 확정적인 것들
# ─────────────────────────────────────────────────────────────
def _numbers_in(text: str) -> set[float]:
    out = set()
    for m in re.findall(r"\d+(?:\.\d+)?", text):
        try:
            out.add(float(m))
        except ValueError:
            pass
    return out


def _allowed_numbers(score_result: dict, evidences: list[Evidence]) -> set[float]:
    """인용 가능한 수치 = 점수 + 측정값 + 근거 원문에 등장하는 수치."""
    ok: set[float] = set()
    axes = score_result.get("axes") or score_result.get("axis_scores") or {}
    for axis, v in axes.items():
        if isinstance(v, dict):
            for key in ("score", "점수"):
                if key in v:
                    ok.add(float(v[key]))
            for feat, fv in (v.get("features") or v.get("측정값") or {}).items():
                try:
                    ok.add(round(float(fv), 3))
                except (TypeError, ValueError):
                    pass
        else:
            try:
                ok.add(float(v))
            except (TypeError, ValueError):
                pass
    for key in ("total", "total_score", "총점", "overall"):
        if key in score_result:
            try:
                ok.add(float(score_result[key]))
            except (TypeError, ValueError):
                pass
    for e in evidences:
        ok |= _numbers_in(e.text)
    return ok


def _report_text(report: dict) -> str:
    """리포트 dict → 검사 대상 텍스트 전체."""
    parts = []
    for v in report.values():
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, list):
            parts += [x for x in v if isinstance(x, str)]
        elif isinstance(v, dict):
            parts += [x for x in v.values() if isinstance(x, str)]
    return "\n".join(parts)


def _sentences(text: str) -> list[str]:
    s = re.split(r"(?<=[.!?。])\s+|\n+", text)
    return [x.strip() for x in s if len(x.strip()) >= 10]


def rule_checks(report: dict, score_result: dict,
                evidences: list[Evidence], allowed_ids: set[str]) -> dict:
    """규칙으로 확정 판정 가능한 것들. LLM 호출 전에 먼저 돌린다."""
    text = _report_text(report)
    issues: list[str] = []

    # 1) 숫자 근거성 — 허용 목록에 없는 수치는 지어낸 것
    allowed = _allowed_numbers(score_result, evidences)
    used = _numbers_in(text)
    # 연도·나이 등 오탐을 줄이려 소수점/점수대 수치 위주로 검사
    bad = {n for n in used - allowed if (n != int(n)) or (0 < n <= 100)}
    # 허용값과 반올림 오차 내면 통과
    bad = {n for n in bad if not any(abs(n - a) < 0.051 for a in allowed)}
    if bad:
        issues.append(f"근거 없는 수치: {sorted(bad)}")

    # 2) 점수 불변 — 해석 과정에서 점수를 다시 매기지 않았는가
    axes = score_result.get("axes") or score_result.get("axis_scores") or {}
    changed = []
    for axis, v in axes.items():
        src = v.get("score") if isinstance(v, dict) else v
        if src is None:
            continue
        rep = report.get("axes", {}).get(axis) if isinstance(report.get("axes"), dict) else None
        rep_score = rep.get("score") if isinstance(rep, dict) else None
        if rep_score is not None and abs(float(rep_score) - float(src)) > 0.01:
            changed.append(f"{axis}: {src}→{rep_score}")
    if changed:
        issues.append(f"점수가 변경됨(해석자는 점수를 바꿀 수 없음): {changed}")

    # 3) 인용 유효성 — 허용 ID 외 인용 = 환각
    cited = set(re.findall(r"\b((?:exp|bench|clin)-[a-z0-9-]+)\b", text))
    unknown = cited - allowed_ids
    if unknown:
        issues.append(f"허용되지 않은 근거 인용: {sorted(unknown)}")

    # 5a) 진단 표현 — 규칙으로 잡히는 명백한 것
    diag = [p for p in DIAGNOSIS_PATTERNS if re.search(p, text)]
    if diag:
        found = [re.search(p, text).group(0) for p in diag]
        issues.append(f"진단 단정 표현: {found}")

    return {"pass": not issues, "issues": issues, "cited": sorted(cited)}


# ─────────────────────────────────────────────────────────────
# LLM 검사 — 원문 대조 (EXAONE)
# ─────────────────────────────────────────────────────────────
def _build_verify_prompt(report: dict, evidences: list[Evidence]) -> str:
    sents = _sentences(_report_text(report))
    ev_block = "\n".join(f"({e.id}) {e.text}" for e in evidences)
    sent_block = "\n".join(f"{i}. {s}" for i, s in enumerate(sents, 1))
    return (f"(B) 근거 원문 — 이것만이 판단 기준입니다:\n{ev_block}\n\n"
            f"(A) 검증할 리포트 문장:\n{sent_block}\n\n"
            f"각 문장을 근거 원문과 대조해 판정하고 JSON으로만 답하세요.")


def _parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}


def llm_entailment_check(report: dict, evidences: list[Evidence],
                         model: str = "exaone") -> dict:
    """검색된 원문만 주고 대조 판정. 검증자의 자체 지식 사용을 프롬프트에서 차단."""
    if os.environ.get("LLM_MOCK") == "1":
        return {"judgements": [], "diagnosis_language": [], "pass": True,
                "note": "mock 모드 — LLM 대조 생략"}
    try:
        from src.common.llm import chat
        raw = chat(model, VERIFY_SYSTEM, _build_verify_prompt(report, evidences),
                   temperature=0.0)
        out = _parse_json(raw)
        if not out:
            return {"pass": False, "error": "검증자 JSON 파싱 실패", "raw": raw[:300]}
        return out
    except Exception as e:
        return {"pass": False, "error": f"검증자 호출 실패: {e}"}


# ─────────────────────────────────────────────────────────────
# 통합
# ─────────────────────────────────────────────────────────────
def verify_report(report: dict, score_result: dict,
                  evidence_by_axis: dict[str, list[Evidence]],
                  use_llm: bool = True) -> dict:
    """3중 검증. 규칙 먼저 → 통과하면 LLM 원문 대조.

    반환: {'pass': bool, 'rule': {...}, 'llm': {...}, 'issues': [...]}
    """
    evidences = [e for evs in evidence_by_axis.values() for e in evs]
    seen, uniq = set(), []
    for e in evidences:
        if e.id not in seen:
            seen.add(e.id)
            uniq.append(e)
    allowed = {e.id for e in uniq}

    rule = rule_checks(report, score_result, uniq, allowed)
    issues = list(rule["issues"])

    llm: dict = {}
    if use_llm:
        llm = llm_entailment_check(report, uniq)
        for j in llm.get("judgements", []):
            if j.get("verdict") in ("unsupported", "overreach"):
                issues.append(f"[{j['verdict']}] {j.get('sentence','')[:60]}… — {j.get('reason','')}")
        for d in llm.get("diagnosis_language", []):
            issues.append(f"[진단표현] {d}")
        if llm.get("error"):
            issues.append(llm["error"])

    return {"pass": not issues, "rule": rule, "llm": llm, "issues": issues}


if __name__ == "__main__":
    # 더미 검증 — 규칙 검사가 실제로 잡는지 확인
    from src.rag.retriever import retrieve_for_scores

    score = {"axes": {"침묵 시간": {"score": 62.0, "features": {"ac_pause_ratio": 0.51}},
                      "버벅임": {"score": 71.0, "features": {"lg_filler_rate": 0.08}}},
             "total": 66.5}
    ev = retrieve_for_scores(score)

    good = {"summary": "침묵 시간 축은 62점으로, 휴지 비율 0.51이 관찰되었습니다. "
                       "내용어 앞 휴지는 단어 찾기 어려움과 관련될 수 있습니다(clin-pause-wordfinding). "
                       "다만 휴지는 생각을 정리하는 정상적 과정이기도 합니다."}
    bad = {"summary": "침묵 시간 62점으로 치매입니다. 정확도 97.3%로 확진되었습니다"
                      "(clin-made-up-source). 버벅임은 85점입니다.",
           "axes": {"버벅임": {"score": 85.0}}}

    for name, rep in (("정상 리포트", good), ("문제 리포트", bad)):
        r = verify_report(rep, score, ev, use_llm=False)
        print(f"\n=== {name} — {'통과' if r['pass'] else '실패'}")
        for i in r["issues"]:
            print(f"  · {i}")
