import { useEffect, useState } from "react";
import { obsSnapshot } from "../../../src/shared/obs/log";
import type { ObsEvent } from "../../../src/shared/protocol";

// ============================================================================
// 디버그 HUD — d 를 세 번 연타하면 열린다. inline 이면 늘 열린 채로 제자리에 그린다
// (떠 있는 두리의 펼친 카드 맨 아래 "점검 기록").
//
// 무대에서 무언가 안 될 때 "왜"를 즉시 보기 위한 창이다. 특히 content 와 panel 의
// 빌드 시각을 나란히 보여주는데, 확장 일부만 리로드된 상태가 MV3 에서 가장 흔한
// 유령 버그이기 때문이다. 두 시각이 다르면 그것부터 의심해야 한다.
// ============================================================================

const PANEL_BUILD_AT = new Date().toISOString();

export default function DebugHud({ inline = false }: { inline?: boolean }) {
  const [open, setOpen] = useState(inline);
  const [events, setEvents] = useState<ObsEvent[]>([]);

  useEffect(() => {
    let taps: number[] = [];
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "d") return;
      const now = Date.now();
      taps = [...taps.filter((t) => now - t < 700), now];
      if (taps.length >= 3) {
        taps = [];
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setEvents(obsSnapshot(25).slice().reverse()), 400);
    return () => clearInterval(t);
  }, [open]);

  if (!open) return null;

  return (
    <div className="dh-root" data-inline={inline}>
      <style>{STYLES}</style>
      <div className="dh-head">
        <b>디버그</b>
        <span>패널 빌드 {PANEL_BUILD_AT.slice(11, 19)}</span>
        {!inline && (
          <button type="button" onClick={() => setOpen(false)}>
            ✕
          </button>
        )}
      </div>
      <ol className="dh-log">
        {events.map((e, i) => (
          <li key={`${e.t}-${i}`} data-level={e.level}>
            <code>{e.where}·{e.code}</code>
            {e.detail && <span>{JSON.stringify(e.detail)}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

const STYLES = `
.dh-root {
  position: fixed;
  inset: auto 0 0 0;
  max-height: 55%;
  display: flex;
  flex-direction: column;
  background: rgba(10, 8, 14, 0.97);
  border-top: 1px solid #3a3350;
  color: #b9b1cc;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  z-index: 999;
}
.dh-root[data-inline="true"] {
  position: static;
  max-height: 140px;
  border: 1px solid #3a3350;
  border-radius: 8px;
}
.dh-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #2a2438;
  color: #c4b5fd;
}
.dh-head b { flex: 0 0 auto; }
.dh-head span { flex: 1; opacity: 0.7; }
.dh-head button {
  background: none;
  border: none;
  color: #8f87a3;
  cursor: pointer;
  font-size: 13px;
}
.dh-log {
  margin: 0;
  padding: 8px 10px 10px 26px;
  overflow-y: auto;
  line-height: 1.65;
}
.dh-log li[data-level="warn"] { color: #facc15; }
.dh-log li[data-level="error"] { color: #f87171; }
.dh-log code { color: #c4b5fd; }
.dh-log span { margin-left: 5px; opacity: 0.7; }
`;
