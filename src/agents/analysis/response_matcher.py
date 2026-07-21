"""회상 응답 매칭 — 자유 발화 → scene_id 순서.

어르신은 "코로나 얘기 먼저 나왔고, 그다음에 올림픽..."처럼 말한다.
이걸 이벤트 그래프의 scene_id 순서로 바꿔야 score_recall_order로 채점할 수 있다.

2단계 매칭
  1. **키워드 규칙** — 장면 키워드가 응답에 직접 등장하면 확정(빠르고 근거 명확)
  2. **Solar 보정** — 규칙으로 못 잡은 조각만 LLM이 판정

철칙
  - 없는 장면을 만들어내지 않는다(intrusion은 intrusion대로 남겨야 채점이 성립).
  - 매칭마다 **근거(evidence)** 를 남긴다.
  - 확신 없으면 매칭하지 않는다(억지 매칭이 오히려 채점을 망침).
"""
from __future__ import annotations

import json
import re

from src.common.llm import LLMError, chat_json

MATCH_SYSTEM = """당신은 어르신의 회상 발화를 영상 장면과 매칭하는 도우미입니다.

주어진 것: 장면 목록(요약·키워드)과 어르신이 말한 회상 내용.
할 일: 어르신이 **말한 순서대로** 어떤 장면을 가리키는지 찾으세요.

규칙:
1. 장면 목록에 있는 scene_id만 쓰세요. 새로 만들지 마세요.
2. 어느 장면인지 확실하지 않으면 그 부분은 빼세요. 억지로 맞추지 마세요.
3. 목록에 없는 내용을 말했다면 matches에 넣지 말고 unmatched에 원문을 넣으세요.
4. 각 매칭마다 근거가 된 어르신의 표현을 evidence에 그대로 적으세요.

반드시 이 JSON만 출력:
{"matches": [{"scene_id": "...", "evidence": "어르신 발화 중 근거 부분", "confidence": 0.0~1.0}],
 "unmatched": ["매칭 안 된 발화 조각"]}"""


def _scene_brief(nodes) -> list[dict]:
    return [
        {"scene_id": n.scene_id, "summary": n.summary[:120], "keywords": n.keywords[:8]}
        for n in sorted(nodes, key=lambda x: x.order)
    ]


def _unique_keywords(nodes) -> dict[str, set[str]]:
    """장면별 **고유** 키워드 (다른 장면과 겹치는 것은 제외).

    ⚠️ 중요: 뉴스처럼 여러 장면이 '미국' 같은 공통 키워드를 가지면, 한 번의 언급이
       여러 장면에 매칭돼 **실제 누락(기억 못 함)을 정상 회상으로 오판**한다.
       모호한 키워드는 규칙 매칭에서 빼고, 필요하면 LLM 판정에 맡긴다.
    """
    counts: dict[str, int] = {}
    for n in nodes:
        for kw in {k.strip() for k in n.keywords if len(k.strip()) >= 2}:
            counts[kw] = counts.get(kw, 0) + 1
    return {
        n.scene_id: {k.strip() for k in n.keywords
                     if len(k.strip()) >= 2 and counts.get(k.strip(), 0) == 1}
        for n in nodes
    }


def keyword_match(response_text: str, nodes) -> list[dict]:
    """키워드 규칙 매칭 — 응답에 등장한 위치(순서) 기준. 고유 키워드만 사용."""
    uniq = _unique_keywords(nodes)
    hits = []
    for n in nodes:
        best_pos, best_kw = None, None
        for kw in uniq.get(n.scene_id, set()):
            p = response_text.find(kw)
            if p >= 0 and (best_pos is None or p < best_pos):
                best_pos, best_kw = p, kw
        if best_pos is not None:
            hits.append({
                "scene_id": n.scene_id, "pos": best_pos,
                "evidence": f"'{best_kw}' 언급", "confidence": 0.95, "by": "keyword",
            })
    hits.sort(key=lambda h: h["pos"])
    return hits


def match_response(
    response_text: str,
    event_graph,
    use_llm: bool = True,
    min_confidence: float = 0.7,
) -> dict:
    # min_confidence 0.5→0.7: LLM이 흐릿한 언급까지 매칭하면 **실제 누락이 정상 회상으로
    # 오판**된다(키워드 중복 문제와 동일한 실패 양상). 확신 높은 것만 채택한다.
    """자유 발화 → {'scene_order', 'matches', 'unmatched'}.

    scene_order는 score_recall_order()의 response_events 인자로 바로 넣을 수 있다.
    """
    nodes = sorted(event_graph.nodes, key=lambda n: n.order)
    valid_ids = {n.scene_id for n in nodes}

    # 1) 키워드 규칙
    kw_hits = keyword_match(response_text, nodes)
    matched_ids = {h["scene_id"] for h in kw_hits}

    matches = list(kw_hits)
    unmatched: list[str] = []

    # 2) 규칙이 전부 못 잡았을 때만 LLM 보정 (호출 절약 + 근거 우선)
    need_llm = use_llm and len(matched_ids) < len(nodes)
    if need_llm:
        try:
            out = chat_json(
                "solar", MATCH_SYSTEM,
                "[장면 목록]\n"
                + json.dumps(_scene_brief(nodes), ensure_ascii=False, indent=1)
                + f"\n\n[어르신 회상]\n{response_text}\n\n말한 순서대로 매칭하세요.",
                temperature=0.0,
            )
            for i, m in enumerate(out.get("matches", [])):
                sid = m.get("scene_id")
                conf = float(m.get("confidence", 0))
                if sid in valid_ids and sid not in matched_ids and conf >= min_confidence:
                    matches.append({
                        "scene_id": sid, "pos": 10_000 + i,   # 규칙 매칭 뒤에 배치
                        "evidence": m.get("evidence", ""),
                        "confidence": conf, "by": "llm",
                    })
                    matched_ids.add(sid)
            unmatched = [u for u in out.get("unmatched", []) if isinstance(u, str)]
        except LLMError as e:
            unmatched.append(f"(LLM 매칭 실패: {e})")

    matches.sort(key=lambda m: m["pos"])
    return {
        "scene_order": [m["scene_id"] for m in matches],
        "matches": [{k: v for k, v in m.items() if k != "pos"} for m in matches],
        "unmatched": unmatched,
    }


if __name__ == "__main__":
    from src.agents.analysis.recall import score_recall_order
    from src.event_graph.sample_loader import load_all

    g = next(x for x in load_all() if len(x.nodes) >= 4)
    nodes = sorted(g.nodes, key=lambda n: n.order)
    print(f"콘텐츠 {g.content_id} 정답 순서: {g.true_order}")
    for n in nodes:
        print(f"  {n.scene_id}: {n.keywords[:4]}")

    # 실제 어르신이 말할 법한 자유 발화 (키워드 기반이라 LLM 없이도 동작)
    cases = {
        "정확한 순서": "처음에 코로나 확진자 얘기가 나왔고, 그다음 서울시 탄소 중립, 그리고 베이징 올림픽 얘기, 마지막에 마스크 거부해서 비행기 회항한 거요.",
        "순서 뒤바뀜": "베이징 올림픽 얘기가 먼저 나오고, 코로나 확진자 얘기가 나왔어요.",
        "일부만 기억": "코로나 얘기랑 마스크 때문에 회항한 거 봤어요.",
    }
    for name, text in cases.items():
        r = match_response(text, g, use_llm=False)
        sc = score_recall_order(r["scene_order"], g)
        print(f"\n[{name}]")
        print(f"  발화: {text[:50]}...")
        print(f"  매칭: {r['scene_order']}")
        print(f"  채점: tau={sc['kendall_tau']:+.2f} 커버리지={sc['coverage']:.0%} 오류={sc['errors']}")
