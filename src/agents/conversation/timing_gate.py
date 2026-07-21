"""타이밍 게이트 — 시청 중 질문 여부·시점 결정.

CLAUDE.md §3: draft(A.X K1) → judge(EXAONE) → refine 3단계.
             rule-based hard block이 API 호출 **앞단**에서 RPS·방해를 차단.

핵심 목적: 시청을 방해하지 않으면서 자연스러운 대화 신호를 얻는 것.
          → 질문을 "많이" 하는 게 아니라 "제때" 하는 게 성능.

CLAUDE.md §9 시그니처:
    decide_question(context) -> {'action': 'ask'|'silence', 'question': str|None, 'timing': float}
"""
from __future__ import annotations

import json

from src.common.llm import LLMError, chat_json

# ── 하드 블록 규칙 (LLM 호출 전) ─────────────────────────────
MIN_GAP_SEC = 90.0        # 직전 질문 후 최소 간격
SCENE_EDGE_SEC = 3.0      # 장면 시작/끝 ±3초는 몰입 구간 → 금지
MAX_QUESTIONS = 5         # 세션당 질문 상한
SPEECH_GUARD_SEC = 1.0    # 현재 발화 중이면 금지(끝나고 이 시간 뒤부터 허용)


DRAFT_SYSTEM = """당신은 어르신과 함께 TV를 보는 친구입니다. 지금 화면 내용에 대해
자연스럽게 건넬 **질문 후보**를 만드세요.

규칙:
- 시험처럼 묻지 마세요. 친구가 툭 던지는 말투로.
- 방금 지나간 내용에 대해서만 물으세요. 화면에 없는 건 묻지 마세요.
- 짧게(20자 내외).
- 지금이 물어보기 애매하면 silence_ok를 true로 두세요.

반드시 이 JSON만 출력:
{"candidates": [{"question": "...", "reason": "..."}], "silence_ok": true}
후보는 최대 3개."""

JUDGE_SYSTEM = """당신은 시청 방해를 판정하는 심판입니다. 아래 질문 후보 중
지금 시점에 던져도 **시청을 방해하지 않는** 것을 고르세요.

판정 기준:
- 중요한 장면이 진행 중이면 방해 → silence
- 방금 장면이 끝났거나 전환 직후면 적절 → ask
- 후보가 화면에 없는 내용을 묻으면 → silence

반드시 이 JSON만 출력:
{"action": "ask" 또는 "silence", "best_index": 0, "reason": "..."}"""


def hard_block(context: dict) -> tuple[bool, str]:
    """LLM 호출 전 규칙 차단. (차단여부, 사유)"""
    t = float(context.get("t", 0.0))

    if context.get("n_asked", 0) >= MAX_QUESTIONS:
        return True, f"질문 상한({MAX_QUESTIONS}) 도달"

    last = context.get("last_question_t")
    if last is not None and t - float(last) < MIN_GAP_SEC:
        return True, f"직전 질문 후 {t - float(last):.0f}초 (최소 {MIN_GAP_SEC:.0f}초)"

    if context.get("user_speaking"):
        return True, "사용자 발화 중"

    # 장면 경계 몰입 구간
    for s in context.get("scenes", []):
        st, en = float(s["start"]), float(s["end"])
        if st - SCENE_EDGE_SEC <= t <= st + SCENE_EDGE_SEC:
            return True, "장면 시작 직후(몰입)"
        if en - SCENE_EDGE_SEC <= t <= en:
            return True, "장면 종료 직전(몰입)"

    return False, ""


def _recent_context(context: dict, window: float = 60.0) -> str:
    """직전 window초의 자막/전사 — 질문 생성 근거."""
    t = float(context.get("t", 0.0))
    lines = [
        x["form"] for x in context.get("transcript", [])
        if t - window <= x.get("end", 0) <= t
    ]
    return " ".join(lines)[-600:]


def decide_question(context: dict) -> dict:
    """질문 여부·내용·시점 결정.

    context:
      t              : 현재 재생 시각(초)
      transcript     : [{start, end, form}] 콘텐츠 전사
      scenes         : [{scene_id, start, end, summary}] 이벤트 그래프 장면
      last_question_t: 직전 질문 시각 | None
      n_asked        : 지금까지 질문 수
      user_speaking  : 사용자 발화 중 여부

    반환: {'action', 'question', 'timing', 'stage', 'reason'}
    """
    t = float(context.get("t", 0.0))

    # ── 1단계: 하드 블록 (API 호출 전 차단) ──
    blocked, why = hard_block(context)
    if blocked:
        return {"action": "silence", "question": None, "timing": t,
                "stage": "hard_block", "reason": why}

    recent = _recent_context(context)
    if not recent.strip():
        return {"action": "silence", "question": None, "timing": t,
                "stage": "hard_block", "reason": "최근 발화 없음"}

    # ── 2단계: draft (A.X K1) ──
    try:
        draft = chat_json(
            "ax", DRAFT_SYSTEM,
            f"[방금 지나간 내용]\n{recent}\n\n[현재 시각] {t:.0f}초\n질문 후보를 만드세요.",
            temperature=0.3,
        )
    except LLMError as e:
        return {"action": "silence", "question": None, "timing": t,
                "stage": "draft", "reason": f"draft 실패: {e}"}

    candidates = draft.get("candidates") or []
    if not candidates:
        return {"action": "silence", "question": None, "timing": t,
                "stage": "draft", "reason": "후보 없음"}

    # ── 3단계: judge (EXAONE) ──
    try:
        judge = chat_json(
            "exaone", JUDGE_SYSTEM,
            "[방금 지나간 내용]\n" + recent
            + "\n\n[질문 후보]\n"
            + json.dumps(candidates, ensure_ascii=False, indent=1)
            + "\n\n지금 질문해도 될지 판정하세요.",
            temperature=0.0,
        )
    except LLMError as e:
        return {"action": "silence", "question": None, "timing": t,
                "stage": "judge", "reason": f"judge 실패(보수적 침묵): {e}"}

    if judge.get("action") != "ask":
        return {"action": "silence", "question": None, "timing": t,
                "stage": "judge", "reason": judge.get("reason", "판정: 침묵")}

    idx = int(judge.get("best_index", 0))
    idx = idx if 0 <= idx < len(candidates) else 0
    question = _refine(candidates[idx].get("question", ""))

    return {"action": "ask", "question": question, "timing": t,
            "stage": "refine", "reason": judge.get("reason", "")}


def _refine(q: str) -> str:
    """말투 다듬기 — 검사처럼 들리지 않게, 존댓말 유지."""
    q = q.strip().strip('"').replace("\n", " ")
    for bad, good in [("기억하십니까", "기억나세요"), ("무엇입니까", "뭐였을까요"),
                      ("설명하시오", "어떠셨어요"), ("말하시오", "말씀해 주세요")]:
        q = q.replace(bad, good)
    if q and not q.endswith(("?", "요", "다", ".")):
        q += "?"
    return q[:60]


if __name__ == "__main__":
    from src.event_graph.sample_loader import load_all

    g = next(x for x in load_all() if len(x.nodes) >= 4)
    scenes = [{"scene_id": n.scene_id, "start": n.start, "end": n.end,
               "summary": n.summary} for n in sorted(g.nodes, key=lambda n: n.order)]
    base = {"transcript": g.transcript, "scenes": scenes}

    print(f"콘텐츠 {g.content_id} — 하드블록 규칙 검증\n")
    cases = [
        ("장면 시작 직후(몰입)", {**base, "t": scenes[0]["start"] + 1, "n_asked": 0}),
        ("질문 직후(간격 부족)", {**base, "t": 200.0, "last_question_t": 190.0, "n_asked": 1}),
        ("사용자 발화 중", {**base, "t": 200.0, "user_speaking": True, "n_asked": 0}),
        ("질문 상한 도달", {**base, "t": 200.0, "n_asked": 5}),
        ("정상 시점", {**base, "t": scenes[0]["end"] + 30, "n_asked": 0}),
    ]
    for name, ctx in cases:
        blocked, why = hard_block(ctx)
        print(f"  {name:20s} → {'차단' if blocked else '통과'} {('('+why+')') if why else ''}")
