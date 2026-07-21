"""데모 시나리오 — 같은 콘텐츠를 본 두 사람(정상형 vs MCI형) 대조.

⚠️ 이 데모의 회상 발화는 **합성(시나리오)** 이다.
   - 대본은 Kang 코퍼스에서 **실측한 HC/MCI 차이**를 근거로 생성한다(임의 창작 아님).
   - 음향 점수는 TTS가 음질 저하를 재현하지 못하므로 **실제 Kang 화자 값을 병행 표기**한다.
   - 합성 데이터는 **탐지 분류기 학습에 절대 사용하지 않는다** (CLAUDE.md §7).

실행:
    LLM_MOCK=1 python3 -m src.demo.scenario      # 구조 검증
    python3 -m src.demo.scenario                 # 실제 Solar로 대본 생성
    python3 -m src.demo.scenario --tts           # TTS 음성까지 생성
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from src.agents.analysis.recall import score_recall_order
from src.agents.analysis.response_matcher import match_response
from src.agents.analysis.scoring.score import ScoringModel
from src.common.llm import LLMError, chat_json
from src.demo.tts import TTSVoice, get_tts
from src.event_graph.sample_loader import load_all

OUT = Path("docs/데모_시나리오.md")
AUDIO_DIR = Path("data/demo_audio")
CACHE = Path("data/kang_features.npz")

# Kang 실측 차이 (docs/음성_실험_결과_정리.md) — 대본 생성의 근거
KANG_FACTS = """Kang 코퍼스 실측 (HC 37명 / MCI 40명):
- 총 발화량: HC 708초 vs MCI 449초 (MCI가 훨씬 적게 말함)
- 발화 중 휴지: HC가 더 자주 쉼 (MCI는 짧게 끊어 답하고 덜 쉼)
- 발화 분절: MCI는 분절이 적고 길게 이어 말함
- 발화당 길이·어휘 다양성·내용어 비율: MCI가 낮음
- 대명사 과다(그거·저거) 경향: MCI에서 관찰"""

SCRIPT_SYSTEM = """당신은 인지 스크리닝 **데모 시나리오**용 회상 발화 대본을 만듭니다.

주어진 것: 영상의 장면 목록, 그리고 실제 코퍼스에서 측정된 정상군/MCI군의 발화 특징.
할 일: 두 사람이 같은 영상을 보고 장면 순서를 회상하는 발화를 각각 작성.

정상형(normal):
- 장면을 **전부 순서대로** 기억, 구체적 어휘 사용, 문장이 완결됨
- 어르신이 가족에게 이야기하듯 존댓말(~요, ~네요)로

MCI형(mci) — 아래를 **모두** 반영:
- **장면 목록 중 최소 1개는 아예 언급하지 않는다**(누락). 어느 것을 뺐는지 omitted_scenes에 적을 것.
- 언급하는 장면들 중 **최소 한 쌍은 실제와 순서를 바꿔** 말한다(순서 혼동).
- 대명사(그거, 저거, 뭐더라)를 자주 씀, 문장이 미완성으로 끊김
- 전체 발화가 정상형보다 **절반 이하로 짧다**
- 세부 내용(숫자·기관명)은 흐릿하게 말하거나 생략

규칙:
1. 장면 목록에 **있는 내용만** 쓰세요. 없는 사건을 지어내지 마세요.
2. 실제 어르신 말투(구어체, ~요/~네)로 자연스럽게.
3. 어느 장면을 의도적으로 빠뜨렸는지 omitted_scenes에 scene_id로 적으세요.

반드시 이 JSON만 출력 (한 줄, 문자열 안에 큰따옴표 금지):
{"normal": {"text": "...", "omitted_scenes": []},
 "mci": {"text": "...", "omitted_scenes": ["..."]}}"""


def _scene_brief(graph) -> list[dict]:
    return [
        {"scene_id": n.scene_id, "summary": n.summary[:100], "keywords": n.keywords[:6]}
        for n in sorted(graph.nodes, key=lambda x: x.order)
    ]


def generate_scripts(graph) -> dict:
    """Kang 실측 근거로 회상 대본 2종 생성."""
    try:
        return chat_json(
            "solar", SCRIPT_SYSTEM,
            f"[영상 장면 목록]\n{json.dumps(_scene_brief(graph), ensure_ascii=False, indent=1)}\n\n"
            f"[실측 발화 특징]\n{KANG_FACTS}\n\n두 사람의 회상 발화를 작성하세요.",
            temperature=0.4,
        )
    except LLMError as e:
        print(f"  ⚠️ 대본 생성 실패({e}) — 내장 대본 사용")
        return _fallback_scripts(graph)


def _fallback_scripts(graph) -> dict:
    """LLM 실패 시 키워드 기반 내장 대본 (구조 검증용).

    ⚠️ 장면 간 **중복 키워드는 쓰지 않는다**. 예: 뉴스 장면 3·4가 모두 '미국'을 가지면
       그 단어로는 어느 장면인지 특정할 수 없어 대조 시나리오가 성립하지 않는다.
    """
    from src.agents.analysis.response_matcher import _unique_keywords

    nodes = sorted(graph.nodes, key=lambda n: n.order)
    uniq = _unique_keywords(nodes)

    def pick(n):
        cands = sorted(uniq.get(n.scene_id, set()), key=len, reverse=True)
        return cands[0] if cands else (n.keywords[0] if n.keywords else n.summary[:8])

    kws = {n.scene_id: pick(n) for n in nodes}

    normal = " ".join(
        f"{'처음에는' if i == 0 else '그다음에는'} {kws[n.scene_id]} 이야기가 나왔어요."
        for i, n in enumerate(nodes)
    )
    keep = nodes[:2]
    mci = (f"음… {kws[keep[0].scene_id]} 그거 나왔고요. "
           f"그리고 뭐더라, {kws[keep[1].scene_id]} 그것도 나온 것 같은데… 잘 모르겠네요.")
    return {
        "normal": {"text": normal, "omitted_scenes": []},
        "mci": {"text": mci, "omitted_scenes": [n.scene_id for n in nodes[2:]]},
    }


def real_kang_speech_scores() -> dict:
    """실제 Kang 화자의 발화 5축 점수 — TTS가 못 만드는 음질 축을 대신한다."""
    if not CACHE.exists():
        return {}
    d = np.load(CACHE, allow_pickle=True)
    X, y, names = d["X"], d["y"], [str(n) for n in d["names"]]
    ids = [str(i) for i in d["ids"]] if "ids" in d else None
    model = ScoringModel.fit(X, y, names)
    totals = model.total_scores(X)

    hc_idx = int(np.argmax(np.where(y == 0, totals, -1)))          # HC 중 최고점
    mci_idx = int(np.argmin(np.where(y == 1, totals, 999)))        # MCI 중 최저점
    return {
        "normal": {"subject": ids[hc_idx] if ids else f"#{hc_idx}",
                   **model.score_one(X[hc_idx])},
        "mci": {"subject": ids[mci_idx] if ids else f"#{mci_idx}",
                **model.score_one(X[mci_idx])},
    }


def run_case(name: str, script: dict, graph, tts=None) -> dict:
    """대본 1건 → 매칭 → 채점 (+선택적 TTS)."""
    text = script.get("text", "")
    m = match_response(text, graph, use_llm=True)
    s = score_recall_order(m["scene_order"], graph)

    audio = None
    if tts:
        # 노년 화자 + 느린 속도. MCI형은 더 느리게(실측: MCI가 발화량 적고 분절이 길다).
        # seed 고정 → 같은 대본이면 항상 같은 음성(재현성).
        voice = TTSVoice(speed=0.85 if name == "mci" else 0.95, seed=42)
        audio = str(tts.synthesize(text, AUDIO_DIR / f"{graph.content_id}_{name}.wav", voice))

    # 정합성 검증: 대본이 "빼겠다"고 선언한 장면을 매칭기가 잡아냈다면 = 과다 매칭 신호.
    # (누락을 정상 회상으로 오판하는 실패 양상을 자동 감지)
    declared = script.get("omitted_scenes", []) or []
    over_matched = [sid for sid in declared if sid in m["scene_order"]]

    return {"text": text, "matching": m, "recall": s,
            "declared_omitted": declared, "over_matched": over_matched, "audio": audio}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--content", help="콘텐츠 ID")
    ap.add_argument("--tts", action="store_true", help="TTS 음성 생성")
    a = ap.parse_args()

    graphs = load_all()
    if not graphs:
        raise SystemExit("Sample 데이터 없음 — data/Sample 확인")
    graph = next((g for g in graphs if g.content_id == a.content), None) \
        or max(graphs, key=lambda g: len(g.nodes))

    print(f"데모 시나리오 — [{graph.category}] {graph.content_id}, 장면 {len(graph.nodes)}개")
    print(f"정답 순서: {' → '.join(graph.true_order)}\n")

    print("[1] 회상 대본 생성 (Kang 실측 근거)")
    scripts = generate_scripts(graph)

    tts = get_tts() if a.tts else None
    if a.tts:
        print(f"    TTS: {type(tts).__name__}")

    print("[2] 매칭·채점")
    cases = {k: run_case(k, scripts.get(k, {}), graph, tts) for k in ("normal", "mci")}

    print("[3] 실제 Kang 화자 음향 점수 (TTS 한계 보완)")
    speech = real_kang_speech_scores()

    for k, label in (("normal", "정상형"), ("mci", "MCI형")):
        c, r = cases[k], cases[k]["recall"]
        print(f"\n  [{label}] {c['text'][:60]}...")
        print(f"    회상: tau={r['kendall_tau']:+.2f} 커버리지={r['coverage']:.0%} 오류={r['errors']}")
        if c["declared_omitted"]:
            print(f"    대본이 뺀 장면: {c['declared_omitted']}")
        if c["over_matched"]:
            print(f"    ⚠️ 과다 매칭: {c['over_matched']} — 빠뜨린 장면을 회상한 것으로 잘못 판정함")
        elif k == "mci" and not c["declared_omitted"]:
            print("    ⚠️ 대본이 누락을 만들지 않음 — 프롬프트 미준수(대조 약해짐)")
        if k in speech:
            sp = speech[k]
            print(f"    발화점수(실제 {sp['subject']}): {sp['total_score']}점 {sp['grade']}")

    _write_doc(graph, scripts, cases, speech)
    print(f"\n문서 저장: {OUT}")


def _write_doc(graph, scripts, cases, speech):
    L = [
        "# 데모 시나리오 — 정상형 vs MCI형 대조",
        "",
        "> ⚠️ **합성 시나리오입니다.** 회상 발화는 Kang 코퍼스에서 실측한 HC/MCI 차이를 근거로",
        "> 생성한 대본이며, 실제 환자 발화가 아닙니다. 합성 데이터는 탐지 분류기 학습에",
        "> 사용하지 않습니다(CLAUDE.md §7).",
        "> 음향(발음 정확도) 점수는 TTS가 음질 저하를 재현하지 못하므로 **실제 Kang 화자 값**을 병행 표기합니다.",
        "",
        f"## 콘텐츠 — [{graph.category}] {graph.content_id}",
        "",
        f"- 길이 {graph.duration:.0f}초, 장면 {len(graph.nodes)}개",
        f"- 정답 순서: {' → '.join(graph.true_order)}",
        "",
    ]
    for n in sorted(graph.nodes, key=lambda x: x.order):
        L.append(f"  {n.order + 1}. `{n.scene_id}` [{n.start:.0f}–{n.end:.0f}초] {n.summary[:70]}")
    L += ["", "---", ""]

    for k, label in (("normal", "정상형"), ("mci", "MCI형")):
        c, r = cases[k], cases[k]["recall"]
        e = r["errors"]
        L += [
            f"## {label}",
            "",
            "**회상 발화 (합성)**",
            "",
            f"> {c['text']}",
            "",
            "**채점 결과**",
            "",
            f"| 항목 | 값 |",
            f"|---|---|",
            f"| 매칭된 장면 | {' → '.join(c['matching']['scene_order']) or '없음'} |",
            f"| Kendall's tau | **{r['kendall_tau']:+.2f}** |",
            f"| 커버리지 | {r['coverage']:.0%} ({r['n_correct']}/{len(graph.nodes)}장면) |",
            f"| 누락(omission) | {e['omission']} |",
            f"| 순서 뒤바뀜(reversal) | {e['reversal']} |",
            f"| 없는 내용(intrusion) | {e['intrusion']} |",
            "",
        ]
        if k in speech:
            sp = speech[k]
            L += [
                f"**발화 5축 점수** — 실제 Kang 화자 `{sp['subject']}` 기준 *(TTS 한계 보완)*",
                "",
                f"- 총점 **{sp['total_score']}점** · 등급 **{sp['grade']}**",
                "",
            ]
            for ax, v in sp["axes"].items():
                L.append(f"  - {ax}: {v['score']}점")
            L.append("")
        if c.get("audio"):
            L += [f"**합성 음성**: `{c['audio']}`", ""]
        L += ["---", ""]

    n, m = cases["normal"]["recall"], cases["mci"]["recall"]
    L += [
        "## 대조 요약",
        "",
        "| 지표 | 정상형 | MCI형 |",
        "|---|---|---|",
        f"| Kendall's tau | {n['kendall_tau']:+.2f} | {m['kendall_tau']:+.2f} |",
        f"| 커버리지 | {n['coverage']:.0%} | {m['coverage']:.0%} |",
        f"| 누락 | {n['errors']['omission']} | {m['errors']['omission']} |",
        f"| 순서 뒤바뀜 | {n['errors']['reversal']} | {m['errors']['reversal']} |",
        "",
        "**해석**: 순서 회상은 이벤트 그래프라는 객관적 정답이 있어, 자유 회상과 달리",
        "누락·순서오류를 **수치로 판정**할 수 있다. AI는 진단명을 내지 않고 이 근거만 전달한다.",
        "",
    ]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
