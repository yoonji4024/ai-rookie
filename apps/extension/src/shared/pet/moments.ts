// ============================================================================
// '오늘 웃었던 순간' 카드 (유대감 ④).
//
// 검토 4.7절 4번 "보호자 화면 맨 위에 카드 한 장을 둔다".
//
// 이 파일의 핵심은 만드는 것이 아니라 **막는 것**이다 (검토 4.5절 신뢰 경계).
// 같은 대화를 사용자에게는 우정으로, 보호자에게는 기록으로 쓰는 제품이라,
// 어르신이 "내 말을 가족에게 보고한다"고 느끼는 순간 관계가 끝난다.
//
// 그래서 두 가지를 코드로 못 박는다.
//  1. 발췌를 자른다. 회상 대화 전문이 보호자 화면으로 넘어가지 않는다.
//  2. 안부(checkin) 턴은 제외한다. 아침에 나눈 사적인 이야기는 카드가 되지 않는다.
// 그리고 MemoryNote 를 MomentCard 로 바꾸는 함수는 이 저장소 어디에도 두지 않는다 —
// 회상 대화가 보호자에게 갈 경로를 타입 수준에서 없앤 것이다.
// ============================================================================

import type { ContentRef, PetBeat } from "./types.ts";
import type { MomentCard } from "./memory.ts";
import { clipQuote } from "./memory.ts";
import { dayKey } from "../time/now.ts";

/**
 * 비트가 완주했을 때 카드 후보를 만든다.
 * @param answers turnRunner 가 돌려준 { turnId: 답변텍스트 }
 * @returns 카드로 삼을 만한 것이 없으면 null
 */
export function captureMoment(
  beat: PetBeat,
  answers: Record<string, string>,
  content: ContentRef | null,
  at: Date,
): MomentCard | null {
  const seed = beat.moment;
  if (!seed) return null;

  // highlight 로 표시된 턴만 본다. Phase B 에서 이 판정이 웃음·감정 검출로 바뀌어도
  // 바깥에서 보이는 모양은 그대로다.
  const candidate = beat.turns.find(
    (t) =>
      t.highlight === true &&
      // 안부 대화는 보호자에게 넘기지 않는다
      t.analysis?.source !== "checkin" &&
      typeof answers[t.id] === "string" &&
      answers[t.id].trim().length > 0,
  );
  if (!candidate) return null;

  return {
    id: `${beat.id}:${candidate.id}`,
    date: dayKey(at),
    petLine: seed.petLine,
    quote: clipQuote(answers[candidate.id]),
    context: seed.context,
    contentTitle: content?.title ?? "",
  };
}
