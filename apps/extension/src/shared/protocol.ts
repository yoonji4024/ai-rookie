// ============================================================================
// content script ↔ 두리(페이지에 떠 있는 확장 iframe) 메시지 프로토콜.
//
// 확장에서 가장 흔한 유령 버그는 "일부만 리로드된 상태"다. content script 는 옛 버전인데
// 패널만 새로 로드되면, 메시지 모양이 어긋나 조용히 아무 일도 일어나지 않는다.
// 그래서 모든 메시지에 v 를 박고, 불일치는 무시가 아니라 error 로 남긴다.
//
// v2 (A 보완): video/attached 에 attachId 가 생기고 pet/hello 가 늘었다. 모양이 바뀌었으므로
// 버전을 올렸다 — 옛 content script 와 새 패널이 섞이면 조용히 어긋나는 대신 시끄럽게 실패한다.
// ============================================================================

import type { BeatCue, ContentRef } from "./pet/types.ts";
import type { FloatAnchor } from "./float/position.ts";

export const PROTOCOL_VERSION = 2;
type V = typeof PROTOCOL_VERSION;

export interface VideoPulse {
  /** 재생 위치(초) */
  seconds: number;
  /**
   * 직전 tick 의 위치. seek 판별용이다.
   * 예전 플레이어는 `t >= q.timestamp` 로 판정해서 20초로 건너뛰면 15초 질문이 즉시 터졌다.
   * 이제는 prev < cue <= now 이고 (now - prev) 가 작을 때만 발화한다.
   */
  prevSeconds: number;
  paused: boolean;
  ended: boolean;
  /**
   * 광고 재생 중인가.
   * 유튜브 광고는 본편과 같은 <video> 로 재생되고 currentTime 이 광고 경과초로 바뀐다.
   * 즉 프리롤 8초째에 "8초 cue" 가 광고 위에서 터질 수 있다 — 그래서 전면 차단한다.
   */
  adShowing: boolean;
  /**
   * 두리를 볼 수 없는 상태면 비트를 보류한다. 이름은 전체화면이지만 뜻은 "안 보인다"다 —
   * 전체화면이어도 두리가 그 위에(top layer) 떠 있으면 content 는 false 를 보낸다.
   */
  fullscreen: boolean;
}

export type ObsLevel = "debug" | "info" | "warn" | "error";
export type ObsWhere = "content" | "sw" | "panel";

export interface ObsEvent {
  t: number;
  level: ObsLevel;
  where: ObsWhere;
  /** grep 가능한 고정 코드. 예: "beat:already-delivered". 자유 서술 금지 */
  code: string;
  detail?: Record<string, string | number | boolean | null>;
}

export type ContentToPanel =
  /**
   * attachId 는 content script 가 영상에 붙을 때마다 새로 발급한다.
   * 같은 attachId 의 attached 는 "다시 알려 주기"(pet/hello 에 대한 응답)이므로 세션을 리셋하지 않는다.
   * 새로고침이나 다른 영상이면 attachId 가 달라지고, 그때만 새 세션이 시작된다.
   */
  | { v: V; type: "video/attached"; content: ContentRef; durationSec: number; attachId: string }
  | { v: V; type: "video/detached" }
  | { v: V; type: "video/pulse"; pulse: VideoPulse }
  | { v: V; type: "video/cue"; cue: BeatCue; seconds: number }
  | { v: V; type: "obs/event"; event: ObsEvent };

export type PanelToContent =
  | { v: V; type: "pet/arm"; cues: BeatCue[] }
  /** 토큰은 "이 정지를 건 것이 나"임을 증명한다 — 사용자가 직접 누른 정지를 우리가 풀지 않기 위해 */
  | { v: V; type: "pet/pause"; token: string }
  | { v: V; type: "pet/resume"; token: string }
  /** 볼륨을 낮춘다(0~1). 멈추지 않고 말을 거는 기본 경로 */
  | { v: V; type: "pet/duck"; gain: number }
  | { v: V; type: "pet/ping" }
  /**
   * "지금 무엇을 보고 계세요?" — 패널이 영상보다 늦게 열렸을 때 보낸다.
   * content 는 붙어 있는 영상을 같은 attachId 로 다시 알린다(video/attached).
   * 이게 없으면 패널은 pulse 만 받고 어떤 영상인지 몰라서, 인사만 하고 영상 내내 침묵한다.
   */
  | { v: V; type: "pet/hello" };

/** 서비스 워커 → content. 툴바 아이콘을 누르면 이 탭에서 두리를 보이거나 숨긴다 */
export type WorkerToContent = { v: V; type: "pet/toggle" | "pet/open" };

// ── 화면에 떠 있는 두리(iframe) ↔ 페이지(content script) ─────────────────────
// 영상 신호는 위의 chrome.runtime 메시지로 오가고, 여기는 화면 배치 신호만 다룬다.
// window.postMessage 로 오가므로 받는 쪽은 반드시 발신 origin 과 source 창을 확인한다 —
// 같은 창의 페이지 스크립트도 메시지를 보낼 수 있기 때문이다.
const FRAME_SOURCE = "memflix-pet" as const;

export type FrameToHost = { v: V; source: typeof FRAME_SOURCE } & (
  /** 내용 크기. 투명한 큰 iframe 은 아래 페이지 클릭을 가로채므로 늘 내용에 딱 맞춘다 */
  | { type: "frame/size"; width: number; height: number }
  /** "오늘은 그만" */
  | { type: "frame/hide" }
  | { type: "frame/busy"; busy: boolean }
);

export type HostToFrame = { v: V; source: typeof FRAME_SOURCE } & (
  | { type: "host/viewport"; height: number; width?: number }
  /** 강아지가 붙은 모서리. 말풍선은 그 반대쪽으로 자란다 */
  | { type: "host/anchor"; anchor: FloatAnchor }
  /**
   * 강아지를 눌렀다(끌지 않고). 강아지 위에는 페이지 쪽 투명 손잡이가 겹쳐 있어서 누르기와 끌기는
   * 페이지가 받는다 — iframe 이 움직이는 동안 iframe 안 좌표로 끌기를 계산하면 어긋났다(실측).
   */
  | { type: "host/tap" }
  /** 페이지에서 사용자가 무언가를 눌렀다 — 이제 소리를 낼 수 있을지 모른다(자는 두리를 깨울 기회) */
  | { type: "host/page-activated" }
);

/** 버전·출처 표식을 뺀 본문. 유니언의 각 갈래마다 따로 뺀다(Omit 은 유니언에 분배되지 않는다) */
export type FrameBody<T> = T extends unknown ? Omit<T, "v" | "source"> : never;

export function frameMessage<T extends FrameToHost | HostToFrame>(msg: FrameBody<T>): T {
  return { ...msg, v: PROTOCOL_VERSION, source: FRAME_SOURCE } as T;
}

const CONTENT_TYPES: ReadonlyArray<ContentToPanel["type"]> = [
  "video/attached",
  "video/detached",
  "video/pulse",
  "video/cue",
  "obs/event",
];

const PANEL_TYPES: ReadonlyArray<PanelToContent["type"]> = [
  "pet/arm",
  "pet/pause",
  "pet/resume",
  "pet/duck",
  "pet/ping",
  "pet/hello",
];

function hasVersion(msg: unknown): msg is { v: unknown; type: unknown } {
  return typeof msg === "object" && msg !== null && "v" in msg && "type" in msg;
}

export function isContentToPanel(msg: unknown): msg is ContentToPanel {
  if (!hasVersion(msg)) return false;
  if (msg.v !== PROTOCOL_VERSION) return false;
  if (typeof msg.type !== "string" || !(CONTENT_TYPES as readonly string[]).includes(msg.type)) return false;
  // attached 는 세션의 시작이라 모양까지 본다. attachId 가 없으면 세션 중복 판정이 불가능하다.
  if (msg.type === "video/attached") {
    const attachId = (msg as { attachId?: unknown }).attachId;
    return typeof attachId === "string" && attachId !== "";
  }
  return true;
}

export function isWorkerToContent(msg: unknown): msg is WorkerToContent {
  return hasVersion(msg) && msg.v === PROTOCOL_VERSION && (msg.type === "pet/toggle" || msg.type === "pet/open");
}

function isFrameMessage(msg: unknown, prefix: "frame/" | "host/"): boolean {
  return (
    hasVersion(msg) &&
    msg.v === PROTOCOL_VERSION &&
    (msg as { source?: unknown }).source === FRAME_SOURCE &&
    typeof msg.type === "string" &&
    msg.type.startsWith(prefix)
  );
}

export function isFrameToHost(msg: unknown): msg is FrameToHost {
  return isFrameMessage(msg, "frame/");
}

export function isHostToFrame(msg: unknown): msg is HostToFrame {
  return isFrameMessage(msg, "host/");
}

export function isPanelToContent(msg: unknown): msg is PanelToContent {
  if (!hasVersion(msg)) return false;
  if (msg.v !== PROTOCOL_VERSION) return false;
  return typeof msg.type === "string" && (PANEL_TYPES as readonly string[]).includes(msg.type);
}

/**
 * 우리 프로토콜처럼 생겼는데 버전이 다른가.
 * 참이면 "확장 일부만 리로드됨"이라는 뜻이므로 조용히 무시하지 말고 시끄럽게 알린다.
 */
export function isVersionMismatch(msg: unknown): boolean {
  return hasVersion(msg) && msg.v !== PROTOCOL_VERSION && typeof msg.type === "string";
}
