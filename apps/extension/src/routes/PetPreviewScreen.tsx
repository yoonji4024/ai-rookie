import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PetPanel from "../components/PetPanel";
import FloatingPet, { type FloatingChrome } from "../components/FloatingPet";
import type { PetSessionOptions } from "../components/usePetSession";
import { clampPosition, DEFAULT_POSITION, moveBy, reanchor, toCss, type FloatPosition } from "../shared/float/position";
import { createMockHost, type MockHost } from "../shared/host/mockHost";
import type { ContentRef } from "../shared/pet/types";
import { obsSnapshot } from "../shared/obs/log";
import type { ObsEvent } from "../shared/protocol";
import { createSpeak } from "../shared/voice/speakImpl";
import { createVoiceCache } from "../shared/voice/voiceCache";
import { findBeatsFor } from "../shared/pet/script";
import { setNowProvider, dayKey } from "../shared/time/now";
import { createMemory } from "../shared/pet/memory";

// ============================================================================
// /pet — Pet 패널 단독 작업대.
//
// 확장을 빌드하지 않고도 대본·타이밍·유대감을 HMR 로 다듬을 수 있어야 한다.
// 가짜 타임라인으로 재생·정지·seek·광고·전체화면·종료를 전부 재현하므로,
// 확장에서 수동으로만 확인 가능한 상황들을 여기서 자동 검증할 수 있다.
// 무대에서 확장이 죽었을 때의 백업 경로이기도 하다.
// ============================================================================

/**
 * 떠다니는 두리 미리보기. 확장에서는 content script 가 iframe 을 옮기는 일을 여기서는
 * div 하나로 한다 — 같은 위치 계산(src/shared/float/position.ts)을 쓴다.
 */
function FloatPreview({ session, asleep, onWake }: { session: PetSessionOptions; asleep: boolean; onWake: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<FloatPosition>({ ...DEFAULT_POSITION });
  const [anchor, setAnchor] = useState({ h: DEFAULT_POSITION.h, v: DEFAULT_POSITION.v });

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const place = useCallback((p: FloatPosition) => {
    posRef.current = p;
    if (boxRef.current) Object.assign(boxRef.current.style, toCss(p));
  }, []);

  useEffect(() => place(posRef.current), [place]);

  const chrome = useMemo<FloatingChrome>(
    () => ({
      anchor,
      onSize() {
        /* div 는 내용 크기를 스스로 따른다 */
      },
      onDrag(dx, dy) {
        place(clampPosition(moveBy(posRef.current, dx, dy), viewport()));
      },
      onDragEnd() {
        const next = reanchor(posRef.current, viewport());
        place(next);
        setAnchor({ h: next.h, v: next.v });
      },
    }),
    [anchor, place],
  );

  return (
    <div ref={boxRef} className="ppv-float" data-testid="float-preview">
      <FloatingPet chrome={chrome} session={session} asleep={asleep} onWake={onWake} />
    </div>
  );
}

const DEMO_CONTENT: ContentRef = {
  provider: "youtube",
  id: "7mYPIds26Js",
  title: "영하 75도 냉동창고 취재",
};

export default function PetPreviewScreen() {
  const hostRef = useRef<MockHost | null>(null);
  if (hostRef.current === null) hostRef.current = createMockHost();
  const host = hostRef.current;

  const [tick, setTick] = useState(0);
  const [showLog, setShowLog] = useState(false);
  /** 유대감을 눈으로 확인하려면 날짜를 넘겨야 한다 — 어제 약속을 오늘 되짚는지 보는 것 */
  const [dayOffset, setDayOffset] = useState(0);
  const [panelKey, setPanelKey] = useState(0);
  /** 확장과 같은 "화면에 떠 있는 두리"로 보기 */
  const [floating, setFloating] = useState(() => new URLSearchParams(location.search).get("float") === "1");
  const [asleep, setAsleep] = useState(false);

  useEffect(() => {
    if (dayOffset === 0) return;
    return setNowProvider(() => {
      const d = new Date();
      d.setDate(d.getDate() + dayOffset);
      return d;
    });
  }, [dayOffset]);

  // 타임라인 상태를 화면에 비추기 위한 가벼운 폴링
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 150);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    host.timeline.attach(DEMO_CONTENT, 62);
    host.timeline.start();
    // StrictMode 는 이펙트를 두 번 실행한다. start/stop 이 짝을 이루므로
    // 두 번째 마운트에서 타임라인이 정상적으로 되살아난다.
    return () => host.timeline.stop();
  }, [host]);

  // 확장과 같은 대본(beats.ko.json)을 쓴다 — 여기서 확인한 것이 확장에서 보는 것과 같다
  const findBeats = useCallback(findBeatsFor, []);

  // 3단 폴백: 구워 둔 음성 → 릴레이 합성 → 무음.
  // 개발 서버에서는 vite 프록시가 릴레이 역할을 하므로 VARCO 키가 있으면 실제 목소리가 난다.
  // 키가 없거나 오프라인이면 무음으로 내려가고, 대화는 그대로 끝까지 진행된다.
  const speak = useMemo(() => {
    const cache = createVoiceCache((path) => host.assetUrl(path));
    return createSpeak({ cache, isStageMode: () => host.isStageMode() });
  }, [host]);

  const state = host.timeline.state();
  const events: ObsEvent[] = useMemo(() => obsSnapshot(25).slice().reverse(), [tick, showLog]);

  return (
    <div className="ppv-root">
      <style>{STYLES}</style>

      <div className="ppv-stage">
        <h1 className="ppv-title">Pet 패널 작업대</h1>
        <p className="ppv-desc">
          진짜 영상 없이 타임라인만 재현합니다. 확장을 빌드하지 않고도 대사·타이밍·표정을 확인할 수 있어요.
        </p>

        <div className="ppv-screen" data-ad={state.adShowing} data-fs={state.fullscreen}>
          <div className="ppv-screen-label">
            {state.adShowing ? "광고 재생 중 (Pet 은 끼어들지 않습니다)" : DEMO_CONTENT.title}
          </div>
          <div className="ppv-time">
            {state.seconds.toFixed(1)}초 / 62초 {state.ended ? "· 종료" : state.paused ? "· 정지" : "· 재생 중"}
          </div>
          <input
            className="ppv-seek"
            type="range"
            min={0}
            max={62}
            step={0.5}
            value={Math.min(62, state.seconds)}
            onChange={(e) => host.timeline.seek(Number(e.target.value))}
            aria-label="재생 위치"
          />
        </div>

        <div className="ppv-controls">
          <button type="button" onClick={() => host.timeline.play()}>▶ 재생</button>
          <button type="button" onClick={() => host.timeline.pause()}>❚❚ 정지</button>
          <button type="button" onClick={() => host.timeline.seek(0)}>↺ 처음으로</button>
          <button type="button" onClick={() => host.timeline.end()}>⏭ 끝으로</button>
          <button
            type="button"
            className={state.adShowing ? "on" : ""}
            onClick={() => host.timeline.setAdShowing(!state.adShowing)}
          >
            광고 {state.adShowing ? "끄기" : "켜기"}
          </button>
          <button
            type="button"
            className={state.fullscreen ? "on" : ""}
            onClick={() => host.timeline.setFullscreen(!state.fullscreen)}
          >
            전체화면 {state.fullscreen ? "해제" : "진입"}
          </button>
          <button type="button" onClick={() => setShowLog((v) => !v)}>
            로그 {showLog ? "숨기기" : "보기"}
          </button>
        </div>

        <div className="ppv-controls">
          <button type="button" className={floating ? "on" : ""} onClick={() => setFloating((v) => !v)}>
            🐶 떠다니는 모드 {floating ? "끄기" : "켜기"}
          </button>
          {floating && (
            <button type="button" className={asleep ? "on" : ""} onClick={() => setAsleep((v) => !v)}>
              💤 {asleep ? "깨우기" : "재우기 (소리가 막힌 경우)"}
            </button>
          )}
        </div>

        <div className="ppv-controls">
          <button
            type="button"
            onClick={() => {
              setDayOffset((n) => n + 1);
              setPanelKey((n) => n + 1); // 패널을 새로 마운트해 아침 인사를 다시 받는다
            }}
          >
            🌙 다음 날로 넘기기 {dayOffset > 0 ? `(+${dayOffset}일)` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              host.resetMemory(createMemory(dayKey()));
              setDayOffset(0);
              setPanelKey((n) => n + 1);
            }}
          >
            🧹 기억 지우기
          </button>
        </div>

        <p className="ppv-hint">
          영상을 끝까지 보면 Pet 이 <b>약속</b>으로 인사를 닫습니다. 그 뒤 [다음 날로 넘기기]를
          누르면 Pet 이 <b>어제 한 약속을 먼저 되짚습니다</b> — 유대감이 문장이 아니라 기억에서
          나온다는 것을 여기서 확인할 수 있어요.
        </p>

        <p className="ppv-hint">
          15초·32초에 Pet 이 말을 겁니다. 진행 바를 20초로 끌면 15초 대사는 <b>터지지 않습니다</b>.
          광고를 켜 두면 그 구간에서는 아무 말도 하지 않습니다.
        </p>

        {showLog && (
          <ol className="ppv-log">
            {events.map((e, i) => (
              <li key={`${e.t}-${i}`} data-level={e.level}>
                <code>{e.code}</code>
                {e.detail && <span>{JSON.stringify(e.detail)}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>

      {floating ? (
        <FloatPreview
          key={panelKey}
          session={{ host, findBeats, speak }}
          asleep={asleep}
          onWake={() => setAsleep(false)}
        />
      ) : (
        <aside className="ppv-panel">
          <PetPanel key={panelKey} host={host} findBeats={findBeats} speak={speak} />
        </aside>
      )}
    </div>
  );
}

const STYLES = `
.ppv-float { position: fixed; z-index: 50; }
.ppv-root {
  display: flex;
  width: 100%;
  height: 100%;
  background: #0d0b12;
  color: #eee;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
  color-scheme: dark;
}
.ppv-stage {
  flex: 1;
  min-width: 0;
  padding: 28px 32px;
  overflow-y: auto;
}
.ppv-title { margin: 0 0 6px; font-size: 20px; font-weight: 800; }
.ppv-desc { margin: 0 0 22px; font-size: 13px; color: #928aa6; word-break: keep-all; }

.ppv-screen {
  aspect-ratio: 16 / 9;
  max-width: 560px;
  border-radius: 12px;
  border: 1px solid #2c2638;
  background: #17131f;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  transition: border-color 0.2s ease;
}
.ppv-screen[data-ad="true"] { border-color: #b45309; background: #241a0f; }
.ppv-screen[data-fs="true"] { border-color: #38bdf8; }
.ppv-screen-label { font-size: 14px; font-weight: 700; text-align: center; word-break: keep-all; }
.ppv-time { font-size: 12.5px; color: #928aa6; font-variant-numeric: tabular-nums; }
.ppv-seek { width: 80%; accent-color: #8b5cf6; }

.ppv-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0 14px;
  max-width: 560px;
}
.ppv-controls button {
  border: 1px solid #332c42;
  background: #1c1826;
  color: #ddd;
  border-radius: 9px;
  padding: 8px 13px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.ppv-controls button:hover { border-color: #8b5cf6; color: #c4b5fd; }
.ppv-controls button.on { border-color: #8b5cf6; background: rgba(139, 92, 246, 0.18); color: #c4b5fd; }

.ppv-hint {
  max-width: 560px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #7d7590;
  word-break: keep-all;
}
.ppv-hint b { color: #c4b5fd; }

.ppv-log {
  max-width: 560px;
  margin: 16px 0 0;
  padding: 12px 14px 12px 30px;
  border-radius: 10px;
  background: #141019;
  border: 1px solid #2c2638;
  font-size: 11.5px;
  line-height: 1.7;
  color: #8f87a3;
  max-height: 280px;
  overflow-y: auto;
}
.ppv-log li[data-level="warn"] { color: #facc15; }
.ppv-log li[data-level="error"] { color: #f87171; }
.ppv-log code { color: #c4b5fd; }
.ppv-log span { margin-left: 6px; opacity: 0.75; }

.ppv-panel {
  flex: 0 0 360px;
  border-left: 1px solid #2c2638;
  display: flex;
}

@media (max-width: 900px) {
  .ppv-root { flex-direction: column; }
  .ppv-panel { flex: 1 1 auto; border-left: none; border-top: 1px solid #2c2638; min-height: 320px; }
}
`;
