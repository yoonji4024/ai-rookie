"""A.X STT 클라이언트 (SKT, 전국민 AI 경진대회).

규격 (A.X STT API 가이드 v1.3)
  Base URL  https://awf-gw.adot.ai   (WebSocket: wss://awf-gw.adot.ai)
  인증      `X-API-Key: {KEY}`   ← ⚠️ LLM API는 Bearer, STT는 X-API-Key (키는 동일)
  모델      A.X_STT_note_batch / A.X_STT_note_streaming

  Batch 3단계
    1) GET  /v1/stt/upload-token?fileSize=N   → upload_token
    2) PUT  /v1/stt/upload/{token}            → file_key   (octet-stream)
    3) POST /v1/stt/transcript                → utterances[]
  한도: 파일당 100MB / 30분

  ⚠️ **화자 분리(speaker)는 Batch에서만 지원.** Streaming은 미지원.
     Kang은 조사자(INV)+참가자(PAR)가 섞인 인터뷰라 화자 분리가 필수 → Batch 사용.

왜 중요한가 (CLAUDE.md §4, §13)
  런타임은 사람이 만든 전사가 아니라 STT 출력으로 피처를 뽑는다.
  STT가 disfluency를 다듬으면  "제가 즈 , 나 , 제 , 제가" → "제가"
  처럼 파편반복·어미미완성 신호가 사라진다 → stt_shift.py로 보존율을 측정한다.
"""
from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import requests

from src.common.llm import load_env

load_env()

BASE = os.environ.get("AX_STT_BASE", "https://awf-gw.adot.ai")
WS_BASE = os.environ.get("AX_STT_WS", "wss://awf-gw.adot.ai")
MODEL_BATCH = "A.X_STT_note_batch"
MODEL_STREAM = "A.X_STT_note_streaming"

MAX_BYTES = 100 * 1024 * 1024      # 100MB
MAX_SECONDS = 30 * 60              # 30분


class STTError(RuntimeError):
    pass


@dataclass
class Utterance:
    text: str
    start: float
    end: float
    speaker: int | None = None      # 화자 index (Batch만)


@dataclass
class Transcript:
    utterances: list[Utterance] = field(default_factory=list)
    duration: float = 0.0
    raw: dict = field(default_factory=dict)

    @property
    def text(self) -> str:
        return " ".join(u.text for u in self.utterances if u.text)

    def by_speaker(self, speaker: int) -> list[Utterance]:
        return [u for u in self.utterances if u.speaker == speaker]

    @property
    def speakers(self) -> list[int]:
        return sorted({u.speaker for u in self.utterances if u.speaker is not None})

    def speaker_durations(self) -> dict[int, float]:
        return {s: sum(u.end - u.start for u in self.by_speaker(s)) for s in self.speakers}

    def main_speaker(self) -> int | None:
        """가장 오래 말한 화자 — 인터뷰에서 보통 참가자(PAR).

        ⚠️ 화자 분리가 3명 이상으로 나오기도 한다(잡음·중첩). 이때도 최장 화자를
           참가자로 보되, 2위와의 격차가 작으면 신뢰도가 낮으므로 호출부에서 확인할 것
           (diarization_confidence 참고).
        """
        d = self.speaker_durations()
        return max(d, key=d.get) if d else None

    def diarization_confidence(self) -> float:
        """주 화자 발화 비중 (0~1). 낮으면 화자 분리를 믿기 어렵다."""
        d = self.speaker_durations()
        total = sum(d.values())
        return max(d.values()) / total if total else 0.0


class AXSTT:
    def __init__(self, api_key: str | None = None, timeout: int = 600):
        self.api_key = api_key or os.environ.get("AX_API_KEY")
        self.timeout = timeout

    @property
    def headers(self) -> dict:
        if not self.api_key:
            raise STTError("AX_API_KEY 미설정 — .env 확인")
        return {"X-API-Key": self.api_key}      # ⚠️ Bearer 아님

    # ── Batch 3단계 ─────────────────────────────────────────
    def _upload_token(self, size: int) -> str:
        r = requests.get(f"{BASE}/v1/stt/upload-token", params={"fileSize": size},
                         headers=self.headers, timeout=60)
        if not r.ok:
            raise STTError(f"토큰 발급 실패 {r.status_code}: {r.text[:200]}")
        tok = r.json().get("upload_token")
        if not tok:
            raise STTError(f"upload_token 없음: {r.text[:200]}")
        return tok

    def _upload(self, token: str, path: Path) -> str:
        with open(path, "rb") as f:
            r = requests.put(
                f"{BASE}/v1/stt/upload/{token}",
                headers={**self.headers, "Content-Type": "application/octet-stream"},
                data=f, timeout=self.timeout,
            )
        if not r.ok:
            raise STTError(f"업로드 실패 {r.status_code}: {r.text[:200]}")
        key = r.json().get("file_key")
        if not key:
            raise STTError(f"file_key 없음: {r.text[:200]}")
        return key

    def _transcript(self, file_key: str, keywords: list[str] | None = None) -> dict:
        payload = {
            "message_id": f"airookie-{uuid.uuid4().hex[:12]}",
            "speech_model": MODEL_BATCH,
            "audio_file_key": file_key,
        }
        if keywords:
            payload["keywords"] = keywords
        r = requests.post(f"{BASE}/v1/stt/transcript", headers=self.headers,
                          json=payload, timeout=self.timeout)
        if not r.ok:
            raise STTError(f"인식 실패 {r.status_code}: {r.text[:300]}")
        return r.json()

    def transcribe(self, audio_path: str | Path,
                   keywords: list[str] | None = None,
                   retries: int = 2) -> Transcript:
        """Batch 전사 (화자 분리 포함)."""
        path = Path(audio_path)
        size = path.stat().st_size
        if size > MAX_BYTES:
            raise STTError(f"파일 {size/1e6:.0f}MB > 한도 100MB — 분할 필요")

        last: Exception | None = None
        for attempt in range(retries + 1):
            try:
                token = self._upload_token(size)
                key = self._upload(token, path)
                return self._parse(self._transcript(key, keywords))
            except STTError as e:
                last = e
                if "429" in str(e) or "500" in str(e):
                    time.sleep(2 ** attempt)      # 지수 백오프
                    continue
                raise
        raise STTError(f"재시도 소진: {last}")

    @staticmethod
    def _parse(d: dict) -> Transcript:
        """**단어 단위 화자**로 발화를 재구성한다.

        ⚠️ STT의 utterance 경계는 화자 전환과 일치하지 않는다.
           실측 예: 한 utterance 안에 조사자 질문과 참가자 답변이 함께 들어옴
             "...즐겨보신 거 있으세요? 드라마 봤어요."
           → utterance 단위로 다수결 화자를 매기면 상대 화자 발화가 섞여
             참가자 텍스트가 오염된다.
           → words[].speaker로 **연속 동일 화자 구간**을 묶어 발화를 다시 만든다.
        """
        words = []
        for u in d.get("utterances", []):
            for w in (u.get("words") or []):
                t = (w.get("text") or "").strip()
                if t:
                    words.append((w.get("speaker"), t,
                                  float(w.get("start_time", 0)),
                                  float(w.get("end_time", 0))))

        if not words:      # words가 없으면 utterance 그대로 (화자 미상)
            utts = [Utterance((u.get("text") or "").strip(),
                              float(u.get("start_time", 0)),
                              float(u.get("end_time", 0)))
                    for u in d.get("utterances", [])]
            return Transcript(utts, float(d.get("transcript_duration", 0)), d)

        words.sort(key=lambda x: x[2])
        utts, cur_spk, buf, st, en = [], words[0][0], [], words[0][2], words[0][3]
        for spk, txt, s, e in words:
            if spk != cur_spk:                      # 화자 전환 → 발화 확정
                utts.append(Utterance(" ".join(buf), st, en, cur_spk))
                cur_spk, buf, st = spk, [], s
            buf.append(txt)
            en = e
        if buf:
            utts.append(Utterance(" ".join(buf), st, en, cur_spk))
        return Transcript(utts, float(d.get("transcript_duration", 0)), d)


def get_stt() -> AXSTT:
    return AXSTT()


if __name__ == "__main__":
    import sys

    stt = get_stt()
    target = sys.argv[1] if len(sys.argv) > 1 else None
    if not target:
        from src.preprocessing.kang_loader import load_kang
        target = load_kang()[0].wav_path

    p = Path(target)
    print(f"Base: {BASE} | 모델: {MODEL_BATCH} | 인증: X-API-Key")
    print(f"대상: {p.name} ({p.stat().st_size/1e6:.1f}MB)\n")
    try:
        t = stt.transcribe(target)
        print(f"길이 {t.duration:.0f}초 | 발화 {len(t.utterances)}개 | 화자 {t.speakers}")
        dur = t.speaker_durations()
        for s in t.speakers:
            print(f"  sp{s}: {dur[s]:6.1f}초 ({dur[s]/sum(dur.values())*100:4.1f}%)")
        main = t.main_speaker()
        conf = t.diarization_confidence()
        print(f"주 화자: sp{main} (비중 {conf:.0%})"
              + ("  ⚠️ 비중이 낮아 화자 분리 신뢰도 주의" if conf < 0.5 else ""))

        print("\n[화자별 발화 — 질문/답변이 섞이지 않아야 정상]")
        for u in t.utterances[:8]:
            tag = "★참가자" if u.speaker == main else "  조사자"
            print(f"  [{u.start:6.1f}] {tag} sp{u.speaker}: {u.text[:55]}")
    except STTError as e:
        print(f"⚠️ {e}")
