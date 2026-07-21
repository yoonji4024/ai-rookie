"""A.X STT 클라이언트 (SKT).

⚠️ 엔드포인트 규격 미확정
   A.X K1이 OpenAI 호환(`awf-gw.adot.ai/v1`)이므로 STT도 `/v1/audio/transcriptions`를
   따른다고 가정했다. 실제와 다르면 **환경변수로 덮어쓰거나** `_request()` 한 곳만 고치면 된다.
     AX_STT_URL   : 엔드포인트 URL
     AX_STT_MODEL : 모델명

왜 중요한가 (CLAUDE.md §4, §13)
   런타임에서는 사람이 만든 전사가 아니라 **STT 출력**으로 피처를 뽑는다.
   그런데 STT가 disfluency를 매끄럽게 정리하면
     "제가 즈 , 나 , 제 , 제가" → "제가"
   처럼 우리가 방금 확보한 신호(파편 반복·어미 미완성)가 **통째로 사라진다.**
   → 도입 전에 **보존 여부를 반드시 측정**해야 한다(stt_shift.py).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import requests

from src.common.llm import load_env

load_env()

DEFAULT_URL = "https://awf-gw.adot.ai/v1/audio/transcriptions"
DEFAULT_MODEL = "ax-stt"


@dataclass
class Transcript:
    text: str
    segments: list[dict]          # [{start, end, text}] — 있으면 채움
    raw: dict

    @property
    def utterances(self) -> list[str]:
        return [s["text"] for s in self.segments if s.get("text")] or (
            [self.text] if self.text else [])


class STTError(RuntimeError):
    pass


class AXSTT:
    def __init__(self, api_key: str | None = None, url: str | None = None,
                 model: str | None = None, timeout: int = 180):
        self.api_key = api_key or os.environ.get("AX_API_KEY")
        self.url = url or os.environ.get("AX_STT_URL", DEFAULT_URL)
        self.model = model or os.environ.get("AX_STT_MODEL", DEFAULT_MODEL)
        self.timeout = timeout

    def _request(self, audio_path: Path, language: str = "ko") -> dict:
        if not self.api_key:
            raise STTError("AX_API_KEY 미설정 — .env 확인")
        with open(audio_path, "rb") as f:
            r = requests.post(
                self.url,
                headers={"Authorization": f"Bearer {self.api_key}"},
                files={"file": (audio_path.name, f, "audio/wav")},
                data={
                    "model": self.model,
                    "language": language,
                    "response_format": "verbose_json",   # 세그먼트 타임스탬프 요청
                },
                timeout=self.timeout,
            )
        if not r.ok:
            raise STTError(f"STT 실패 {r.status_code}: {r.text[:300]}")
        try:
            return r.json()
        except ValueError:
            return {"text": r.text}

    def transcribe(self, audio_path: str | Path, language: str = "ko") -> Transcript:
        d = self._request(Path(audio_path), language)
        segs = []
        for s in (d.get("segments") or []):
            segs.append({
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
                "text": (s.get("text") or "").strip(),
            })
        return Transcript(text=(d.get("text") or "").strip(), segments=segs, raw=d)


def get_stt() -> AXSTT:
    return AXSTT()


if __name__ == "__main__":
    import sys

    stt = get_stt()
    print(f"엔드포인트: {stt.url}\n모델: {stt.model}")
    target = sys.argv[1] if len(sys.argv) > 1 else None
    if not target:
        # Kang 샘플 하나로 연결 확인
        from src.preprocessing.kang_loader import load_kang
        target = load_kang()[0].wav_path
    print(f"대상: {target}\n")
    try:
        t = stt.transcribe(target)
        print(f"전사 {len(t.text)}자, 세그먼트 {len(t.segments)}개")
        print(f"앞부분: {t.text[:200]}")
    except STTError as e:
        print(f"⚠️ {e}")
        print("\n엔드포인트가 다르면 .env에 지정하세요:")
        print("  AX_STT_URL=https://.../v1/audio/transcriptions")
        print("  AX_STT_MODEL=...")
