import { useEffect, useMemo, useRef, useState } from "react";
import PetBubbles from "./PetBubbles";
import PetFace, { type PetFaceHandle } from "./PetFace";
import { createTurnRunner, type PetBubble, type PetPhase } from "../shared/pet/turnRunner";
import type { PetBeat, PetTurn } from "../shared/pet/types";
import { createSpeak } from "../shared/voice/speakImpl";
import { createVoiceCache } from "../shared/voice/voiceCache";
import type { FaceTrack } from "../shared/voice/speak";
import { PERSONA } from "../shared/pet/persona";

// ============================================================================
// 웹앱용 Pet 대화창 (로그인 화면·콘텐츠 선택 화면).
//
// 예전에는 여기에 질문 진행 상태기계가 통째로 들어 있었다 — 445줄. 지금은 확장과
// 같은 엔진(turnRunner)을 쓰는 얇은 껍데기다. 그래서:
//   - 상태기계가 한 벌만 존재한다. 웹앱을 돌리는 것이 곧 엔진 회귀 테스트가 된다.
//   - 모듈 스코프의 "이미 물어본 질문" Set 이 사라졌다. 그 Set 은 "페이지를 새로고침하면
//     초기화된다"는 가정 위에 있었고, 오래 사는 문서에서는 거짓이 되어 Pet 을 침묵시켰다.
//   - 자동재생이 막혀도 대화가 멈추지 않는다.
//
// props 는 한 글자도 바꾸지 않았다 — 호출처 두 곳을 건드릴 이유가 없다.
// ============================================================================

export interface ChatbotQuestion {
  id: string;
  /** 대화창에 표시하고 TTS 로 읽어줄 질문 문구 */
  question: string;
  /** (데모용) 사용자가 답했다고 가정하는 텍스트. 실제 서비스에서는 ASR 결과로 대체된다 */
  simulatedAnswer: string;
  /** 답변 후 보여줄 Pet 의 반응 */
  feedback: string;
}

export interface ChatbotPanelProps {
  questions: ChatbotQuestion[];
  /** 마운트 후 첫 질문까지의 지연(ms) */
  startDelayMs?: number;
  onAllDone?: () => void;
  /** 패널 헤더 라벨 */
  title?: string;
  /** (더 이상 쓰지 않음) 마이크 상태 라벨. 마이크 노출 자체를 없앴다 */
  idleLabel?: string;
}

function toBeat(questions: ChatbotQuestion[]): PetBeat {
  const turns: PetTurn[] = questions.map((q) => ({
    id: q.id,
    kind: "ask",
    text: q.question,
    simulatedAnswer: q.simulatedAnswer,
    ack: q.feedback,
  }));
  return { id: "webapp-chat", cue: { at: "panel-open" }, pauseVideo: false, turns };
}

export default function ChatbotPanel({
  questions,
  startDelayMs = 800,
  onAllDone,
  title = PERSONA.defaultPetName,
}: ChatbotPanelProps) {
  const [bubbles, setBubbles] = useState<PetBubble[]>([]);
  const [phase, setPhase] = useState<PetPhase>("watching");

  const faceRef = useRef<PetFaceHandle>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<FaceTrack | null>(null);
  const rafRef = useRef<number | null>(null);
  // onAllDone 을 ref 로 들고 있는다 — 예전 구현은 이 콜백을 stale closure 로 잡았다
  const doneRef = useRef(onAllDone);
  doneRef.current = onAllDone;

  const speak = useMemo(() => {
    const cache = createVoiceCache((p) => (p.startsWith("/") ? p : `/${p}`));
    return createSpeak({ cache, isStageMode: () => false });
  }, []);

  const beat = useMemo(() => toBeat(questions), [questions]);

  useEffect(() => {
    let cancelled = false;

    const stopLipSync = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      audioRef.current = null;
      trackRef.current = null;
    };

    const runLipSync = () => {
      if (rafRef.current !== null) return;
      const tick = () => {
        rafRef.current = null;
        const audio = audioRef.current;
        const track = trackRef.current;
        if (!audio || !track) return;
        const frame = Math.min(track.numFrames - 1, Math.floor(audio.currentTime * track.exportFps));
        const weights = track.weightMat[frame];
        if (weights) {
          const index = new Map(track.facsNames.map((n, i) => [n, i]));
          faceRef.current?.apply((name) => weights[index.get(name) ?? -1] ?? 0);
        }
        if (!audio.ended) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    const runner = createTurnRunner({
      beat,
      speak: (req) =>
        speak({
          ...req,
          onAudio: (audio) => {
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
      answer: async (turn) => turn.simulatedAnswer ?? "",
      onBubble: (b) => !cancelled && setBubbles((prev) => [...prev, b]),
      onBubbleText: (id, text) =>
        !cancelled && setBubbles((prev) => prev.map((b) => (b.id === id ? { ...b, text } : b))),
      onPhase: (p) => {
        if (cancelled) return;
        setPhase(p);
        if (p !== "speaking") {
          stopLipSync();
          faceRef.current?.setMood(p === "earsUp" ? "listening" : "neutral", p === "earsUp" ? 1 : 0);
        }
      },
      onDone: () => {
        stopLipSync();
        if (!cancelled) doneRef.current?.();
      },
    });

    const timer = window.setTimeout(() => runner.run(), startDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stopLipSync();
      runner.abort("panel-closed");
    };
    // questions 가 바뀌면 새 beat 로 다시 시작한다 — 예전에는 반영되지 않았다
  }, [beat, speak, startDelayMs]);

  return (
    <div className="cbp-panel">
      <style>{STYLES}</style>
      <div className="cbp-header">{title}</div>
      <div className="cbp-face" data-phase={phase}>
        <PetFace ref={faceRef} petName={title} size={84} />
      </div>
      <PetBubbles bubbles={bubbles} phase={phase} petName={title} />
    </div>
  );
}

const STYLES = `
.cbp-panel {
  width: 268px;
  height: min(400px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: rgba(20, 20, 20, 0.78);
  border: 1px solid rgba(139, 92, 246, 0.25);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  animation: cbp-slide-in 0.35s ease;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
  color-scheme: dark;
}
@keyframes cbp-slide-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
.cbp-header {
  padding: 10px 14px;
  font-size: 12.5px;
  font-weight: 800;
  color: #c4b5fd;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex: 0 0 auto;
}
.cbp-face {
  display: flex;
  justify-content: center;
  padding: 10px 0 2px;
  flex: 0 0 auto;
  transition: transform 0.3s ease;
}
.cbp-face[data-phase="earsUp"] { transform: translateY(2px) scale(1.04); }
@media (prefers-reduced-motion: reduce) {
  .cbp-panel, .cbp-face { animation: none; transition: none; }
}
`;
