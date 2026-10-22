// ============================================================================
// 약속으로 끝나는 인사 (유대감 ③).
//
// 검토 4.7절 3번 "마지막 인사를 약속으로 바꾼다".
//
// 이 파일의 시그니처가 설계다. buildClosingBeat 는 말할 비트와 저장할 약속을
// **같은 호출에서 함께** 돌려준다. 약속을 말하는 것과 기억에 남기는 것을 분리할 수
// 없게 만들어 두면, 내일 아침 인사(greeting.ts)가 반드시 그 약속을 되짚게 된다.
// 유대감 ③ 과 ① 은 같은 데이터의 쓰기와 읽기다.
//
// 그리고 순서가 중요하다: 호출자는 약속 문장을 **말하기 전에** memory 에 먼저 저장하고,
// 저장이 실패하면 약속 문장을 빼고 일반 작별로 대체해야 한다.
// 지키지 못할 약속을 하지 않는 것(검토 4.5절 정직)을 제어 흐름으로 구현하는 것이다.
// 그 분기를 호출자가 잊지 않도록 buildFarewellBeat 를 함께 제공한다.
// ============================================================================

import type { PetBeat, PetTurn } from "./types.ts";
import type { PetMemory, PetPromise } from "./memory.ts";
import { dayKey } from "../time/now.ts";
import { PERSONA } from "./persona.ts";

export interface ClosingPlan {
  beat: PetBeat;
  promise: PetPromise;
}

/** 콘텐츠 제목에서 되짚을 짧은 키워드를 뽑는다 */
function keywordOf(contentTitle: string): string {
  const trimmed = contentTitle.trim();
  if (!trimmed) return "어제 보던 것";
  // 너무 길면 앞부분만 — 내일 인사에서 한 호흡에 말할 수 있어야 한다
  return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 15)}…`;
}

export function buildClosingBeat(memory: PetMemory, at: Date, contentTitle: string): ClosingPlan {
  const today = dayKey(at);
  const keyword = keywordOf(contentTitle);

  const honorific = memory.userHonorific || PERSONA.defaultHonorific;
  const turns: PetTurn[] = [
    {
      id: "c-thanks",
      kind: "remark",
      text: `${honorific}, 다 봤네요! 오늘도 같이 봐서 좋았어요.`,
      emotion: "happy",
      restMs: 600,
    },
    {
      id: "c-promise",
      kind: "promise",
      // App.tsx 의 마지막 대사와 같은 상수를 참조한다 — 두 데모의 끝이 어긋나지 않게
      text: PERSONA.lines.promise,
      emotion: "happy",
      restMs: 0,
    },
  ];

  return {
    beat: { id: `closing:${today}`, cue: { at: "ended" }, pauseVideo: false, once: "day", turns },
    promise: { madeOn: today, text: PERSONA.lines.promise, keyword },
  };
}

/**
 * 약속을 저장하지 못했을 때 쓰는 대체 작별.
 * 약속 문장이 빠져 있다 — 지키지 못할 약속을 하지 않기 위해서다.
 */
export function buildFarewellBeat(memory: PetMemory, at: Date): PetBeat {
  const today = dayKey(at);
  const honorific = memory.userHonorific || PERSONA.defaultHonorific;
  return {
    id: `closing:${today}`,
    cue: { at: "ended" },
    pauseVideo: false,
    once: "day",
    turns: [
      {
        id: "c-thanks",
        kind: "remark",
        text: `${honorific}, 다 봤네요! 오늘도 같이 봐서 좋았어요.`,
        emotion: "happy",
        restMs: 0,
      },
    ],
  };
}
