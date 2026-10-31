// NCSOFT VARCO Voice TTS 연동 공용 유틸.
// VARCO API는 브라우저 직접 호출을 막고 있어(CORS 응답 헤더 없음) 프론트엔드에서
// 바로 fetch할 수 없다. 같은 출처의 채점 백엔드가 대신 요청하면서 API 키를
// 서버에서만 붙인다 — 키가 클라이언트 번들에 들어가지 않는다.
const VARCO_TTS_PROXY_PATH = "/api/score/tts";

/** "미리엘(행복)" — 여성/노년/중음/거침/구수한 톤. 예시 답변 재생용 */
export const GRANDMA_ANSWER_VOICE_ID = "ac19386b-adc3-58e2-afe4-f96713ef0f5b";

export interface VarcoTtsProperties {
  /** 0.5~1.5, 기본 0.95 */
  speed?: number;
  /** 0.5~1.5, 기본 1 */
  pitch?: number;
}

/** 텍스트를 VARCO Voice로 합성해 base64 WAV 오디오만 받아온다 (재생은 호출자가 담당) */
export async function synthesizeVarcoTts(
  text: string,
  voiceId: string,
  properties?: VarcoTtsProperties,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(VARCO_TTS_PROXY_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      text,
      language: "korean",
      voice: voiceId,
      properties: { speed: 0.95, pitch: 1, ...properties },
      n_fm_steps: 8,
      seed: -1,
      return_metadata: false,
    }),
  });
  if (!res.ok) throw new Error(`음성을 준비하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요. (HTTP ${res.status})`);
  const data = await res.json();
  if (typeof data.audio !== 'string' || !data.audio.trim()) {
    throw new Error('재생할 음성을 받지 못했어요. 다시 시도해 주세요.');
  }
  return data.audio;
}

/**
 * 텍스트를 VARCO Voice로 합성해 바로 재생한다.
 * @returns 재생을 즉시 중단하는 함수 (컴포넌트 언마운트/토글 시 호출)
 */
export function playVarcoTts(
  text: string,
  voiceId: string,
  onEnd: () => void,
  properties?: VarcoTtsProperties,
  onStart?: () => void,
  onError?: (error: Error) => void,
): () => void {
  let cancelled = false;
  let audio: HTMLAudioElement | null = null;
  let started = false;
  let settled = false;
  const controller = new AbortController();
  const finish = (error?: Error) => {
    if (cancelled || settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error && onError) onError(error);
    else {
      // Preserve recovery for existing callers without an error callback.
      if (error && !started) onStart?.();
      onEnd();
    }
  };
  const timeout = setTimeout(() => {
    finish(new Error('음성 연결이 늦어지고 있어요. 다시 시도해 주세요.'));
    controller.abort();
    audio?.pause();
  }, 65000);

  (async () => {
    try {
      const audioB64 = await synthesizeVarcoTts(text, voiceId, properties, controller.signal);
      if (cancelled || settled) return;

      audio = new Audio(`data:audio/wav;base64,${audioB64}`);
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('음성을 재생하지 못했어요. 브라우저의 소리 설정을 확인해 주세요.'));
      await audio.play();
      if (cancelled || settled) return;
      started = true;
      clearTimeout(timeout);
      onStart?.();
    } catch (err) {
      if (!cancelled) {
        console.error("VARCO TTS 합성/재생 실패:", err);
        finish(err instanceof Error && err.name === 'NotAllowedError'
          ? new Error('브라우저에서 소리 재생이 차단됐어요. 소리를 허용한 뒤 다시 눌러 주세요.')
          : err instanceof Error ? err : new Error('음성을 재생하지 못했어요. 다시 시도해 주세요.'));
      }
    }
  })();

  return () => {
    cancelled = true;
    clearTimeout(timeout);
    controller.abort();
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
  };
}

/** 이미 합성해 둔 WAV를 바로 재생한다. 대화 시작 문장이 나오는 동안 다음
 * 문장의 TTS를 준비해 두었다가 끊김 없이 이어 말할 때 사용한다. */
export function playSynthesizedVarcoAudio(
  audioB64: string,
  onEnd: () => void,
  onStart?: () => void,
): () => void {
  let cancelled = false;
  let ended = false;
  const audio = new Audio(`data:audio/wav;base64,${audioB64}`);
  const finish = () => {
    if (cancelled || ended) return;
    ended = true;
    onEnd();
  };

  audio.onended = finish;
  audio.onerror = finish;
  void audio.play()
    .then(() => {
      if (!cancelled) onStart?.();
    })
    .catch(() => {
      if (!cancelled) {
        onStart?.();
        finish();
      }
    });

  return () => {
    cancelled = true;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
  };
}
