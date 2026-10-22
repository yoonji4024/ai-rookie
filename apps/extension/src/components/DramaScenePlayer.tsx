import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  playVarcoTts,
  GRANDMA_ANSWER_VOICE_ID,
  QUESTION_VOICE_ID,
  QUESTION_VOICE_PROPERTIES,
} from "../lib/varcoTts";

// ============================================================================
// 타입 정의
// ============================================================================

export interface DramaQuestion {
  id: string;
  /** 영상 재생 중 이 시각(초)에 도달하면 자동으로 일시정지하고 질문을 띄운다 */
  timestamp: number;
  /** 챗 패널에 표시할 질문 문구 */
  question: string;
  /** (데모용) 사용자가 답했다고 가정하는 텍스트. 실제 서비스에서는 ASR 결과 텍스트로 대체된다 */
  simulatedAnswer: string;
  /** 답변 후 보여줄 AI 칭찬/피드백 문구 */
  feedback: string;
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
}

type MicState = "idle" | "listening" | "processing";

interface ChatMessage {
  id: string;
  role: "question" | "user" | "ai";
  text: string;
}

// ============================================================================
// ASR 시뮬레이션 영역
// 실제 서비스에서는 이 함수를 Web Speech API / 서버 ASR 연동 로직으로 교체한다.
// 데모에서는 정해진 답변 텍스트를 약간의 지연 후 그대로 반환한다.
// ============================================================================
function simulateASR(answerText: string): Promise<string> {
  // TODO: 실제 ASR 연동 지점 — 마이크 입력을 받아 STT 결과를 resolve 하도록 교체
  return new Promise((resolve) => {
    setTimeout(() => resolve(answerText), 900);
  });
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

// 초 단위 시각을 "0:35" / "1:02:03" 형식으로 표시 (1시간 넘으면 시:분:초)
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ============================================================================
// 메인 컴포넌트
// ============================================================================

export default function DramaScenePlayer({ videoSrc, youtubeId, questions, title }: DramaScenePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<number | null>(null);
  const ytHostRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<any>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [answeredIds, setAnsweredIds] = useState<Set<string>>(new Set());
  const [activeQuestion, setActiveQuestion] = useState<DramaQuestion | null>(null);
  const [micState, setMicState] = useState<MicState>("idle");
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

  const sortedQuestions = [...questions].sort((a, b) => a.timestamp - b.timestamp);

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
      if (typingTimerRef.current) window.clearInterval(typingTimerRef.current);
      if (panelHideTimerRef.current) window.clearTimeout(panelHideTimerRef.current);
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
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

  // 한 글자씩 타이핑되는 효과로 메시지를 채팅창에 추가
  const appendTypedMessage = useCallback(
    (role: ChatMessage["role"], fullText: string, onDone?: () => void) => {
      const id = nextId();
      setMessages((prev) => [...prev, { id, role, text: "" }]);
      let i = 0;
      typingTimerRef.current = window.setInterval(() => {
        i += 1;
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: fullText.slice(0, i) } : m)));
        if (i >= fullText.length) {
          if (typingTimerRef.current) window.clearInterval(typingTimerRef.current);
          onDone?.();
        }
      }, 35);
    },
    []
  );

  // VAD(음성 활동 감지) 시뮬레이션: AI가 질문을 다 읽고 나서야 "듣는 중" 상태로
  // 전환된다(질문을 읽는 동안 마이크가 녹음 중인 것처럼 보이지 않도록 함).
  // "듣는 중" 상태에서는 실제로 할머니(환자) 목소리로 답변을 읽어줘서, 마이크가
  // 그 발화를 녹음하고 있는 것처럼 보이게 한다 — 재생이 끝나는 시점에 맞춰
  // 자연스럽게 "음… 잠깐만요"로 넘어간다.
  useEffect(() => {
    if (!activeQuestion) return;
    const question = activeQuestion;
    let stopAnswerVoice: (() => void) | null = null;

    const stopQuestionVoice = playVarcoTts(
      question.question,
      QUESTION_VOICE_ID,
      () => {
        setMicState("listening");
        stopAnswerVoice = playVarcoTts(question.simulatedAnswer, GRANDMA_ANSWER_VOICE_ID, () => {
          setMicState("processing");
          simulateASR(question.simulatedAnswer).then((answerText) => {
            appendTypedMessage("user", answerText, () => {
              appendTypedMessage("ai", question.feedback, () => {
                setMicState("idle");
                setAnsweredIds((prev) => new Set(prev).add(question.id));
                setActiveQuestion(null);
                resumePlayback();
                // 피드백을 읽을 시간을 잠깐 준 뒤 다음 질문 시점까지 대화창을 숨긴다
                panelHideTimerRef.current = window.setTimeout(() => {
                  setPanelVisible(false);
                  panelHideTimerRef.current = null;
                }, 2200);
              });
            });
          });
        });
      },
      QUESTION_VOICE_PROPERTIES,
    );

    return () => {
      stopQuestionVoice();
      stopAnswerVoice?.();
    };
  }, [activeQuestion, appendTypedMessage, resumePlayback]);

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

          <div className="dsp-progress-bar" onClick={handleSeek} role="slider" aria-label="재생 위치">
            <div className="dsp-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>

          <div className="dsp-time-label" aria-label="재생 시간">
            {formatTime(currentTime)} / {formatTime(duration)}
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
          {messages.map((m) => (
            <div key={m.id} className={`dsp-bubble dsp-bubble-${m.role}`}>
              {m.text}
            </div>
          ))}
        </div>

        <div className="dsp-mic-area">
          <div className={`dsp-vad-icon dsp-vad-${micState}`} aria-hidden>
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
          <div className={`dsp-waveform${micState === "listening" ? " dsp-waveform-active" : ""}`} aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="dsp-wave-bar" style={{ animationDelay: `${i * 0.1}s` }} />
            ))}
          </div>
          <div className="dsp-mic-label" aria-live="polite">
            {micState === "idle" && ""}
            {micState === "listening" && "듣고 있어요..."}
            {micState === "processing" && "음… 잠깐만요"}
          </div>
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

.dsp-time-label {
  flex-shrink: 0;
  color: #fff;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
/* 대화창: 영상 위 우하단에 떠 있는 작은 반투명 오버레이.
   하단 재생 컨트롤(전체화면 버튼 등)을 가리지 않도록 바닥에서 띄운다.
   내용이 길면 메시지 영역이 스크롤되고 항상 최신 메시지가 보인다 */
.dsp-chat-panel {
  position: absolute;
  right: 16px;
  bottom: 84px;
  width: 200px;
  height: min(300px, calc(100% - 100px));
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: rgba(20, 20, 20, 0.3);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  transition: opacity 0.35s ease, transform 0.35s ease;
}
/* 질문이 없는 동안에는 대화창을 숨긴다 */
.dsp-panel-hidden {
  opacity: 0;
  transform: translateY(10px);
  pointer-events: none;
}


.dsp-chat-messages {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  overflow-y: auto;
}
.dsp-bubble {
  max-width: 92%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.45;
  word-break: keep-all;
  white-space: pre-wrap;
}
.dsp-bubble-question {
  align-self: flex-start;
  background: #8b5cf6;
  color: #fff;
  border-bottom-left-radius: 4px;
}
.dsp-bubble-ai {
  align-self: flex-start;
  background: #8b5cf6;
  color: #fff;
  border-bottom-left-radius: 4px;
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
  padding: 9px;
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
  font-size: 12px;
  color: #999;
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
