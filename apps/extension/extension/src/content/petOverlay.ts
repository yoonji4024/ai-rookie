// ============================================================================
// 화면에 떠 있는 두리의 집 — 페이지에 iframe 하나를 띄우고 그 자리를 관리한다.
//
// 두리의 화면과 대화 엔진은 iframe(extension/pet.html) 안에 있다. 여기서 하는 일은 넷뿐이다.
//   1. 플랫폼 진입 안내를 띄우고, 수락할 때만 연결 iframe 을 만든다
//   2. iframe 이 알려 주는 크기에 딱 맞춘다 — 투명한 큰 iframe 은 아래 페이지 클릭을 가로챈다
//   3. 강아지 위에 겹친 투명 손잡이로 끌기를 받고, 놓으면 가까운 모서리에 붙여 위치를 기억한다
//   4. 전체화면에서도 보이게 한다 — 호스트를 popover 로 만들어 top layer 에 올린다
//
// 실측으로 정한 것들 (Chromium 141, scratchpad 스파이크):
//   · popover 를 전체화면 진입 뒤 다시 띄우면 전체화면 요소 위에 그려진다. iframe 은 DOM 에서
//     옮기지 않으므로 다시 로드되지 않는다. 다만 전체화면 바깥은 inert 라서 그동안은 누르거나
//     끌 수 없다 — 보이고 말할 수는 있다. TV 를 보듯 보는 동안 곁에 있는 것이 목적이라 충분하다.
//   · 끌기를 iframe 안에서 계산하면 iframe 이 옮겨지는 동안의 좌표가 어긋난다. 화면 좌표(screenX)로는
//     절반만, iframe 안 좌표로는 목표를 지나쳐 움직였다. 그래서 강아지 바로 위에 *페이지 쪽* 투명
//     손잡이를 겹쳐 두고 끌기를 페이지 좌표로 처리한다. 누르기만 iframe 에 host/tap 으로 넘긴다 —
//     페이지에서 생긴 클릭이라 allow="autoplay" 위임으로 iframe 의 소리도 함께 허락된다.
//
// 값 import 대상은 이 content script 안에서만 사용하여 IIFE 를 유지한다.
// scripts/check-ext.mjs 가 동적 로더 전환을 검사한다.
// ============================================================================

import type { FrameBody, FrameToHost, HostToFrame, WorkerToContent } from "../../../src/shared/protocol";
import {
  clampPosition,
  DOG_PX,
  moveBy,
  reanchor,
  reviveFloatPosition,
  ROOT_PAD_PX,
  toCss,
  type FloatPosition,
} from "../../../src/shared/float/position";
import type {} from "./bridge";
import { entryMode, localDay, SNOOZE_KEY } from './platformEntry';
import {acceptFrameLayout, type Layout} from './frameLayout';

/** src/shared/protocol.ts 의 PROTOCOL_VERSION 복제 — check-ext 가 대조한다 */
const V = 2 as const;
const SOURCE = "memflix-pet" as const;
const POSITION_KEY = "memflix.pet.position";
const FRAME_URL = chrome.runtime.getURL("extension/pet.html");
const FRAME_ORIGIN = new URL(FRAME_URL).origin;

/** 이만큼 움직여야 끌기로 본다. 그보다 작으면 누르기 */
const DRAG_SLOP_PX = 6;

let hostEl: HTMLElement | null = null;
let frame: HTMLIFrameElement | null = null;
/** 강아지 위에 겹친 투명 손잡이 — 끌기와 누르기를 페이지 좌표로 받는다 */
let handle: HTMLElement | null = null;
let position: FloatPosition = reviveFloatPosition(null);
let size = { width: 0, height: 0 };
let watching = false;
/** 툴바 아이콘이나 "오늘은 그만"으로 숨긴 상태 */
let dismissed = false;
let busy = false;
let lastActivationPing = 0;
let entryReady = false;
let accepted = false;
let snoozedOn: unknown = null;
let invitation: HTMLElement | null = null;
let frameChannel='';
let frameReady=false;
let loadingNotice:HTMLElement|null=null;
let loadingTimer:number|undefined;

function removeInvitation(): void {
  invitation?.remove();
  invitation = null;
}

function acceptInvitation(): void {
  accepted = true;
  dismissed = false;
  removeInvitation();
  create();
  show();
}

function snoozeToday(): void {
  if (busy) return;
  accepted = false;
  dismissed = true;
  snoozedOn = localDay();
  removeInvitation();
  destroy();
  void chrome.storage.local.set({ [SNOOZE_KEY]: snoozedOn }).catch(() => {});
}

function showInvitation(): void {
  if (invitation) return;
  invitation = document.createElement('div');
  invitation.id = 'memflix-invitation';
  important(invitation, { position: 'fixed', right: '20px', bottom: '20px',
    width: 'min(350px, calc(100vw - 40px))', 'z-index': '2147483647' });
  const root = invitation.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box}section{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#38292b;background:#fffcf8;border:1px solid #e6d9d5;border-radius:22px;padding:24px;box-shadow:0 12px 45px #34232924}
    small{color:#723841;font-weight:700;letter-spacing:.1em}h2{font-size:23px;margin:12px 0 6px}p{margin:0 0 18px;color:#6e6361}button{width:100%;min-height:46px;border:1px solid #e6d9d5;border-radius:12px;background:white;color:#514447;font:inherit;cursor:pointer;padding:9px 14px;margin-top:8px}button.primary{background:#71343e;color:white;border-color:#71343e}button:focus-visible{outline:3px solid #b9875f;outline-offset:3px}.note{font-size:13px;margin:14px 0 0}
  </style><section role="region" aria-label="MEMFLIX 함께 보기 안내">
    <small>MEMFLIX</small><h2>같이 볼까요?</h2>
    <p>영상 옆에서 함께 보고,<br>기억에 남는 이야기를 나눠요.</p>
    <button class="primary" type="button">함께 볼게요</button>
    <button class="later" type="button">오늘은 혼자 볼게요</button>
    <p class="note">마이크는 ‘말하기’를 누를 때만 켜져요.</p>
  </section>`;
  root.querySelector('.primary')!.addEventListener('click', acceptInvitation);
  root.querySelector('.later')!.addEventListener('click', snoozeToday);
  (document.body ?? document.documentElement).appendChild(invitation);
}

function syncEntry(): void {
  const mode = entryMode({ready:entryReady, visible:!document.hidden, accepted, busy,
    today:localDay(), snoozedOn});
  if (mode === 'invite') showInvitation();
  else removeInvitation();
  if (mode === 'pet') { create(); show(); }
  else if (!busy) hide();
}

void chrome.storage.local.get(SNOOZE_KEY).then(bag => {
  snoozedOn = bag[SNOOZE_KEY];
}).catch(() => {}).finally(() => { entryReady = true; syncEntry(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SNOOZE_KEY]) {
    snoozedOn = changes[SNOOZE_KEY].newValue;
    syncEntry();
  }
});
document.addEventListener('visibilitychange', syncEntry);

void chrome.storage.local.get(POSITION_KEY).then(
  (bag) => {
    position = reviveFloatPosition(bag[POSITION_KEY]);
    place();
  },
  () => {},
);

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function postToFrame(msg: FrameBody<HostToFrame>): void {
  // A new iframe initially inherits the page's origin (about:blank). A load
  // event alone is not proof of our extension document. Wait for its validated
  // size handshake before sending to the exact extension origin.
  if (!frameReady) return;
  frame?.contentWindow?.postMessage({ ...msg, v: V, source: SOURCE }, FRAME_ORIGIN);
}

function important(el: HTMLElement, styles: Record<string, string>): void {
  // 페이지의 CSS 가 div 에 무엇을 걸어 두었든 이긴다
  for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, "important");
}

/** 위치·크기를 실제 스타일에 반영한다 */
function place(): void {
  if (!hostEl || !frame) return;
  position = clampPosition(position, viewport());
  important(hostEl, toCss(position));
  if (size.width > 0) {
    position = {...position, x:Math.max(0,Math.min(position.x,window.innerWidth-size.width)),
      y:Math.max(0,Math.min(position.y,window.innerHeight-size.height))};
    important(hostEl, toCss(position));
    important(hostEl, { width: `${size.width}px`, height: `${size.height}px`, visibility: "visible" });
    if(frameReady)important(frame, { width: `${size.width}px`, height: `${size.height}px` });
  }
  if (handle) {
    // 강아지는 늘 붙은 모서리 쪽 구석, 여백(ROOT_PAD_PX) 안쪽에 있다(FloatingPet 의 배치)
    const pad = `${ROOT_PAD_PX}px`;
    important(handle, {
      left: position.h === "left" ? pad : "auto",
      right: position.h === "right" ? pad : "auto",
      top: position.v === "top" ? pad : "auto",
      bottom: position.v === "bottom" ? pad : "auto",
    });
  }
}

function makeHandle(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true"); // 키보드·화면낭독은 iframe 안의 강아지 버튼이 맡는다
  important(el, {
    position: "absolute",
    width: `${DOG_PX}px`,
    height: `${DOG_PX}px`,
    "border-radius": "50%",
    cursor: "grab",
    "touch-action": "none",
    background: "transparent",
  });
  let grab: { x: number; y: number; id: number; dragging: boolean } | null = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    grab = { x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false };
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!grab || grab.id !== e.pointerId) return;
    if (!grab.dragging && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < DRAG_SLOP_PX) return;
    grab.dragging = true;
    important(el, { cursor: "grabbing" });
    position = clampPosition(moveBy(position, e.clientX - grab.x, e.clientY - grab.y), viewport());
    grab.x = e.clientX;
    grab.y = e.clientY;
    place();
  });
  const end = (e: PointerEvent) => {
    if (!grab || grab.id !== e.pointerId) return;
    const wasDrag = grab.dragging;
    grab = null;
    important(el, { cursor: "grab" });
    if (!wasDrag) {
      postToFrame({ type: "host/tap" });
      return;
    }
    position = reanchor(position, viewport());
    place();
    postToFrame({ type: "host/anchor", anchor: { h: position.h, v: position.v } });
    void chrome.storage.local.set({ [POSITION_KEY]: position }).catch(() => {});
    console.log(`[pet:content] pet:moved ${position.h}/${position.v}`);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", (e) => {
    if (grab?.dragging) end(e);
    grab = null;
  });
  return el;
}

function create(): void {
  if (hostEl?.isConnected) return;
  hostEl = document.createElement("div");
  hostEl.id = "memflix-pet";
  // popover: 전체화면 요소 위(top layer)에 올라갈 수 있는 유일한 방법이다
  hostEl.setAttribute("popover", "manual");
  important(hostEl, {
    position: "fixed",
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    overflow: "visible",
    "color-scheme": "light",
    visibility: "visible",
    width: `${Math.min(360,window.innerWidth)}px`,
    height: "100px",
  });
  const root = hostEl.attachShadow({ mode: "open" });
  frameChannel=crypto.randomUUID();frameReady=false;
  loadingNotice=document.createElement('div');
  loadingNotice.textContent='두리를 연결하고 있어요…';
  loadingNotice.setAttribute('role','status');
  important(loadingNotice,{position:'absolute',inset:'0',padding:'20px',background:'#fffcf8',color:'#38292b',border:'1px solid #e5d6d5','border-radius':'18px',font:'15px/1.6 sans-serif'});
  root.appendChild(loadingNotice);
  frame = document.createElement("iframe");
  frame.src = FRAME_URL+'?instance='+encodeURIComponent(frameChannel);
  // 페이지에서 사용자가 한 번이라도 누른 뒤라면, 이 위임으로 iframe 이 소리를 낼 수 있다
  frame.allow = "autoplay; microphone";
  frame.title = "두리";
  important(frame, {
    display: "block",
    visibility: "hidden",
    border: "0",
    background: "transparent",
    // pet.html 의 color-scheme(light)과 같아야 크롬이 iframe 을 투명하게 그린다
    "color-scheme": "light",
    width: `${Math.min(360, window.innerWidth)}px`,
    height: `${Math.max(200, window.innerHeight - 32)}px`,
  });
  frame.addEventListener('load', () => {
    if (frameReady) return;
    // Loading and measuring are independent: even a failed app must be visible
    // so its own error UI is readable. This does not enable message sending.
    size={width:Math.min(360,window.innerWidth),height:Math.min(620,window.innerHeight-32)};
    important(frame!,{visibility:'visible',width:`${size.width}px`,height:`${size.height}px`});
    if(loadingNotice)loadingNotice.style.setProperty('display','none','important');
    place();
  });
  root.appendChild(frame);
  handle = makeHandle();
  root.appendChild(handle);
  (document.body ?? document.documentElement).appendChild(hostEl);
  size = { width: Math.min(360,window.innerWidth), height: 100 };
  clearTimeout(loadingTimer);
  loadingTimer=window.setTimeout(()=>{
    if(!frameReady&&loadingNotice){
      loadingNotice.textContent='두리 화면 연결이 멈췄어요. 로그인 문제가 아닐 수 있어요. 확장을 새로고침했다면 이 영상 탭도 다시 열어 주세요.';
      loadingNotice.style.setProperty('display','block','important');
      loadingNotice.style.setProperty('inset','auto 0 0','important');
    }
  },10000);
  place();
  show();
  console.log("[pet:content] pet:created");
}

function destroy(): void {
  // iframe 을 빼면 그 안의 대화 엔진도 멈춘다 — 보이지 않는 두리가 소리를 줄이는 일이 없게
  hostEl?.remove();
  hostEl = null;
  frame = null;
  handle = null;
  clearTimeout(loadingTimer);loadingNotice=null;frameReady=false;frameChannel='';
  console.log("[pet:content] pet:removed");
}

function show(): void {
  if (!hostEl) return;
  if (!hostEl.matches(":popover-open")) hostEl.showPopover();
}

function hide(): void {
  if (hostEl?.matches(":popover-open")) hostEl.hidePopover();
}

function setWatching(on: boolean): void {
  watching = on;
  syncEntry();
}

function applyLayout(msg:Layout):void {
  if(msg.type==='frame/size'){
    if(!Number.isFinite(msg.width)||!Number.isFinite(msg.height)||msg.width<=0||msg.height<=0||!frame)return;
    const first=!frameReady;
    frameReady=true;clearTimeout(loadingTimer);loadingNotice?.remove();loadingNotice=null;
    size={width:Math.min(msg.width,window.innerWidth),height:Math.min(msg.height,window.innerHeight)};
    important(frame,{visibility:'visible'});place();
    if(first){
      postToFrame({type:'host/viewport',width:window.innerWidth,height:window.innerHeight});
      postToFrame({type:'host/anchor',anchor:{h:position.h,v:position.v}});
    }
  }else if(msg.type==='frame/hide')snoozeToday();
  else if(msg.type==='frame/busy')busy=msg.busy===true;
}

// ── iframe 의 화면 신호 ─────────────────────────────────────────────────────
window.addEventListener("message", (event) => {
  // 같은 창의 페이지 스크립트도 메시지를 보낼 수 있다. origin 과 보낸 창을 둘 다 확인한다.
  if (!frame || event.origin !== FRAME_ORIGIN || event.source !== frame.contentWindow) return;
  const msg = event.data as FrameToHost;
  if (msg?.v !== V || msg.source !== SOURCE) return;

  applyLayout(msg);
});

// iframe 이 처음 뜰 때 붙은 모서리를 알려 준다(저장된 위치가 왼쪽 위일 수 있다)
document.addEventListener(
  "load",
  (event) => {
    if (event.target === frame) postToFrame({ type: "host/anchor", anchor: { h: position.h, v: position.v } });
  },
  true,
);

// ── 전체화면 ────────────────────────────────────────────────────────────────
document.addEventListener("fullscreenchange", () => {
  if (!hostEl || !watching || dismissed) return;
  // top layer 는 나중에 올라간 것이 위다. 전체화면 요소가 올라간 뒤 다시 띄워 그 위에 선다.
  hide();
  show();
  place();
});

window.addEventListener("resize", () => {
  postToFrame({type:'host/viewport',width:window.innerWidth,height:window.innerHeight});
  place();
});

// 페이지에서 무언가 눌렀다 = 이제 iframe 이 위임받은 자동재생으로 소리를 낼 수 있다.
// 자고 있던 두리가 스스로 깨어날 기회다. (두리 자신을 누른 것은 iframe 안이라 여기로 오지 않는다)
document.addEventListener(
  "pointerdown",
  () => {
    const at = Date.now();
    if (!frame || at - lastActivationPing < 1000) return;
    lastActivationPing = at;
    postToFrame({ type: "host/page-activated" });
  },
  { capture: true },
);

// ── 툴바 아이콘 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const layout=acceptFrameLayout(message,sender,{id:chrome.runtime.id,url:frame?.src??'',channel:frameChannel});
  if(layout){applyLayout(layout);sendResponse({received:true});return;}
  const msg = message as WorkerToContent;
  if (msg?.v !== V || (msg.type !== "pet/toggle" && msg.type !== "pet/open")) return;
  if (msg.type === 'pet/open') {
    acceptInvitation();
    sendResponse({opened: frameReady});
    return;
  }
  if (hostEl) {
    if (busy) { show(); return; }
    snoozeToday();
  } else {
    // An explicit toolbar click can reopen the pet after today's dismissal.
    acceptInvitation();
  }
});

globalThis.memflixPetOverlay = {
  setWatching,
  isOnTop() {
    return !!hostEl && !dismissed && hostEl.matches(":popover-open");
  },
};
