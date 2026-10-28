import { useEffect, useRef, useState } from "react";
import FaceAvatar from "./FaceAvatar";
import { GRANDMA_ANSWER_VOICE_ID, synthesizeVarcoTts } from "../lib/varcoTts";
import { fetchBlendshape, type VarcoBlendshape } from "../lib/varcoFace";

const DEFAULT_TEXT = "그… 뭐더라, 그 앉는 거… 침대였나? 이름이 잘 생각이 안 나네.";
const ZERO_WEIGHTS: number[] = new Array(52).fill(0);

type Status = "idle" | "synthesizing" | "animating" | "playing" | "error";

/** VARCO TTS(음성 합성) → VARCO Voice-to-Face(블렌드셰이프 생성) → 2D 얼굴 애니메이션 재생까지
 * 한 번에 확인해보는 프로토타입 데모 화면. 실제 3D 리깅 모델이 없어 SVG 일러스트로 대신한다. */
export default function FaceDemoScreen() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [credit, setCredit] = useState<number | null>(null);
  const [weights, setWeights] = useState<number[]>(ZERO_WEIGHTS);
  const [facsNames, setFacsNames] = useState<string[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blendshapeRef = useRef<VarcoBlendshape | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopAnimationLoop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  useEffect(() => stopAnimationLoop, []);

  const runAnimationLoop = () => {
    const tick = () => {
      const audio = audioRef.current;
      const bs = blendshapeRef.current;
      if (!audio || !bs) return;
      const frame = Math.min(bs.numFrames - 1, Math.floor(audio.currentTime * bs.exportFps));
      setWeights(bs.weightMat[frame] ?? ZERO_WEIGHTS);
      if (!audio.paused && !audio.ended) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const handleGenerate = async () => {
    if (!text.trim() || status === "synthesizing" || status === "animating") return;
    stopAnimationLoop();
    setErrorMsg(null);
    setWeights(ZERO_WEIGHTS);
    setStatus("synthesizing");
    try {
      const audioB64 = await synthesizeVarcoTts(text, GRANDMA_ANSWER_VOICE_ID);

      setStatus("animating");
      const result = await fetchBlendshape(audioB64, {
        fps: 30,
        lipStyle: "balanced",
        faceStyle: "natural",
        emotion: "neutral",
      });
      blendshapeRef.current = result.blendshape;
      setFacsNames(result.blendshape.facsNames);
      setCredit(result.credit);

      const audio = new Audio(`data:audio/wav;base64,${audioB64}`);
      audioRef.current = audio;
      audio.onended = () => {
        stopAnimationLoop();
        setWeights(ZERO_WEIGHTS);
        setStatus("idle");
      };
      setStatus("playing");
      await audio.play();
      runAnimationLoop();
    } catch (err) {
      console.error(err);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const statusLabel: Record<Status, string> = {
    idle: "대기 중",
    synthesizing: "음성 합성 중…",
    animating: "표정 애니메이션 생성 중…",
    playing: "재생 중",
    error: "오류 발생",
  };

  return (
    <div className="fds-root">
      <style>{STYLES}</style>
      <div className="fds-card">
        <div className="fds-kicker">VARCO Voice-to-Face 데모</div>
        <h1>음성 → 표정 애니메이션 프로토타입</h1>
        <p className="fds-desc">
          텍스트를 VARCO TTS로 음성 합성 → 그 음성을 Voice-to-Face(SyncFace) API에 넣어 ARKit 52종
          블렌드셰이프를 받아온 뒤, 프레임마다 값을 읽어 2D 얼굴을 움직입니다.
        </p>

        <FaceAvatar weights={weights} facsNames={facsNames} size={260} />

        <textarea
          className="fds-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="읽어줄 텍스트를 입력하세요"
        />

        <button
          type="button"
          className="fds-btn"
          onClick={handleGenerate}
          disabled={status === "synthesizing" || status === "animating"}
        >
          {status === "synthesizing" || status === "animating" ? "생성 중…" : "생성 & 재생"}
        </button>

        <div className="fds-status">
          <span className={`fds-status-dot fds-status-${status}`} />
          {statusLabel[status]}
          {credit !== null && <span className="fds-credit"> · 이번 얼굴 생성 사용 크레딧 {credit}</span>}
        </div>
        {errorMsg && <div className="fds-error">{errorMsg}</div>}
      </div>
    </div>
  );
}

const STYLES = `
.fds-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #121018;
  color: #f1eefb;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
  padding: 24px;
  box-sizing: border-box;
}
.fds-card {
  width: min(480px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 32px 28px;
  border-radius: 20px;
  background: #1a1725;
  border: 1px solid #322c42;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
  text-align: center;
}
.fds-kicker {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #a78bfa;
  text-transform: uppercase;
}
.fds-card h1 {
  margin: 4px 0 0;
  font-size: 21px;
  font-weight: 800;
}
.fds-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: #a79fc0;
}
.fds-textarea {
  width: 100%;
  box-sizing: border-box;
  border-radius: 10px;
  border: 1px solid #322c42;
  background: #221e2e;
  color: #f1eefb;
  padding: 10px 12px;
  font-size: 13.5px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
}
.fds-btn {
  border: none;
  border-radius: 999px;
  padding: 10px 26px;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #a78bfa, #7c3aed);
  cursor: pointer;
}
.fds-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.fds-status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: #a79fc0;
}
.fds-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #555;
}
.fds-status-playing, .fds-status-animating, .fds-status-synthesizing {
  background: #a78bfa;
}
.fds-status-error {
  background: #ef4444;
}
.fds-credit {
  color: #6f6884;
}
.fds-error {
  font-size: 12.5px;
  color: #f87171;
}
`;
