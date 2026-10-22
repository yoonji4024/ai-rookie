import { useMemo, useState } from "react";
import GuardianDramaReport, {
  DAILY_QUESTIONS,
  DIAGNOSTIC_QUESTIONS,
} from "./components/GuardianDramaReport";
import PatientInfoGate, { LoginInfo } from "./components/PatientInfoGate";
import ContentSelectScreen from "./components/ContentSelectScreen";
import DramaScenePlayer, { DramaQuestion } from "./components/DramaScenePlayer";
import FaceDemoScreen from "./components/FaceDemoScreen";
import OrientationCheck, { type OrientationSession } from "./components/OrientationCheck";
import type { ReportResponse } from "./lib/scoreApi";

// A.X STT가 일시적으로 실패할 때만 쓰는 고지된 시연 전사.
// 보호자 리포트의 "틀린 답변 목업"과 분리해야 실제 사용자의 답을 왜곡하지 않는다.
const DEMO_TRANSCRIPT_FALLBACKS: Record<string, string> = {
  d1: "대학가요제에서 대상을 탔대요.",
  x1: "대학가요제에서 대상을 받고 유명해져서요.",
  d2: "대학교 1학년 때 만났대요.",
  x2: "트리하우스 지붕을 고치려고요.",
};

// 사용자의 답을 처리하는 동안 먼저 건네는 장면별 감상. 정답을 미리 흘리지
// 않으면서도 질문마다 실제로 영상을 함께 보고 있다는 느낌을 준다.
const CONVERSATION_OPENERS: Record<string, string[]> = {
  d1: [
    "저는 오래된 대학가요제 사진이 먼저 눈에 들어왔어요.",
    "가요제 시절 사진을 가리키며 이야기하시던 모습이 인상적이었어요.",
    "사진 속 젊은 시절 모습이 참 멋져 보였어요.",
  ],
  x1: [
    "기타를 치며 그 시절 이야기를 들려주시는 모습이 정겨웠어요.",
    "기타를 들고 옛날 이야기를 떠올리시는 모습이 눈에 들어왔어요.",
    "그 시절을 이야기하며 노래하시던 모습이 인상적이었어요.",
  ],
  d2: [
    "두 분이 함께 음식을 나눠 드시는 모습이 참 편안해 보였어요.",
    "같이 식사하시는 모습이 참 정겨웠어요.",
    "두 분이 한자리에서 음식을 즐기시는 모습이 보기 좋았어요.",
  ],
  x2: [
    "저는 높은 곳에 서 계셔서 괜히 제가 다 조마조마했어요.",
    "나무 사이 높은 곳에서 움직이시는 모습이 먼저 눈에 들어왔어요.",
    "지붕 위에 서 계신 모습을 보니 괜히 걱정이 됐어요.",
  ],
};

// 사용자 체험 페이지용 질문. 질문·시점·정답은 보호자 리포트와 공유하되,
// 장애 시 대체 전사는 위의 올바른 시연 대본을 명시적으로 사용한다.
const BASE_USER_QUESTIONS: DramaQuestion[] = [...DAILY_QUESTIONS, ...DIAGNOSTIC_QUESTIONS]
  .sort((a, b) => a.videoTimestamp - b.videoTimestamp)
  .map((q) => ({
    id: q.id,
    timestamp: q.videoTimestamp,
    question: q.question,
    simulatedAnswer: DEMO_TRANSCRIPT_FALLBACKS[q.id] ?? q.correctAnswer,
    correctAnswer: q.correctAnswer,
    answerKeywords: q.answerKeywords,
    conversationOpeners: CONVERSATION_OPENERS[q.id],
    // 실제 화면 반응은 STT 결과를 본 뒤 동적으로 생성한다. 이 문구는 API 장애 시에도
    // 정답을 단정하지 않기 위한 안전한 최종 폴백이다.
    feedback: "이야기해 주셔서 고마워요. 우리 계속 같이 볼까요?",
  }));

// 뉴스 체험용 질문 (유튜브 영상: KBS "영하 75도 냉동창고 취재", 1분 2초)
const NEWS_YOUTUBE_ID = "7mYPIds26Js";
const NEWS_QUESTIONS: DramaQuestion[] = [
  {
    id: "n1",
    timestamp: 15,
    question: "와, 화면만 봐도 정말 추워 보이네요. 온도계가 몇 도쯤이었을까요?",
    simulatedAnswer: "영하 75도… 라고 했던 것 같아요. 엄청 춥던데.",
    feedback: "그러게요, 정말 추운 온도였어요. 이야기 잘 들었어요.",
  },
  {
    id: "n2",
    timestamp: 32,
    question: "기자가 아주 특별한 곳에 들어갔는데요. 어떤 곳이었을까요?",
    simulatedAnswer: "아주 차가운 창고… 냉동창고라고 했어요.",
    feedback: "맞아요, 초저온 냉동창고였죠. 우리 이어서 볼까요?",
  },
  {
    id: "n3",
    timestamp: 50,
    question: "기자가 안으로 들어갔을 때 모습이 어땠는지 편하게 이야기해 주세요.",
    simulatedAnswer: "하얗게 김이 서리고 아주 추워 보였어요.",
    feedback: "그러게요, 보기만 해도 추운 장면이었어요. 이야기 나눠주셔서 고마워요.",
  },
];

// 경로별 페이지 구성:
//   /      → 로그인 후 사용유형에 따라 분기
//            보호자 → 미디어 시청 리포트
//            사용자 → 콘텐츠 선택 화면 → 예능·교양/뉴스 체험
//   /user  → 미디어 시청 사용자 화면 (로그인 없이 바로 진입)
export default function App() {
  const [login, setLogin] = useState<LoginInfo | null>(null);
  const [content, setContent] = useState<"media" | "news" | null>(null);
  const [orientationSession, setOrientationSession] = useState<OrientationSession | null>(null);
  const pathname = window.location.pathname.replace(/\/+$/, "");
  const isUserPage = pathname === "/user";
  const isFaceDemoPage = pathname === "/face-demo";

  const finishSession = (report: ReportResponse) => {
    const userKey = (report.patientName ?? login?.username ?? "anonymous").trim() || "anonymous";
    window.localStorage.setItem(`memflix-latest-report:${userKey}`, JSON.stringify(report));
  };
  const userQuestions = useMemo<DramaQuestion[]>(() => [
    ...BASE_USER_QUESTIONS,
    {
      id: "f-reflection",
      timestamp: 385,
      question: `저는 두 분이 함께 음식을 나눠 드시던 모습이 참 정겨워서 마음에 남았어요. ${login?.username ?? "시연 사용자"} 님은 어떤 장면이 가장 마음에 남으셨어요? 왜 마음에 남았는지도 편하게 들려주세요.`,
      simulatedAnswer: "두 분이 함께 웃으며 식사하던 장면이 따뜻해 보여서 기억에 남았어요.",
      correctAnswer: "정답이 없는 자유 감상",
      answerKeywords: [],
      conversationOpeners: [
        "이야기를 듣고 있으니 그 장면이 다시 떠오르는 것 같아요.",
        "그 장면이 마음에 남으셨군요. 이야기해 주셔서 고마워요.",
        "어떤 마음으로 보셨는지 들으니 저도 그 장면을 다시 보게 되네요.",
      ],
      feedback: "어떤 마음으로 보셨는지 들려주셔서 고마워요.",
      maxRecordingMs: 60_000,
    },
  ].sort((a, b) => a.timestamp - b.timestamp), [login?.username]);
  const mediaPlayer = (
    <DramaScenePlayer
      videoSrc="/videos/H231141.mp4"
      contentId="H231141"
      patientName={login?.username ?? "시연 사용자"}
      patientBirthDatePromise={orientationSession?.patientBirthDate}
      questions={userQuestions}
      initialAnswers={orientationSession?.answers}
      initialAudio={orientationSession?.audio}
      initialTranscriptions={orientationSession?.transcriptions}
      onSessionComplete={finishSession}
    />
  );
  const newsPlayer = (
    <DramaScenePlayer
      youtubeId={NEWS_YOUTUBE_ID}
      contentId="NEWS_DEMO"
      patientName={login?.username ?? "시연 사용자"}
      patientBirthDatePromise={orientationSession?.patientBirthDate}
      questions={NEWS_QUESTIONS}
      initialAnswers={orientationSession?.answers}
      initialAudio={orientationSession?.audio}
      initialTranscriptions={orientationSession?.transcriptions}
      onSessionComplete={finishSession}
    />
  );

  let screen;
  if (isFaceDemoPage) {
    screen = <FaceDemoScreen />;
  } else if (isUserPage) {
    screen = mediaPlayer;
  } else if (!login) {
    screen = <PatientInfoGate onComplete={setLogin} />;
  } else if (login.role === "guardian") {
    screen = <GuardianDramaReport patientName={login.username} />;
  } else if (!orientationSession) {
    screen = (
      <OrientationCheck
        patientName={login.username}
        onComplete={setOrientationSession}
      />
    );
  } else if (content === "media") {
    screen = mediaPlayer;
  } else if (content === "news") {
    screen = newsPlayer;
  } else {
    screen = (
      <ContentSelectScreen
        onSelectMedia={() => setContent("media")}
        onSelectNews={() => setContent("news")}
      />
    );
  }

  const showNavigation = !isFaceDemoPage && (isUserPage || login !== null);
  const returnFromScreen = () => {
    if (isUserPage) {
      window.location.assign("/");
      return;
    }
    if (content !== null) {
      setContent(null);
      return;
    }
    setOrientationSession(null);
    setLogin(null);
  };
  const navigationLabel = content !== null ? "영상 선택으로" : "로그인 화면으로";

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
      {showNavigation && (
        <button
          type="button"
          aria-label={navigationLabel}
          title={navigationLabel}
          onClick={returnFromScreen}
          style={NAVIGATION_STYLE}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 10.8 12 3l9 7.8v9.7a.5.5 0 0 1-.5.5H15v-6H9v6H3.5a.5.5 0 0 1-.5-.5v-9.7Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {screen}
    </div>
  );
}

const NAVIGATION_STYLE = {
  position: "fixed",
  top: "20px",
  left: "20px",
  zIndex: 10000,
  width: "48px",
  height: "48px",
  display: "grid",
  placeItems: "center",
  borderRadius: "50%",
  border: "1px solid rgba(167, 139, 250, 0.7)",
  background: "rgba(18, 15, 26, 0.88)",
  color: "#ffffff",
  cursor: "pointer",
  boxShadow: "0 8px 28px rgba(0, 0, 0, 0.35)",
} as const;
