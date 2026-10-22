// ============================================================================
// 릴레이 서버 클라이언트.
//
// VARCO API 는 브라우저 직접 호출을 막고(CORS 헤더 없음) API 키도 숨겨야 하므로
// 항상 서버를 한 번 거친다. 개발 중에는 vite 프록시가, 확장에서는 릴레이 서버가 그 역할을 한다.
//
// 두 가지 안전장치가 있다.
//  1. 모든 요청에 타임아웃. fetch 는 기본 타임아웃이 없어서, 릴레이가 hang 하면
//     await 가 영원히 pending 이 된다 — 이 저장소가 이미 한 번 겪은 종류의 고장이다.
//  2. 회로 차단. 연속 실패하면 한동안 아예 시도하지 않는다. 발표장에서 네트워크가
//     죽었을 때 매 문장마다 15초씩 기다리는 것보다 즉시 캐시로 넘어가는 편이 낫다.
// ============================================================================

import { log } from "../obs/log.ts";

/** 확장 빌드는 릴레이 절대 URL 을, 웹 dev 는 빈 값(= vite 프록시 경유)을 쓴다 */
const BASE: string = (import.meta.env?.VITE_RELAY_BASE as string | undefined) ?? "";

const REQUEST_TIMEOUT_MS = 15_000;
const FAILURES_BEFORE_TRIP = 2;
const TRIP_DURATION_MS = 60_000;

export type RelayResult<T> = { ok: true; value: T; ms: number } | { ok: false; reason: string };

let consecutiveFailures = 0;
let trippedUntil = 0;

function circuitOpen(): boolean {
  return Date.now() < trippedUntil;
}

function noteFailure(reason: string): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURES_BEFORE_TRIP && !circuitOpen()) {
    trippedUntil = Date.now() + TRIP_DURATION_MS;
    log.warn("relay:circuit-open", { forMs: TRIP_DURATION_MS, reason });
  }
}

function noteSuccess(): void {
  consecutiveFailures = 0;
  trippedUntil = 0;
}

/** 테스트와 옵션 페이지가 회로를 되돌릴 수 있게 */
export function resetRelayCircuit(): void {
  noteSuccess();
}

export function relayUrl(path: string): string {
  return `${BASE}${path}`;
}

async function postJson<T>(path: string, body: unknown): Promise<RelayResult<T>> {
  if (circuitOpen()) return { ok: false, reason: "circuit-open" };

  const started = Date.now();
  try {
    const res = await fetch(relayUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // fetch 에는 기본 타임아웃이 없다. 이것이 없으면 hang 이 곧 무한 대기가 된다.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      noteFailure(`http-${res.status}`);
      return { ok: false, reason: `http-${res.status}` };
    }
    const value = (await res.json()) as T;
    noteSuccess();
    return { ok: true, value, ms: Date.now() - started };
  } catch (err) {
    const reason = err instanceof Error ? err.name : String(err);
    noteFailure(reason);
    log.warn("relay:request-failed", { path, reason });
    return { ok: false, reason };
  }
}

export interface TtsResponse {
  /** base64 WAV */
  audio: string;
}

export interface FaceResponse {
  blendshape: {
    exportFps: number;
    numPoses: number;
    numFrames: number;
    facsNames: string[];
    weightMat: number[][];
  };
  credit?: number;
}

export function postTts(
  text: string,
  voice: string,
  properties?: { speed?: number; pitch?: number },
): Promise<RelayResult<TtsResponse>> {
  return postJson<TtsResponse>("/api/varco-tts", {
    text,
    language: "korean",
    voice,
    properties: { speed: 0.95, pitch: 1, ...properties },
    n_fm_steps: 8,
    seed: -1,
    return_metadata: false,
  });
}

export function postFace(
  audioBase64: string,
  options?: { fps?: number; emotion?: string },
): Promise<RelayResult<FaceResponse>> {
  return postJson<FaceResponse>("/api/varco-face", {
    id: `face-${Date.now()}`,
    audio: audioBase64,
    fps: options?.fps ?? 30,
    lip_style: "balanced",
    face_style: "natural",
    emotion: options?.emotion ?? "neutral",
    neck: "off",
    eye: "off",
  });
}

export async function getHealth(): Promise<RelayResult<{ tts: boolean; face: boolean }>> {
  try {
    const res = await fetch(relayUrl("/health"), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true, value: (await res.json()) as { tts: boolean; face: boolean }, ms: 0 };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.name : String(err) };
  }
}
