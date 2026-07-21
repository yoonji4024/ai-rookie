"""순서 회상 분석 — 응답 순서 vs 이벤트 그래프.

CLAUDE.md §9 시그니처:
    score_recall_order(response_events, event_graph) -> {'kendall_tau', 'errors'}

오류 유형 (§2)
  - omission       : 정답 장면인데 응답에서 빠짐
  - reversal       : 두 장면의 상대 순서가 뒤바뀜 (역전쌍 수)
  - intrusion      : 이벤트 그래프에 없는 장면을 말함 (없는 기억 삽입)
  - cue_dependency : 단서(키워드) 제공 후에야 회상한 장면 수

설계
  - 자유 회상과 달리 **정답 순서가 객관적으로 정의**되므로 정오·오류유형 판정이 가능하다.
  - Kendall's tau: 응답에 등장한 장면들의 상대 순서 일치도 (-1~1).
  - 진단명은 내지 않는다. 근거 수치만 반환.
"""
from __future__ import annotations

from itertools import combinations


def _normalize_graph(event_graph) -> tuple[list[str], dict[str, int]]:
    """EventGraph 객체 또는 [{'scene_id','order'}] 리스트 모두 허용."""
    if hasattr(event_graph, "true_order"):
        order = event_graph.true_order
    elif isinstance(event_graph, list):
        if event_graph and isinstance(event_graph[0], dict):
            items = sorted(event_graph, key=lambda d: d.get("order", 0))
            order = [d["scene_id"] for d in items]
        else:
            order = list(event_graph)
    else:
        raise TypeError("event_graph: EventGraph 또는 list여야 함")
    return order, {sid: i for i, sid in enumerate(order)}


def kendall_tau(seq_a: list[int], seq_b: list[int]) -> float:
    """두 순위 수열의 Kendall's tau-a. 쌍이 없으면 0.0."""
    n = len(seq_a)
    if n < 2:
        return 0.0
    conc = disc = 0
    for i, j in combinations(range(n), 2):
        s = (seq_a[i] - seq_a[j]) * (seq_b[i] - seq_b[j])
        if s > 0:
            conc += 1
        elif s < 0:
            disc += 1
    total = conc + disc
    return (conc - disc) / total if total else 0.0


def score_recall_order(
    response_events: list[str],
    event_graph,
    cued_events: list[str] | None = None,
) -> dict:
    """응답 장면 순서를 이벤트 그래프와 비교해 채점.

    response_events: 어르신이 회상한 장면 id를 말한 순서대로.
    event_graph    : EventGraph 또는 [{'scene_id','order'}].
    cued_events    : 단서 제공 후에야 회상한 장면 id 목록 (cue_dependency 집계용).

    반환: {'kendall_tau', 'errors', 'coverage', 'n_correct', 'details'}
    """
    true_order, pos = _normalize_graph(event_graph)
    cued = set(cued_events or [])

    # 유효(그래프에 존재) / 침입(존재하지 않음) 분리 — 중복은 첫 등장만 순서에 사용
    valid, intrusions, seen = [], [], set()
    for e in response_events:
        if e in pos:
            if e not in seen:
                valid.append(e)
                seen.add(e)
        else:
            intrusions.append(e)

    omissions = [s for s in true_order if s not in seen]

    # Kendall's tau — 응답 등장 순서 vs 정답 순서
    resp_rank = list(range(len(valid)))
    true_rank = [pos[e] for e in valid]
    tau = kendall_tau(resp_rank, true_rank)

    # reversal — 정답 대비 역전된 쌍의 수
    reversal = sum(
        1 for i, j in combinations(range(len(valid)), 2)
        if pos[valid[i]] > pos[valid[j]]
    )

    n_true = len(true_order)
    return {
        "kendall_tau": round(tau, 3),
        "errors": {
            "omission": len(omissions),
            "reversal": reversal,
            "intrusion": len(intrusions),
            "cue_dependency": len([e for e in valid if e in cued]),
        },
        "coverage": round(len(valid) / n_true, 3) if n_true else 0.0,
        "n_correct": len(valid),
        "details": {
            "true_order": true_order,
            "response_order": valid,
            "omitted": omissions,
            "intruded": intrusions,
            "cued": [e for e in valid if e in cued],
        },
    }


if __name__ == "__main__":
    from src.event_graph.sample_loader import load_all

    g = next(x for x in load_all() if len(x.nodes) >= 4)
    truth = g.true_order
    print(f"콘텐츠 {g.content_id} 정답 순서: {truth}\n")

    cases = {
        "완벽 회상": (truth, None),
        "2·3 순서 뒤바뀜(reversal)": ([truth[0], truth[2], truth[1], truth[3]], None),
        "1개 누락(omission)": ([truth[0], truth[1], truth[3]], None),
        "없는 장면 삽입(intrusion)": (truth[:2] + ["없는장면"], None),
        "단서 후 회상(cue)": (truth, [truth[2], truth[3]]),
        "완전 역순": (list(reversed(truth)), None),
    }
    for name, (resp, cued) in cases.items():
        r = score_recall_order(resp, g, cued)
        print(f"[{name}]")
        print(f"  tau={r['kendall_tau']:+.2f} coverage={r['coverage']:.2f} 오류={r['errors']}")
