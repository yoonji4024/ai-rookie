// ============================================================================
// 사용자 화면 금칙어 — 단일 소스.
//
// 이 프로젝트의 명제는 "검사처럼 보이지 않는 검사"다. 사용자에게 보이는 문자열에
// 측정 목적이 드러나면 그 명제가 무너진다. 규칙을 주석이 아니라 코드로 두고,
// 대본 린터(scripts/check-script.mjs)와 테스트가 같은 규칙을 공유한다.
//
// 한국어는 교착어라 단순 부분문자열 검사가 오탐을 낸다.
// 예: "무슨 요일인지도 궁금해요" 의 "인지" 는 어미이지 인지기능이 아니다.
// 그래서 애매한 낱말은 패턴으로 좁힌다.
// ============================================================================

export interface ForbiddenRule {
  /** 오류 메시지에 보일 이름 */
  label: string;
  pattern: RegExp;
  /** 왜 막는지 — 규칙을 지우려는 사람이 읽을 문장 */
  why: string;
}

export const FORBIDDEN_RULES: ForbiddenRule[] = [
  { label: "치매", pattern: /치매/, why: "질병명을 사용자 화면에 노출하지 않는다." },
  { label: "진단", pattern: /진단/, why: "의료 행위를 연상시킨다." },
  { label: "검사", pattern: /검사/, why: "'검사받는 느낌'이 이 프로젝트가 없애려는 바로 그것이다." },
  { label: "측정", pattern: /측정/, why: "사용자를 대상으로 재고 있다는 인상을 준다." },
  { label: "평가", pattern: /평가/, why: "사용자가 평가받는 위치에 놓인다." },
  { label: "점수", pattern: /점수/, why: "점수는 보호자 리포트 전용이다." },
  { label: "분석", pattern: /분석/, why: "\"답변 분석 중\"이 대표적인 검사 느낌 문구였다." },
  { label: "테스트", pattern: /테스트/, why: "시험을 연상시킨다." },
  { label: "체험", pattern: /체험/, why: "관계가 아니라 일회성 시연처럼 들린다." },
  {
    label: "인지(기능)",
    // "요일인지", "괜찮은지" 같은 어미는 정상이다. 인지기능을 가리킬 때만 잡는다.
    pattern: /인지\s*(기능|능력|검사|저하|장애|훈련|재활)|인지력|인지기능/,
    why: "인지기능이라는 측정 개념을 사용자에게 노출하지 않는다.",
  },
];

export interface ForbiddenHit {
  label: string;
  why: string;
  /** 실제로 걸린 부분 */
  matched: string;
}

/** 사용자에게 보이는 문자열 하나를 검사한다 */
export function findForbidden(text: string): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const rule of FORBIDDEN_RULES) {
    const m = rule.pattern.exec(text);
    if (m) hits.push({ label: rule.label, why: rule.why, matched: m[0] });
  }
  return hits;
}
