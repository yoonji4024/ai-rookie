"""One bounded streaming request for browser PCM; no batch retry or text rewriting."""
import asyncio
import math
import tempfile
import uuid
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from src.common.stt import AXSTT, STTError, Transcript, Utterance, WS_BASE, MODEL_STREAM

def prepare_pcm(source, target):
    source=Path(source)
    if source.stat().st_size > 16*1024*1024:
        raise STTError('녹음 크기가 허용 범위를 넘었습니다.')
    info=sf.info(str(source))
    if info.format not in {'WAV','WAVEX'} or info.subtype not in {'PCM_16','PCM_24','PCM_32','FLOAT'}:
        raise STTError('PCM WAV 녹음이 필요합니다.')
    if not 8000 <= info.samplerate <= 96000 or not 1 <= info.channels <= 2 or not 0 < info.duration <= 65:
        raise STTError('녹음 길이 또는 형식을 확인해 주세요.')
    samples,rate=sf.read(str(source),dtype='float32',always_2d=True)
    if not np.isfinite(samples).all():
        raise STTError('유효하지 않은 오디오입니다.')
    mono=samples.mean(axis=1)
    if rate!=16000:
        common=math.gcd(rate,16000)
        mono=resample_poly(mono,16000//common,rate//common)
    sf.write(str(target),np.clip(mono,-1,1),16000,subtype='PCM_16')

class RuntimeSTT(AXSTT):
    def transcribe_streaming(self,audio_path,keywords=None):
        with tempfile.TemporaryDirectory(prefix='memflix_pcm_') as folder:
            wav=Path(folder)/'input.wav'
            prepare_pcm(audio_path,wav)
            async def once():
                return await asyncio.wait_for(self._stream_pcm_wav(wav,[]),timeout=110)
            return asyncio.run(once())

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

        if last_partial and not utterances:
            raise STTError("최종 전사를 받지 못했습니다.")
        if not utterances:
            raise STTError("Streaming 전사 결과가 비어 있음")
        return Transcript(utterances=utterances, duration=duration)


def transcribe_once(path,keywords=None):
    # No reference-answer hints: only the user's waveform determines this text.
    return RuntimeSTT().transcribe_streaming(path).text
