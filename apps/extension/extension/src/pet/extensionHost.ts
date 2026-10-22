import type { PetHost } from "../../../src/shared/host/petHost";
import type { BeatOutcome } from "../../../src/shared/pet/types";
import type { ContentToPanel, ObsEvent, PanelToContent } from "../../../src/shared/protocol";
import { isContentToPanel, PROTOCOL_VERSION } from "../../../src/shared/protocol";
import { createMemory, MEMORY_KEY, reviveMemory, type PetMemory } from "../../../src/shared/pet/memory";
import { log } from "../../../src/shared/obs/log";

// ============================================================================
// 확장용 PetHost 구현.
//
// 여기가 chrome.* 을 만지는 유일한 곳이다. src/shared 는 이 포트 뒤에 있어서
// chrome 타입 없이 컴파일되고, 그 덕분에 node --test 로 그대로 테스트된다.
//
// claimBeat 가 이 파일의 핵심이다. 예전에는 "이미 말한 비트"를 모듈 스코프 Set 에
// 담고 "페이지를 새로고침하면 초기화된다"고 가정했는데, 두리 문서는 오래 산다 — 유튜브는
// SPA 라서 영상을 바꿔도 같은 iframe 이 그대로 있다. 그 가정이 거짓이었다. chrome.storage.session 은
// 브라우저를 닫으면 알아서 사라지고 영상마다 키가 달라져, 그 실패가 불가능해진다.
// ============================================================================

const STAGE_MODE_KEY = "memflix.pet.stageMode";
const SESSION_PREFIX = "memflix.pet.session.";
const HEARTBEAT_MS = 20_000;

interface SessionBag {
  deliveredBeatIds: string[];
}

export function createExtensionHost(): PetHost {
  const listeners = new Set<(msg: ContentToPanel) => void>();
  let stageMode = false;
  /** 메시지를 보낼 대상 탭. content script 가 먼저 말을 걸어오면 알게 된다 */
  let contentTabId: number | null = null;
  /**
   * 이 문서가 사는 탭. 두리는 영상 페이지에 띄운 iframe 이라 자기 탭이 곧 지켜볼 탭이다.
   * content script 의 runtime 메시지는 모든 확장 문서로 퍼지므로, 영상 탭이 둘이면(예: 무대에서
   * MemTube 와 진짜 유튜브를 같이 띄워 둔 경우) 남의 탭 pulse 가 섞여 들어온다. 자기 탭 것만 받는다.
   * null 이면 아직 모르는 것이므로 다른 탭의 신호를 받지 않는다.
   */
  let watchedTabId: number | null = null;
  /** 지켜보는 탭에서 video/attached 를 받았는가 */
  let knowsContent = false;
  let lastHelloAt = 0;
  /**
   * 마지막으로 받은 attached. 패널 화면(PetPanel)은 자동재생 탐침이 끝난 뒤에야 구독하므로,
   * 그 사이 hello 응답이 오면 받을 사람이 없다. 구독할 때 다시 건넨다(목업 호스트와 같은 계약).
   */
  let lastAttached: ContentToPanel | null = null;

  function broadcast(message: ContentToPanel): void {
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (err) {
        log.error("host:listener-threw", { message: String(err) });
      }
    }
  }

  // 실측(Chromium 141): 페이지에 띄운 확장 iframe 에서 getCurrent() 는 그 페이지의 탭을 돌려준다.
  // 탭으로 직접 연 pet.html(검증용)에서는 자기 자신이라, 영상 신호가 없을 뿐 동작은 같다.
  void chrome.tabs.getCurrent().then(
    (self) => {
      if (typeof self?.id !== "number") return;
      watchedTabId = self.id;
      contentTabId = self.id;
      log.debug("host:own-tab", { tabId: self.id });
    },
    () => {},
  );

  void chrome.storage.local.get(STAGE_MODE_KEY).then((bag) => {
    stageMode = Boolean(bag[STAGE_MODE_KEY]);
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!isContentToPanel(message)) return;
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") return;
    if (watchedTabId === null || tabId !== watchedTabId) return;
    contentTabId = tabId;

    if (message.type === "video/attached") {
      knowsContent = true;
      lastAttached = message;
    } else if (message.type === "video/detached") {
      knowsContent = false;
      lastAttached = null;
    }
    else if (message.type === "video/pulse" && !knowsContent) {
      // 영상은 흐르는데 무슨 영상인지 모른다 — 패널이 영상보다 늦게 열린 것이다.
      // 실제 사용 순서("영상을 켜고 → 두리를 부른다")가 정확히 이 경우다.
      const at = Date.now();
      if (at - lastHelloAt > 1000) {
        lastHelloAt = at;
        log.info("host:hello", { tabId });
        void chrome.tabs.sendMessage(tabId, { v: PROTOCOL_VERSION, type: "pet/hello" }).catch(() => {});
      }
    }
    broadcast(message);
  });

  // 세션이 도는 동안 서비스 워커를 깨워 둔다. SW 에 상태를 두지는 않지만,
  // 죽어 있으면 content 의 sendMessage 가 수신자 부재로 던질 수 있다.
  const heartbeat = setInterval(() => {
    void chrome.runtime.sendMessage({ type: "pet/heartbeat" }).catch(() => {
      // 워커가 깨어나는 중이면 실패할 수 있다. 다음 주기에 다시 시도한다.
    });
  }, HEARTBEAT_MS);
  addEventListener("pagehide", () => clearInterval(heartbeat), { once: true });

  return {
    kind: "extension",

    assetUrl(path) {
      return chrome.runtime.getURL(path.startsWith("/") ? path.slice(1) : path);
    },

    async loadMemory(): Promise<PetMemory> {
      try {
        const bag = await chrome.storage.local.get(MEMORY_KEY);
        return reviveMemory(bag[MEMORY_KEY]);
      } catch (err) {
        log.warn("memory:read-failed", { message: String(err) });
        return createMemory();
      }
    },

    async saveMemory(next) {
      try {
        await chrome.storage.local.set({ [MEMORY_KEY]: next });
        return true;
      } catch (err) {
        // 저장이 실패해도 Pet 은 말할 수 있어야 한다 — 던지지 않고 false 만 돌려준다
        log.warn("memory:write-failed", { message: String(err) });
        return false;
      }
    },

    async claimBeat(sessionKey, beatId) {
      const key = `${SESSION_PREFIX}${sessionKey}`;
      try {
        const bag = await chrome.storage.session.get(key);
        const current = (bag[key] as SessionBag | undefined)?.deliveredBeatIds ?? [];
        if (current.includes(beatId)) {
          log.info("beat:already-delivered", { sessionKey, beatId });
          return false;
        }
        await chrome.storage.session.set({ [key]: { deliveredBeatIds: [...current, beatId] } });
        return true;
      } catch (err) {
        // 저장소가 막혀도 Pet 이 침묵하는 것보다는 말하는 편이 낫다.
        // 최악의 경우 같은 비트를 두 번 말하는데, 그건 침묵보다 훨씬 덜 나쁘다.
        log.warn("beat:claim-failed", { sessionKey, beatId, message: String(err) });
        return true;
      }
    },

    reportBeat(beatId, outcome: BeatOutcome) {
      log.info("beat:reported", { beatId, status: outcome.status });
    },

    subscribe(listener) {
      listeners.add(listener);
      if (lastAttached) {
        try {
          listener(lastAttached);
        } catch (err) {
          log.error("host:listener-threw", { message: String(err) });
        }
      }
      return () => listeners.delete(listener);
    },

    sendToContent(msg: PanelToContent) {
      if (contentTabId === null) {
        log.debug("content:no-tab", { type: msg.type });
        return;
      }
      void chrome.tabs.sendMessage(contentTabId, { ...msg, v: PROTOCOL_VERSION }).catch((err) => {
        // 탭이 닫혔거나 다른 페이지로 갔다. 다음 attach 에서 다시 알게 된다.
        log.debug("content:send-failed", { type: msg.type, message: String(err) });
        contentTabId = null;
      });
    },

    emit(event: ObsEvent) {
      // broadcast 를 쓰지 않는다 — 리스너가 던지면 broadcast 는 log.error 를 남기고,
      // 그 로그가 다시 emit 으로 돌아오면 무한 재귀가 된다.
      for (const listener of listeners) {
        try {
          listener({ v: PROTOCOL_VERSION, type: "obs/event", event });
        } catch {
          /* 로깅이 본 작업을 죽이지 않는다 */
        }
      }
    },

    isStageMode() {
      return stageMode;
    },
  };
}
