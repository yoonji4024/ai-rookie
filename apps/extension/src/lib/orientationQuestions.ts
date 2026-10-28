// ============================================================================
// 지남력(시간·장소·사람) 문진 데이터 — 단일 소스.
// Pet 의 아침 안부(greeting)와 보호자 리포트가 같은 문항을 공유한다.
//
// question/simulatedAnswer/feedback 은 사용자에게 보이므로 측정 목적(치매/인지/
// 검사 등) 문구를 절대 넣지 않는다. categoryLabel/correctAnswer 는 보호자 리포트
// 전용이라 지남력 용어를 써도 된다.
//
// 주의 — 이 파일은 예전에 모듈 로드 시점의 `new Date()` 를 상수로 구워 뒀다.
// 사이드 패널처럼 오래 사는 문서에서는 자정을 넘기면 기준 답이 어제가 되므로,
// 지금은 호출 시점의 시각을 받는 함수로 바뀌었다. 시각이 필요하면 반드시
// getOrientationQuestions(at) 를 다시 호출할 것.
// ============================================================================

// src/shared/** 를 가리킬 때는 확장자 ".ts" 를 반드시 붙인다.
// 이유: 그래야 node 가 빌드나 로더 없이 이 코드를 그대로 실행할 수 있고, 덕분에
// `node --test` 가 의존성 0으로 shared 엔진을 테스트할 수 있다.
// tsconfig 의 allowImportingTsExtensions 와 Vite 둘 다 이 표기를 받아들인다.
import { formatMonthDay, formatWeekday, now, seasonOf } from "../shared/time/now.ts";

/** 챗봇 필드(ChatbotQuestion과 구조적으로 호환) + 보호자 리포트 전용 필드 */
export interface OrientationQuestion {
  id: string;
  /** 지남력 분류 */
  category: "time" | "place" | "person";
  /** 리포트 카드/목록의 메타 라벨 (보호자 전용) */
  categoryLabel: string;
  /** Pet 이 TTS로 읽어줄 질문 문구 */
  question: string;
  /** (데모용) 사용자가 답했다고 가정하는 텍스트 — 리포트의 "사용자 답"으로도 표시 */
  simulatedAnswer: string;
  /** Pet 의 피드백 문구 */
  feedback: string;
  /** 보호자 리포트의 "기준 답안" — 시간 문항은 호출 시점 날짜에서 파생 */
  correctAnswer: string;
  /** 리포트 표시 순서 (1이 먼저) */
  rank: number;
}

/**
 * 일상 안부처럼 자연스럽게 묻는 지남력 문항.
 * 노출 순서는 배열 순서, 리포트 순서는 rank.
 * @param at 기준 시각. 생략하면 호출 시점 — 자정을 넘겨도 항상 오늘 기준이 된다.
 */
export function getOrientationQuestions(at: Date = now()): OrientationQuestion[] {
  const monthDay = formatMonthDay(at);
  const weekday = formatWeekday(at);
  const season = seasonOf(at);

  return [
    {
      // 시간 지남력 ① 계절·날씨 (아이스브레이킹)
      id: "ori-time-season",
      category: "time",
      categoryLabel: "시간 지남력 · 계절",
      // 앞의 인사말은 6단계에서 greeting.ts 의 별도 인사 턴이 가져간다.
      // 그때 이 문장에서 "안녕하세요!"를 떼어내면 인사가 두 번 나오지 않는다.
      question: "안녕하세요! 오늘 날씨는 어떤가요?",
      simulatedAnswer: `해가 쨍쨍하고 많이 덥네요. 요즘 한창 ${season}이잖아요.`,
      feedback: `맞아요, 요즘 ${season}이죠. 날씨 이야기 들려주셔서 고마워요!`,
      correctAnswer: `현재 계절(${season})과 오늘 날씨를 실제와 비슷하게 말한다.`,
      rank: 4,
    },
    {
      // 시간 지남력 ② 날짜·요일
      id: "ori-time-date",
      category: "time",
      categoryLabel: "시간 지남력 · 날짜",
      question: "오늘이 몇 월 며칠이었죠? 무슨 요일인지도 궁금해요!",
      simulatedAnswer: `오늘이… ${monthDay}이고, ${weekday} 맞죠?`,
      feedback: `네, ${monthDay} ${weekday}이에요! 정확하게 기억하고 계시네요.`,
      correctAnswer: `오늘은 ${monthDay} ${weekday}이다.`,
      rank: 1,
    },
    {
      // 장소 지남력 — 현재 위치·주변 환경
      id: "ori-place",
      category: "place",
      categoryLabel: "장소 지남력",
      question: "지금 계신 곳은 어디인가요?",
      simulatedAnswer: "집 거실이에요. 소파에 앉아서 텔레비전 보려던 참이에요.",
      feedback: "편안한 거실에서 함께해 주시니 좋네요!",
      correctAnswer: "현재 있는 곳(집·병원 등 구체적인 장소)을 정확히 말한다.",
      rank: 2,
    },
    {
      // 사람 지남력 — 친숙한 사람·관계 인식
      id: "ori-person",
      category: "person",
      categoryLabel: "사람 지남력",
      question: "오늘은 누구와 함께 시간을 보내셨어요? 가족분들 이야기도 듣고 싶어요.",
      simulatedAnswer: "낮에 딸이 다녀갔어요. 우리 손녀도 같이 와서 수박 먹고 갔지요.",
      // 예전 문구는 "이제 로그인하고 재미있는 영상 보러 가요"였다. 확장에는 로그인이 없고,
      // Pet 은 다음 행동을 지시하는 대신 관계를 잇는 말로 턴을 닫는다.
      feedback: "따님이랑 손녀분 얘기 들으니까 저도 기분이 좋아요. 오늘도 같이 있어요!",
      correctAnswer: "함께 시간을 보낸 가족·지인과의 관계(딸, 손녀 등)를 정확히 말한다.",
      rank: 3,
    },
  ];
}

/**
 * 호환 shim — 기존 호출처(PatientInfoGate, GuardianDramaReport)가 깨지지 않도록 남긴다.
 * 모듈 로드 시점에 한 번 계산되므로 오래 사는 문서에서는 쓰지 말 것.
 * 새 코드는 getOrientationQuestions(at) 를 직접 부른다.
 */
export const ORIENTATION_QUESTIONS: OrientationQuestion[] = getOrientationQuestions();
