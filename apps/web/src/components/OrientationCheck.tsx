import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTranscript, type AnswerInput } from "../lib/scoreApi";
import { playVarcoTts } from "../lib/varcoTts";
import {
  recordingHasVoice,
  startPcmAudioCapture,
  type PcmAudioCapture,
} from "../lib/audioRecorder";

const QUESTION_VOICE_ID = "3278b908-86ee-5c30-bb55-24b5b1bbc67b";

interface OrientationQuestion {
  id: string;
  question: string;
  correctAnswer: string;
  answerKeywords: string[];
}

export interface OrientationSession {
  answers: AnswerInput[];
  audio: File[];
  /** 화면 전환과 별개로 계속 진행되는 STT 작업. 최종 리포트 직전에만 기다린다. */
  transcriptions: Promise<void>[];
  /** 생일 답변 전사가 끝나면 리포트의 연령 참조 범위를 정할 생년월일. */
  patientBirthDate: Promise<string | undefined>;
}

interface OrientationCheckProps {
  patientName: string;
  onComplete: (session: OrientationSession) => void;
}

type Stage = "asking" | "listening" | "error";

export function parseSpokenBirthDate(text: string, now = new Date()): string | undefined {
  const normalized = text.replace(/\s+/g, "");
  const match = normalized.match(/(\d{2,4})년?(\d{1,2})월(\d{1,2})일?/);
  if (!match) return undefined;
  let year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 100) {
    year += year <= now.getFullYear() % 100 ? 2000 : 1900;
  }
  const candidate = new Date(year, month - 1, day);
  if (
    year < 1900 || candidate > now || candidate.getFullYear() !== year
    || candidate.getMonth() !== month - 1 || candidate.getDate() !== day
  ) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function buildQuestions(patientName: string, now = new Date()): OrientationQuestion[] {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const weekday = new Intl.DateTimeFormat("ko-KR", { weekday: "long" }).format(now);
  return [
    {
      id: "p-birthday",
      question: `${patientName} 님, 환영해요. 오늘 같이 영상 보면서 이야기 나눠봐요. 먼저 생일이 언제인지 들려주실래요?`,
      correctAnswer: "본인이 기억하는 생년월일을 말함",
      answerKeywords: [],
    },
    {
      id: "o-date-weekday",
      question: "고마워요. 그럼 오늘은 몇 년 몇 월 며칠이고, 무슨 요일이죠? 천천히 말씀해 주세요.",
      correctAnswer: `${year}년 ${month}월 ${day}일 ${weekday}`,
      answerKeywords: [`${year}`, `${month}월`, `${day}일`, weekday, weekday.replace("요일", "")],
    },
    {
      id: "o-place",
      question: "좋아요. 지금 어디에서 보고 계시죠? 편하게 말씀해 주세요.",
      correctAnswer: "현재 머무는 장소를 구체적으로 말함",
      answerKeywords: [],
    },
  ];
}

export default function OrientationCheck({ patientName, onComplete }: OrientationCheckProps) {
  const questions = useMemo(() => buildQuestions(patientName), [patientName]);
  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState<Stage>("asking");
  const [error, setError] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<PcmAudioCapture | null>(null);
  const recordingQuestionRef = useRef<OrientationQuestion | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const answersRef = useRef<AnswerInput[]>([]);
  const audioFilesRef = useRef<File[]>([]);
  const transcriptionJobsRef = useRef<Promise<void>[]>([]);
  const birthDateJobRef = useRef<Promise<string | undefined>>(Promise.resolve(undefined));
  const disposedRef = useRef(false);
  const question = questions[index];

  const saveRecording = useCallback((file: File, active: OrientationQuestion) => {
    if (disposedRef.current) return;
    const answer: AnswerInput = {
      id: active.id,
      question: active.question,
      correctAnswer: active.correctAnswer,
      userAnswer: "",
      transcriptSource: "recorded",
      audioFilename: file.name,
      answerKeywords: active.answerKeywords,
    };
    answersRef.current.push(answer);
    audioFilesRef.current.push(file);

    // 사용자는 곧바로 다음 단계로 이동하고, 전사 결과는 같은 answer 객체에
    // 백그라운드로 채운다. 실패해도 최종 리포트 API가 저장된 원음을 재시도한다.
    const transcriptJob = fetchTranscript(file, active.answerKeywords)
      .then((text) => {
        answer.userAnswer = text;
        return text;
      })
      .catch(() => {
        answer.userAnswer = "";
        return "";
      });
    const job = transcriptJob.then(() => undefined);
    if (active.id === "p-birthday") {
      birthDateJobRef.current = transcriptJob.then((text) => parseSpokenBirthDate(text));
    }
    transcriptionJobsRef.current.push(job);

    if (index === questions.length - 1) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      onComplete({
        answers: answersRef.current,
        audio: audioFilesRef.current,
        transcriptions: transcriptionJobsRef.current,
        patientBirthDate: birthDateJobRef.current,
      });
      return;
    }

    setIndex((current) => current + 1);
    setError("");
    setStage("asking");
  }, [index, onComplete, questions.length]);

  const finishRecording = useCallback(async () => {
    const capture = captureRef.current;
    const active = recordingQuestionRef.current;
    if (!capture || capture.state !== "recording" || !active) return;
    captureRef.current = null;
    recordingQuestionRef.current = null;
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;

    try {
      const result = await capture.stop();
      if (disposedRef.current) return;
      if (!recordingHasVoice(result)) {
        setError("목소리가 거의 들리지 않았어요. 마이크가 켜져 있는지 확인하고 다시 말씀해 주세요.");
        setStage("error");
        return;
      }
      const file = new File([result.blob], `${active.id}.wav`, { type: "audio/wav" });
      saveRecording(file, active);
    } catch (reason) {
      if (disposedRef.current) return;
      const message = reason instanceof Error ? reason.message : "녹음 저장 실패";
      setError(`목소리를 저장하지 못했어요. 다시 말씀해 주세요. (${message})`);
      setStage("error");
    }
  }, [saveRecording]);

  const beginRecording = useCallback(async (active: OrientationQuestion) => {
    try {
      const currentStream = streamRef.current;
      const stream = currentStream?.getAudioTracks().some((track) => track.readyState === "live")
        ? currentStream
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
      streamRef.current = stream;
      const capture = await startPcmAudioCapture(stream);
      captureRef.current = capture;
      recordingQuestionRef.current = active;
      setStage("listening");
      stopTimerRef.current = window.setTimeout(() => {
        void finishRecording();
      }, 20_000);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "마이크 권한 없음";
      setError(`마이크를 사용할 수 없어요. 권한을 확인해 주세요. (${message})`);
      setStage("error");
    }
  }, [finishRecording]);

  useEffect(() => {
    if (stage !== "asking") return;
    const stopVoice = playVarcoTts(
      question.question,
      QUESTION_VOICE_ID,
      () => void beginRecording(question),
      { speed: 0.92, pitch: 0.98 },
    );
    return stopVoice;
  }, [beginRecording, question, stage]);

  useEffect(() => {
    // React StrictMode는 개발 중 effect를 setup → cleanup → setup 순서로
    // 한 번 더 검증한다. 두 번째 setup에서 반드시 활성 상태로 되돌려야
    // 실제 녹음 onstop이 정상적으로 다음 질문을 진행한다.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
      void captureRef.current?.cancel();
      captureRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const stopRecording = () => {
    const capture = captureRef.current;
    if (!capture || capture.state !== "recording") return;
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    stopTimerRef.current = window.setTimeout(() => {
      void finishRecording();
    }, 500);
  };

  const retry = () => {
    setError("");
    setStage("asking");
  };

  return (
    <main className="oc-root">
      <style>{STYLES}</style>
      <section className="oc-card">
        <div className="oc-kicker">MEMFLIX · 시청 전 가벼운 대화</div>
        <h1>{patientName} 님, 잠깐 이야기 나눠요</h1>
        <p className="oc-intro">편하게 말씀해 주세요. 목소리는 안전하게 기록할게요.</p>

        <div className="oc-progress" aria-label={`${index + 1} / ${questions.length}`}>
          {questions.map((item, itemIndex) => (
            <span key={item.id} className={itemIndex <= index ? "oc-progress-on" : ""} />
          ))}
        </div>

        <div className="oc-question">{question.question}</div>

        <div className={`oc-mic oc-mic-${stage}`} aria-hidden>
          <span>●</span>
          <i /><i /><i /><i /><i />
        </div>

        <div className="oc-status" aria-live="polite">
          {stage === "asking" && "질문을 들려드리고 있어요."}
          {stage === "listening" && "듣고 있어요. 천천히 말씀해 주세요."}
          {stage === "error" && "마이크를 다시 확인해 주세요."}
        </div>
        {error && <div className="oc-error">{error}</div>}

        {stage === "listening" && (
          <button className="oc-primary" type="button" onClick={stopRecording}>말 다 했어요</button>
        )}
        {stage === "error" && (
          <button className="oc-primary" type="button" onClick={retry}>다시 해볼게요</button>
        )}
      </section>
    </main>
  );
}

const STYLES = `
.oc-root {
  width: 100%; height: 100%; padding: 28px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  overflow-y: auto; color: #fff;
  background: radial-gradient(ellipse at 50% 0%, #160b2d 0%, #000 68%);
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
}
.oc-card {
  width: min(720px, 94vw); min-height: 560px; padding: 46px 54px;
  box-sizing: border-box; border: 1px solid #2f2542; border-radius: 26px;
  background: rgba(20,20,20,.96); display: flex; flex-direction: column; align-items: center;
  box-shadow: 0 24px 80px rgba(0,0,0,.5);
}
.oc-kicker { color: #a78bfa; font-size: 14px; font-weight: 800; letter-spacing: .08em; }
.oc-card h1 { margin: 14px 0 8px; font-size: 31px; text-align: center; }
.oc-intro { margin: 0; color: #aaa; font-size: 17px; line-height: 1.6; text-align: center; }
.oc-progress { display: flex; gap: 9px; margin: 26px 0 30px; }
.oc-progress span { width: 54px; height: 6px; border-radius: 99px; background: #333; }
.oc-progress .oc-progress-on { background: #8b5cf6; }
.oc-question {
  width: 100%; min-height: 104px; padding: 24px 28px; box-sizing: border-box;
  border-radius: 18px; background: #24153d; color: #fff; display: flex; align-items: center;
  justify-content: center; font-size: 26px; font-weight: 800; line-height: 1.45; text-align: center;
  word-break: keep-all;
}
.oc-mic { height: 58px; margin: 24px 0 4px; display: flex; gap: 5px; align-items: center; color: #666; }
.oc-mic span { width: 32px; height: 32px; margin-right: 8px; display: grid; place-items: center; border-radius: 50%; background: #333; font-size: 10px; }
.oc-mic i { display: block; width: 5px; height: 10px; border-radius: 5px; background: currentColor; }
.oc-mic-listening { color: #a78bfa; }
.oc-mic-listening span { background: #8b5cf6; color: #fff; animation: oc-pulse 1s infinite; }
.oc-mic-listening i { animation: oc-wave .8s ease-in-out infinite; }
.oc-mic-listening i:nth-of-type(2) { animation-delay: .1s; }
.oc-mic-listening i:nth-of-type(3) { animation-delay: .2s; }
.oc-mic-listening i:nth-of-type(4) { animation-delay: .3s; }
.oc-mic-processing { color: #facc15; }
.oc-status { min-height: 28px; color: #ddd; font-size: 17px; font-weight: 700; text-align: center; }
.oc-transcript {
  width: 100%; margin-top: 16px; padding: 18px 22px; box-sizing: border-box;
  border: 1px solid rgba(139,92,246,.55); border-radius: 14px; background: rgba(139,92,246,.1);
  color: #fff; font-size: 21px; line-height: 1.5; text-align: center; word-break: keep-all;
}
.oc-transcript-empty { color: #bbb; font-size: 16px; }
.oc-error { margin-top: 12px; color: #fde68a; font-size: 14px; line-height: 1.5; text-align: center; }
.oc-primary {
  min-width: 210px; min-height: 56px; margin-top: auto; padding: 0 28px; border: 0; border-radius: 999px;
  background: #8b5cf6; color: #fff; font-size: 19px; font-weight: 900; cursor: pointer;
}
.oc-primary:hover { background: #a78bfa; }
@keyframes oc-wave { 0%,100% { height: 8px; } 50% { height: 34px; } }
@keyframes oc-pulse { 0% { box-shadow: 0 0 0 0 rgba(139,92,246,.6); } 70% { box-shadow: 0 0 0 15px rgba(139,92,246,0); } 100% { box-shadow: 0 0 0 0 rgba(139,92,246,0); } }
@media (max-height: 720px) {
  .oc-card { min-height: 0; padding: 28px 42px; }
  .oc-card h1 { font-size: 26px; }
  .oc-progress { margin: 18px 0; }
  .oc-question { min-height: 84px; font-size: 22px; }
  .oc-mic { margin-top: 14px; }
}
`;
