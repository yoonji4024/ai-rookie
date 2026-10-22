// ============================================================================
// 아침 인사 (유대감 ①).
//
// 검토 4.7절 1번 "시연 첫 장면을 Pet 의 아침 인사와 어제 기억 언급으로 시작한다".
//
// 문장만 넣으면 두 번째 시연에서 거짓말이 된다 — 어제 약속을 기억하지 못하는 Pet 이
// "어제 약속했잖아요"라고 말하는 꼴이다. 그래서 인사는 PetMemory 를 읽어 만든다.
// closing.ts 가 쓴 약속을 여기서 읽는 것이 유대감 ③ → ① 의 연결이다.
//
// 규칙 하나를 코드에 못 박는다: **"왜 안 오셨어요"는 만들지 않는다.**
// 죄책감으로 끌어오는 것은 어르신 대상 제품에서 특히 해롭다 (검토 4.5절).
// 며칠 만에 와도 "보고 싶었어요" 한 번으로 끝낸다.
// ============================================================================

import type { PetBeat, PetTurn } from "./types.ts";
import type { PetMemory } from "./memory.ts";
import { latestNote } from "./memory.ts";
import { dayKey, daysBetween } from "../time/now.ts";
import { getOrientationQuestions } from "../../lib/orientationQuestions.ts";
import { PERSONA } from "./persona.ts";

/** 인사 한 번에 물어볼 수 있는 질문의 최대 개수. 문진처럼 보이지 않게 하는 상수 */
export const MAX_ASK_PER_GREETING = 1;

export type GreetingKind = "first-meeting" | "same-day" | "next-day" | "after-a-while";

export function greetingKindOf(memory: PetMemory, today: string): GreetingKind {
  if (memory.lastMetOn === null) return "first-meeting";
  if (memory.lastMetOn === today) return "same-day";
  return daysBetween(memory.lastMetOn, today) <= 1 ? "next-day" : "after-a-while";
}

/** 지남력 문항을 rank 순환으로 하나 고른다 — 매번 같은 것만 묻지 않게 */
function pickOrientationTurn(memory: PetMemory, at: Date): PetTurn {
  const questions = getOrientationQuestions(at).slice().sort((a, b) => a.rank - b.rank);
  const q = questions[memory.streakDays % questions.length];
  return {
    id: q.id,
    kind: "ask",
    text: q.question,
    simulatedAnswer: q.simulatedAnswer,
    ack: q.feedback,
    restMs: 700,
    analysis: {
      source: "checkin",
      correctAnswer: q.correctAnswer,
      categoryLabel: q.categoryLabel,
      rank: q.rank,
    },
  };
}

export function buildGreetingBeat(memory: PetMemory, at: Date): PetBeat {
  const today = dayKey(at);
  const kind = greetingKindOf(memory, today);
  const honorific = memory.userHonorific || PERSONA.defaultHonorific;
  const turns: PetTurn[] = [];

  if (kind === "same-day") {
    // 같은 날 다시 만났다. 인사를 처음부터 다시 하지 않는다.
    turns.push({ id: "g-same", kind: "greeting", text: PERSONA.lines.sameDayReturn, restMs: 0 });
    return { id: `greeting:${today}`, cue: { at: "panel-open" }, pauseVideo: false, once: "day", turns };
  }

  if (kind === "first-meeting") {
    turns.push({
      id: "g-hello",
      kind: "greeting",
      text: `안녕하세요! 저는 ${memory.petName}예요. 오늘부터 같이 봐요.`,
      emotion: "happy",
      restMs: 700,
    });
  } else {
    // ① 약속 회수 — 어제 한 약속을 먼저 되짚는다. 이것이 관계의 가장 강한 신호다.
    if (memory.openPromise) {
      turns.push({
        id: "g-promise",
        kind: "recall",
        text: `${honorific}, 어제 또 보자고 했잖아요. 저 왔어요!`,
        emotion: "happy",
        restMs: 700,
      });
    } else {
      turns.push({
        id: "g-hello",
        kind: "greeting",
        text: kind === "after-a-while"
          // "왜 안 오셨어요"가 아니다. 반가움만 말하고 넘어간다.
          ? `${honorific}, 보고 싶었어요!`
          : `${honorific}, 안녕히 주무셨어요?`,
        emotion: "happy",
        restMs: 700,
      });
    }

    // ② 연속성 — 지난번에 들은 이야기를 이어 받는다
    const note = latestNote(memory);
    if (note) {
      turns.push({
        id: "g-recall",
        kind: "recall",
        text: recallLine(note.theme),
        restMs: 700,
      });
    }
  }

  // ③ 지남력은 최대 한 문항. 안부 대화의 리듬을 문진으로 바꾸지 않기 위해서다.
  for (let i = 0; i < MAX_ASK_PER_GREETING; i += 1) {
    turns.push(pickOrientationTurn(memory, at));
  }

  return { id: `greeting:${today}`, cue: { at: "panel-open" }, pauseVideo: false, once: "day", turns };
}

function recallLine(theme: PetMemory["notes"][number]["theme"]): string {
  switch (theme) {
    case "health":
      return "지난번에 몸이 좀 안 좋다고 하셨는데, 오늘은 어떠세요?";
    case "family":
      return "따님은 요즘도 자주 오세요?";
    case "taste":
      return "저번에 말씀하신 그 드라마, 계속 보고 계세요?";
    default:
      return "지난번 이야기 또 듣고 싶어요.";
  }
}
