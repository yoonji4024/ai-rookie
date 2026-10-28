import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import PetBubbles from "./PetBubbles";
import PetFace, { type PetFaceHandle } from "./PetFace";
import { usePetSession, type PetSessionOptions } from "./usePetSession";
import { PERSONA } from "../shared/pet/persona";
import type { PetBubble } from "../shared/pet/turnRunner";
import type { FloatAnchor } from "../shared/float/position";

// ============================================================================
// 화면에 떠 있는 두리.
//
// 사이드바 대신 영상 페이지 위 한쪽 구석에 강아지가 앉아 있다. 끌어서 옮길 수 있고,
// 말할 때만 옆에 말풍선이 뜨며, 누르면 대화 기록이 펼쳐진다.
//
// 이 컴포넌트는 자기가 어디에 떠 있는지 모른다. 위치·크기는 바깥이 정한다.
//   · 확장: 페이지에 띄운 iframe 안에서 돈다. 크기와 끌기를 postMessage 로 부모(content script)에
//     알리고, 부모가 iframe 을 옮기고 크기를 맞춘다. 투명한 큰 iframe 은 아래 페이지의 클릭을
//     가로채므로, iframe 은 늘 내용 크기에 딱 맞아야 한다 — 그래서 크기를 알린다.
//   · /pet 작업대: 같은 콜백을 부모 div 의 위치 계산에 바로 연결한다.
//
// anchor 는 강아지가 붙어 있는 화면 모서리다. 말풍선과 카드는 늘 그 반대쪽으로 자란다 —
// 오른쪽 아래 구석이면 위·왼쪽으로. 그래야 바깥이 모서리 기준으로 위치를 고정했을 때
// 내용이 커지고 작아져도 강아지가 제자리에 있다.
// ============================================================================

export type { FloatAnchor };

export interface FloatingChrome {
  anchor: FloatAnchor;
  /** 내용 크기(px). 바깥은 이 크기로 창(iframe)을 맞춘다 */
  onSize(width: number, height: number): void;
  /**
   * 강아지를 끄는 중이다. 잡은 지점에서 포인터가 벗어난 만큼(dx, dy) 옮겨 달라는 뜻이다.
   * 바깥이 옮기기를 마치면 resolve 한다. 그 전에는 다음 요청을 보내지 않는다.
   *
   * 확장에서는 쓰지 않는다. 그쪽은 강아지 위에 페이지 쪽 손잡이를 겹쳐 두고 끌기를 페이지가
   * 직접 처리한다 — iframe 이 옮겨지는 동안 iframe 안 좌표로 계산하면 지나치거나 덜 움직였다.
   * 끌기 없이 누른 것만 tapSignal 로 들어온다.
   */
  onDrag?(dx: number, dy: number): Promise<void> | void;
  onDragEnd?(): void;
  /** "오늘은 그만" */
  onHide?(): void;
}

export interface FloatingPetProps {
  chrome: FloatingChrome;
  session: PetSessionOptions;
  /** 자동재생이 막혀 자는 중인가. 깨어나기 전에는 대화 엔진을 띄우지 않는다 */
  asleep: boolean;
  onWake(): void;
  /** 펼친 카드 맨 아래에 붙일 것 (확장의 점검 기록 등) */
  footerExtra?: ReactNode;
  /** 바깥이 강아지 누르기를 대신 받았을 때마다 1씩 늘린다(확장의 손잡이) */
  tapSignal?: number;
}

/** 말이 끝난 뒤 말풍선을 남겨 두는 시간 */
const BUBBLE_LINGER_MS = 6000;
/** 이만큼 움직여야 끌기로 본다. 그보다 작으면 탭 */
const DRAG_SLOP_PX = 6;

// ── 끌기와 탭 ────────────────────────────────────────────────────────────────
function useDragHandle(chrome: FloatingChrome, onTap: () => void) {
  const grab = useRef<{ x: number; y: number; id: number; dragging: boolean } | null>(null);
  const waiting = useRef(false);
  const pending = useRef<{ x: number; y: number } | null>(null);

  const flush = useCallback(() => {
    const g = grab.current;
    const p = pending.current;
    if (!g || !p || waiting.current) return;
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    pending.current = null;
    if (dx === 0 && dy === 0) return;
    waiting.current = true;
    // 잡은 지점 기준 오차를 보낸다. 옮겨지고 나면 포인터는 다시 잡은 지점 근처로 돌아오므로
    // 오차가 쌓이지 않는다. 화면 좌표(screenX)는 iframe 이 옮겨지는 동안 늦게 갱신돼 쓸 수 없었다.
    void Promise.resolve(chrome.onDrag?.(dx, dy)).finally(() => {
      waiting.current = false;
      requestAnimationFrame(flush);
    });
  }, [chrome]);

  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      grab.current = { x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false };
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const g = grab.current;
      if (!g || g.id !== e.pointerId) return;
      if (!g.dragging && Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_SLOP_PX) return;
      g.dragging = true;
      pending.current = { x: e.clientX, y: e.clientY };
      flush();
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) {
      const g = grab.current;
      if (!g || g.id !== e.pointerId) return;
      grab.current = null;
      pending.current = null;
      if (g.dragging) chrome.onDragEnd?.();
      else onTap();
    },
    onPointerCancel() {
      if (grab.current?.dragging) chrome.onDragEnd?.();
      grab.current = null;
      pending.current = null;
    },
  };
}

// ── 크기 알림 ───────────────────────────────────────────────────────────────
function useReportSize(chrome: FloatingChrome) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      chrome.onSize(Math.ceil(r.width), Math.ceil(r.height));
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chrome]);
  return ref;
}

/** 바깥에서 들어온 누르기 신호 — 첫 값은 무시하고 바뀔 때마다 한 번 */
function useTapSignal(signal: number | undefined, onTap: () => void) {
  const seen = useRef(signal);
  useEffect(() => {
    if (signal === undefined || signal === seen.current) return;
    seen.current = signal;
    onTap();
  }, [signal, onTap]);
}

/** 작은 상태에서 보여 줄 말풍선 — 지금 말하는 것, 그리고 바로 앞이 상대 말이면 그것까지 */
function pickVisible(bubbles: PetBubble[]): PetBubble[] {
  const last = bubbles[bubbles.length - 1];
  if (!last) return [];
  const prev = bubbles[bubbles.length - 2];
  return prev && prev.speaker !== last.speaker ? [prev, last] : [last];
}

// ── 깨어 있는 두리 ──────────────────────────────────────────────────────────
function AwakePet({ chrome, session, footerExtra, tapSignal }: Omit<FloatingPetProps, "asleep" | "onWake">) {
  const { state, name, faceRef } = usePetSession(session);
  const [expanded, setExpanded] = useState(false);
  const [lingering, setLingering] = useState(false);
  const rootRef = useReportSize(chrome);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const drag = useDragHandle(chrome, toggle);
  useTapSignal(tapSignal, toggle);

  const busy = state.activeBeatId !== null || state.phase !== "watching";
  // 말이 끝나도 마지막 말풍선을 잠시 남긴다 — 어르신이 끝까지 읽을 시간
  const lastBubbleId = state.bubbles[state.bubbles.length - 1]?.id;
  useEffect(() => {
    if (busy || !lastBubbleId) return;
    setLingering(true);
    const t = window.setTimeout(() => setLingering(false), BUBBLE_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [busy, lastBubbleId]);

  const visible = busy || lingering ? pickVisible(state.bubbles) : [];

  return (
    <div
      ref={rootRef}
      className="fp-root"
      data-h={chrome.anchor.h}
      data-v={chrome.anchor.v}
      data-phase={state.phase}
      data-expanded={expanded}
    >
      <style>{STYLES}</style>

      {expanded ? (
        <section className="fp-card" aria-label={`${name}와의 대화`}>
          <header className="fp-card-head">
            <strong>{name}</strong>
            {state.content && <span className="fp-card-title" title={state.content.title}>{state.content.title}</span>}
            <button type="button" className="fp-icon-btn" onClick={() => setExpanded(false)} aria-label="작게 보기">
              ▾
            </button>
          </header>
          <PetBubbles bubbles={state.bubbles} phase={state.phase} petName={name} />
          {(chrome.onHide || footerExtra) && (
            <footer className="fp-card-foot">
              {chrome.onHide && (
                <button type="button" className="fp-text-btn" onClick={() => chrome.onHide?.()}>
                  오늘은 그만 볼래요
                </button>
              )}
              {footerExtra}
            </footer>
          )}
        </section>
      ) : (
        <div className="fp-bubbles" aria-live="polite">
          {visible.map((b) => (
            <div key={b.id} className={`fp-bubble fp-${b.speaker}`} data-kind={b.kind}>
              {b.text}
            </div>
          ))}
          {state.phase === "thinking" && (
            <div className="fp-bubble fp-pet fp-typing" aria-hidden>
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      )}

      <div
        className="fp-dog"
        role="button"
        tabIndex={0}
        aria-label={expanded ? `${name} — 눌러서 작게` : `${name} — 눌러서 대화 보기, 끌어서 옮기기`}
        aria-expanded={expanded}
        data-phase={state.phase}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        {...drag}
      >
        <PetFace ref={faceRef} petName={name} size={84} />
      </div>
    </div>
  );
}

// ── 자는 두리 ───────────────────────────────────────────────────────────────
// 브라우저가 아직 소리를 허락하지 않았다(이 페이지에서 아무것도 누르지 않았다).
// 예전 "쓰다듬기" 화면을 Pet 의 몸짓으로 바꾼 것이다. 누르면 그 제스처 안에서 깨어난다.
function SleepingPet({ chrome, session, onWake, tapSignal }: Omit<FloatingPetProps, "asleep" | "footerExtra">) {
  const name = session.petName ?? PERSONA.defaultPetName;
  const faceRef = useRef<PetFaceHandle>(null);
  const rootRef = useReportSize(chrome);
  const drag = useDragHandle(chrome, onWake);
  useTapSignal(tapSignal, onWake);

  useEffect(() => {
    // 눈을 감긴다 — 얼굴 리그의 깜빡임 값을 끝까지 올린다
    faceRef.current?.apply((n) => (n === "eyeBlinkLeft" || n === "eyeBlinkRight" ? 1 : 0));
  }, []);

  return (
    <div ref={rootRef} className="fp-root" data-h={chrome.anchor.h} data-v={chrome.anchor.v} data-asleep="true">
      <style>{STYLES}</style>
      <div className="fp-bubbles">
        <div className="fp-bubble fp-pet fp-hint">{name}가 졸고 있어요. 눌러서 깨워 주세요</div>
      </div>
      <div
        className="fp-dog"
        role="button"
        tabIndex={0}
        aria-label={`${name} 깨우기`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onWake();
          }
        }}
        {...drag}
      >
        <PetFace ref={faceRef} petName={name} size={84} />
        <span className="fp-zzz" aria-hidden>
          💤
        </span>
      </div>
    </div>
  );
}

export default function FloatingPet(props: FloatingPetProps) {
  const { asleep, onWake, ...rest } = props;
  return asleep ? (
    <SleepingPet chrome={props.chrome} session={props.session} onWake={onWake} tapSignal={props.tapSignal} />
  ) : (
    <AwakePet {...rest} />
  );
}

const STYLES = `
.fp-root {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  width: max-content;
  /* 그림자가 iframe 가장자리에서 잘리지 않을 여백 */
  padding: 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  color: #f1eefb;
  color-scheme: dark;
}
.fp-root[data-v="top"] { flex-direction: column-reverse; }
.fp-root[data-h="left"] { align-items: flex-start; }

/* ── 강아지 ── */
.fp-dog {
  position: relative;
  width: 96px;
  height: 96px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, #2a2235, #17121e);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45), 0 0 0 3px rgba(167, 139, 250, 0.55);
  cursor: grab;
  touch-action: none;
  user-select: none;
  animation: fp-breathe 3.2s ease-in-out infinite;
}
.fp-dog:active { cursor: grabbing; }
.fp-dog:focus-visible { outline: 3px solid #fde68a; outline-offset: 3px; }
.fp-dog[data-phase="earsUp"] { animation: none; transform: translateY(2px) scale(1.05); }
.fp-dog[data-phase="speaking"] { box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45), 0 0 0 4px #a78bfa; }
@keyframes fp-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}
.fp-root[data-asleep="true"] .fp-dog { animation-duration: 5s; opacity: 0.92; }
.fp-zzz {
  position: absolute;
  top: -6px;
  right: -4px;
  font-size: 24px;
  animation: fp-float 2.4s ease-in-out infinite;
}
@keyframes fp-float {
  0%, 100% { transform: translate(0, 0); opacity: 0.7; }
  50% { transform: translate(3px, -5px); opacity: 1; }
}

/* ── 말풍선 (작은 상태) ── */
.fp-bubbles {
  display: flex;
  flex-direction: column;
  align-items: inherit;
  gap: 6px;
}
.fp-bubbles:empty { display: none; }
.fp-bubble {
  width: max-content;
  max-width: 280px;
  padding: 11px 14px;
  border-radius: 16px;
  font-size: 18px;
  line-height: 1.5;
  word-break: keep-all;
  white-space: pre-wrap;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  animation: fp-pop 0.22s ease;
}
@keyframes fp-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to { opacity: 1; transform: none; }
}
.fp-pet { background: #7c3aed; color: #fff; }
.fp-user { background: #f4f4f5; color: #18181b; font-size: 16px; }
/* 말풍선 꼬리는 강아지 쪽 모서리를 덜 둥글게 */
.fp-root[data-h="right"][data-v="bottom"] .fp-pet:last-child { border-bottom-right-radius: 4px; }
.fp-root[data-h="left"][data-v="bottom"] .fp-pet:last-child { border-bottom-left-radius: 4px; }
.fp-root[data-h="right"][data-v="top"] .fp-pet:first-child { border-top-right-radius: 4px; }
.fp-root[data-h="left"][data-v="top"] .fp-pet:first-child { border-top-left-radius: 4px; }
.fp-hint { font-size: 16px; background: #2a2235; border: 1px solid rgba(167, 139, 250, 0.5); }
.fp-typing { display: flex; gap: 5px; align-items: center; padding: 14px 16px; }
.fp-typing span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  animation: fp-blink 1.1s ease-in-out infinite;
}
.fp-typing span:nth-child(2) { animation-delay: 0.15s; }
.fp-typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes fp-blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

/* ── 펼친 카드 ── */
.fp-card {
  width: 340px;
  height: 420px;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: #141018;
  border: 1px solid rgba(167, 139, 250, 0.35);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  animation: fp-pop 0.2s ease;
}
.fp-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 10px 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.fp-card-head strong { color: #c4b5fd; font-size: 15px; flex: 0 0 auto; }
.fp-card-title { flex: 1; min-width: 0; font-size: 12px; color: #8e86a3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-icon-btn {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
}
.fp-card-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.fp-text-btn {
  align-self: flex-start;
  border: 0;
  background: none;
  color: #a1a1aa;
  font-size: 14px;
  padding: 6px 2px;
  cursor: pointer;
  text-decoration: underline;
}

@media (prefers-reduced-motion: reduce) {
  .fp-dog, .fp-zzz, .fp-bubble, .fp-card, .fp-typing span { animation: none; }
}
`;
