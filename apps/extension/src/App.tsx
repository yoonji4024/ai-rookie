import { useState } from "react";
import GuardianDramaReport, {
  DAILY_QUESTIONS,
  DIAGNOSTIC_QUESTIONS,
} from "./components/GuardianDramaReport";
import PatientInfoGate, { LoginInfo } from "./components/PatientInfoGate";
import ContentSelectScreen from "./components/ContentSelectScreen";
import DramaScenePlayer, { DramaQuestion } from "./components/DramaScenePlayer";
import FaceDemoScreen from "./components/FaceDemoScreen";
import PetPreviewScreen from "./routes/PetPreviewScreen";
import MomentHighlightCard from "./components/MomentHighlightCard";
import { MEMORY_KEY, reviveMemory, type MomentCard } from "./shared/pet/memory";
import { PERSONA } from "./shared/pet/persona";

// 사용자(치매위험군) 체험 페이지용 질문.
// 보호자 리포트와 같은 데이터(일상 내용 + 진단용 질문)에서 만들어
// 질문·시점·사용자 답이 두 화면에서 항상 일치한다.
const USER_QUESTIONS: DramaQuestion[] = [...DAILY_QUESTIONS, ...DIAGNOSTIC_QUESTIONS]
  // 영상 시점이 있는 질문만 영상 체험에 쓴다 — 안부·놀이 신호에는 시점이 없다
  .filter((q): q is typeof q & { videoTimestamp: number } => q.videoTimestamp !== undefined)
  .sort((a, b) => a.videoTimestamp - b.videoTimestamp)
  .map((q, i, arr) => ({
    id: q.id,
    timestamp: q.videoTimestamp,
    question: q.question,
    simulatedAnswer: q.userAnswer,
    feedback:
      i === arr.length - 1
        ? PERSONA.lines.promise
        : "네, 답변 잘 들었어요. 계속 이어서 볼까요?",
  }));

// 뉴스 체험용 질문 (유튜브 영상: KBS "영하 75도 냉동창고 취재", 1분 2초)
const NEWS_YOUTUBE_ID = "7mYPIds26Js";
const NEWS_QUESTIONS: DramaQuestion[] = [
  {
    id: "n1",
    timestamp: 15,
    question: "화면 속 온도계는 몇 도를 가리키고 있었나요?",
    simulatedAnswer: "영하 75도… 라고 했던 것 같아요. 엄청 춥던데.",
    feedback: "맞아요, 영하 75.6도였어요. 숫자까지 잘 기억하셨네요!",
  },
  {
    id: "n2",
    timestamp: 32,
    question: "기자가 취재하러 들어간 곳은 어떤 곳이었나요?",
    simulatedAnswer: "아주 차가운 창고… 냉동창고라고 했어요.",
    feedback: "네, 초저온 냉동창고였죠. 잘 보고 계세요!",
  },
  {
    id: "n3",
    timestamp: 50,
    question: "냉동창고에 들어간 기자의 모습은 어땠나요?",
    simulatedAnswer: "하얗게 김이 서리고 아주 추워 보였어요.",
    feedback: "맞아요, 보기만 해도 추운 장면이었죠. 끝까지 함께 봐주셔서 감사해요!",
  },
];

// 경로별 페이지 구성:
//   /      → 로그인 후 사용유형에 따라 분기
//            보호자 → 드라마 파트 리포트
//            사용자 → 콘텐츠 선택 화면 → 드라마/뉴스 체험
//   /user  → 치매위험군 사용자용 드라마 체험 화면 (로그인 없이 바로 진입)
//   /pet   → Pet 작업대 (가짜 타임라인 + 패널·떠 있는 두리 미리보기)
/**
 * Pet 이 남긴 '오늘 웃었던 순간' 카드를 읽는다.
 * 확장은 chrome.storage 에, 웹앱은 localStorage 에 같은 키로 쓴다.
 * Phase A 에서는 확장과 웹앱이 같은 브라우저에서 돌 때만 이어지고,
 * Phase B 에서 서버를 경유하게 되면 이 함수만 바뀐다.
 */
function readLatestMoment(): MomentCard | null {
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY);
    if (!raw) return null;
    return reviveMemory(JSON.parse(raw)).moments[0] ?? null;
  } catch {
    return null;
  }
}

export default function App() {
  const [login, setLogin] = useState<LoginInfo | null>(null);
  const [content, setContent] = useState<"drama" | "news" | null>(null);
  const pathname = window.location.pathname.replace(/\/+$/, "");
  const isUserPage = pathname === "/user";
  const isFaceDemoPage = pathname === "/face-demo";
  // Pet 패널 작업대. 확장을 빌드하지 않고도 대사·타이밍·표정을 확인하는 경로이자
  // 무대에서 확장이 죽었을 때의 백업 경로다.
  const isPetPreviewPage = pathname === "/pet";

  const dramaPlayer = <DramaScenePlayer videoSrc="/videos/H231141.mp4" questions={USER_QUESTIONS} />;
  const newsPlayer = <DramaScenePlayer youtubeId={NEWS_YOUTUBE_ID} questions={NEWS_QUESTIONS} />;

  let screen;
  if (isPetPreviewPage) {
    screen = <PetPreviewScreen />;
  } else if (isFaceDemoPage) {
    screen = <FaceDemoScreen />;
  } else if (isUserPage) {
    screen = dramaPlayer;
  } else if (!login) {
    screen = <PatientInfoGate onComplete={setLogin} />;
  } else if (login.role === "guardian") {
    screen = (
      <GuardianDramaReport
        patientName={login.username}
        momentCard={
          <MomentHighlightCard moment={readLatestMoment()} petName={PERSONA.defaultPetName} />
        }
      />
    );
  } else if (content === "drama") {
    screen = dramaPlayer;
  } else if (content === "news") {
    screen = newsPlayer;
  } else {
    screen = (
      <ContentSelectScreen
        onSelectDrama={() => setContent("drama")}
        onSelectNews={() => setContent("news")}
      />
    );
  }

  return <div style={{ width: "100vw", height: "100vh", background: "#000" }}>{screen}</div>;
}
