// ============================================================================
// 웹앱용 호스트 — /pet 프리뷰와 기존 데모 화면이 쓴다.
//
// 두 가지 목적이 있다.
//  1. 확장을 빌드하지 않고도 대본·목소리·얼굴·유대감을 HMR 로 다듬는 작업대
//  2. 무대에서 확장이 죽었을 때의 백업 경로
// 그리고 부수효과로, 웹앱과 확장이 같은 엔진을 쓰기 때문에 `npm run dev` 가
// 상시 회귀 테스트가 된다.
//
// 가짜 비디오 타임라인을 함께 제공해 재생·정지·seek·종료·"다음 날로 넘기기"를
// 실제 영상 없이 재현한다.
// ============================================================================

import type { PetHost } from "./petHost.ts";
import type { BeatOutcome, ContentRef } from "../pet/types.ts";
import type { ContentToPanel, ObsEvent, PanelToContent, VideoPulse } from "../protocol.ts";
import { PROTOCOL_VERSION } from "../protocol.ts";
import { createMemory, MEMORY_KEY, reviveMemory, type PetMemory } from "../pet/memory.ts";
import { log } from "../obs/log.ts";

export interface MockTimeline {
  /** 재생 위치를 옮긴다 (seek 포함) */
  seek(seconds: number): void;
  play(): void;
  pause(): void;
  end(): void;
  setAdShowing(on: boolean): void;
  setFullscreen(on: boolean): void;
  attach(content: ContentRef, durationSec: number): void;
  state(): VideoPulse;
  /** 현재 붙어 있는 콘텐츠 (없으면 provider === "none") */
  content(): ContentRef;
  /**
   * 타임라인 tick 을 시작한다. 이미 돌고 있으면 아무 일도 하지 않는다.
   * StrictMode 는 이펙트를 마운트 → 언마운트 → 마운트 로 두 번 실행한다.
   * start/stop 이 짝을 이루지 않으면 두 번째 마운트에서 타이머가 죽은 채로 남는다
   * — 실제로 이 버그를 StrictMode 가 잡아냈다.
   */
  start(): void;
  /** tick 을 멈춘다. 구독자는 유지한다 */
  stop(): void;
}

export interface MockHost extends PetHost {
  timeline: MockTimeline;
  /** 저장된 기억을 통째로 갈아끼운다 (프리뷰의 "다음 날로 넘기기" 등) */
  resetMemory(next?: PetMemory): void;
  setStageMode(on: boolean): void;
}

const TICK_MS = 150;

/** localStorage 는 사파리 프라이빗 모드 등에서 던진다. 기억이 없어도 Pet 은 말해야 한다 */
function safeRead(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    log.warn("memory:read-failed", { message: String(err) });
    return null;
  }
}

function safeWrite(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    log.warn("memory:write-failed", { message: String(err) });
    return false;
  }
}

export function createMockHost(): MockHost {
  const listeners = new Set<(msg: ContentToPanel) => void>();
  const claimed = new Set<string>();
  let stageMode = false;

  let seconds = 0;
  let prevSeconds = 0;
  let playing = false;
  let ended = false;
  let adShowing = false;
  let fullscreen = false;
  let content: ContentRef = { provider: "none", id: "", title: "" };
  let durationSec = 0;
  let attachId = "";
  let attachSeq = 0;
  let pausedByPet: string | null = null;

  function announce(listener?: (msg: ContentToPanel) => void): void {
    const msg: ContentToPanel = { v: PROTOCOL_VERSION, type: "video/attached", content, durationSec, attachId };
    if (!listener) {
      broadcast(msg);
      return;
    }
    try {
      listener(msg);
    } catch (err) {
      log.error("host:listener-threw", { message: String(err) });
    }
  }

  function pulse(): VideoPulse {
    return { seconds, prevSeconds, paused: !playing, ended, adShowing, fullscreen };
  }

  function broadcast(msg: ContentToPanel): void {
    for (const l of listeners) {
      try {
        l(msg);
      } catch (err) {
        log.error("host:listener-threw", { message: String(err) });
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    if (playing && !ended) {
      prevSeconds = seconds;
      seconds = Math.min(durationSec || Number.MAX_SAFE_INTEGER, seconds + TICK_MS / 1000);
      if (durationSec > 0 && seconds >= durationSec) {
        ended = true;
        playing = false;
      }
    }
    broadcast({ v: PROTOCOL_VERSION, type: "video/pulse", pulse: pulse() });
  }

  const timeline: MockTimeline = {
    seek(next) {
      prevSeconds = seconds;
      seconds = Math.max(0, next);
      ended = false;
    },
    play() {
      playing = true;
      ended = false;
    },
    pause() {
      playing = false;
    },
    end() {
      ended = true;
      playing = false;
      prevSeconds = seconds;
    },
    setAdShowing(on) {
      adShowing = on;
    },
    setFullscreen(on) {
      fullscreen = on;
    },
    attach(next, duration) {
      content = next;
      durationSec = duration;
      seconds = 0;
      prevSeconds = 0;
      ended = false;
      attachSeq += 1;
      attachId = `mock-${attachSeq}`;
      announce();
    },
    state: pulse,
    content() {
      return content;
    },
    start() {
      if (timer !== null) return;
      timer = setInterval(tick, TICK_MS);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };

  return {
    kind: "web",
    timeline,

    assetUrl(path) {
      return path.startsWith("/") ? path : `/${path}`;
    },

    async loadMemory() {
      return reviveMemory(safeRead(MEMORY_KEY));
    },

    async saveMemory(next) {
      return safeWrite(MEMORY_KEY, next);
    },

    // 웹 프리뷰는 문서 하나가 곧 세션이므로 메모리 Set 으로 충분하다.
    // 확장에서는 이 구현이 chrome.storage.session 으로 바뀐다 — 패널을 닫았다 열어도
    // 같은 영상이면 이미 말한 비트를 다시 말하지 않는다.
    async claimBeat(sessionKey, beatId) {
      const key = `${sessionKey}::${beatId}`;
      if (claimed.has(key)) {
        log.info("beat:already-delivered", { key });
        return false;
      }
      claimed.add(key);
      return true;
    },

    reportBeat(beatId, outcome: BeatOutcome) {
      log.info("beat:reported", { beatId, status: outcome.status });
    },

    subscribe(listener) {
      listeners.add(listener);
      // 늦게 구독한 패널도 지금 무엇을 보고 있는지 알아야 한다.
      // (사용자가 영상을 한참 보다가 Pet 을 부르는 것이 정상 동선이다)
      // 확장에서는 같은 일을 pet/hello 왕복으로 한다 — 여기서는 구독 시점에 바로 알린다.
      if (content.provider !== "none") announce(listener);
      return () => listeners.delete(listener);
    },

    sendToContent(msg: PanelToContent) {
      // 프리뷰에는 진짜 영상이 없다. Pet 의 정지/재개 의도를 타임라인에 그대로 반영한다.
      if (msg.type === "pet/hello") {
        // content script 와 같은 계약: 붙어 있는 영상을 같은 attachId 로 다시 알린다
        if (content.provider !== "none") announce();
      } else if (msg.type === "pet/pause") {
        pausedByPet = msg.token;
        playing = false;
      } else if (msg.type === "pet/resume") {
        // 토큰이 다르면 사용자가 그 사이에 직접 조작한 것이다 — 의도를 이기지 않는다
        if (pausedByPet === msg.token) {
          pausedByPet = null;
          playing = true;
        } else {
          log.info("resume:token-mismatch", { token: msg.token });
        }
      }
    },

    emit(event: ObsEvent) {
      broadcast({ v: PROTOCOL_VERSION, type: "obs/event", event });
    },

    isStageMode() {
      return stageMode;
    },

    resetMemory(next) {
      const value = next ?? createMemory();
      safeWrite(MEMORY_KEY, value);
      claimed.clear();
    },

    setStageMode(on) {
      stageMode = on;
    },
  };
}
