"""AI-Hub 방송콘텐츠 Sample 로더 → 이벤트 그래프.

데이터 구조 (data/Sample/)
  01.원천데이터/{카테고리}/{ID}.mp4      — 영상
  02.라벨링데이터/{카테고리}/{ID}.json   — 전사 + 하이라이트

JSON
  transcript: [{speaker_id, dialog_id, start, end, form}]      — 타임스탬프 전사
  highlight : [{id, start_time, end_time, classification,
                keywords, summary, user_query[6]}]             — 장면 단위 요약·질문

이벤트 그래프 (순서 회상 ground truth)
  하이라이트 1개 = 장면 노드 1개. 시간순 정렬 → 정답 순서.
  각 노드는 요약·키워드 + **근거 transcript span**을 보존한다 (CLAUDE.md §12: 원문 근거 보존).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

DATA_ROOT = Path("data/Sample")
SRC_DIR = "01.원천데이터"
LABEL_DIR = "02.라벨링데이터"


@dataclass
class SceneNode:
    """이벤트 그래프의 장면 노드 = 하이라이트 1개."""

    scene_id: str
    order: int                  # 시간순 인덱스 (0부터) — 정답 순서
    start: float
    end: float
    summary: str
    keywords: list[str]
    evidence: list[dict] = field(default_factory=list)   # 근거 transcript span
    queries: list[dict] = field(default_factory=list)    # user_query

    @property
    def evidence_text(self) -> str:
        return " ".join(e["form"] for e in self.evidence)


@dataclass
class EventGraph:
    """콘텐츠 1개의 이벤트 그래프."""

    content_id: str
    category: str
    duration: float
    nodes: list[SceneNode]
    transcript: list[dict] = field(default_factory=list)
    video_path: str | None = None

    @property
    def true_order(self) -> list[str]:
        """정답 장면 순서 (시간순 scene_id)."""
        return [n.scene_id for n in sorted(self.nodes, key=lambda n: n.order)]

    def node(self, scene_id: str) -> SceneNode | None:
        return next((n for n in self.nodes if n.scene_id == scene_id), None)

    def to_dict(self) -> dict:
        return {
            "content_id": self.content_id,
            "category": self.category,
            "duration": self.duration,
            "true_order": self.true_order,
            "nodes": [
                {
                    "scene_id": n.scene_id,
                    "order": n.order,
                    "start": n.start,
                    "end": n.end,
                    "summary": n.summary,
                    "keywords": n.keywords,
                    "n_evidence": len(n.evidence),
                    "n_queries": len(n.queries),
                }
                for n in sorted(self.nodes, key=lambda n: n.order)
            ],
        }


def _spans_in(transcript: list[dict], start: float, end: float) -> list[dict]:
    """하이라이트 구간과 겹치는 전사 발화 (근거 span)."""
    return [t for t in transcript if t["end"] > start and t["start"] < end]


def build_event_graph(json_path: str | Path, video_path: str | Path | None = None) -> EventGraph:
    """라벨링 JSON 1개 → EventGraph."""
    json_path = Path(json_path)
    d = json.loads(json_path.read_text(encoding="utf-8"))

    transcript = d.get("transcript", [])
    highlights = sorted(d.get("highlight", []), key=lambda h: h["start_time"])

    nodes = []
    for i, h in enumerate(highlights):
        kws = [k.strip() for k in str(h.get("keywords", "")).split(",") if k.strip()]
        nodes.append(
            SceneNode(
                scene_id=h["id"],
                order=i,
                start=float(h["start_time"]),
                end=float(h["end_time"]),
                summary=h.get("summary", "").strip(),
                keywords=kws,
                evidence=_spans_in(transcript, h["start_time"], h["end_time"]),
                queries=h.get("user_query", []),
            )
        )

    return EventGraph(
        content_id=json_path.stem,
        category=d.get("typeInfo", {}).get("category", ""),
        duration=float(d.get("typeInfo", {}).get("length", 0)),
        nodes=nodes,
        transcript=transcript,
        video_path=str(video_path) if video_path else None,
    )


def _is_label_json(path: Path) -> bool:
    """라벨링 JSON인지 판별 (우리가 생성한 산출물 JSON과 구분)."""
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    return isinstance(d, dict) and "transcript" in d and "highlight" in d


def load_all(root: str | Path = DATA_ROOT) -> list[EventGraph]:
    """Sample 전체 → EventGraph 목록. mp4 경로도 매칭.

    ⚠️ 한글 폴더명을 하드코딩하지 않는다.
       macOS(NFD)에서 scp한 파일은 리눅스(NFC)와 바이트가 달라 경로 문자열 매칭이 실패한다.
       → 폴더명 대신 **JSON 내용**으로 라벨 파일을 찾고, mp4는 파일명(stem)으로 매칭.
    """
    root = Path(root)
    graphs = []
    mp4s = {p.stem: p for p in root.rglob("*.mp4")}

    for jf in sorted(root.rglob("*.json")):
        if not _is_label_json(jf):
            continue                      # event_graphs.json 등 생성 산출물 제외
        graphs.append(build_event_graph(jf, mp4s.get(jf.stem)))
    return graphs


if __name__ == "__main__":
    gs = load_all()
    print(f"이벤트 그래프 {len(gs)}개\n")
    for g in gs:
        print(f"[{g.category}] {g.content_id} — {g.duration:.0f}초, 장면 {len(g.nodes)}개")
        print(f"  정답 순서: {' → '.join(g.true_order)}")
        for n in sorted(g.nodes, key=lambda n: n.order):
            print(f"   {n.order}. [{n.start:.0f}-{n.end:.0f}초] {n.summary[:50]}...")
            print(f"      키워드 {len(n.keywords)}개 | 근거 발화 {len(n.evidence)}개 | 질문 {len(n.queries)}개")
        print(f"  영상: {'있음' if g.video_path else '없음'}\n")
