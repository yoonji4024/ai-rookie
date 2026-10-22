// ============================================================================
// speak() 3단 폴백 구현.
//
//   baked  — 빌드 타임에 구워 둔 WAV(+블렌드셰이프). 네트워크 0, 지연 0.
//   live   — 릴레이 합성. 오디오가 도착하는 즉시 재생을 시작하고,
//            얼굴은 병렬로 받아 도착한 프레임부터 합류시킨다.
//   silent — 무음. 고정 속도로 글자만 드러낸다.
//
// 사다리를 내려가는 조건은 셋뿐이다: 무대 모드이거나, 구운 게 없거나, 릴레이가 실패했거나.
// 어느 칸에서 끝나든 done 은 반드시 settle 된다 — 그것이 이 파일의 유일한 불변식이다.
//
// 얼굴을 직렬로 기다리지 않는 이유: 예전 프로토타입은 TTS 합성 → 얼굴 생성 → 재생 순서라
// 왕복이 2회였고, 그동안 Pet 이 아무 말도 못 한 채 멈춰 있었다.
// ============================================================================

import type { SpeakFn, SpeechEndReason, SpeechHandle, SpeechRequest, SpeechResult, VoiceTier, FaceTrack } from "./speak.ts";
import { createSilentSpeak } from "./speak.ts";
import type { VoiceCache } from "./voiceCache.ts";
import { cacheKey } from "./voiceCache.ts";
import { postFace, postTts } from "./relay.ts";
import { log } from "../obs/log.ts";

export interface SpeakDeps {
  cache: VoiceCache;
  /** 무대 모드면 네트워크를 아예 시도하지 않는다 */
  isStageMode: () => boolean;
  /** 무음 폴백의 글자당 속도 */
  silentMsPerChar?: number;
}

/** 오디오 길이에 맞춰 글자를 드러내는 속도의 상한/하한(ms).
 *  실측값이다 — 한국어 TTS 는 문장부호·억양에 따라 글자당 90~160ms 로 늘어지는 일이 흔하다 */
const MIN_CHAR_MS = 18;
const MAX_CHAR_MS = 260;

export function createSpeak(deps: SpeakDeps): SpeakFn {
  const silent = createSilentSpeak(deps.silentMsPerChar);

  return (req: SpeechRequest): SpeechHandle => {
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    let revealTimer: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let fallback: SpeechHandle | null = null;
    let settle: ((r: SpeechResult) => void) | null = null;
    const started = Date.now();
    const faceAbort = new AbortController();

    const done = new Promise<SpeechResult>((resolve) => {
      settle = resolve;
    });

    function cleanup(): void {
      if (revealTimer !== null) {
        clearInterval(revealTimer);
        revealTimer = null;
      }
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
      }
      faceAbort.abort();
    }

    function finish(tier: VoiceTier, reason: SpeechEndReason): void {
      if (!settle) return;
      cleanup();
      req.onReveal(req.text.length); // 어떤 종료 사유든 문장은 끝까지 보여준다
      const fn = settle;
      settle = null;
      fn({ tier, reason, durationMs: Date.now() - started });
    }

    /** 마지막 칸. 오디오를 쓰지 않으므로 자동재생 정책과 무관하게 항상 끝난다 */
    function goSilent(why: string): void {
      if (cancelled || !settle) return;
      log.info("voice:silent", { why, chars: req.text.length });
      fallback = silent({ ...req, onReveal: req.onReveal });
      void fallback.done.then((r) => finish("silent", r.reason));
    }

    /** 오디오 길이에 글자 속도를 맞춘다 — 말하는 속도와 보이는 속도를 일치시킨다 */
    function startReveal(durationMs: number): void {
      const perChar = Math.min(
        MAX_CHAR_MS,
        Math.max(MIN_CHAR_MS, durationMs / Math.max(1, req.text.length)),
      );
      let shown = 0;
      revealTimer = setInterval(() => {
        shown += 1;
        req.onReveal(Math.min(shown, req.text.length));
        if (shown >= req.text.length && revealTimer !== null) {
          clearInterval(revealTimer);
          revealTimer = null;
        }
      }, perChar);
    }

    function play(tier: VoiceTier, url: string, face: FaceTrack | null): void {
      if (cancelled || !settle) return;

      audio = new Audio(url);
      req.onAudio?.(audio);
      if (face && req.withFace) req.onFace?.(face);

      audio.onerror = () => goSilentFrom(tier, "audio-error");
      audio.onended = () => finish(tier, "ended");

      const begin = (): void => {
        if (cancelled || !audio) return;
        const durationMs =
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration * 1000
            : req.text.length * 60;
        startReveal(durationMs);

        // ended 이벤트는 유실될 수 있다. 이것이 없으면 대화가 멈춘 채로 남는다.
        watchdog = setTimeout(() => finish(tier, "ended"), durationMs * 1.5 + 4000);

        audio.play().catch((err) => {
          // 자동재생 거부. 예전 코드는 이 예외를 삼켰고, 턴을 끝내는 경로가
          // onended 뿐이라 대화가 영구 정지했다. 이제는 "값"으로 돌려준다.
          log.warn("voice:autoplay-blocked", { reason: String(err) });
          req.onBlocked?.(err);
          // 소리는 못 내도 글자는 끝까지 보여주고 턴을 정상 종료시킨다
          if (revealTimer === null) startReveal(req.text.length * 45);
          if (watchdog !== null) clearTimeout(watchdog);
          watchdog = setTimeout(() => finish(tier, "blocked"), req.text.length * 45 + 500);
        });
      };

      if (audio.readyState >= 1) begin();
      else audio.addEventListener("loadedmetadata", begin, { once: true });
    }

    function goSilentFrom(tier: VoiceTier, why: string): void {
      log.warn("voice:degraded", { from: tier, why });
      cleanup();
      goSilent(why);
    }

    void (async () => {
      const key = await cacheKey(req.text, req.voiceId, req.properties?.speed ?? 1);
      if (cancelled) return;

      // ── 1칸: 구워 둔 음성 ──────────────────────────────────────────────────
      const bakedVoice = await deps.cache.lookup(key);
      if (cancelled) return;
      if (bakedVoice) {
        log.info("voice:baked", { key });
        play("baked", bakedVoice.audioUrl, bakedVoice.face);
        return;
      }

      // ── 2칸: 릴레이 합성 ──────────────────────────────────────────────────
      if (deps.isStageMode()) {
        goSilent("stage-mode");
        return;
      }

      const tts = await postTts(req.text, req.voiceId, req.properties);
      if (cancelled) return;
      if (!tts.ok) {
        goSilent(`tts-${tts.reason}`);
        return;
      }
      log.info("voice:live", { ms: tts.ms, chars: req.text.length });

      // 얼굴은 병렬로 받는다. 오디오는 기다리지 않고 지금 재생을 시작한다.
      const cached = deps.cache.put(key, tts.value.audio, null);
      play("live", cached.audioUrl, null);

      if (req.withFace) {
        void postFace(tts.value.audio, { emotion: req.emotion }).then((face) => {
          if (cancelled || faceAbort.signal.aborted || !face.ok) return;
          req.onFace?.(face.value.blendshape as FaceTrack);
        });
      }
    })();

    return {
      done,
      stop() {
        cancelled = true;
        fallback?.stop();
        finish(audio ? "live" : "silent", "stopped");
      },
    };
  };
}
