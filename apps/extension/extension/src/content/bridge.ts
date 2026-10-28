// ============================================================================
// content script 두 개(youtubeAgent.ts, petOverlay.ts) 사이의 다리 — 타입만 있다.
//
// 둘은 같은 isolated world 에서 돌지만 각자 IIFE 로 묶여 변수를 공유하지 않는다.
// petOverlay 가 isolated world 전역에 아래 객체를 걸어 두고 youtubeAgent 가 부른다.
// isolated world 의 전역은 페이지 스크립트가 볼 수도 흉내 낼 수도 없다 — 같은 일을
// DOM 이벤트로 하면 페이지가 엿듣거나 거짓 신호를 보낼 수 있다.
//
// 매니페스트의 content_scripts.js 순서가 [petOverlay, youtubeAgent] 라서 다리가 먼저 놓인다.
// ============================================================================

export interface PetOverlayBridge {
  /** 시청 페이지의 영상에 붙었다(true) / 떨어졌다(false) */
  setWatching(on: boolean): void;
  /** 두리가 지금 화면 맨 위에 보이는가 — 전체화면 위에서도 */
  isOnTop(): boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var memflixPetOverlay: PetOverlayBridge | undefined;
}
