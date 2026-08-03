"""마이크 녹음 → 채점 API 호출 → 점수 출력. 런타임 경로 확인용.

왜 필요한가
    학습 데이터(인터뷰)와 실사용(편한 대화)의 조건 차이를 눈으로 보기 위함.
    본인 목소리는 조사자 발화가 섞이지 않아 참조분포 조건에 더 가깝다
    (임상 전화녹음은 조사자 음성 포함 → 휴지 비율이 3배 이상 튐).

사용:
    # 1) 마이크 목록 확인
    python3 -m src.api.record_and_score --list-devices
    # 2) 30초 녹음하고 바로 채점 (백엔드가 :8000에 떠 있어야 함)
    python3 -m src.api.record_and_score --seconds 30
    # 3) 이미 있는 wav 채점
    python3 -m src.api.record_and_score --file my_voice.wav

선행: pip install sounddevice soundfile requests
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

API = "http://localhost:8000/api/report"
SR = 16000                      # 파이프라인 전제 샘플레이트

PROMPT = """
────────────────────────────────────────────────────────
 아래처럼 편하게 말해 주세요 (실제 사용 상황과 같은 조건).
 대본을 읽지 말고, 떠오르는 대로 이야기하듯 말하는 게 중요합니다.

   "오늘 아침에 뭐 했는지 순서대로 말해 보세요."
   "최근에 본 드라마나 뉴스 내용을 기억나는 대로 이야기해 보세요."

 30초 정도면 충분합니다. 중간에 막히거나 '음...' 해도 그대로 두세요.
 (그 머뭇거림이 바로 측정 대상입니다)
────────────────────────────────────────────────────────
"""


def list_devices():
    import sounddevice as sd
    print(sd.query_devices())


def record(seconds: int, out: Path) -> Path:
    import sounddevice as sd
    import soundfile as sf

    print(PROMPT)
    input("준비되면 Enter를 누르세요 → 바로 녹음이 시작됩니다.")
    print(f"\n● 녹음 중… {seconds}초")
    audio = sd.rec(int(seconds * SR), samplerate=SR, channels=1, dtype="float32")
    for s in range(seconds, 0, -1):
        print(f"\r  남은 시간 {s:2d}초 ", end="", flush=True)
        sd.sleep(1000)
    sd.wait()
    print("\r  녹음 완료          ")

    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, audio, SR)
    print(f"저장: {out}")
    return out


def score(wav: Path, answer_text: str = "") -> None:
    import json

    import requests

    answers = [{
        "id": "live1",
        "question": "오늘 있었던 일을 순서대로 말해 보세요",
        "correctAnswer": "",
        "userAnswer": answer_text,      # 비우면 백엔드가 STT로 채움
        "videoTimestamp": 0,
        "audioFilename": wav.name,
    }]
    with open(wav, "rb") as fh:
        r = requests.post(API, data={"answers": json.dumps(answers, ensure_ascii=False)},
                          files={"audio": (wav.name, fh, "audio/wav")}, timeout=300)
    r.raise_for_status()
    d = r.json()

    note = (d.get("interpretation") or {}).get("caveats", "")
    if "목업" in note:
        print(f"\n⚠️  {note}")
        print("   configs/scoring_model.json 이 있는지 확인하세요.")
        return

    print("\n발화 점수 (100점 만점, 높을수록 정상군에 가까움)")
    for f in d["speechScore"]["factors"]:
        bar = "█" * int(f["score"] / 5)
        print(f"  {f['label']:8s} {f['score']:3d} {bar}")

    it = d.get("interpretation") or {}
    if it.get("summary"):
        print(f"\n해석: {it['summary']}")
    if it.get("caveats"):
        print(f"유의: {it['caveats']}")
    if it.get("verifyIssues"):
        print("검증 지적:", it["verifyIssues"])

    print("\n※ 참조분포가 인터뷰 음성 기준이라, 편한 대화로 녹음하면 점수가 낮게")
    print("  나올 수 있습니다. 이 차이를 보정하려면 파일럿 세션 녹음이 필요합니다.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--out", default="data/live/my_voice.wav")
    ap.add_argument("--file", help="녹음 대신 기존 wav 채점")
    ap.add_argument("--text", default="", help="응답 텍스트(생략 시 STT)")
    ap.add_argument("--list-devices", action="store_true")
    a = ap.parse_args()

    if a.list_devices:
        list_devices()
        return

    wav = Path(a.file) if a.file else record(a.seconds, Path(a.out))
    if not wav.exists():
        sys.exit(f"파일 없음: {wav}")
    score(wav, a.text)


if __name__ == "__main__":
    main()
