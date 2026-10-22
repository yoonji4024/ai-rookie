// ============================================================================
// 관측 로그 — 링버퍼.
//
// 이 저장소에서 찾은 결함 네 개의 공통점은 "조용히 고장난다"는 것이었다.
// 자동재생이 거부되면 상태기계가 멈춘 채로 아무 말도 없고, 이미 물어본 질문 집합이
// 초기화되지 않으면 Pet 이 침묵하는데 예외도 로그도 남지 않았다.
//
// 그래서 모든 상태 전이가 흔적을 남기게 한다. code 는 자유 서술이 아니라 고정 문자열이다
// — 무대에서 DevTools 를 열고 grep 할 수 있어야 하기 때문이다.
// ============================================================================

import type { ObsEvent, ObsLevel, ObsWhere } from "../protocol.ts";

const CAPACITY = 500;

const buffer: ObsEvent[] = [];
let where: ObsWhere = "panel";
let sink: ((event: ObsEvent) => void) | null = null;
let mirrorToConsole = true;

/** 이 실행 컨텍스트가 어디인지 알려준다 (content / sw / panel) */
export function setObsWhere(next: ObsWhere): void {
  where = next;
}

/** 이벤트를 다른 곳(예: 패널 → 확장 호스트)으로도 흘려보낸다 */
export function setObsSink(next: ((event: ObsEvent) => void) | null): void {
  sink = next;
}

export function setObsConsoleMirror(enabled: boolean): void {
  mirrorToConsole = enabled;
}

function push(level: ObsLevel, code: string, detail?: ObsEvent["detail"]): void {
  const event: ObsEvent = { t: Date.now(), level, where, code, ...(detail ? { detail } : {}) };
  buffer.push(event);
  if (buffer.length > CAPACITY) buffer.shift();

  if (mirrorToConsole) {
    const line = `[pet:${where}] ${code}`;
    if (level === "error") console.error(line, detail ?? "");
    else if (level === "warn") console.warn(line, detail ?? "");
    else if (level === "debug") console.debug(line, detail ?? "");
    else console.log(line, detail ?? "");
  }

  // sink 가 던져도 로깅 때문에 본 작업이 죽으면 안 된다
  try {
    sink?.(event);
  } catch {
    /* 무시 */
  }
}

export const log = {
  debug: (code: string, detail?: ObsEvent["detail"]) => push("debug", code, detail),
  info: (code: string, detail?: ObsEvent["detail"]) => push("info", code, detail),
  warn: (code: string, detail?: ObsEvent["detail"]) => push("warn", code, detail),
  error: (code: string, detail?: ObsEvent["detail"]) => push("error", code, detail),
};

/** 최근 이벤트. DebugHud 와 자동화 테스트가 읽는다 */
export function obsSnapshot(limit = CAPACITY): ObsEvent[] {
  return buffer.slice(Math.max(0, buffer.length - limit));
}

export function obsClear(): void {
  buffer.length = 0;
}

/** 특정 code 가 몇 번 나왔는지 — 테스트에서 시퀀스를 단언할 때 쓴다 */
export function obsCount(code: string): number {
  return buffer.reduce((n, e) => (e.code === code ? n + 1 : n), 0);
}
