// ============================================================================
// 서비스 워커 — 일부러 거의 아무것도 하지 않는다.
//
// MV3 서비스 워커는 30초쯤 유휴면 종료된다. 거기에 세션 상태를 두면 그 종료가 곧
// 상태 유실이 된다. 그래서 데이터 경로에서 아예 빼고, 잃을 것을 만들지 않는다.
// content script 의 sendMessage 는 페이지에 떠 있는 두리(확장 iframe)에 직접 도달하므로
// 중계도 필요 없다.
//
// 하는 일 셋:
//   1. 툴바 아이콘을 누르면 그 탭에서 두리를 보이거나 숨긴다
//   2. 아무 일도 하지 않는 onMessage 리스너 — 두리가 없을 때 content 의 sendMessage 가
//      "Receiving end does not exist" 로 던지지 않게 하는 흡수판
//   3. 빌드 시각 로그 — 확장 일부만 리로드된 상태를 두리 쪽과 대조할 수 있게
// ============================================================================

const BUILD_AT = new Date().toISOString();

// The action popup opens the in-page companion on supported pages. Ordinary
// pages retain its compact launcher. Settings open only on an explicit click.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 두리가 떠 있으면 두리가 같은 메시지를 따로 받는다. 여기서는 흡수만 한다.
  if ((message as { type?: string })?.type === "pet/heartbeat") {
    sendResponse({ ok: true, buildAt: BUILD_AT });
    return true;
  }
  return false;
});

console.log(`[pet:sw] sw:start ${BUILD_AT}`);
