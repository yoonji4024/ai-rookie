"""Sample → 파이프라인 산출물 일괄 생성 + 검증.

만드는 것
  1. data/Sample/event_graphs.json   — 이벤트 그래프(순서 회상 ground truth)
  2. data/Sample/recall_questions.json — 순서 회상 질문 (장면 요약 기반, 우리가 생성)
  3. data/Sample/query_evalset.json  — user_query 72개 (대화 AI 질문 평가 기준)

검증
  - 장면 순서가 시간순인지, 근거 span이 비지 않았는지
  - 순서 회상 채점기가 정상·오류 케이스를 구분하는지

사용:
    python3 -m src.event_graph.build_dataset
"""
from __future__ import annotations

import json
from pathlib import Path

from src.agents.analysis.recall import score_recall_order
from src.event_graph.sample_loader import load_all

OUT = Path("data/Sample")


def build_recall_questions(graphs) -> list[dict]:
    """장면 요약 기반 순서 회상 질문 생성.

    ⚠️ 질문 텍스트는 콘텐츠에 실제 있는 요약만 사용(없는 내용 생성 금지).
    """
    out = []
    for g in graphs:
        nodes = sorted(g.nodes, key=lambda n: n.order)
        if len(nodes) < 2:
            continue
        out.append({
            "content_id": g.content_id,
            "category": g.category,
            "question": "방금 보신 내용에서 어떤 장면이 먼저 나왔는지 순서대로 말씀해 주시겠어요?",
            "choices": [
                {"scene_id": n.scene_id, "summary": n.summary, "keywords": n.keywords[:5]}
                for n in nodes
            ],
            "answer_order": [n.scene_id for n in nodes],
            "cue_hints": {n.scene_id: n.keywords[:3] for n in nodes},   # 단서 제공용
        })
    return out


def build_query_evalset(graphs) -> list[dict]:
    """user_query → 대화 AI 질문 평가셋 (근거 장면·시각 포함)."""
    out = []
    for g in graphs:
        for n in sorted(g.nodes, key=lambda x: x.order):
            for q in n.queries:
                out.append({
                    "query_id": q.get("query_id"),
                    "query": q.get("query"),
                    "content_id": g.content_id,
                    "category": g.category,
                    "scene_id": n.scene_id,
                    "scene_time": [n.start, n.end],
                    "gold_summary": n.summary,
                    "gold_keywords": n.keywords,
                })
    return out


def verify(graphs) -> list[str]:
    """검증 — 문제 발견 시 메시지 목록 반환 (빈 리스트면 통과)."""
    issues = []
    for g in graphs:
        nodes = sorted(g.nodes, key=lambda n: n.order)
        # 1) 시간순 정렬 확인
        starts = [n.start for n in nodes]
        if starts != sorted(starts):
            issues.append(f"{g.content_id}: 장면이 시간순이 아님")
        # 2) 구간 겹침
        for a, b in zip(nodes, nodes[1:]):
            if a.end > b.start:
                issues.append(f"{g.content_id}: 장면 {a.scene_id}·{b.scene_id} 구간 겹침")
        # 3) 근거 span 존재
        for n in nodes:
            if not n.evidence:
                issues.append(f"{g.content_id}/{n.scene_id}: 근거 전사 없음")
            if not n.summary:
                issues.append(f"{g.content_id}/{n.scene_id}: 요약 비어있음")
        # 4) 채점기 정합 — 정답 순서는 tau=1, 역순은 tau=-1
        truth = g.true_order
        if len(truth) >= 2:
            if score_recall_order(truth, g)["kendall_tau"] != 1.0:
                issues.append(f"{g.content_id}: 정답 순서인데 tau≠1")
            if score_recall_order(list(reversed(truth)), g)["kendall_tau"] != -1.0:
                issues.append(f"{g.content_id}: 역순인데 tau≠-1")
    return issues


def main():
    graphs = load_all()
    OUT.mkdir(parents=True, exist_ok=True)

    # 1) 이벤트 그래프
    eg = [g.to_dict() for g in graphs]
    (OUT / "event_graphs.json").write_text(
        json.dumps(eg, ensure_ascii=False, indent=2), encoding="utf-8")

    # 2) 순서 회상 질문
    rq = build_recall_questions(graphs)
    (OUT / "recall_questions.json").write_text(
        json.dumps(rq, ensure_ascii=False, indent=2), encoding="utf-8")

    # 3) 질문 평가셋
    qe = build_query_evalset(graphs)
    (OUT / "query_evalset.json").write_text(
        json.dumps(qe, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=== 생성 결과 ===")
    print(f"  이벤트 그래프 : {len(eg)}개 콘텐츠, 장면 {sum(len(g['nodes']) for g in eg)}개")
    print(f"  순서 회상 질문 : {len(rq)}개")
    print(f"  질문 평가셋    : {len(qe)}개")

    print("\n=== 검증 ===")
    issues = verify(graphs)
    if issues:
        for i in issues:
            print(f"  ⚠️ {i}")
    else:
        print("  통과 — 시간순 정렬·구간 비겹침·근거 span 존재·채점기 정합 모두 정상")

    # 샘플 채점 시연
    g = max(graphs, key=lambda x: len(x.nodes))
    truth = g.true_order
    print(f"\n=== 채점 시연 ({g.content_id}, 장면 {len(truth)}개) ===")
    demo = {
        "정확히 회상": truth,
        "순서 뒤바뀜": [truth[0], truth[2], truth[1]] + truth[3:],
        "일부 누락": truth[:2],
    }
    for name, resp in demo.items():
        r = score_recall_order(resp, g)
        print(f"  {name}: tau={r['kendall_tau']:+.2f}, 커버리지 {r['coverage']:.0%}, 오류 {r['errors']}")


if __name__ == "__main__":
    main()
