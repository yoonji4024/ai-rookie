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
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import requests

from src.common.llm import load_env

load_env()

BASE = os.environ.get("AX_STT_BASE", "https://awf-gw.adot.ai")
# STT_DEBUG=1 → 각 단계의 응답 원문 출력. 응답 스키마가 문서와 다를 때 추적용.
STT_DEBUG = os.environ.get("STT_DEBUG") == "1"


def prepare_for_stt(path: str | Path, max_mb: float = 95.0) -> Path:
    """STT 업로드용으로 오디오를 16kHz 모노로 변환(필요할 때만).

    왜 필요한가 — 원본이 44.1kHz 스테레오면 10분 녹음이 100MB를 넘어 한도에 걸린다
    (임상 파일 1020초 = 180MB). 16kHz 모노로 바꾸면 약 1/11로 줄고,
    STT 권장 포맷과도 일치한다. **타임스탬프는 시간 기준이라 그대로 유효하다.**

    이미 16kHz 모노이고 한도 이하면 원본을 그대로 반환한다.
    """
    import soundfile as sf
    p = Path(path)
    size_mb = p.stat().st_size / 1e6
    try:
        info = sf.info(str(p))
        ok = info.samplerate == 16000 and info.channels == 1
    except Exception:
        ok, info = False, None
    if ok and size_mb <= max_mb:
        return p

    import librosa
    y, sr = librosa.load(str(p), sr=16000, mono=True)
    out = Path(tempfile.gettempdir()) / f"stt16k_{p.stem}.wav"
    sf.write(out, y, 16000, subtype="PCM_16")
    print(f"  [변환] {p.name} {size_mb:.0f}MB → {out.stat().st_size/1e6:.0f}MB (16kHz 모노)")
    return out


def _safe_json(r) -> dict:
    """본문이 비었거나 JSON이 아니어도 죽지 않는다. 실패 시 빈 dict."""
    if not (r.text or "").strip():
        return {}
    try:
        d = r.json()
        return d if isinstance(d, dict) else {"_raw": d}
    except Exception:
        return {}
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
        d = _safe_json(r)
        if STT_DEBUG:
            print(f"  [debug] upload-token {r.status_code} → {str(d)[:200]}")
        self._token_body = d                     # 업로드 응답이 비었을 때 참조
        tok = d.get("upload_token") or d.get("uploadToken")
        if not tok:
            raise STTError(f"upload_token 없음: {r.text[:200]}")
        return tok

    def _upload(self, token: str, path: Path) -> str:
        """업로드 후 file_key 확보.

        ⚠️ 이 엔드포인트는 성공(2xx)해도 **본문이 비어 있을 수 있다.**
           r.json()을 무조건 부르면 JSONDecodeError로 죽는다(실제 발생).
           본문이 없으면 토큰 발급 응답의 file_key, 그것도 없으면 토큰 자체를 쓴다.
        """
        # ⚠️ 파일 객체를 data=로 넘기면 requests가 Transfer-Encoding: chunked 를 쓴다.
        #    이 경로 앞단의 WAF가 chunked 업로드를 거부한다("Request Rejected" HTML).
        #    바이트로 읽어 Content-Length를 명시해야 통과한다.
        raw = path.read_bytes()
        url = f"{BASE}/v1/stt/upload/{token}"
        media_type = {
            ".wav": "audio/wav",
            ".m4a": "audio/mp4",
            ".mp4": "audio/mp4",
            ".caf": "audio/x-caf",
        }.get(path.suffix.lower(), "application/octet-stream")

        def _put(headers: dict):
            return requests.put(url, headers=headers, data=raw, timeout=self.timeout)

        attempts = [
            {**self.headers, "Content-Type": "application/octet-stream",
             "Content-Length": str(len(raw))},
            # 실제 파일 형식을 명시한 인증 요청. 이전에는 M4A/CAF까지 audio/wav로
            # 보내 형식 불일치가 WAF 오탐을 유발할 수 있었다.
            {**self.headers, "Content-Type": media_type,
             "Content-Length": str(len(raw))},
            # 업로드 토큰 자체가 인증인 배포 환경을 위한 무인증 조합.
            {"Content-Type": "application/octet-stream", "Content-Length": str(len(raw))},
            {"Content-Type": media_type, "Content-Length": str(len(raw))},
        ]
        r = None
        for i, h in enumerate(attempts, 1):
            r = _put(h)
            rejected = "Request Rejected" in (r.text or "")
            if STT_DEBUG:
                print(f"  [debug] upload 시도{i} {r.status_code} "
                      f"{'WAF 거부' if rejected else 'OK'} body={r.text[:120]!r}")
            if r.ok and not rejected:
                break
        if r is None or not r.ok:
            raise STTError(f"업로드 실패 {getattr(r,'status_code','?')}: {getattr(r,'text','')[:200]}")
        if "Request Rejected" in (r.text or ""):
            raise STTError(
                "업로드가 WAF에 거부됨(Request Rejected). "
                "네트워크(사내망·VPN·프록시)를 바꿔 재시도하거나 SKT에 support ID로 문의 필요. "
                f"응답: {r.text[:150]}")

        d = _safe_json(r)

        key = (d.get("file_key") or d.get("fileKey")
               or getattr(self, "_token_body", {}).get("file_key")
               or getattr(self, "_token_body", {}).get("fileKey")
               or token)                          # 최후: 토큰이 곧 키인 설계
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

    def transcribe_streaming(self, audio_path: str | Path,
                             keywords: list[str] | None = None) -> Transcript:
        """공식 Streaming API로 녹음 파일을 실시간 속도로 전송한다.

        Batch의 파일 PUT이 WAF에 거절될 때 사용하는 폴백이다. Streaming 규격은
        16kHz/16bit/mono 헤더 없는 PCM 청크이므로 입력 형식과 무관하게 ffmpeg로
        표준 WAV를 만든 뒤 ``wave.readframes``로 헤더를 제외해 전송한다.
        """
        import asyncio
        import subprocess

        source = Path(audio_path)
        with tempfile.TemporaryDirectory(prefix="ax_stt_stream_") as tmp_name:
            wav_path = Path(tmp_name) / "audio_16k.wav"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(source), "-ar", "16000", "-ac", "1",
                "-c:a", "pcm_s16le", str(wav_path),
            ], check=True, timeout=45)
            return asyncio.run(self._stream_pcm_wav(wav_path, keywords or []))

    async def _stream_pcm_wav(self, wav_path: Path,
                              keywords: list[str]) -> Transcript:
        import asyncio
        import base64
        import certifi
        import json
        import ssl
        import wave

        try:
            import websockets
        except ImportError as exc:
            raise STTError("Streaming 폴백에 websockets 패키지가 필요함") from exc

        tr_id = f"memflix-{uuid.uuid4().hex[:12]}"
        url = f"{WS_BASE}/v1/stt/realtime"
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        utterances: list[Utterance] = []
        last_partial = ""

        with wave.open(str(wav_path), "rb") as wf:
            sample_rate = wf.getframerate()
            if sample_rate != 16000 or wf.getnchannels() != 1 or wf.getsampwidth() != 2:
                raise STTError("Streaming 오디오는 16kHz/16bit/mono PCM이어야 함")
            chunk_frames = int(sample_rate * 0.1)  # 공식 권장 범위 내 100ms
            duration = wf.getnframes() / sample_rate
            # 기본은 API 가이드의 실시간 속도(1.0). 시연 환경에서 더 빠른 전송이
            # 누락 없이 동작하는지 실측할 때만 환경변수로 낮춰 비교한다.
            try:
                pacing = min(1.0, max(0.05, float(
                    os.environ.get("AX_STT_STREAM_PACING", "1.0")
                )))
            except ValueError:
                pacing = 1.0

            try:
                async with websockets.connect(
                    url,
                    additional_headers=self.headers,
                    ssl=ssl_context,
                    open_timeout=15,
                    close_timeout=5,
                ) as ws:
                    create = {
                        "message_type": "create",
                        "speech_model": MODEL_STREAM,
                        "audio_format": "pcm_16k",
                        "vad_type": "semantic",
                        "partial": True,
                        "tr_id": tr_id,
                    }
                    if keywords:
                        create["keywords"] = keywords
                    await ws.send(json.dumps(create, ensure_ascii=False))
                    created = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                    if created.get("message_type") != "created" or created.get("code") != 0:
                        raise STTError(f"Streaming 채널 생성 실패: {created.get('error', created)}")

                    async def receive_results():
                        nonlocal last_partial
                        try:
                            async for raw in ws:
                                data = json.loads(raw)
                                message_type = data.get("message_type")
                                if message_type == "transcript":
                                    text = str(data.get("text", "")).strip()
                                    if not text:
                                        continue
                                    if data.get("final"):
                                        if not utterances or utterances[-1].text != text:
                                            utterances.append(Utterance(
                                                text=text,
                                                start=float(data.get("start_time", 0.0)),
                                                end=float(data.get("end_time", duration)),
                                            ))
                                    else:
                                        last_partial = text
                                elif message_type == "stopped":
                                    return
                                elif data.get("code", 0) not in (0, None):
                                    raise STTError(f"Streaming 인식 실패: {data}")
                        except websockets.exceptions.ConnectionClosed as exc:
                            # 일부 게이트웨이는 stopped/close 프레임 없이 연결을 닫는다.
                            # 그 전에 최종/중간 전사를 받았다면 결과는 보존한다.
                            if not utterances and not last_partial:
                                raise STTError(f"Streaming 연결 조기 종료: {exc}") from exc

                    receiver = asyncio.create_task(receive_results())
                    while True:
                        chunk = wf.readframes(chunk_frames)
                        if not chunk:
                            break
                        await ws.send(json.dumps({
                            "message_type": "audio",
                            "data": base64.b64encode(chunk).decode("ascii"),
                        }))
                        # 파일을 몰아서 보내면 VAD/인식 서버가 청크를 누락할 수 있으므로
                        # 가이드대로 실제 재생 속도를 유지한다.
                        await asyncio.sleep(0.1 * pacing)

                    await ws.send(json.dumps({"message_type": "stop"}))
                    timeout = max(30.0, duration + 20.0)
                    await asyncio.wait_for(receiver, timeout=timeout)
            except STTError:
                raise
            except Exception as exc:
                raise STTError(f"Streaming 연결/인식 실패: {type(exc).__name__}: {exc}") from exc

        if not utterances and last_partial:
            utterances.append(Utterance(last_partial, 0.0, duration))
        if not utterances:
            raise STTError("Streaming 전사 결과가 비어 있음")
        return Transcript(utterances=utterances, duration=duration)

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
