// ============================================================================
// 마감 시한이 있는 await.
//
// 규칙: src/shared 안에서 await 하는 모든 Promise 는 이 래퍼를 통과한다.
// 이유는 이 저장소가 실제로 겪은 결함이다 — TTS 오디오의 play() 가 거부되면
// onended 가 영원히 오지 않고, 그 Promise 를 기다리던 대화가 통째로 멈췄다.
// 네트워크 fetch 도 기본 타임아웃이 없어 릴레이가 hang 하면 같은 일이 난다.
//
// 검증 방법: `rg 'await ' src/shared | rg -v withDeadline` 이 비어 있어야 한다.
// ============================================================================

import { log } from "./log.ts";

// 주의: src/shared/** 는 `node --test` 의 네이티브 타입 스트리핑으로 그대로 실행된다.
// 그래서 파라미터 프로퍼티(constructor(readonly x: T))·enum·namespace 를 쓸 수 없다 —
// 타입만 지워서는 실행 가능한 JS 가 되지 않기 때문이다. 필드는 명시적으로 대입한다.
export class DeadlineError extends Error {
  readonly code = "deadline";
  readonly label: string;
  readonly ms: number;

  constructor(label: string, ms: number) {
    super(`${label} 이(가) ${ms}ms 안에 끝나지 않았습니다`);
    this.name = "DeadlineError";
    this.label = label;
    this.ms = ms;
  }
}

/**
 * ms 안에 끝나지 않으면 onTimeout 의 값으로 대신 resolve 한다.
 * onTimeout 이 없으면 DeadlineError 로 reject 한다.
 *
 * 원래 Promise 는 취소되지 않는다(Promise 는 취소할 수 없다) — 늦게 도착한 결과가
 * 문제를 일으킬 수 있는 자리에서는 호출자가 AbortController 를 함께 써야 한다.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn("deadline:exceeded", { label, ms });
      if (onTimeout) resolve(onTimeout());
      else reject(new DeadlineError(label, ms));
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 취소 가능한 대기. 타이머를 확실히 정리하려는 자리에서 쓴다 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
