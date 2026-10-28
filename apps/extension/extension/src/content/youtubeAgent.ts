// ============================================================================
// 유튜브 content script — 영상과 패널 사이의 다리.
//
// ★ 이 파일은 값(value) import 를 하지 않는다. import type 만 쓴다.
//   CRXJS 는 content script 가 다른 청크와 런타임 값을 공유하면 IIFE 를 버리고
//   동적 import 로더로 바꾼다. 그러면 실행이 비동기가 되고 내부 청크가
//   web_accessible_resources 로 노출된다. scripts/check-ext.mjs 가 빌드 산출물의
//   첫 바이트를 검사해 이 규칙을 강제한다.
//
// 하는 일은 넷뿐이다: 영상을 찾고, 재생 상태를 알리고, 정지/재개/볼륨을 대신 눌러 주고,
// 광고·전체화면을 판별한다. 대사도 화면도 여기에 없다 — 화면에 떠 있는 두리는
// petOverlay.ts 가 띄우고, 여기서는 "지금 영상을 보고 있다"만 알려 준다.
//
// 진짜 유튜브와 MemTube(유튜브 DOM 을 흉내 낸 시연 사이트) 를 구분하지 않는다.
// 사이트가 유튜브를 흉내 내고 이 스크립트는 차이를 모르는 것이 MemTube 의 존재 이유다.
// ============================================================================

import type { ContentToPanel, PanelToContent, VideoPulse } from "../../../src/shared/protocol";
import type {} from "./bridge"; // memflixPetOverlay 전역의 타입만 가져온다
import type { ContentRef } from "../../../src/shared/pet/types";

/**
 * src/shared/protocol.ts 의 PROTOCOL_VERSION 과 같아야 한다.
 * 값 import 를 할 수 없어 복제했고, scripts/check-ext.mjs 가 빌드 산출물에서 둘을 대조한다.
 */
const V = 2 as const;
const PULSE_MS = 150;
const BUILD_AT = new Date().toISOString();

let bound: HTMLVideoElement | null = null;
/**
 * 지금 붙어 있는 영상의 id.
 * 요소 동일성만으로는 부족하다 — 유튜브는 SPA 전환에서 <video> 요소를 *재사용*하기 때문에,
 * "같은 요소면 그대로 둔다"로 두면 다른 영상으로 넘어가도 세션이 바뀌지 않는다.
 * 콘텐츠 정체성으로 판정해야 새 영상에서 대본과 진행 기록이 새로 시작된다.
 */
let boundVideoId: string | null = null;
/**
 * 이번 attach 의 id. 패널이 늦게 열려 pet/hello 로 물어오면 같은 id 로 다시 알린다 —
 * 그래야 패널이 "같은 영상의 재공지"와 "새로고침·새 영상"을 구분한다.
 */
let attachId = "";
let attachSeq = 0;
let prevSeconds = 0;
let pulseTimer: number | null = null;
/** 우리가 건 정지의 토큰. 사용자가 직접 누른 정지를 우리가 풀지 않기 위한 표식 */
let pauseToken: string | null = null;
let duckedFrom: number | null = null;

function send(msg: ContentToPanel): void {
  // 패널이 닫혀 있으면 수신자가 없다. 서비스 워커가 흡수하지만 그마저 실패할 수 있으므로
  // 조용히 삼킨다 — 로그를 남기면 150ms 마다 콘솔이 가득 찬다.
  void chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * 본편 <video> 를 찾는다.
 * 전역 querySelector("video") 를 쓰면 안 된다 — 유튜브 홈·추천 목록의 호버 프리뷰가
 * 먼저 잡혀서, Pet 이 엉뚱한 영상의 시각을 따라가게 된다.
 */
function resolveWatchVideo(): HTMLVideoElement | null {
  // #movie_player 를 *먼저* 본다. querySelector("#movie_player, .html5-video-player") 처럼 한 번에 물으면
  // 우선순위가 아니라 문서 순서로 첫 요소가 나온다. 유튜브는 홈 화면과 호버 프리뷰 플레이어
  // (.html5-video-player)를 숨긴 채 남겨 두는데, 그게 문서 앞쪽에 있으면 Pet 이 소리 없는 프리뷰를
  // 본편으로 알고 따라간다. MemTube 에서 "프리뷰를 띄운 채 카드를 누르는" 동작으로 재현했다.
  const player = document.querySelector("#movie_player") ?? document.querySelector(".html5-video-player");
  if (!player) return null;
  return player.querySelector<HTMLVideoElement>("video.html5-main-video, video.video-stream, video");
}

/** 시청 페이지인가 — v 가 없으면 홈·검색·채널이다. 숨은 플레이어나 호버 프리뷰에 붙지 않는다 */
function currentContent(): ContentRef {
  const id = new URL(location.href).searchParams.get("v") ?? "";
  const title =
    document.querySelector("#title h1 yt-formatted-string")?.textContent?.trim() ??
    document.title.replace(/ - YouTube$/, "").trim();
  return { provider: "youtube", id, title };
}

/** 광고 재생 중인가. 광고는 본편과 같은 요소로 재생되고 currentTime 이 광고 경과초가 된다 */
function isAdShowing(): boolean {
  const player = document.querySelector("#movie_player");
  return !!player?.classList.contains("ad-showing") || !!document.querySelector(".ad-showing");
}

function isFullscreen(): boolean {
  return document.fullscreenElement !== null || !!document.querySelector(".ytp-fullscreen");
}

/**
 * 두리가 볼 수 없는 상태인가. 전체화면이어도 떠 있는 두리가 그 위에 보이면(top layer)
 * 볼 수 없는 것이 아니다 — 그때는 TV 를 보듯 전체화면 위에서 그대로 말을 건다.
 */
function petCannotBeSeen(): boolean {
  return isFullscreen() && !globalThis.memflixPetOverlay?.isOnTop();
}

function readPulse(video: HTMLVideoElement): VideoPulse {
  const seconds = video.currentTime;
  const pulse: VideoPulse = {
    seconds,
    prevSeconds,
    paused: video.paused,
    ended: video.ended,
    adShowing: isAdShowing(),
    fullscreen: petCannotBeSeen(),
  };
  prevSeconds = seconds;
  return pulse;
}

function startPulsing(video: HTMLVideoElement): void {
  stopPulsing();
  prevSeconds = video.currentTime;
  pulseTimer = window.setInterval(() => {
    if (!bound || !bound.isConnected) {
      // 플레이어가 통째로 교체됐다. 다음 관찰 주기가 다시 붙인다.
      detach();
      return;
    }
    send({ v: V, type: "video/pulse", pulse: readPulse(bound) });
  }, PULSE_MS);
}

function stopPulsing(): void {
  if (pulseTimer !== null) {
    window.clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

function detach(): void {
  stopPulsing();
  if (bound) {
    bound = null;
    boundVideoId = null;
    pauseToken = null;
    duckedFrom = null;
    send({ v: V, type: "video/detached" });
    console.log("[pet:content] yt:detached");
  }
  globalThis.memflixPetOverlay?.setWatching(false);
}

/** 지금 붙어 있는 영상을 알린다. 새 attach 와 pet/hello 응답이 같은 모양을 쓴다 */
function announce(): void {
  if (!bound) return;
  const content = currentContent();
  const durationSec = Number.isFinite(bound.duration) ? bound.duration : 0;
  send({ v: V, type: "video/attached", content, durationSec, attachId });
}

function attach(video: HTMLVideoElement): void {
  // 이전 영상에서 우리가 걸어 둔 상태를 끌고 오지 않는다
  if (duckedFrom !== null && bound) {
    bound.volume = duckedFrom;
  }
  duckedFrom = null;
  pauseToken = null;

  bound = video;
  const content = currentContent();
  boundVideoId = content.id;
  attachSeq += 1;
  attachId = `${Date.now().toString(36)}-${attachSeq}-${Math.random().toString(36).slice(2, 8)}`;
  startPulsing(video);
  announce();
  globalThis.memflixPetOverlay?.setWatching(true);
  console.log(`[pet:content] yt:attached ${content.id} (build ${BUILD_AT})`);
}

/**
 * 영상 요소를 찾아 붙인다. 여러 번 불려도 안전하다(idempotent).
 *
 * 재바인딩 조건을 "다른 요소일 때"로만 두면 안 된다 — 실측 결과 유튜브는 SPA 전환에서
 * <video> 요소를 재사용하고, 그러면 다른 영상으로 넘어가도 Pet 이 이전 영상의 대본을
 * 그대로 들고 있게 된다. 요소 동일성과 영상 id 를 함께 본다.
 */
function syncBinding(): void {
  // 시청 페이지가 아니면 붙지 않는다. 유튜브는 홈으로 나가도 플레이어 요소를 숨겨 둔 채 남기고,
  // 홈의 호버 프리뷰도 .html5-video-player 를 쓴다 — 요소만 보고 붙으면 id 없는 세션이 생긴다.
  const next = currentContent().id ? resolveWatchVideo() : null;
  if (!next) {
    detach();
    return;
  }
  // 요소가 그대로여도 영상이 바뀌었으면 새로 붙는다.
  // 두 조건을 함께 보기 때문에, 유튜브가 <video> 를 교체하든 재사용하든 옳게 동작한다.
  const sameElement = bound === next && bound.isConnected;
  const sameVideo = boundVideoId === currentContent().id;
  if (sameElement && sameVideo) return;
  attach(next);
}

// ── 관찰 ─────────────────────────────────────────────────────────────────────
// 유튜브의 SPA 이벤트는 window 가 아니라 document 에서 발생한다.
// 이벤트 이름은 유튜브 내부 구현이라 언제든 바뀔 수 있어서, 폴링과 MutationObserver 를
// 함께 둔다. 셋 중 하나만 살아 있어도 Pet 이 영상을 놓치지 않는다.
//
// ★ 예약은 미루지 않는다(스로틀이지 디바운스가 아니다). 예전에는 신호가 올 때마다 타이머를
//   처음부터 다시 걸었는데, 영상이 재생되는 동안에는 시간 표시 글자가 0.2초마다 바뀌어
//   MutationObserver 가 250ms 보다 자주 울린다. 타이머가 영영 만료되지 않아, 재생 중에
//   다른 영상으로 넘어가면 사용자가 일시정지할 때까지 붙지 못했다(MemTube 에서 6초 지연 재현).
//   syncBinding 은 몇 번 불려도 안전하므로, 이미 예약돼 있으면 그대로 둔다.
let syncTimer: number | null = null;
function scheduleSync(): void {
  if (syncTimer !== null) return;
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    syncBinding();
  }, 250);
}

for (const name of ["yt-navigate-finish", "yt-page-data-updated", "yt-player-updated"]) {
  // 전환 이벤트는 드물다. 이미 예약된 확인이 전환 도중에 돌았을 수 있으니, 전환이 끝난 뒤
  // 한 번 더 확인한다 — 제목이 바뀐 뒤의 DOM 으로 붙어야 한다.
  document.addEventListener(name, () => window.setTimeout(syncBinding, 250));
}

let lastHref = location.href;
window.setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    scheduleSync();
  }
}, 1000);

new MutationObserver(() => {
  if (!bound || !bound.isConnected) scheduleSync();
}).observe(document.documentElement, { childList: true, subtree: true });

// ── 패널의 지시 ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  const msg = message as PanelToContent;
  if (!msg || msg.v !== V) return;
  const video = bound;
  if (!video) return;

  if (msg.type === "pet/pause") {
    pauseToken = msg.token;
    video.pause();
    return;
  }

  if (msg.type === "pet/resume") {
    // 토큰이 다르면 그 사이 사용자가 직접 조작한 것이다 — 사용자 의도를 이기지 않는다
    if (pauseToken !== msg.token) {
      console.log("[pet:content] resume:token-mismatch");
      return;
    }
    pauseToken = null;
    void video.play().catch(() => {});
    return;
  }

  if (msg.type === "pet/duck") {
    // 멈추지 않고 말을 얹는 기본 경로. 원래 볼륨을 기억했다가 되돌린다.
    if (msg.gain < 1) {
      if (duckedFrom === null) duckedFrom = video.volume;
      video.volume = Math.max(0, Math.min(1, duckedFrom * msg.gain));
    } else if (duckedFrom !== null) {
      video.volume = duckedFrom;
      duckedFrom = null;
    }
    return;
  }

  if (msg.type === "pet/ping") {
    send({ v: V, type: "video/pulse", pulse: readPulse(video) });
    return;
  }

  if (msg.type === "pet/hello") {
    // 패널이 영상보다 늦게 열렸다. 지금 붙어 있는 영상을 같은 attachId 로 다시 알린다.
    console.log(`[pet:content] hello:announce ${boundVideoId}`);
    announce();
  }
});

// 사용자가 직접 누른 정지는 우리 토큰을 무효화한다.
// (두리를 누른 것은 여기로 오지 않는다 — 두리는 iframe 안이라 그 클릭은 이 문서의 이벤트가 아니다)
document.addEventListener(
  "click",
  () => {
    pauseToken = null;
  },
  { capture: true },
);

syncBinding();
console.log(`[pet:content] content:start ${BUILD_AT}`);
