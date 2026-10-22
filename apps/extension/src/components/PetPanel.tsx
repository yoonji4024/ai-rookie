import PetBubbles from "./PetBubbles";
import PetFace from "./PetFace";
import { usePetSession, type PetSessionOptions } from "./usePetSession";

// ============================================================================
// Pet 패널 — 사이드바형 화면. /pet 작업대가 쓴다.
//
// 듣고 판단하고 말하는 로직은 usePetSession 에 있다. 여기는 그 상태를 세로 패널로 그릴 뿐이다.
// 확장에서 화면에 떠 있는 두리는 같은 훅을 FloatingPet 으로 그린다.
// ============================================================================

export type PetPanelProps = PetSessionOptions;

export default function PetPanel(props: PetPanelProps) {
  const { state, name, faceRef } = usePetSession(props);

  return (
    <div className="pp-root" data-phase={state.phase}>
      <style>{STYLES}</style>

      <header className="pp-head">
        <span className="pp-name">{name}</span>
        {state.content && <span className="pp-content" title={state.content.title}>{state.content.title}</span>}
      </header>

      <div className="pp-face" data-phase={state.phase}>
        <PetFace ref={faceRef} petName={name} />
      </div>

      <PetBubbles bubbles={state.bubbles} phase={state.phase} petName={name} />
    </div>
  );
}

const STYLES = `
.pp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* 고정 폭을 두지 않는다 — 사이드 패널 폭은 사용자가 드래그로 바꾼다 */
  width: 100%;
  background: #141018;
  color: #f1eefb;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
  color-scheme: dark;
  overflow: hidden;
}
.pp-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.pp-name {
  font-size: 14px;
  font-weight: 800;
  color: #c4b5fd;
  flex: 0 0 auto;
}
.pp-face {
  display: flex;
  justify-content: center;
  padding: 14px 0 6px;
  flex: 0 0 auto;
  transition: transform 0.3s ease;
}
/* 듣는 중에는 살짝 앞으로 기울인다 — 마이크 아이콘 대신의 몸짓 */
.pp-face[data-phase="earsUp"] { transform: translateY(3px) scale(1.03); }
@media (prefers-reduced-motion: reduce) { .pp-face { transition: none; } }

.pp-content {
  font-size: 11.5px;
  color: #7d7590;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;
