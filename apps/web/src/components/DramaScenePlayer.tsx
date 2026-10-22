import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { playSynthesizedVarcoAudio, playVarcoTts, synthesizeVarcoTts } from "../lib/varcoTts";
import {
  recordingHasVoice,
  startPcmAudioCapture,
  type PcmAudioCapture,
} from "../lib/audioRecorder";
import { startLiveTranscript, type LiveTranscriptSession } from "../lib/liveTranscript";
import {
  fetchEmpatheticReply,
  fetchReport,
  fetchTranscript,
  type AnswerInput,
  type ReportResponse,
} from "../lib/scoreApi";

/** "에스텔(행복)" — 여성/청년/고음/얇음/귀여운 톤. 손녀가 옆에서 재잘대는 듯한 느낌을 노려 고름 */
const QUESTION_VOICE_ID = "3278b908-86ee-5c30-bb55-24b5b1bbc67b";
const QUESTION_VOICE_PROPERTIES = { speed: 0.92, pitch: 0.98 };
const GENERIC_CONVERSATION_OPENERS = [
  "저는 그 장면의 분위기가 꽤 인상적이었는데요.",
  "저는 화면 속 표정들이 먼저 눈에 들어왔어요.",
  "같이 보니까 아까 그 장면이 더 눈에 남는데요.",
];

function pickRandomText(values: string[], previous = ""): string {
  const source = values.length > 0 ? values : GENERIC_CONVERSATION_OPENERS;
  const candidates = source.filter((text) => text !== previous);
  const pool = candidates.length > 0 ? candidates : source;
  const randomValue = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
    : Math.floor(Math.random() * 1_000_000);
  return pool[randomValue % pool.length];
}

// ============================================================================
// 타입 정의
// ============================================================================

export interface DramaQuestion {
  id: string;
  /** 영상 재생 중 이 시각(초)에 도달하면 자동으로 일시정지하고 질문을 띄운다 */
  timestamp: number;
  /** 챗 패널에 표시할 질문 문구 */
  question: string;
  /** 마이크/STT 장애 시 화면에 고지하고 사용하는 시연용 대체 전사 */
  simulatedAnswer: string;
  /** 보호자 리포트와 회상 점수에 쓰는 정답 */
  correctAnswer?: string;
  /** 정답의 핵심 표현. 규칙 기반 회상 점수에 사용한다. */
  answerKeywords?: string[];
  /** STT·LLM 처리 중 먼저 재생할, 정답을 드러내지 않는 장면별 감상 후보 */
  conversationOpeners?: string[];
  /** 답변 후 보여줄 AI 칭찬/피드백 문구 */
  feedback: string;
  /** 자유 감상처럼 충분한 발화가 필요한 질문의 최대 녹음 시간. */
  maxRecordingMs?: number;
}

export interface DramaScenePlayerProps {
  /** 재생할 로컬 영상 경로 (예: "/videos/scene1.mp4") */
  videoSrc?: string;
  /** 유튜브 영상 ID — 지정하면 videoSrc 대신 유튜브 플레이어로 재생 */
  youtubeId?: string;
  /** 시점별 질문 목록 */
  questions: DramaQuestion[];
  /** 좌상단에 표시할 제목 (선택) */
  title?: string;
  contentId?: string;
  patientName?: string;
  patientBirthDate?: string;
  patientBirthDatePromise?: Promise<string | undefined>;
  /** 로그인 직후 진행한 지남력 문답을 최종 리포트에 함께 보낸다. */
  initialAnswers?: AnswerInput[];
  initialAudio?: File[];
  initialTranscriptions?: Promise<void>[];
  /** 마지막 질문 분석이 끝나면 실제 리포트를 전달한다. */
  onSessionComplete?: (report: ReportResponse) => void;
}

type MicState = "idle" | "listening" | "processing";

interface ChatMessage {
  id: string;
  role: "question" | "user" | "ai";
  text: string;
}

// ============================================================================
// 유튜브 IFrame API 로더
// <video>와 달리 유튜브는 iframe 안에서 재생되므로, 재생 시각을 읽으려면
// 공식 IFrame API(YT.Player)를 로드해 폴링해야 한다.
// ============================================================================
function loadYouTubeAPI(): Promise<any> {
  return new Promise((resolve) => {
    const w = window as any;
    if (w.YT?.Player) {
      resolve(w.YT);
      return;
    }
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT);
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
}

let uidCounter = 0;
function nextId(): string {
  uidCounter += 1;
  return `dsp-msg-${uidCounter}`;
}

function formatPlaybackTime(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ============================================================================
// 메인 컴포넌트
// ============================================================================

export default function DramaScenePlayer({
  videoSrc,
  youtubeId,
  questions,
  title,
  contentId,
  patientName,
  patientBirthDate,
  patientBirthDatePromise,
  initialAnswers,
  initialAudio,
  initialTranscriptions,
  onSessionComplete,
}: DramaScenePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ytHostRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<any>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const feedbackVoiceStopRef = useRef<(() => void) | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<PcmAudioCapture | null>(null);
  const liveTranscriptRef = useRef<LiveTranscriptSession | null>(null);
  const recordingQuestionRef = useRef<DramaQuestion | null>(null);
  const beginRecordingRef = useRef<(question: DramaQuestion) => Promise<void>>(async () => {});
  const recordingTimerRef = useRef<number | null>(null);
  const noSpeechTimerRef = useRef<number | null>(null);
  const heardVoiceRef = useRef(false);
  const answersRef = useRef<AnswerInput[]>(initialAnswers ?? []);
  const audioFilesRef = useRef<File[]>(initialAudio ?? []);
  const pendingTranscriptionsRef = useRef<Promise<void>[]>(initialTranscriptions ?? []);
  const lastConversationOpenerRef = useRef("");

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [answeredIds, setAnsweredIds] = useState<Set<string>>(new Set());
  const [activeQuestion, setActiveQuestion] = useState<DramaQuestion | null>(null);
  const [micState, setMicState] = useState<MicState>("idle");
  const [voiceActive, setVoiceActive] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  // 대화창은 질문이 나올 때만 보이고, 답변이 끝나면 다음 질문 시점까지 숨긴다
  const [panelVisible, setPanelVisible] = useState(false);
  const panelHideTimerRef = useRef<number | null>(null);
  // 재생 바는 스페이스 바로 정지/재개할 때 잠깐, 또는 마우스가 하단에 있을 때만 보인다
  const [controlsVisible, setControlsVisible] = useState(false);
  const controlsTimerRef = useRef<number | null>(null);
  const [recordingError, setRecordingError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const sortedQuestions = useMemo(
    () => [...questions].sort((a, b) => a.timestamp - b.timestamp),
    [questions],
  );

  // 첫 답변 시에도 즉시 들리도록 영상을 보는 동안 장면별 감상 문장들을 차례로
  // 미리 합성한다. 백엔드 TTS 캐시에만 올리고 이 시점에는 재생하지 않는다.
  useEffect(() => {
    const controller = new AbortController();
    const openers = Array.from(new Set([
      ...GENERIC_CONVERSATION_OPENERS,
      ...questions.flatMap((question) => question.conversationOpeners ?? []),
    ]));
    void (async () => {
      for (const text of openers) {
        if (controller.signal.aborted) return;
        try {
          await synthesizeVarcoTts(
            text,
            QUESTION_VOICE_ID,
            QUESTION_VOICE_PROPERTIES,
            controller.signal,
          );
        } catch {
          if (controller.signal.aborted) return;
        }
      }
    })();
    return () => controller.abort();
  }, [questions]);

  // 질문이 뜨는 동안 영상을 멈춰서, 답변하는 사이 영상이 앞서가며
  // 화면 장면과 질문 내용이 어긋나는 것을 막는다.
  const pausePlayback = useCallback(() => {
    if (youtubeId) {
      ytPlayerRef.current?.pauseVideo?.();
    } else {
      videoRef.current?.pause();
      setIsPlaying(false);
    }
  }, [youtubeId]);

  const resumePlayback = useCallback(() => {
    if (youtubeId) {
      ytPlayerRef.current?.playVideo?.();
    } else {
      videoRef.current?.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [youtubeId]);

  // 재생 시각 반영 + 지정 시점 도달 시 영상을 멈추고 질문을 표시.
  // 로컬 <video>의 timeupdate와 유튜브 폴링이 공용으로 사용한다.
  const checkQuestionAt = useCallback(
    (t: number) => {
      setCurrentTime(t);
      if (activeQuestion) return;
      const due = sortedQuestions.find((q) => !answeredIds.has(q.id) && t >= q.timestamp);
      if (due) {
        // 예약된 숨김이 있어도 새 질문이 나오면 대화창을 계속 띄워 둔다
        if (panelHideTimerRef.current) {
          window.clearTimeout(panelHideTimerRef.current);
          panelHideTimerRef.current = null;
        }
        setPanelVisible(true);
        setActiveQuestion(due);
        // 채팅창에는 지난 대화 기록을 남기지 않고 현재 질문만 보여준다
        setMessages([{ id: nextId(), role: "question", text: due.question }]);
        pausePlayback();
      }
    },
    [activeQuestion, answeredIds, sortedQuestions, pausePlayback]
  );
  // 유튜브 폴링 타이머가 항상 최신 상태를 보도록 ref로 우회한다
  const checkQuestionAtRef = useRef(checkQuestionAt);
  checkQuestionAtRef.current = checkQuestionAt;

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (video) checkQuestionAt(video.currentTime);
  }, [checkQuestionAt]);

  // 유튜브 모드: IFrame API 플레이어를 만들고 재생 시각을 폴링한다
  useEffect(() => {
    if (!youtubeId) return;
    let disposed = false;
    let pollTimer: number | undefined;

    loadYouTubeAPI().then((YT) => {
      if (disposed || !ytHostRef.current) return;
      ytPlayerRef.current = new YT.Player(ytHostRef.current, {
        width: "100%",
        height: "100%",
        videoId: youtubeId,
        // 유튜브 자체 컨트롤은 끄고(controls: 0) 로컬 영상과 같은 커스텀 재생 바를 쓴다
        playerVars: { rel: 0, playsinline: 1, autoplay: 1, controls: 0 },
        events: {
          onReady: (e: any) => {
            e.target.playVideo?.(); // 콘텐츠 선택 직후 바로 재생 시작
            pollTimer = window.setInterval(() => {
              const player = ytPlayerRef.current;
              if (!player?.getCurrentTime) return;
              checkQuestionAtRef.current(player.getCurrentTime());
              const d = player.getDuration?.();
              if (d) setDuration(d);
              setIsPlaying(player.getPlayerState?.() === 1);
            }, 400);
          },
        },
      });
    });

    return () => {
      disposed = true;
      if (pollTimer) window.clearInterval(pollTimer);
      ytPlayerRef.current?.destroy?.();
      ytPlayerRef.current = null;
    };
  }, [youtubeId]);

  useEffect(() => {
    return () => {
      if (panelHideTimerRef.current) window.clearTimeout(panelHideTimerRef.current);
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
      if (recordingTimerRef.current) window.clearTimeout(recordingTimerRef.current);
      if (noSpeechTimerRef.current) window.clearTimeout(noSpeechTimerRef.current);
      feedbackVoiceStopRef.current?.();
      feedbackVoiceStopRef.current = null;
      void captureRef.current?.cancel();
      captureRef.current = null;
      liveTranscriptRef.current?.cancel();
      liveTranscriptRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // 콘텐츠 선택 직후 영상 바로 시작.
  // 콘텐츠 카드를 클릭한 사용자 제스처 직후라 소리 있는 자동 재생이 허용된다.
  // (제스처 없이 열린 경우 등 차단되면 조용히 넘어가고 ▶ 버튼으로 시작)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video
      .play()
      .then(() => setIsPlaying(true))
      .catch(() => {});
  }, []);

  const finishQuestion = useCallback((
    question: DramaQuestion,
    file?: File,
    liveTranscript?: Promise<string>,
  ) => {
    const transcript = file ? "" : question.simulatedAnswer;
    const answer: AnswerInput = {
      id: question.id,
      question: question.question,
      correctAnswer: question.correctAnswer ?? "",
      userAnswer: transcript,
      // 실제 녹음이 있으면 고정 정답으로 대체하지 않는다. STT 실패는 측정 불가로 남긴다.
      fallbackAnswer: undefined,
      transcriptSource: file ? "recorded" : "demo",
      videoTimestamp: question.timestamp,
      audioFilename: file?.name,
      answerKeywords: question.answerKeywords,
    };
    const nextAnswers = [...answersRef.current, answer];
    answersRef.current = nextAnswers;
    if (file) audioFilesRef.current = [...audioFilesRef.current, file];
    const mediaQuestionIds = new Set(sortedQuestions.map((item) => item.id));
    const answeredMediaCount = nextAnswers.filter((item) => mediaQuestionIds.has(item.id)).length;

    const fileTranscript = () => file
      ? fetchTranscript(file, question.answerKeywords ?? [])
      : Promise.resolve(transcript);
    const transcriptJob: Promise<string> = file
      ? (liveTranscript
        ? liveTranscript.then((text) => {
          const normalized = text.trim();
          if (!normalized) throw new Error("실시간 전사 결과가 비어 있습니다.");
          return normalized;
        }).catch(fileTranscript)
        : fileTranscript())
        .then((text) => {
          answer.userAnswer = text;
          return text;
        })
        .catch(() => {
          // 사용자 흐름은 멈추지 않는다. 최종 리포트 API가 원음으로 다시 전사한다.
          answer.userAnswer = "";
          return "";
        })
      : Promise.resolve(transcript);
    pendingTranscriptionsRef.current.push(transcriptJob.then(() => undefined));

    // 전사·LLM 처리와 동시에 정답을 드러내지 않는 장면 감상을 먼저 건넨다.
    // '아, 그렇군요' 같은 처리용 맞장구 대신 실제로 함께 시청하는 느낌을 준다.
    const openerText = pickRandomText(
      question.conversationOpeners ?? GENERIC_CONVERSATION_OPENERS,
      lastConversationOpenerRef.current,
    );
    lastConversationOpenerRef.current = openerText;
    const responseMessageId = nextId();
    setMessages((current) => [
      ...current,
      { id: responseMessageId, role: "ai", text: openerText },
    ]);
    let resolveOpener: () => void = () => {};
    const openerDone = new Promise<void>((resolve) => {
      resolveOpener = resolve;
    });
    feedbackVoiceStopRef.current?.();
    feedbackVoiceStopRef.current = playVarcoTts(
      openerText,
      QUESTION_VOICE_ID,
      () => {
        feedbackVoiceStopRef.current = null;
        resolveOpener();
      },
      QUESTION_VOICE_PROPERTIES,
    );

    let flowFinished = false;
    const finishFeedbackFlow = async () => {
      if (flowFinished) return;
      flowFinished = true;
      feedbackVoiceStopRef.current = null;
      setAnsweredIds((prev) => new Set(prev).add(question.id));
      setActiveQuestion(null);
      setMicState("idle");
      // 공감 음성이 끝난 뒤 대화창을 먼저 닫고 잠깐 호흡을 둔다. 답변 글이
      // 남아 있는 상태에서 영상이 움직이면 두 장면이 겹쳐 보인다.
      setPanelVisible(false);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 350));

      if (answeredMediaCount < sortedQuestions.length) {
        resumePlayback();
        return;
      }

      setSubmitting(true);
      // 보호자용 리포트는 백그라운드에서 완성하되 사용자 영상은 자연스럽게 잇는다.
      resumePlayback();
      try {
        // 지남력과 영상 질문의 STT는 그동안 백그라운드에서 진행한다.
        // 리포트에 실제 전사 결과가 들어가야 하는 마지막 순간에만 기다린다.
        await Promise.allSettled(pendingTranscriptionsRef.current);
        const spokenBirthDate = await patientBirthDatePromise?.catch(() => undefined);
        const report = await fetchReport({
          answers: answersRef.current,
          audio: audioFilesRef.current,
          patientName,
          patientBirthDate: spokenBirthDate ?? patientBirthDate,
          contentId,
        });
        onSessionComplete?.(report);
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 오류";
        console.error("보호자 리포트 생성 실패", message);
      } finally {
        setSubmitting(false);
      }
    };

    void (async () => {
      const userAnswer = await transcriptJob;
      const recognizedText = userAnswer.replace(/\s+/g, "");
      if (file && recognizedText.length < 2) {
        // 인식하지 못한 녹음은 이번 질문의 답으로 확정하지 않는다. 같은 파일명이
        // 다음 재녹음과 충돌하지 않도록 답변/오디오 목록에서 함께 되돌린다.
        answersRef.current = answersRef.current.filter((item) => item !== answer);
        audioFilesRef.current = audioFilesRef.current.filter((item) => item !== file);
        const retryMessage = "제가 잘 못 들었어요. 다시 한 번만 말씀해 주실래요?";

        feedbackVoiceStopRef.current?.();
        feedbackVoiceStopRef.current = null;
        resolveOpener();
        feedbackVoiceStopRef.current = playVarcoTts(
          retryMessage,
          QUESTION_VOICE_ID,
          () => {
            feedbackVoiceStopRef.current = null;
            void beginRecordingRef.current(question);
          },
          QUESTION_VOICE_PROPERTIES,
          () => {
            setMessages((current) => current.map((message) =>
              message.id === responseMessageId ? { ...message, text: retryMessage } : message,
            ));
          },
        );
        return;
      }

      let reply = "";
      let replyAudio = "";
      try {
        reply = await fetchEmpatheticReply({
          questionId: question.id,
          question: question.question,
          correctAnswer: question.correctAnswer ?? "",
          userAnswer,
          answerKeywords: question.answerKeywords,
          opener: openerText,
          variationKey: `${question.id}-${Date.now()}-${Math.random()}`,
        });
        // 시작 감상이 재생되는 동안 다음 문장의 음성까지 준비한다. 재생 시점에는
        // 네트워크 합성을 다시 기다리지 않아 두 문장 사이가 길게 비지 않는다.
        replyAudio = await synthesizeVarcoTts(
          reply,
          QUESTION_VOICE_ID,
          QUESTION_VOICE_PROPERTIES,
        );
      } catch {
        // 생성이나 합성이 늦으면 상투적인 대체 문장을 더 붙이지 않는다. 이미
        // 장면별 감상을 자연스럽게 건넸으므로 바로 영상으로 돌아가는 편이 낫다.
      }

      // 시작 감상과 실제 답변 기반 문장을 한 말풍선, 한 호흡처럼 이어 붙인다.
      await openerDone;
      if (!reply || !replyAudio) {
        await finishFeedbackFlow();
        return;
      }
      feedbackVoiceStopRef.current?.();
      feedbackVoiceStopRef.current = playSynthesizedVarcoAudio(
        replyAudio,
        () => { void finishFeedbackFlow(); },
        () => {
          // 실제 음성이 시작되는 순간 같은 말풍선에 이어 붙여 화면과 TTS를 맞춘다.
          setMessages((current) => current.map((message) =>
            message.id === responseMessageId
              ? { ...message, text: `${openerText} ${reply}` }
              : message,
          ));
        },
      );
    })();
  }, [contentId, onSessionComplete, patientBirthDate, patientBirthDatePromise, patientName, resumePlayback, sortedQuestions]);

  const finishRecording = useCallback(async () => {
    const capture = captureRef.current;
    const active = recordingQuestionRef.current;
    if (!capture || capture.state !== "recording" || !active) return;
    captureRef.current = null;
    recordingQuestionRef.current = null;
    const liveSession = liveTranscriptRef.current;
    liveTranscriptRef.current = null;
    if (recordingTimerRef.current) window.clearTimeout(recordingTimerRef.current);
    recordingTimerRef.current = null;
    if (noSpeechTimerRef.current) window.clearTimeout(noSpeechTimerRef.current);
    noSpeechTimerRef.current = null;

    try {
      const result = await capture.stop();
      setVoiceActive(false);
      if (!recordingHasVoice(result)) {
        liveSession?.cancel();
        const retryMessage = "제가 잘 못 들었어요. 다시 한 번만 말씀해 주실래요?";
        setMicState("processing");
        setRecordingError("");
        setMessages((current) => [
          ...current.filter((message) => message.role !== "ai"),
          { id: nextId(), role: "ai", text: retryMessage },
        ]);
        feedbackVoiceStopRef.current?.();
        feedbackVoiceStopRef.current = playVarcoTts(
          retryMessage,
          QUESTION_VOICE_ID,
          () => {
            feedbackVoiceStopRef.current = null;
            void beginRecordingRef.current(active);
          },
          QUESTION_VOICE_PROPERTIES,
        );
        return;
      }
      const file = new File([result.blob], `${active.id}.wav`, { type: "audio/wav" });
      setMicState("processing");
      finishQuestion(active, file, liveSession?.finish());
    } catch (error) {
      const message = error instanceof Error ? error.message : "녹음 저장 실패";
      setMicState("idle");
      setRecordingError(`목소리를 저장하지 못했어요. 다시 말씀해 주세요. (${message})`);
    }
  }, [finishQuestion]);

  const beginRecording = useCallback(async (question: DramaQuestion) => {
    setRecordingError("");
    try {
      const currentStream = mediaStreamRef.current;
      const stream = currentStream?.getAudioTracks().some((track) => track.readyState === "live")
        ? currentStream
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
      mediaStreamRef.current = stream;
      setVoiceActive(false);
      heardVoiceRef.current = false;
      const liveSession = await startLiveTranscript(question.answerKeywords ?? []).catch(() => null);
      liveTranscriptRef.current = liveSession;
      const capture = await startPcmAudioCapture(
        stream,
        (active) => {
          setVoiceActive(active);
          if (active) heardVoiceRef.current = true;
          if (active && noSpeechTimerRef.current) {
            window.clearTimeout(noSpeechTimerRef.current);
            noSpeechTimerRef.current = null;
          }
        },
        (chunk) => liveSession?.send(chunk),
      );
      captureRef.current = capture;
      recordingQuestionRef.current = question;
      setMicState("listening");
      // 질문 뒤 아무 말도 하지 않는 경우 20초 전체를 기다리지 않는다. 생각할
      // 여유는 주되 4.5초 동안 음성이 전혀 없으면 바로 재안내한다.
      noSpeechTimerRef.current = window.setTimeout(() => {
        void finishRecording();
      }, 4_500);
      if (heardVoiceRef.current && noSpeechTimerRef.current) {
        window.clearTimeout(noSpeechTimerRef.current);
        noSpeechTimerRef.current = null;
      }
      // 자유 감상은 충분히 이야기할 수 있도록 더 길게 열고, 일반 문답은 20초로 유지한다.
      recordingTimerRef.current = window.setTimeout(() => {
        void finishRecording();
      }, question.maxRecordingMs ?? 20_000);
    } catch (error) {
      liveTranscriptRef.current?.cancel();
      liveTranscriptRef.current = null;
      const message = error instanceof Error ? error.message : "마이크 권한 없음";
      setRecordingError(`마이크를 사용할 수 없어요. 권한을 확인해 주세요. (${message})`);
      setVoiceActive(false);
      setMicState("idle");
    }
  }, [finishRecording]);
  beginRecordingRef.current = beginRecording;

  const stopRecording = useCallback(() => {
    const capture = captureRef.current;
    if (capture?.state === "recording") {
      if (recordingTimerRef.current) window.clearTimeout(recordingTimerRef.current);
      if (noSpeechTimerRef.current) window.clearTimeout(noSpeechTimerRef.current);
      noSpeechTimerRef.current = null;
      // 버튼을 누르는 순간 마지막 음절이 잘리지 않도록 짧은 후행 무음을 남긴다.
      recordingTimerRef.current = window.setTimeout(() => {
        void finishRecording();
      }, 350);
    }
  }, [finishRecording]);

  // 질문 음성을 모두 읽은 직후 실제 브라우저 마이크 녹음을 시작한다.
  useEffect(() => {
    if (!activeQuestion) return;
    const question = activeQuestion;

    const stopQuestionVoice = playVarcoTts(
      question.question,
      QUESTION_VOICE_ID,
      () => {
        void beginRecording(question);
      },
      QUESTION_VOICE_PROPERTIES,
    );

    return () => {
      stopQuestionVoice();
    };
  }, [activeQuestion, beginRecording]);

  const togglePlay = () => {
    if (youtubeId) {
      const player = ytPlayerRef.current;
      if (!player?.getPlayerState) return;
      if (player.getPlayerState() === 1) {
        player.pauseVideo();
        setIsPlaying(false);
      } else {
        player.playVideo();
        setIsPlaying(true);
      }
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  // ---------- 배속 · 음량 · 자막 · 구간 이동 (로컬/유튜브 공용) ----------

  const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const cyclePlaybackRate = () => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(playbackRate) + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
    if (youtubeId) ytPlayerRef.current?.setPlaybackRate?.(next);
    else if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const applyVolume = (v: number) => {
    setVolume(v);
    setMuted(v === 0);
    if (youtubeId) {
      const player = ytPlayerRef.current;
      player?.setVolume?.(v);
      if (v === 0) player?.mute?.();
      else player?.unMute?.();
    } else if (videoRef.current) {
      videoRef.current.volume = v / 100;
      videoRef.current.muted = v === 0;
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (youtubeId) {
      if (next) ytPlayerRef.current?.mute?.();
      else ytPlayerRef.current?.unMute?.();
    } else if (videoRef.current) {
      videoRef.current.muted = next;
    }
  };

  const toggleCaptions = () => {
    const next = !captionsOn;
    setCaptionsOn(next);
    if (youtubeId) {
      const player = ytPlayerRef.current;
      if (next) player?.loadModule?.("captions");
      else player?.unloadModule?.("captions");
    } else if (videoRef.current) {
      for (const track of Array.from(videoRef.current.textTracks)) {
        track.mode = next ? "showing" : "hidden";
      }
    }
  };

  // ---------- 재생 바 표시/숨김 ----------

  // 스페이스 바 정지/재개 시 잠깐 보여줬다가 다시 숨긴다
  const flashControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      controlsTimerRef.current = null;
    }, 2500);
  }, []);

  // 마우스가 영상 하단 감지 영역에 들어오면 계속 표시, 나가면 숨김
  const handleZoneEnter = () => {
    if (controlsTimerRef.current) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }
    setControlsVisible(true);
  };
  const handleZoneLeave = () => {
    if (!controlsTimerRef.current) setControlsVisible(false);
  };

  // 메시지가 늘어나면(타이핑 포함) 항상 최신 내용이 보이도록 아래로 스크롤 — 내용이 잘리지 않게
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 스페이스 바 → 정지/재개 + 재생 바 잠깐 표시.
  // 키 핸들러가 항상 최신 togglePlay를 부르도록 ref로 우회한다.
  const togglePlayRef = useRef<() => void>(() => {});
  togglePlayRef.current = togglePlay;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return;
      e.preventDefault();
      togglePlayRef.current();
      flashControls();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flashControls]);

  // 진행 바 클릭 → 해당 지점으로 이동
  const handleSeek = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = ratio * duration;
    if (youtubeId) ytPlayerRef.current?.seekTo?.(t, true);
    else if (videoRef.current) videoRef.current.currentTime = t;
    setCurrentTime(t);
  };

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div ref={containerRef} className={`dsp-root${isFullscreen ? " dsp-fullscreen" : ""}`}>
      <style>{STYLES}</style>

      <div className="dsp-video-wrap">
        {youtubeId ? (
          // 유튜브 모드: 자체 컨트롤이 있는 iframe 플레이어 (호스트 div는 API가 iframe으로 교체)
          <div className="dsp-youtube-box">
            <div ref={ytHostRef} />
          </div>
        ) : (
          <video
            ref={videoRef}
            className="dsp-video"
            src={videoSrc}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onClick={togglePlay}
          />
        )}

        {title && !isFullscreen && <div className="dsp-title-overlay">{title}</div>}

        {/* 하단 감지 영역: 마우스가 들어오면 재생 바 표시 (iframe 위에서도 동작하도록 투명 레이어로 감지) */}
        <div className="dsp-bottom-zone" onMouseEnter={handleZoneEnter} onMouseLeave={handleZoneLeave}>
        <div className={`dsp-controls${controlsVisible ? "" : " dsp-controls-hidden"}`}>
          <button className="dsp-icon-btn" onClick={togglePlay} aria-label={isPlaying ? "일시정지" : "재생"}>
            {isPlaying ? "❚❚" : "▶"}
          </button>

          <div
            className="dsp-progress-bar"
            onClick={handleSeek}
            role="slider"
            aria-label="재생 위치"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration)}
            aria-valuenow={Math.floor(currentTime)}
            aria-valuetext={`${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`}
          >
            <div className="dsp-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>

          <div className="dsp-time-code" aria-live="off">
            <span>{formatPlaybackTime(currentTime)}</span>
            <span className="dsp-time-divider">/</span>
            <span>{formatPlaybackTime(duration)}</span>
          </div>

          {/* 음량: 스피커 버튼(음소거 토글) + 슬라이더 */}
          <button className="dsp-icon-btn" onClick={toggleMute} aria-label={muted ? "음소거 해제" : "음소거"}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
              {muted ? (
                <>
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              ) : (
                <>
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                </>
              )}
            </svg>
          </button>
          <input
            className="dsp-volume-slider"
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={(e) => applyVolume(Number(e.target.value))}
            aria-label="음량 조절"
          />

          {/* 배속: 누를 때마다 0.5 → 0.75 → 1 → 1.25 → 1.5 → 2 순환 */}
          <button className="dsp-pill-btn" onClick={cyclePlaybackRate} aria-label="재생 속도 변경">
            {playbackRate}×
          </button>

          {/* 자막: 자막 트랙이 없는 로컬 데모 영상에서는 비활성 표시 */}
          <button
            className={`dsp-icon-btn${captionsOn ? " dsp-btn-on" : ""}`}
            onClick={toggleCaptions}
            disabled={!youtubeId}
            title={youtubeId ? "자막 켜기/끄기" : "이 영상에는 자막이 없어요"}
            aria-label="자막 켜기/끄기"
          >
            {/* 유튜브 스타일 자막 아이콘: 둥근 사각형 + 자막 줄 두 개 */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="2.5" />
              <line x1="6.5" y1="14.5" x2="9.5" y2="14.5" />
              <line x1="12.5" y1="14.5" x2="17.5" y2="14.5" />
            </svg>
          </button>

          <button
            className="dsp-icon-btn"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "전체화면 종료" : "전체화면 시작"}
          >
            {/* 확대(모서리가 바깥으로) / 축소(모서리가 안으로) 아이콘을 분명히 구분해서 표시 */}
            {isFullscreen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 4v4a1 1 0 0 1-1 1H4" />
                <path d="M20 9h-4a1 1 0 0 1-1-1V4" />
                <path d="M4 15h4a1 1 0 0 1 1 1v4" />
                <path d="M15 20v-4a1 1 0 0 1 1-1h4" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 9V5a1 1 0 0 1 1-1h4" />
                <path d="M15 4h4a1 1 0 0 1 1 1v4" />
                <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
                <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
              </svg>
            )}
          </button>
        </div>
        </div>
      </div>

      <div className={`dsp-chat-panel${panelVisible ? "" : " dsp-panel-hidden"}`}>
        <div className="dsp-chat-messages" ref={messagesRef}>
          {messages.map((m) => m.text ? (
            <div key={m.id} className={`dsp-bubble dsp-bubble-${m.role}`}>
              {m.text}
            </div>
          ) : null)}
        </div>

        <div className="dsp-mic-area">
          <div
            className={`dsp-vad-icon dsp-vad-${micState === "listening" && voiceActive ? "speaking" : micState}`}
            aria-hidden
          >
            {/* 선형 마이크 아이콘 — 상태 색(currentColor)을 따라간다. 클릭 불필요, 상시 대기 상태를 표현 */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
              <line x1="12" y1="18" x2="12" y2="22" />
            </svg>
          </div>
          <div className={`dsp-waveform${voiceActive ? " dsp-waveform-active" : ""}`} aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="dsp-wave-bar" style={{ animationDelay: `${i * 0.1}s` }} />
            ))}
          </div>
          <div className="dsp-mic-label" aria-live="polite">
            {micState === "idle" && "시청 중"}
            {micState === "listening" && (voiceActive ? "말씀을 듣고 있어요..." : "편하게 말씀해 주세요.")}
            {micState === "processing" && !submitting && ""}
          </div>
          {micState === "listening" && (
            <button type="button" className="dsp-record-done" onClick={stopRecording}>
              답변 완료
            </button>
          )}
          {recordingError && <div className="dsp-record-error" role="status">{recordingError}</div>}
          {recordingError && activeQuestion && micState === "idle" && (
            <button type="button" className="dsp-record-done" onClick={() => void beginRecording(activeQuestion)}>
              다시 말하기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 스타일 (넷플릭스 톤: 블랙 배경 + 레드 포인트)
// ============================================================================
const STYLES = `
.dsp-root {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 480px;
  background: #000;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
  position: relative;
  overflow: hidden;
}
.dsp-root.dsp-fullscreen {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
}

.dsp-video-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dsp-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  cursor: pointer;
}
.dsp-youtube-box {
  width: 100%;
  height: 100%;
  background: #000;
}
.dsp-youtube-box iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
}

.dsp-title-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 20px 24px;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: linear-gradient(to bottom, rgba(0,0,0,0.75), transparent);
  pointer-events: none;
}

/* 하단 감지 영역: 이 안에 마우스가 있으면 재생 바가 보인다 */
.dsp-bottom-zone {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 120px;
}

.dsp-controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px 18px;
  background: linear-gradient(to top, rgba(0,0,0,0.85), transparent);
  transition: opacity 0.25s ease;
}
.dsp-controls-hidden {
  opacity: 0;
  pointer-events: none;
}
.dsp-icon-btn {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: none;
  background: rgba(255,255,255,0.15);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
  transition: background 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dsp-icon-btn:hover:not(:disabled) {
  background: #8b5cf6;
}
.dsp-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dsp-progress-bar {
  position: relative;
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: rgba(255,255,255,0.25);
  cursor: pointer;
}

.dsp-time-code {
  flex-shrink: 0;
  min-width: 104px;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}
.dsp-time-divider {
  margin: 0 5px;
  color: rgba(255,255,255,0.58);
}

.dsp-volume-slider {
  width: 78px;
  accent-color: #8b5cf6;
  cursor: pointer;
}

.dsp-pill-btn {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  border: none;
  background: rgba(255,255,255,0.15);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease;
}
.dsp-pill-btn:hover {
  background: #8b5cf6;
}
.dsp-btn-on {
  background: #8b5cf6;
}
.dsp-progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: 3px;
  background: #8b5cf6;
  transition: width 0.15s linear;
}
/* 질문·공감 대화창: 영상이 멈춘 동안 화면 중앙에 큰 팝업으로 보여준다. */
.dsp-chat-panel {
  position: absolute;
  left: 50%;
  top: 50%;
  width: min(720px, calc(100% - 48px));
  min-width: 320px;
  height: min(440px, calc(100% - 120px));
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(167, 139, 250, 0.5);
  border-radius: 24px;
  background: rgba(14, 10, 22, 0.9);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.68);
  overflow: hidden;
  transform: translate(-50%, -50%);
  transition: opacity 0.35s ease, transform 0.35s ease;
  z-index: 30;
}
/* 질문이 없는 동안에는 대화창을 숨긴다 */
.dsp-panel-hidden {
  opacity: 0;
  transform: translate(-50%, calc(-50% + 14px));
  pointer-events: none;
}


.dsp-chat-messages {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
  padding: 28px 32px 18px;
  overflow-y: auto;
}
.dsp-bubble {
  max-width: 100%;
  padding: 16px 20px;
  border-radius: 18px;
  font-size: 24px;
  line-height: 1.55;
  word-break: keep-all;
  white-space: pre-wrap;
}
.dsp-bubble-question {
  align-self: flex-start;
  background: #8b5cf6;
  color: #fff;
  border-bottom-left-radius: 4px;
  font-weight: 800;
}
.dsp-bubble-ai {
  align-self: flex-start;
  background: #2a2a2a;
  color: #f2f2f2;
  border-bottom-left-radius: 4px;
  font-size: 22px;
  font-weight: 600;
}
.dsp-bubble-user {
  align-self: flex-end;
  background: #3a3a3a;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.dsp-mic-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 16px 18px 22px;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.dsp-vad-icon {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, opacity 0.2s ease;
}
.dsp-vad-idle {
  background: #333;
  color: #fff;
  opacity: 0.55;
}
.dsp-vad-listening {
  background: #333;
  color: #fff;
  opacity: 0.72;
}
.dsp-vad-speaking {
  background: #8b5cf6;
  color: #fff;
  animation: dsp-pulse-ring 1.1s ease-out infinite;
}
.dsp-vad-processing {
  background: #b8860b;
  color: #fff;
  animation: dsp-pulse-fade 0.9s ease-in-out infinite;
}
.dsp-mic-label {
  font-size: 16px;
  color: #ddd;
  font-weight: 700;
}
.dsp-record-done {
  min-width: 118px;
  min-height: 46px;
  margin-top: 12px;
  border: 0;
  border-radius: 999px;
  background: #8b5cf6;
  color: #fff;
  font-size: 17px;
  font-weight: 800;
  cursor: pointer;
}
.dsp-record-done:hover { background: #a78bfa; }
.dsp-record-error {
  margin-top: 10px;
  color: #fde68a;
  font-size: 14px;
  line-height: 1.45;
  text-align: center;
}

.dsp-waveform {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 3px;
  height: 16px;
}
.dsp-wave-bar {
  width: 3px;
  height: 5px;
  border-radius: 2px;
  background: #444;
  transition: background 0.2s ease;
}
.dsp-waveform-active .dsp-wave-bar {
  background: #a78bfa;
  animation: dsp-wave-bounce 0.9s ease-in-out infinite;
}

@keyframes dsp-pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(139,92,246,0.55); }
  70% { box-shadow: 0 0 0 16px rgba(139,92,246,0); }
  100% { box-shadow: 0 0 0 0 rgba(139,92,246,0); }
}
@keyframes dsp-pulse-fade {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@keyframes dsp-wave-bounce {
  0%, 100% { height: 5px; }
  50% { height: 16px; }
}
`;
