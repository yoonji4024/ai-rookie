import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FloatingPet, { type FloatingChrome } from "../../../src/components/FloatingPet";
import DebugHud from "./DebugHud";
import { createExtensionHost } from "./extensionHost";
import { canAutoplay } from "./autoplay";
import { createSpeak } from "../../../src/shared/voice/speakImpl";
import { createVoiceCache } from "../../../src/shared/voice/voiceCache";
import { findBeatsFor } from "../../../src/shared/pet/script";
import { log, setObsWhere } from "../../../src/shared/obs/log";
import { frameMessage, isHostToFrame, type FrameBody, type FrameToHost } from "../../../src/shared/protocol";
import type { FloatAnchor } from "../../../src/shared/float/position";

// ============================================================================
// 영상 페이지 위에 떠 있는 두리 — iframe 안의 앱.
//
// content script(petOverlay.ts)가 이 문서를 iframe 으로 띄우고 위치를 맡는다. 여기서는
//   · 대화 엔진(usePetSession)을 돌리고 — 영상 신호는 extensionHost 가 chrome.runtime 으로 받는다
//   · 내용 크기를 부모에게 알린다 — window.postMessage
// 강아지를 끌고 누르는 것은 부모가 받는다. 강아지 위에 페이지 쪽 투명 손잡이가 겹쳐 있다.
// 누르기만 host/tap 으로 넘어온다.
// 둘을 섞지 않는다. 영상 신호는 확장 안에서만, 화면 신호는 이 탭의 부모와만 오간다.
// ============================================================================

setObsWhere("panel");

const params = new URLSearchParams(location.search);
/** pet.html?sleep=1 — 소리가 나더라도 자는 상태로 시작한다(검증·리허설용) */
const FORCE_SLEEP = params.get("sleep") === "1";
const embedded = window.parent !== window;
/** 부모 페이지 origin. 화면 신호는 그 페이지에만 보낸다 */
const PARENT_ORIGIN = location.ancestorOrigins?.[0] ?? "*";

function post(msg: FrameBody<FrameToHost>): void {
  if (!embedded) return;
  window.parent.postMessage(frameMessage<FrameToHost>(msg), PARENT_ORIGIN);
}

export default function FloatPetApp() {
  const host = useMemo(() => createExtensionHost(), []);
  const speak = useMemo(() => {
    const cache = createVoiceCache((path) => host.assetUrl(path));
    return createSpeak({ cache, isStageMode: () => host.isStageMode() });
  }, [host]);
  const findBeats = useCallback(findBeatsFor, []);

  /** null = 아직 소리를 시험하는 중. 그동안은 아무것도 그리지 않는다(자는 모습이 깜빡이지 않게) */
  const [asleep, setAsleep] = useState<boolean | null>(null);
  const asleepRef = useRef(asleep);
  asleepRef.current = asleep;
  const [anchor, setAnchor] = useState<FloatAnchor>({ h: "right", v: "bottom" });
  const [tapSignal, setTapSignal] = useState(0);

  useEffect(() => {
    if (FORCE_SLEEP) {
      setAsleep(true);
      return;
    }
    let alive = true;
    void canAutoplay().then((ok) => {
      if (!alive) return;
      log.info("pet:autoplay-probe", { ok });
      setAsleep(!ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !isHostToFrame(event.data)) return;
      if (PARENT_ORIGIN !== "*" && event.origin !== PARENT_ORIGIN) return;
      const msg = event.data;
      if (msg.type === "host/anchor") {
        setAnchor(msg.anchor);
      } else if (msg.type === "host/tap") {
        setTapSignal((n) => n + 1);
      } else if (msg.type === "host/page-activated" && asleepRef.current && !FORCE_SLEEP) {
        // 페이지에서 무언가 눌렀다(재생 버튼 등). 이제 위임받은 자동재생이 될 수 있다 — 스스로 깨어난다
        void canAutoplay().then((ok) => {
          if (!ok) return;
          log.info("pet:woke-by-page");
          setAsleep(false);
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const chrome = useMemo<FloatingChrome>(
    () => ({
      anchor,
      onSize(width, height) {
        post({ type: "frame/size", width, height });
      },
      onHide() {
        post({ type: "frame/hide" });
      },
    }),
    [anchor],
  );

  const wake = useCallback(() => {
    // 강아지를 누른 것은 페이지 쪽 손잡이가 받았다 — 페이지에 사용자 제스처가 생겼으므로
    // allow="autoplay" 위임으로 이 iframe 도 소리를 낼 수 있다(실측). 그래도 막히면 글자로만 말한다.
    void canAutoplay().then((ok) => log.info("pet:woke-by-tap", { audio: ok }));
    setAsleep(false);
  }, []);

  if (asleep === null) return null;

  return (
    <>
      <style>{STYLES}</style>
      <FloatingPet
        chrome={chrome}
        session={{ host, findBeats, speak }}
        asleep={asleep}
        onWake={wake}
        tapSignal={tapSignal}
        footerExtra={
          <details className="fpa-debug">
            <summary>점검 기록</summary>
            <DebugHud inline />
          </details>
        }
      />
    </>
  );
}

const STYLES = `
.fpa-debug summary {
  cursor: pointer;
  color: #71717a;
  font-size: 12px;
  padding: 2px;
}
.fpa-debug[open] summary { margin-bottom: 6px; }
`;
