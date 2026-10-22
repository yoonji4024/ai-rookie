import { useCallback, useEffect, useReducer, useRef, type RefObject } from "react";
import type { PetFaceHandle } from "./PetFace";
import type { FaceMood } from "../shared/face/faceRig";
import type { FaceTrack } from "../shared/voice/speak";
import type { PetHost } from "../shared/host/petHost";
import type { BeatCue, BeatOutcome, ContentRef, PetBeat } from "../shared/pet/types";
import type { PetBubble, PetPhase, TurnRunnerApi } from "../shared/pet/turnRunner";
import { createTurnRunner } from "../shared/pet/turnRunner";
import { createCueScheduler, type CueScheduler } from "../shared/pet/cueScheduler";
import type { SpeakFn } from "../shared/voice/speak";
import { createSilentSpeak } from "../shared/voice/speak";
import { PERSONA } from "../shared/pet/persona";
import { buildGreetingBeat } from "../shared/pet/greeting";
import { buildClosingBeat, buildFarewellBeat } from "../shared/pet/closing";
import { captureMoment } from "../shared/pet/moments";
import { rememberMoment, touchMeeting, type PetMemory } from "../shared/pet/memory";
import { dayKey, now } from "../shared/time/now";
import { isContentToPanel, isVersionMismatch, PROTOCOL_VERSION } from "../shared/protocol";
import { log } from "../shared/obs/log";

// ============================================================================
// Pet 세션 — 화면과 무관한 조립부. 사이드바형 PetPanel 과 화면에 떠 있는 FloatingPet 이
// 같은 훅을 쓴다. 어디에 그려지든 Pet 이 듣고 판단하고 말하는 방식은 하나여야 한다.
//
// 여기가 하는 일은 셋뿐이다.
//   1. 호스트가 흘려보내는 영상 신호를 cue 판정기에 먹인다
//   2. 발화된 cue 에 해당하는 비트를 "청구"하고, 허락되면 러너를 돌린다
//   3. 러너가 만든 말풍선과 표정 상태를 화면에 반영한다
//
// 상태는 useReducer 하나에만 둔다. 예전 구현처럼 useState 를 흩뿌리면 콜백 안에서
// 낡은 값을 보게 되고, 그것이 "질문 세트를 갈아끼워도 반영되지 않던" 결함의 원인이었다.
// ============================================================================

export interface PetSessionOptions {
  host: PetHost;
  /** videoId 로 대본을 찾는다. 없으면 null — 그때는 침묵하지 않고 안부만 한다 */
  findBeats: (content: ContentRef | null) => PetBeat[];
  /** 음성 구현. 넘기지 않으면 무음(글자만) — 2단계에서 3단 폴백이 들어온다 */
  speak?: SpeakFn;
  petName?: string;
}

export interface PetSessionState {
  content: ContentRef | null;
  bubbles: PetBubble[];
  phase: PetPhase;
  activeBeatId: string | null;
}

type Action =
  /** keepBubbles: 첫 영상이면 인사 말풍선을 지우지 않는다 */
  | { type: "attached"; content: ContentRef; keepBubbles: boolean }
  | { type: "detached" }
  | { type: "beat-start"; beatId: string }
  | { type: "beat-end" }
  | { type: "bubble"; bubble: PetBubble }
  | { type: "bubble-text"; id: string; text: string }
  | { type: "phase"; phase: PetPhase };

/** 대화가 길어져도 메모리가 무한히 늘지 않게. 화면에 보이는 것보다 넉넉하다 */
const MAX_BUBBLES = 40;

function reducer(state: PetSessionState, action: Action): PetSessionState {
  switch (action.type) {
    case "attached":
      // 영상이 바뀌면 대화도 새로 시작한다 — 지난 영상의 말풍선을 끌고 오지 않는다.
      // 단 첫 영상이면 방금 한 인사를 지우지 않는다. 패널을 영상보다 늦게 열면 인사가 먼저 나오고
      // 영상 정보가 뒤따라 도착하는데, 그때 지우면 인사가 화면에서 사라진다.
      return {
        content: action.content,
        bubbles: action.keepBubbles ? state.bubbles : [],
        phase: action.keepBubbles ? state.phase : "watching",
        activeBeatId: action.keepBubbles ? state.activeBeatId : null,
      };
    case "detached":
      return { ...state, content: null, activeBeatId: null, phase: "watching" };
    case "beat-start":
      return { ...state, activeBeatId: action.beatId };
    case "beat-end":
      return { ...state, activeBeatId: null };
    case "bubble":
      return { ...state, bubbles: [...state.bubbles, action.bubble].slice(-MAX_BUBBLES) };
    case "bubble-text":
      return {
        ...state,
        bubbles: state.bubbles.map((b) => (b.id === action.id ? { ...b, text: action.text } : b)),
      };
    case "phase":
      return { ...state, phase: action.phase };
    default:
      return state;
  }
}

const INITIAL: PetSessionState = { content: null, bubbles: [], phase: "watching", activeBeatId: null };

/** 비트의 첫 감정을 얼굴 프리셋으로 — 대사에 emotion 이 없으면 기본값 */
function moodOf(beat: PetBeat): FaceMood {
  const emotion = beat.turns.find((t) => t.emotion)?.emotion;
  if (emotion === "happy") return "happy";
  if (emotion === "surprise") return "curious";
  if (emotion === "sad") return "sad";
  return "neutral";
}

function phaseMood(phase: PetPhase): FaceMood {
  if (phase === "earsUp") return "listening";
  if (phase === "thinking") return "curious";
  return "neutral";
}

export interface PetSession {
  state: PetSessionState;
  name: string;
  /** 얼굴 핸들 — 화면 쪽이 <PetFace ref={faceRef}> 로 연결한다. 립싱크와 표정이 여기로 간다 */
  faceRef: RefObject<PetFaceHandle>;
}

export function usePetSession({ host, findBeats, speak, petName }: PetSessionOptions): PetSession {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const schedulerRef = useRef<CueScheduler | null>(null);
  const runnerRef = useRef<TurnRunnerApi | null>(null);
  /** 지금 말하고 있는 비트 — 영상에 묶인 비트인지 판정하는 데 쓴다 */
  const runningBeatRef = useRef<PetBeat | null>(null);
  const beatsRef = useRef<PetBeat[]>([]);
  const sessionKeyRef = useRef<string>("none");
  /**
   * 지금 세션을 연 attach 의 id. content 가 같은 영상을 "다시 알려 줄" 때(pet/hello 응답)
   * 세션을 리셋하지 않기 위해 기억한다. 리셋하면 말하던 비트가 끊기고 cue 커서를 잃는다.
   */
  const attachIdRef = useRef<string | null>(null);
  /** 이 정지가 우리 것임을 증명하는 토큰 — 사용자가 직접 누른 정지를 우리가 풀지 않기 위해 */
  const pauseTokenRef = useRef<string | null>(null);
  /**
   * 말하는 중에 도착해 미뤄 둔 cue.
   * 지나간 장면(seconds)은 버려도 되지만 — 이미 화면에서 사라졌으니 — 작별 인사와
   * "사용자가 멈췄다"는 시점 의존적이지 않아서, 버리면 Pet 이 인사도 없이 끝난다.
   */
  const pendingCueRef = useRef<BeatCue | null>(null);
  const speakRef = useRef<SpeakFn>(speak ?? createSilentSpeak());
  speakRef.current = speak ?? speakRef.current;
  /** Pet 의 기억. 호스트에서 한 번 읽어 두고, 바뀔 때마다 되쓴다 */
  const memoryRef = useRef<PetMemory | null>(null);
  const contentRef = useRef<ContentRef | null>(null);

  const name = petName ?? PERSONA.defaultPetName;
  /** runCue 와 startBeat 가 서로를 참조하므로 한쪽을 ref 로 우회한다 */
  const startBeatRef = useRef<(beat: PetBeat) => Promise<void>>(async () => {});

  // ── 얼굴 ──────────────────────────────────────────────────────────────────
  // 립싱크는 React 상태를 거치지 않는다. 프레임마다 setState 하면 말풍선 타이핑까지
  // 초당 60회 함께 리렌더된다. 여기서는 ref 로 SVG 속성만 직접 갱신한다.
  const faceRef = useRef<PetFaceHandle>(null);
  const rafRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<FaceTrack | null>(null);

  const stopLipSync = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    trackRef.current = null;
    audioRef.current = null;
  }, []);

  const runLipSync = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const audio = audioRef.current;
      const track = trackRef.current;
      rafRef.current = null;
      if (!audio || !track) return;

      const frame = Math.min(track.numFrames - 1, Math.floor(audio.currentTime * track.exportFps));
      const weights = track.weightMat[frame];
      if (weights) {
        const index = new Map(track.facsNames.map((n, i) => [n, i]));
        faceRef.current?.apply((name2) => weights[index.get(name2) ?? -1] ?? 0);
      }
      // 참조 구현은 paused 면 루프를 끊고 재개해도 살아나지 않았다.
      // 끝나지 않은 동안에는 계속 돌면서, 일시정지 후 재개도 그대로 이어간다.
      if (!audio.ended) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => stopLipSync, [stopLipSync]);

  /** cue 하나를 비트로 바꿔 시작한다. 시작했으면 true */
  const runCue = useCallback(
    (cue: BeatCue): boolean => {
      const beat = beatsRef.current.find(
        (b) =>
          b.cue.at === cue.at &&
          (cue.at !== "seconds" || (b.cue.at === "seconds" && b.cue.seconds === cue.seconds)),
      );
      if (beat) {
        void startBeatRef.current(beat);
        return true;
      }
      // 유대감 ③ — 대본에 마무리가 없으면 여기서 약속으로 닫는다.
      // attach 시점이 아니라 지금 만드는 이유: 그때는 기억이 아직 로드되지 않았을 수 있다.
      if (cue.at === "ended" && memoryRef.current) {
        const plan = buildClosingBeat(memoryRef.current, now(), contentRef.current?.title ?? "");
        void startBeatRef.current(plan.beat);
        return true;
      }
      return false;
    },
    [],
  );

  /** 러너를 끝내고 영상을 되돌린다. 어떤 종료 사유에서도 같은 정리를 거친다 */
  const finishBeat = useCallback(
    (beat: PetBeat, outcome: BeatOutcome) => {
      runnerRef.current = null;
      runningBeatRef.current = null;
      host.reportBeat(beat.id, outcome);

      // 유대감 ④ — 완주한 비트에서 '오늘 웃었던 순간' 카드를 건진다.
      // 안부 대화는 captureMoment 안에서 걸러진다 (검토 4.5절 신뢰 경계).
      const answers = outcome.status === "aborted" ? {} : outcome.answers;
      const memory = memoryRef.current;
      if (memory && Object.keys(answers).length > 0) {
        const card = captureMoment(beat, answers, contentRef.current, now());
        if (card) {
          const next = rememberMoment(memory, card);
          memoryRef.current = next;
          void host.saveMemory(next);
          log.info("moment:captured", { beat: beat.id });
        }
      }

      if (beat.pauseVideo && pauseTokenRef.current) {
        host.sendToContent({ v: PROTOCOL_VERSION, type: "pet/resume", token: pauseTokenRef.current });
        pauseTokenRef.current = null;
      } else {
        host.sendToContent({ v: PROTOCOL_VERSION, type: "pet/duck", gain: 1 });
      }
      dispatch({ type: "beat-end" });

      // 말하는 중에 도착해 미뤄 둔 cue 가 있으면 지금 이어간다
      const pending = pendingCueRef.current;
      if (pending) {
        pendingCueRef.current = null;
        log.info("beat:resumed:deferred", { cue: pending.at });
        runCue(pending);
      }
    },
    [host, runCue],
  );

  const startBeat = useCallback(
    async (incoming: PetBeat) => {
      let beat = incoming;
      // 전역 유일 판정. 패널을 닫았다 열어도, 창이 둘이어도 같은 비트를 두 번 말하지 않는다.
      // 인사·약속은 영상이 아니라 하루에 묶이므로 세션 키를 "panel" 로 둔다 —
      // 영상을 바꿔도 아침 인사를 다시 하지 않는다.
      const scope = beat.once === "day" ? "panel" : sessionKeyRef.current;
      const allowed = await host.claimBeat(scope, beat.id);
      if (!allowed) return;

      // 진행 중인 비트가 있으면 먼저 정리한다 — 두 비트가 동시에 말하면 안 된다
      runnerRef.current?.abort("replaced");

      // 유대감 ③ — 약속 문장을 **말하기 전에** 기억에 먼저 남긴다.
      // 저장이 실패하면 약속을 빼고 일반 작별로 바꾼다. 지키지 못할 약속을 하지 않는 것을
      // 제어 흐름으로 구현한 것이다 (검토 4.5절 정직).
      //
      // 판정 기준은 "약속 턴이 들어 있는가"다. 우리가 만든 마무리든 대본이 직접 쓴
      // 마무리든 똑같이 저장돼야 하기 때문이다 — 비트의 출처로 판정하면 대본 쪽을 놓친다.
      const promiseTurn = beat.turns.find((t) => t.kind === "promise");
      const memory = memoryRef.current;
      if (promiseTurn && memory) {
        const promise = {
          madeOn: dayKey(now()),
          text: promiseTurn.text,
          keyword: contentRef.current?.title ?? "어제 보던 것",
        };
        const next = touchMeeting({ ...memory, openPromise: promise }, dayKey(now()));
        const saved = await host.saveMemory(next);
        if (saved) {
          memoryRef.current = next;
          log.info("promise:saved", { text: promise.text });
        } else {
          log.warn("promise:not-saved");
          beat = buildFarewellBeat(memory, now());
        }
      }

      if (beat.pauseVideo) {
        const token = `pet-${beat.id}-${sessionKeyRef.current}`;
        pauseTokenRef.current = token;
        host.sendToContent({ v: PROTOCOL_VERSION, type: "pet/pause", token });
      } else {
        // 멈추지 않는 것이 기본이다. 볼륨만 낮추고 그 위에 말을 얹는다.
        host.sendToContent({ v: PROTOCOL_VERSION, type: "pet/duck", gain: 0.25 });
      }

      dispatch({ type: "beat-start", beatId: beat.id });

      const runner = createTurnRunner({
        beat,
        speak: (req) =>
          speakRef.current({
            ...req,
            onAudio: (audio) => {
              // Pet 이 말할 때만 얼굴을 붙인다. 사용자 대역 낭독(withFace=false)에는
              // 붙이지 않는다 — 사용자가 말하는데 Pet 이 입을 뻥긋하면 누가 말하는지 알 수 없다.
              if (!req.withFace) return;
              audioRef.current = audio;
              runLipSync();
            },
            onFace: (track) => {
              if (!req.withFace) return;
              trackRef.current = track;
              runLipSync();
            },
          }),
        petVoiceId: PERSONA.voices.pet,
        simulatedUserVoiceId: PERSONA.voices.simulatedUser,
        // Phase A 는 시뮬레이션. Phase B 에서 이 함수만 실제 ASR 로 바뀐다.
        answer: async (turn) => turn.simulatedAnswer ?? "",
        onBubble: (bubble) => dispatch({ type: "bubble", bubble }),
        onBubbleText: (id, text) => dispatch({ type: "bubble-text", id, text }),
        onPhase: (phase) => {
          dispatch({ type: "phase", phase });
          // 얼굴 API 가 없어도 감정과 귀는 움직인다 — 릴레이가 죽어도 표정은 보인다
          if (phase === "speaking") {
            faceRef.current?.setMood(moodOf(beat), 0);
          } else {
            stopLipSync();
            faceRef.current?.setMood(phaseMood(phase), phase === "earsUp" ? 1 : 0);
          }
        },
        onDone: (outcome) => finishBeat(beat, outcome),
      });
      runnerRef.current = runner;
      runningBeatRef.current = beat;
      runner.run();
    },
    [host, finishBeat],
  );

  startBeatRef.current = startBeat;

  // 기억을 읽고, 다 읽은 뒤에 인사한다.
  //
  // 인사를 영상 부착에 묶으면 안 된다 — 기억은 비동기로 읽히는데 부착은 구독 즉시
  // 도착할 수 있어서, 그 시점엔 기억이 아직 없어 인사가 통째로 빠진다.
  // 그리고 의미상으로도 인사는 "패널이 열린 것"에 대한 반응이지 영상에 대한 것이 아니다.
  useEffect(() => {
    let cancelled = false;
    void host.loadMemory().then(async (loaded) => {
      if (cancelled) return;
      const before = loaded;
      const memory = touchMeeting(loaded, dayKey(now()));
      memoryRef.current = memory;
      log.info("memory:loaded", {
        streak: memory.streakDays,
        hasPromise: memory.openPromise !== null,
      });

      // 인사는 "만난 기록"을 남기기 *전*의 기억으로 만든다 —
      // touchMeeting 이 lastMetOn 을 오늘로 바꾸고 나면 "오늘 처음"인지 알 수 없다.
      const greeting = buildGreetingBeat(before, now());
      void host.saveMemory(memory);
      if (!cancelled) await startBeat(greeting);
    });
    return () => {
      cancelled = true;
    };
  }, [host, startBeat]);

  // 호스트 구독 — 영상 신호를 받아 cue 를 판정하고 비트를 시작한다
  useEffect(() => {
    /**
     * 영상을 떠날 때 끊을 것은 *그 영상에 묶인* 비트뿐이다. 인사(panel-open)는 영상이 아니라
     * 패널을 연 순간에 묶여 있다 — 영상 정보가 뒤늦게 도착했다고 인사를 끊으면 안 된다.
     */
    const abortVideoBeat = () => {
      if (runningBeatRef.current?.cue.at === "panel-open") return;
      runnerRef.current?.abort("navigated");
    };

    const unsubscribe = host.subscribe((msg) => {
      if (!isContentToPanel(msg)) {
        // 확장 일부만 리로드된 상태가 MV3 에서 가장 흔한 유령 버그다. 조용히 무시하지 않는다.
        if (isVersionMismatch(msg)) log.error("protocol:version-mismatch", { got: String((msg as { v: unknown }).v) });
        return;
      }

      if (msg.type === "video/attached") {
        if (msg.attachId === attachIdRef.current) {
          log.debug("session:reannounced", { id: msg.content.id });
          return;
        }
        const firstVideo = contentRef.current === null;
        attachIdRef.current = msg.attachId;
        sessionKeyRef.current = `${msg.content.provider}:${msg.content.id}`;
        contentRef.current = msg.content;

        beatsRef.current = findBeats(msg.content);
        // 대본에 자체 마무리가 없으면 "끝났을 때" cue 를 우리가 얹는다.
        // 그 비트는 영상이 실제로 끝나는 순간에 만든다 — 그때는 기억이 확실히 로드돼 있다.
        const cues = beatsRef.current.map((b) => b.cue);
        if (!cues.some((c) => c.at === "ended")) cues.push({ at: "ended" });
        schedulerRef.current = createCueScheduler(cues);

        abortVideoBeat();
        dispatch({ type: "attached", content: msg.content, keepBubbles: firstVideo });
        log.info("session:start", { key: sessionKeyRef.current, beats: beatsRef.current.length });
        return;
      }

      if (msg.type === "video/detached") {
        attachIdRef.current = null;
        contentRef.current = null;
        abortVideoBeat();
        schedulerRef.current = null;
        dispatch({ type: "detached" });
        return;
      }

      if (msg.type === "video/pulse") {
        const scheduler = schedulerRef.current;
        if (!scheduler) return;
        const fired = scheduler.feed(msg.pulse);
        if (fired.length === 0) return;

        if (runnerRef.current) {
          // 이미 말하는 중이다. 두 비트가 겹쳐 말하면 안 되므로 시작하지는 않는다.
          // 다만 시점에 매이지 않는 cue 는 미뤄 뒀다가 말이 끝나면 이어간다 —
          // 그러지 않으면 Pet 이 작별 인사도 없이 끝나 버린다.
          const keepable = fired.find((c) => c.at !== "seconds");
          if (keepable) {
            pendingCueRef.current = keepable;
            log.info("beat:deferred:busy", { cue: keepable.at });
          } else {
            log.info("beat:skipped:busy", { count: fired.length });
          }
          return;
        }

        for (const cue of fired) {
          if (runCue(cue)) break; // 한 번에 한 비트만
        }
      }
    });

    return () => {
      unsubscribe();
      runnerRef.current?.abort("panel-closed");
      runnerRef.current = null;
    };
  }, [host, findBeats, startBeat]);

  // 탭이 가려지면 말하지 않는다 — 안 보이는 곳에서 혼자 떠드는 것을 막는다
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && runnerRef.current) {
        log.info("beat:aborted:hidden");
        runnerRef.current.abort("panel-closed");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return { state, name, faceRef };
}
