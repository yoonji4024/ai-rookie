// ============================================================================
// Pet 이 말하는 방법 — 인터페이스와 계약.
//
// 이 파일이 존재하는 이유는 하나다: **done 은 어떤 경우에도 settle 된다.**
//
// 예전 코드는 그러지 않았다. ChatbotPanel 의 playSyncedTts 는 audio.play() 의 거부를
// `.catch(() => {})` 로 삼켰는데, 턴을 끝내는 유일한 경로가 audio.onended 였다.
// 자동재생이 막히면 onended 가 영원히 오지 않고 대화가 통째로 멈췄다 — 예외도 로그도 없이.
//
// 그래서 여기서는 차단·오프라인·타임아웃을 전부 "값"으로 돌려준다. 호출자는 실패를
// 예외로 처리할 필요가 없고, 어떤 실패에서도 대화는 다음 턴으로 넘어간다.
//
// 실제 구현(3단 폴백)은 2단계에서 speakImpl.ts 에 붙는다.
// ============================================================================

import type { PetEmotion } from "../pet/types.ts";

/** baked = 빌드 타임 선합성 / live = 릴레이 합성 / silent = 무음 고정 속도 타이핑 */
export type VoiceTier = "baked" | "live" | "silent";

export type SpeechEndReason =
  | "ended"     // 오디오가 끝까지 재생됐다
  | "stopped"   // 호출자가 stop() 했다
  | "blocked"   // 자동재생 정책에 막혔다 (텍스트는 끝까지 보여준다)
  | "deadline"  // 예산 시간을 넘겼다
  | "error";    // 합성/재생 실패

export interface SpeechResult {
  tier: VoiceTier;
  reason: SpeechEndReason;
  durationMs: number;
}

/** VARCO Voice-to-Face 가 돌려주는 ARKit 52 블렌드셰이프 애니메이션 */
export interface FaceTrack {
  exportFps: number;
  numFrames: number;
  facsNames: string[];
  /** [numFrames][numPoses] */
  weightMat: number[][];
}

export interface SpeechRequest {
  text: string;
  voiceId: string;
  properties?: { speed?: number; pitch?: number };
  emotion?: PetEmotion;
  /**
   * 얼굴 블렌드셰이프까지 필요한가.
   * Pet 이 말할 때만 true. 사용자 대역 답변 낭독은 반드시 false —
   * 사용자가 말하는 동안 Pet 이 입을 뻥긋하면 누가 말하는지 알 수 없게 된다.
   */
  withFace: boolean;
  /** 오디오 길이에 맞춰 글자를 드러낸다 */
  onReveal: (charsShown: number) => void;
  /**
   * 오디오 요소를 그대로 넘긴다 — currentTime 이 립싱크의 마스터 클럭이 된다.
   * 기존 varcoTts 의 두 함수가 HTMLAudioElement 를 밖으로 안 내주던 제약이 여기서 풀린다.
   */
  onAudio?: (audio: HTMLAudioElement) => void;
  /** 블렌드셰이프는 재생 도중에 도착해도 된다 (낙관적 지연 합류) */
  onFace?: (track: FaceTrack) => void;
  /** 자동재생이 거부됨. 이 콜백이 불린 뒤에도 done 은 반드시 settle 된다 */
  onBlocked?: (err: unknown) => void;
}

export interface SpeechHandle {
  /** ★ 어떤 경우에도 settle 된다. reject 하지 않는다 */
  readonly done: Promise<SpeechResult>;
  stop(): void;
}

export type SpeakFn = (req: SpeechRequest) => SpeechHandle;

/**
 * 무음 폴백 — 고정 속도로 글자만 드러낸다.
 * 3단 사다리의 마지막 칸이자, 테스트와 /pet 프리뷰의 기본 구현이다.
 * 오디오를 전혀 쓰지 않으므로 자동재생 정책과 무관하게 항상 끝난다.
 */
export function createSilentSpeak(msPerChar = 45): SpeakFn {
  return (req) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let settle: ((r: SpeechResult) => void) | null = null;
    const started = Date.now();

    const done = new Promise<SpeechResult>((resolve) => {
      settle = resolve;
    });

    const finish = (reason: SpeechEndReason) => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      const fn = settle;
      settle = null;
      fn?.({ tier: "silent", reason, durationMs: Date.now() - started });
    };

    let shown = 0;
    timer = setInterval(() => {
      shown += 1;
      req.onReveal(Math.min(shown, req.text.length));
      if (shown >= req.text.length) finish("ended");
    }, msPerChar);

    return {
      done,
      stop() {
        req.onReveal(req.text.length);
        finish("stopped");
      },
    };
  };
}
