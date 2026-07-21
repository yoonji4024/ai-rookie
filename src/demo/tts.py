"""TTS 클라이언트 — NC VARCO Voice (국내 서비스, 대회 규정 부합).

⚠️ 엔드포인트 규격 미확정
   voice.varco.ai의 API Guide / 대회 제공 안내에서 아래 3가지를 확인하면
   `VarcoTTS._request()` 한 곳만 고치면 된다.
     1) 엔드포인트 URL
     2) 요청 스키마 (text, speaker, speed, emotion 등 필드명)
     3) 응답 형식 (audio 바이너리 직접 / URL / base64)

⚠️ 합성 음성의 한계 (반드시 문서·발표에 명시)
   TTS는 기계적으로 안정된 음성이라 **음질 저하(jitter·shimmer·HNR·CPP)를 재현하지 못한다.**
   → 데모의 발음 정확도 축은 실제 Kang 화자 값을 병행 표기한다.
   → 합성 음성은 **탐지 분류기 학습에 절대 사용하지 않는다** (CLAUDE.md §7).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import requests


@dataclass
class TTSVoice:
    """화자·말투 설정. 노인 음성 흉내를 위한 파라미터."""

    speaker: str = "default"
    speed: float = 0.9        # 1.0 미만 = 느리게 (노인 발화 속도 근사)
    pitch: float = 0.0
    emotion: str = "neutral"


class TTSClient:
    """TTS 인터페이스. 엔진이 바뀌어도 synthesize()만 유지하면 된다."""

    def synthesize(self, text: str, out_path: str | Path, voice: TTSVoice | None = None) -> Path:
        raise NotImplementedError


class VarcoTTS(TTSClient):
    """NC VARCO Voice TTS.

    규격 확인 후 BASE_URL·payload·응답 처리만 맞추면 동작한다.
    """

    BASE_URL = os.environ.get("VARCO_TTS_URL", "https://voice.varco.ai/api/v1/tts")

    def __init__(self, api_key: str | None = None, timeout: int = 60):
        self.api_key = api_key or os.environ.get("VARCO_API_KEY")
        self.timeout = timeout

    def _request(self, text: str, voice: TTSVoice) -> bytes:
        if not self.api_key:
            raise RuntimeError("VARCO_API_KEY 미설정 — .env 확인")
        payload = {
            "text": text,
            "speaker": voice.speaker,
            "speed": voice.speed,
            "pitch": voice.pitch,
            "emotion": voice.emotion,
        }
        r = requests.post(
            self.BASE_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=payload, timeout=self.timeout,
        )
        r.raise_for_status()
        ctype = r.headers.get("Content-Type", "")
        if "audio" in ctype:                       # 바이너리 직접
            return r.content
        data = r.json()                            # URL 또는 base64
        if isinstance(data, dict):
            if url := (data.get("audio_url") or data.get("url")):
                return requests.get(url, timeout=self.timeout).content
            if b64 := (data.get("audio") or data.get("audio_base64")):
                import base64
                return base64.b64decode(b64)
        raise RuntimeError(f"TTS 응답 형식 불명: {str(data)[:200]}")

    def synthesize(self, text: str, out_path: str | Path, voice: TTSVoice | None = None) -> Path:
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(self._request(text, voice or TTSVoice()))
        return out_path


class NullTTS(TTSClient):
    """TTS 미연동 시 대체 — 대본만 텍스트로 저장하고 파이프라인은 계속 돈다."""

    def synthesize(self, text: str, out_path: str | Path, voice: TTSVoice | None = None) -> Path:
        out_path = Path(out_path).with_suffix(".txt")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        return out_path


def get_tts(prefer_varco: bool = True) -> TTSClient:
    """사용 가능한 TTS 반환. VARCO 규격/키가 없으면 NullTTS로 폴백."""
    if prefer_varco and os.environ.get("VARCO_API_KEY"):
        return VarcoTTS()
    return NullTTS()
