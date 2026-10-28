// ============================================================================
// 시계 — 단일 소스.
// 왜 필요한가: 예전에는 orientationQuestions.ts 가 모듈 로드 시점에 `new Date()` 를 한 번
// 읽어 "오늘 며칠이죠?"의 기준 답을 상수로 구워 버렸다. 웹앱은 새로고침이 잦아 증상이
// 없었지만, 브라우저 확장의 사이드 패널 문서는 닫기 전까지 살아 있어서 자정을 넘기면
// 어제 날짜를 정답이라고 우기게 된다.
// 그래서 (1) 시각은 반드시 함수로 읽고, (2) 테스트와 데모가 시간을 갈아끼울 수 있게
// 주입 가능한 provider 를 둔다.
// ============================================================================

export type NowProvider = () => Date;

const systemNow: NowProvider = () => new Date();
let provider: NowProvider = systemNow;

/**
 * 시계를 갈아끼운다. 테스트와 /pet 프리뷰의 "다음 날로 넘기기" 버튼이 쓴다.
 * @returns 원래 시계로 되돌리는 함수
 */
export function setNowProvider(next: NowProvider): () => void {
  const prev = provider;
  provider = next;
  return () => {
    provider = prev;
  };
}

export function resetNowProvider(): void {
  provider = systemNow;
}

/** 지금 시각. 모듈 로드 시점이 아니라 호출 시점의 값이다 */
export function now(): Date {
  return provider();
}

/** 로컬 시간대 기준 YYYY-MM-DD. 저장 키와 "어제/오늘" 판정의 기준 단위 */
export function dayKey(at: Date = now()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** dayKey 두 개 사이의 일수 차이 (b - a). 같은 날이면 0 */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const msA = Date.UTC(ay, am - 1, ad);
  const msB = Date.UTC(by, bm - 1, bd);
  return Math.round((msB - msA) / 86_400_000);
}

export function formatMonthDay(at: Date = now()): string {
  return `${at.getMonth() + 1}월 ${at.getDate()}일`;
}

const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function formatWeekday(at: Date = now()): string {
  return `${WEEKDAY_NAMES[at.getDay()]}요일`;
}

const SEASON_BY_MONTH = [
  "겨울", "겨울", "봄", "봄", "봄", "여름",
  "여름", "여름", "가을", "가을", "가을", "겨울",
] as const;

export function seasonOf(at: Date = now()): string {
  return SEASON_BY_MONTH[at.getMonth()];
}

/**
 * 날짜가 바뀌면 알려준다. 오래 열려 있는 사이드 패널이 "오늘"을 갱신하는 데 쓴다.
 * 정확한 자정 타이머 대신 1분 폴링을 쓰는 이유: 절전/최대 절전에서 깨어났을 때
 * setTimeout 은 밀린 채로 깨어나지만 폴링은 다음 tick 에 스스로 맞춰진다.
 * @returns 감시를 멈추는 함수
 */
export function watchDayChange(onChange: (today: string) => void, intervalMs = 60_000): () => void {
  let last = dayKey();
  const timer = setInterval(() => {
    const today = dayKey();
    if (today !== last) {
      last = today;
      onChange(today);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
