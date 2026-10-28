"""세션 오케스트레이터 — 프론트 없이 CLI로 도는 end-to-end 파이프라인.

흐름
  1. 콘텐츠 선택 (Sample)
  2. 시청 시뮬레이션 — 재생 시각을 따라가며 **타이밍 게이트**가 질문 시점 결정
  3. 질문 → 사용자 응답 수집 (CLI 입력 / 시나리오 자동응답)
  4. 시청 후 **순서 회상 질문** → 자유 발화 응답
  5. 응답 → 장면 매칭 → **순서 회상 채점**
  6. (오디오 있으면) 음향 분석 → **발화 5축 스코어링**
  7. **보호자 리포트** 생성

팀원 파트 교체 지점 (인터페이스 고정, 지금은 stub/간이 구현)
  - 요약 에이전트(②): summarize() — 현재는 대화 로그 그대로 보관
  - STT: 지금은 텍스트 입력. A.X STT 붙으면 audio→text만 바꿔 끼우면 됨

사용
  LLM_MOCK=1 python3 -m src.session --auto        # 네트워크 없이 구조 검증
  python3 -m src.session                          # 실제 LLM, 대화형 입력
  python3 -m src.session --auto --content B230115 # 시나리오 자동 응답
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from src.agents.analysis.recall_pipeline import analyze_recall
from src.agents.conversation.timing_gate import decide_question
from src.event_graph.sample_loader import load_all

SESSION_DIR = Path("data/sessions")
STEP_SEC = 15.0          # 시청 시뮬레이션 시간 간격


@dataclass
class SessionLog:
    """세션 기록 — 요약 에이전트(②)와 리포트의 입력."""

    content_id: str
    category: str
    turns: list[dict] = field(default_factory=list)      # 시청 중 대화
    recall_response: str = ""
    recall_score: dict = field(default_factory=dict)
    speech_score: dict = field(default_factory=dict)
    report: dict = field(default_factory=dict)

    def add_turn(self, t: float, question: str, answer: str, stage: str):
        self.turns.append({"t": round(t, 1), "question": question,
                           "answer": answer, "stage": stage})

    def to_dict(self) -> dict:
        return {
            "content_id": self.content_id,
            "category": self.category,
            "n_turns": len(self.turns),
            "turns": self.turns,
            "recall_response": self.recall_response,
            "recall_score": self.recall_score,
            "speech_score": self.speech_score,
            "report": self.report,
        }


# ── 응답 수집 (프론트 대체 지점) ──────────────────────────────
class Responder:
    """사용자 응답 수집기. 프론트/음성이 붙으면 이 클래스만 교체."""

    def ask(self, question: str) -> str:
        raise NotImplementedError


class CLIResponder(Responder):
    def ask(self, question: str) -> str:
        print(f"\n🤖 {question}")
        try:
            return input("👵 답변: ").strip()
        except EOFError:
            return ""


class ScriptedResponder(Responder):
    """자동 시나리오 — 검증·데모용. 실제 어르신 발화를 흉내낸 텍스트."""

    def __init__(self, answers: list[str], recall: str):
        self.answers, self.recall, self.i = answers, recall, 0

    def ask(self, question: str) -> str:
        print(f"\n🤖 {question}")
        a = self.answers[self.i % len(self.answers)] if self.answers else "네 봤어요."
        self.i += 1
        print(f"👵 {a}")
        return a


def watch_session(graph, responder: Responder, verbose: bool = True) -> SessionLog:
    """시청 중 상호작용 — 타이밍 게이트가 질문 시점을 결정."""
    log = SessionLog(content_id=graph.content_id, category=graph.category)
    scenes = [{"scene_id": n.scene_id, "start": n.start, "end": n.end,
               "summary": n.summary} for n in sorted(graph.nodes, key=lambda n: n.order)]

    last_q_t, n_asked, t = None, 0, 0.0
    blocked_count = 0

    while t < graph.duration:
        ctx = {
            "t": t, "transcript": graph.transcript, "scenes": scenes,
            "last_question_t": last_q_t, "n_asked": n_asked, "user_speaking": False,
        }
        d = decide_question(ctx)
        if d["action"] == "ask":
            ans = responder.ask(d["question"])
            log.add_turn(t, d["question"], ans, d["stage"])
            last_q_t, n_asked = t, n_asked + 1
        else:
            blocked_count += 1
        t += STEP_SEC

    if verbose:
        print(f"\n  시청 완료 — 질문 {n_asked}회 / 침묵 {blocked_count}회 "
              f"(총 {int(graph.duration // STEP_SEC)} 시점 평가)")
    return log


def recall_session(graph, responder: Responder, log: SessionLog) -> SessionLog:
    """시청 후 순서 회상 — 자유 발화 → 장면 매칭 → 채점."""
    q = "방금 보신 내용에서 어떤 장면이 먼저 나왔는지 순서대로 말씀해 주시겠어요?"
    resp = responder.ask(q) if not isinstance(responder, ScriptedResponder) \
        else _scripted_recall(responder, q)
    log.recall_response = resp

    log.recall_score = analyze_recall(resp, graph, use_llm=True)
    return log


def _scripted_recall(r: ScriptedResponder, q: str) -> str:
    print(f"\n🤖 {q}")
    print(f"👵 {r.recall}")
    return r.recall


def run_session(content_id: str | None, auto: bool, out_dir: Path = SESSION_DIR) -> SessionLog:
    graphs = load_all()
    if not graphs:
        raise SystemExit("Sample 데이터 없음 — data/Sample 확인")
    graph = next((g for g in graphs if g.content_id == content_id), graphs[0])

    print("=" * 60)
    print(f"세션 시작 — [{graph.category}] {graph.content_id} ({graph.duration:.0f}초, 장면 {len(graph.nodes)}개)")
    print("=" * 60)

    if auto:
        responder: Responder = ScriptedResponder(
            answers=["아 그렇구나.", "네 봤어요.", "글쎄 잘 모르겠네."],
            recall=_demo_recall(graph),
        )
    else:
        responder = CLIResponder()

    print("\n[1] 시청 중 대화 (타이밍 게이트)")
    log = watch_session(graph, responder)

    print("\n[2] 시청 후 순서 회상")
    log = recall_session(graph, responder, log)
    s = log.recall_score
    print(f"\n  매칭 결과: {s['matching']['scene_order']}")
    print(f"  정답 순서: {graph.true_order}")
    tau_text = f"{s['kendall_tau']:+.2f}" if s['kendall_tau'] is not None else "측정 불가"
    print(f"  매칭 장면 Kendall's tau {tau_text} | 매칭 커버리지 {s['matched_coverage']:.0%}")
    print(f"  오류 유형: {s['errors']}")

    print("\n[3] 보호자 리포트")
    log.report = _build_report(log, graph)
    print(f"  {log.report.get('summary', '(생성 안 됨)')}")

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{graph.content_id}_session.json"
    out.write_text(json.dumps(log.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n세션 저장: {out}")
    return log


def _demo_recall(graph) -> str:
    """장면 키워드로 만든 데모 회상 발화 — 1개는 일부러 누락(오류 유형 시연)."""
    nodes = sorted(graph.nodes, key=lambda n: n.order)
    parts = []
    for i, n in enumerate(nodes[:-1] if len(nodes) > 2 else nodes):
        kw = n.keywords[0] if n.keywords else n.summary[:10]
        parts.append(f"{'처음에' if i == 0 else '그다음에'} {kw} 얘기가 나왔고")
    return " ".join(parts) + " 뭐 그랬던 것 같아요."


def _build_report(log: SessionLog, graph) -> dict:
    """보호자 리포트 — 순서 회상 근거 기반. 진단 단정 금지."""
    s = log.recall_score
    tau = s.get('kendall_tau')
    facts = [
        f"장면 {len(graph.nodes)}개 중 발화와 매칭한 장면 {s.get('n_correct', 0)}개",
        (f"매칭 장면 순서 일치도(Kendall's tau) {tau:+.2f}" if tau is not None
         else "순서 일치도 측정 불가"),
        "누락·침입 오류 개수는 의미 판정이 완료되지 않아 측정하지 않음",
        f"시청 중 대화 {len(log.turns)}회",
    ]
    return {
        "summary": " / ".join(facts),
        "evidence": s.get("matching", {}).get("matches", []),
        "note": "본 결과는 참고 지표이며 진단이 아닙니다. 우려되시면 전문의와 상담하세요.",
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--content", help="콘텐츠 ID (예: B230115)")
    p.add_argument("--auto", action="store_true", help="자동 시나리오 응답")
    a = p.parse_args()
    run_session(a.content, a.auto)


if __name__ == "__main__":
    main()
