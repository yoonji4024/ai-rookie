// ============================================================================
// PetHost — 플랫폼 의존을 모으는 유일한 포트.
//
// 같은 Pet 이 웹앱(/pet 프리뷰)과 확장(페이지에 떠 있는 두리)에서 돌아야 한다. 그 둘의 차이
// (저장소, 메시지 전달, 에셋 경로)를 여기 한 곳에 가둔다. 덕분에 확장의 메시징 방식이
// 바뀌어도 패널 컴포넌트는 한 줄도 바뀌지 않는다.
//
// claimBeat 가 이 인터페이스의 핵심이다. 예전에는 "이미 물어본 질문"을 모듈 스코프
// Set 에 담고 "페이지를 새로고침하면 초기화된다"고 가정했다. 확장의 두리 문서는
// 오래 산다(유튜브는 SPA 라서 영상을 바꿔도 같은 iframe 이 그대로 있다). 그 가정이 거짓이 되고, 두 번째 영상부터 Pet 이
// 아무 말도 하지 않았다 — 예외도 로그도 없이. 판정을 호스트로 올리면 저장 위치가
// 세션 스코프가 되어 그 실패 자체가 불가능해진다.
// ============================================================================

import type { BeatOutcome } from "../pet/types.ts";
import type { PetMemory } from "../pet/memory.ts";
import type { ContentToPanel, ObsEvent, PanelToContent } from "../protocol.ts";

export interface PetHost {
  readonly kind: "extension" | "web";

  /** 확장이면 chrome.runtime.getURL, 웹이면 "/" 기준 경로 */
  assetUrl(path: string): string;

  loadMemory(): Promise<PetMemory>;
  /** 저장 실패는 throw 하지 않고 false. 기억이 없어도 Pet 은 말할 수 있어야 한다 */
  saveMemory(next: PetMemory): Promise<boolean>;

  /**
   * 이 비트를 말해도 되는가. 전역 유일 판정.
   * true 를 돌려준 뒤에는 같은 (sessionKey, beatId) 로 다시 true 가 나오지 않는다.
   */
  claimBeat(sessionKey: string, beatId: string): Promise<boolean>;
  reportBeat(beatId: string, outcome: BeatOutcome): void;

  subscribe(listener: (msg: ContentToPanel) => void): () => void;
  sendToContent(msg: PanelToContent): void;

  emit(event: ObsEvent): void;

  /** 무대 모드: true 면 네트워크를 아예 시도하지 않고 baked → silent 로 간다 */
  isStageMode(): boolean;
}
