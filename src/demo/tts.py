"""TTS 클라이언트 — NC VARCO Voice (국내 서비스, 대회 규정 부합).

API 규격 (VARCO API Platform · Text To Speech Standard)
  화자 목록  GET  https://openapi.ai.nc.com/tts/standard/v1/api/voices/varco
  음성 합성  POST https://openapi.ai.nc.com/tts/standard/v1/api/synthesize
  인증      헤더 `OPENAPI_KEY: {키}`   ← Bearer 아님
  응답      JSON {"audio": "<base64 wav>"}
  제약      text 최대 1,200바이트 / speed·pitch 0.5~1.5(권장 0.8~1.2) / n_fm_steps 8~20

왜 Standard인가: Lite는 실시간용이고, Standard는 감정·연기 표현이 가능해
                어르신의 머뭇거림·힘 없는 말투를 흉내내기에 적합.

재현성: seed를 양수로 고정하면 항상 같은 음성이 나온다. 데모는 기본 고정 seed를 쓴다.

⚠️ 합성 음성의 한계 (문서·발표에 명시할 것)
   TTS는 기계적으로 안정된 음성이라 **음질 저하(jitter·shimmer·HNR·CPP)를 재현하지 못한다.**
   → 데모의 발음 정확도 축은 실제 Kang 화자 값을 병행 표기한다.
   → 합성 음성은 **탐지 분류기 학습에 절대 사용하지 않는다** (CLAUDE.md §7).
"""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path

import requests

from src.common.llm import load_env   # .env 로딩(공통)

load_env()

BASE = "https://openapi.ai.nc.com/tts/standard/v1/api"
VOICES_URL = f"{BASE}/voices/varco"
SYNTH_URL = f"{BASE}/synthesize"
MAX_BYTES = 1200


@dataclass
class TTSVoice:
    """화자·말투 설정."""

    voice_uuid: str = ""          # speaker_uuid (비우면 노년 화자 자동 선택)
    speed: float = 1.0            # 0.5~1.5 (권장 0.8~1.2). 노인 발화는 느리게
    pitch: float = 1.0
    language: str = "korean"
    n_fm_steps: int = 8           # 품질↑ 속도↓ (8~20)
    seed: int = 42                # 양수 고정 = 재현 가능한 음성


class TTSClient:
    """TTS 인터페이스. 엔진이 바뀌어도 synthesize()만 유지하면 된다."""

    def synthesize(self, text: str, out_path: str | Path, voice: TTSVoice | None = None) -> Path:
        raise NotImplementedError


class VarcoTTS(TTSClient):
    """NC VARCO Voice — Text To Speech (Standard)."""

    def __init__(self, api_key: str | None = None, timeout: int = 60):
        self.api_key = api_key or os.environ.get("VARCO_API_KEY")
        self.timeout = timeout
        self._voices: list[dict] | None = None

    @property
    def headers(self) -> dict:
        if not self.api_key:
            raise RuntimeError("VARCO_API_KEY 미설정 — .env 확인")
        return {"OPENAPI_KEY": self.api_key}

    # ── 화자 ────────────────────────────────────────────────
    def list_voices(self, refresh: bool = False) -> list[dict]:
        """전체 화자 목록 (1,293명). {speaker_uuid, speaker_name, description}"""
        if self._voices is None or refresh:
            r = requests.get(VOICES_URL, headers=self.headers, timeout=self.timeout)
            r.raise_for_status()
            self._voices = r.json()
        return self._voices

    def find_voices(self, *keywords: str) -> list[dict]:
        """설명(description)으로 화자 검색. 예: find_voices('노년', '여성')"""
        return [
            v for v in self.list_voices()
            if all(k in (v.get("description") or "") for k in keywords)
        ]

    def pick_elderly(self, gender: str = "", prefer: str = "중립") -> dict | None:
        """노년 화자 1명 고르기. gender='남성'|'여성', prefer는 이름에 포함된 감정."""
        cands = self.find_voices("노년", *( [gender] if gender else [] ))
        if not cands:
            return None
        named = [v for v in cands if prefer in (v.get("speaker_name") or "")]
        return (named or cands)[0]

    # ── 합성 ────────────────────────────────────────────────
    def _synthesize_chunk(self, text: str, voice: TTSVoice) -> bytes:
        payload = {
            "text": text,
            "language": voice.language,
            "voice": voice.voice_uuid,
            "properties": {"speed": voice.speed, "pitch": voice.pitch},
            "n_fm_steps": voice.n_fm_steps,
            "seed": voice.seed,
            "return_metadata": False,
        }
        r = requests.post(SYNTH_URL, headers=self.headers, json=payload, timeout=self.timeout)
        r.raise_for_status()
        audio = r.json().get("audio")
        if not audio:
            raise RuntimeError(f"TTS 응답에 audio 없음: {str(r.json())[:200]}")
        return base64.b64decode(audio)

    def synthesize(self, text: str, out_path: str | Path, voice: TTSVoice | None = None) -> Path:
        """텍스트 → wav 파일. 1,200바이트 초과 시 문장 단위로 나눠 합성 후 이어붙인다."""
        voice = voice or TTSVoice()
        if not voice.voice_uuid:
            v = self.pick_elderly()
            if v is None:
                raise RuntimeError("노년 화자를 찾지 못했습니다 — voice_uuid를 직접 지정하세요")
            voice.voice_uuid = v["speaker_uuid"]

        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        chunks = _split_by_bytes(text, MAX_BYTES)
        if len(chunks) == 1:
            out_path.write_bytes(self._synthesize_chunk(chunks[0], voice))
            return out_path

        _concat_wav([self._synthesize_chunk(c, voice) for c in chunks], out_path)
        return out_path


class NullTTS(TTSClient):
    """TTS 미연동 시 대체 — 대본만 텍스트로 저장하고 파이프라인은 계속 돈다."""

    def synthesize(self, text: str, out_path: str | Path, voice: TTSVoice | None = None) -> Path:
        out_path = Path(out_path).with_suffix(".txt")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        return out_path


def get_tts(prefer_varco: bool = True) -> TTSClient:
    """사용 가능한 TTS 반환. 키 없으면 NullTTS 폴백."""
    if prefer_varco and os.environ.get("VARCO_API_KEY"):
        return VarcoTTS()
    return NullTTS()


# ── helpers ─────────────────────────────────────────────────
def _split_by_bytes(text: str, limit: int) -> list[str]:
    """문장 경계 우선으로 바이트 제한 이하 조각으로 분할."""
    if len(text.encode("utf-8")) <= limit:
        return [text]
    parts, cur = [], ""
    for sent in _sentences(text):
        cand = (cur + " " + sent).strip()
        if len(cand.encode("utf-8")) > limit and cur:
            parts.append(cur)
            cur = sent
        else:
            cur = cand
    if cur:
        parts.append(cur)
    return parts


def _sentences(text: str) -> list[str]:
    import re
    return [s for s in re.split(r"(?<=[.!?…])\s+", text.strip()) if s]


def _concat_wav(wavs: list[bytes], out_path: Path) -> None:
    """여러 wav 바이트를 하나로 병합."""
    import io
    import wave

    with wave.open(str(out_path), "wb") as w:
        params = None
        for b in wavs:
            with wave.open(io.BytesIO(b), "rb") as r:
                if params is None:
                    params = r.getparams()
                    w.setparams(params)
                w.writeframes(r.readframes(r.getnframes()))


if __name__ == "__main__":
    tts = get_tts()
    if isinstance(tts, NullTTS):
        raise SystemExit("VARCO_API_KEY 없음 — .env 확인")

    print("화자 목록 조회…")
    voices = tts.list_voices()
    print(f"  전체 {len(voices)}명")

    for g in ("여성", "남성"):
        elderly = tts.find_voices("노년", g)
        print(f"\n  노년·{g}: {len(elderly)}명")
        for v in elderly[:5]:
            print(f"    {v['speaker_name']:20s} {v['description']}")

    pick = tts.pick_elderly("여성")
    print(f"\n데모 기본 화자: {pick['speaker_name'] if pick else '없음'}")
