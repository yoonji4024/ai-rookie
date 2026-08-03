"""영상 기반 회상 세션 — 시청 → 녹음 → 발화·순서 동시 채점.

왜 이 형태인가
    자유 회상은 정오를 판정할 기준이 없다. 이벤트 그래프(자막+타임스탬프로 구성한
    장면 순서)가 ground truth 역할을 해야 응답의 정오와 오류 유형을 객관 판정할 수 있다.
    질문은 손으로 쓰지 않고 event_graph 파이프라인이 생성한 것을 그대로 쓴다.
    → data/Sample/recall_questions.json

이 스크립트가 확인하는 것
    ① 발화 5축   — 음향·언어 피처 → 채점 API
    ② 순서 회상  — 자유 발화 → 장면 매칭 → Kendall's tau + 오류 유형
    ②는 지금까지 더미로만 검증됐다. 실제 사람 음성으로 도는지 여기서 처음 확인한다.

사용:
    python3 -m src.api.session_record --list                    # 콘텐츠 목록
    python3 -m src.api.session_record --content B230115         # 세션 시작
    python3 -m src.api.session_record --score-only data/live/... # 재채점
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

API = "http://localhost:8000/api/report"
SR = 16000
SAMPLE = Path("data/Sample")
QUESTIONS_JSON = SAMPLE / "recall_questions.json"
GRAPHS_JSON = SAMPLE / "event_graphs.json"
OUT_ROOT = Path("data/live")

GUIDE = """
════════════════════════════════════════════════════════════
 회상 세션

 1. 영상을 끝까지 보세요. 안 보고 답하면 측정이 무의미합니다.
 2. 다 보면 이 창으로 돌아와 Enter를 누르세요.
 3. 질문에 답하는 동안 녹음됩니다.

 답할 때
   · 대본을 읽지 마세요. 떠오르는 대로 말하세요.
   · 기억나는 장면을 **순서대로** 이야기해 주세요.
   · 기억이 안 나면 "그건 잘 모르겠네요"라고 그대로 말하면 됩니다.
     모르는 것을 모른다고 하는 것도 측정 대상입니다.
   · "음…", "그… 뭐지" 같은 머뭇거림은 그대로 두세요. 그게 신호입니다.
════════════════════════════════════════════════════════════
"""


def _load(path: Path):
    if not path.exists():
        sys.exit(f"파일 없음: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def list_contents():
    qs = _load(QUESTIONS_JSON)
    print("사용 가능한 콘텐츠\n")
    for q in qs:
        vids = list(SAMPLE.glob(f"01.원천데이터/*/{q['content_id']}.mp4"))
        mark = "" if vids else "  (영상 없음)"
        print(f"  {q['content_id']}  {q['category']:4s}  장면 {len(q['choices'])}개{mark}")
        for c in q["choices"]:
            print(f"       · {c['summary'][:60]}…")
        print()


def _video_path(content_id: str) -> Path | None:
    hits = list(SAMPLE.glob(f"01.원천데이터/*/{content_id}.mp4"))
    return hits[0] if hits else None


def record(seconds: int, out: Path) -> Path:
    import sounddevice as sd
    import soundfile as sf

    input("  준비되면 Enter → 녹음 시작 ")
    print(f"  ● 녹음 중 ({seconds}초). 다 말했으면 Ctrl+C")
    audio = sd.rec(int(seconds * SR), samplerate=SR, channels=1, dtype="float32")
    try:
        for s in range(seconds, 0, -1):
            print(f"\r    남은 시간 {s:3d}초 ", end="", flush=True)
            sd.sleep(1000)
        sd.wait()
    except KeyboardInterrupt:
        sd.stop()
        print("\r    조기 종료            ")
    print("\r    녹음 완료            ")
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, audio, SR)
    return out


def run(content_id: str, seconds: int, sess: Path) -> Path:
    qs = {q["content_id"]: q for q in _load(QUESTIONS_JSON)}
    if content_id not in qs:
        sys.exit(f"알 수 없는 콘텐츠: {content_id} (--list 로 확인)")
    q = qs[content_id]

    print(GUIDE)
    v = _video_path(content_id)
    if v:
        print(f"영상: {v}")
        print(f"  열기 → open '{v}'")
    print(f"카테고리 {q['category']} · 장면 {len(q['choices'])}개\n")

    if input("영상을 끝까지 시청하셨나요? (y로 계속) ").strip().lower() != "y":
        sys.exit("시청 후 다시 실행하세요.")

    print(f"\n  Q. {q['question']}")
    sess.mkdir(parents=True, exist_ok=True)
    wav = sess / "recall.wav"
    record(seconds, wav)

    (sess / "session.json").write_text(json.dumps({
        "content_id": content_id, "category": q["category"],
        "question": q["question"], "answer_order": q["answer_order"],
        "audio": wav.name, "recorded_at": datetime.now().isoformat(timespec="seconds"),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    return sess


def score(sess: Path, text: str | None = None) -> None:
    """text가 주어지면 STT를 건너뛰고 그 텍스트로 채점한다.

    A.X STT 업로드가 막힌 환경에서도 언어 5축·순서 회상·해석·검증을 확인하기 위한 경로.
    음향 축은 오디오에서 그대로 계산되므로 영향 없다.
    """
    import requests

    meta = json.loads((sess / "session.json").read_text(encoding="utf-8"))
    wav = sess / meta["audio"]
    if not wav.exists():
        sys.exit(f"오디오 없음: {wav}")

    # 저장해둔 전사가 있으면 재사용 (--text로 한 번 넣으면 이후 자동 사용)
    tfile = sess / "transcript.txt"
    if text:
        tfile.write_text(text, encoding="utf-8")
    elif tfile.exists():
        text = tfile.read_text(encoding="utf-8").strip()

    # ── ① 발화 5축 (채점 API) ─────────────────────────────
    answers = [{"id": "recall", "question": meta["question"], "correctAnswer": "",
                "userAnswer": text or "", "videoTimestamp": 0, "audioFilename": wav.name}]
    with open(wav, "rb") as fh:
        r = requests.post(API, data={"answers": json.dumps(answers, ensure_ascii=False),
                                     # 회상 축(문맥 일치도·기억 정확도) 채점에 필요
                                     "contentId": meta["content_id"]},
                          files={"audio": (wav.name, fh, "audio/wav")}, timeout=600)
    r.raise_for_status()
    d = r.json()

    note = (d.get("interpretation") or {}).get("caveats", "")
    mocked = "목업" in note
    print("\n① 발화 점수" + ("  ⚠️ " + note if mocked else ""))
    for f in d["speechScore"]["factors"]:
        print(f"   {f['label']:9s} {f['score']:3d}  {'█' * int(f['score'] / 5)}")

    said = (d.get("questions") or [{}])[0].get("userAnswer", "")
    print(f"\n   STT 결과: {said[:120] or '(전사 실패 또는 무음)'}")

    # ── ② 순서 회상 (이벤트 그래프 대조) ──────────────────
    print("\n② 순서 회상")
    if not said:
        print("   전사가 비어 채점 불가 — A.X STT 키/응답 확인 필요")
    else:
        try:
            from src.agents.analysis.recall import score_recall_order
            from src.agents.analysis.response_matcher import match_response
            from src.event_graph.sample_loader import load_all

            # match_response·score_recall_order는 EventGraph 객체를 받는다
            # (event_graphs.json의 dict를 그대로 넘기면 .nodes 접근에서 실패)
            graphs = {g.content_id: g for g in load_all()}
            graph = graphs.get(meta["content_id"])
            if graph is None:
                raise RuntimeError(f"이벤트 그래프 없음: {meta['content_id']}")
            m = match_response(said, graph)
            order = m.get("scene_order", [])
            print(f"   인식된 장면 순서: {order}")
            print(f"   정답 순서       : {meta['answer_order']}")
            if m.get("unmatched"):
                print(f"   매칭 안 된 발화 : {m['unmatched'][:2]}")

            res = score_recall_order(order, graph)
            print(f"   Kendall's tau: {res.get('kendall_tau')}")
            print(f"   오류 유형    : {res.get('errors')}")
        except Exception as e:
            print(f"   순서 채점 실패: {e}")

    out = sess / "report.json"
    out.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장: {out}")
    if not mocked:
        print("\n※ 참조분포가 인터뷰 음성 기준이라 편한 대화는 점수가 낮게 나올 수 있습니다.")
        print("  이 차이(도메인 시프트) 보정에는 같은 조건의 파일럿 세션이 필요합니다.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--content", help="콘텐츠 ID (예: B230115)")
    ap.add_argument("--seconds", type=int, default=60, help="녹음 길이")
    ap.add_argument("--score-only", help="기존 세션 폴더 재채점")
    ap.add_argument("--text", help="STT 대신 쓸 응답 텍스트 (업로드가 막힌 환경용)")
    a = ap.parse_args()

    if a.list:
        list_contents()
        return
    if a.score_only:
        score(Path(a.score_only), a.text)
        return
    if not a.content:
        sys.exit("--content 필요 (--list 로 목록 확인)")

    sess = OUT_ROOT / f"{a.content}_{datetime.now():%m%d_%H%M}"
    run(a.content, a.seconds, sess)
    score(sess)


if __name__ == "__main__":
    main()
