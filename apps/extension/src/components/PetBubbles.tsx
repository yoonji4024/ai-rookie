import { useEffect, useRef } from "react";
import type { PetBubble, PetPhase } from "../shared/pet/turnRunner";

// ============================================================================
// Pet 대화 말풍선.
//
// 예전 챗봇 패널과 두 가지가 다르다.
//
// 1. 마이크 아이콘과 음성 파형이 없다. 상시 노출되는 마이크는 "지금 녹음되고 있다"는
//    신호라서, 검사받는 느낌을 만드는 여섯 지점 중 하나였다. 듣고 있다는 것은
//    Pet 의 표정과 귀로 보여주고, 여기서는 말만 보여준다.
// 2. 폭이 고정되어 있지 않다. 사이드 패널의 폭은 사용자가 드래그로 바꾼다.
// ============================================================================

export interface PetBubblesProps {
  bubbles: PetBubble[];
  phase: PetPhase;
  petName: string;
}

export default function PetBubbles({ bubbles, phase, petName }: PetBubblesProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  // 타이핑으로 글자가 늘어날 때도 항상 최신 내용이 보이게 한다
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles]);

  return (
    <div className="pb-root">
      <style>{STYLES}</style>

      <div className="pb-scroller" ref={scrollerRef} aria-live="polite" aria-label={`${petName}와의 대화`}>
        {bubbles.map((b) => (
          <div key={b.id} className={`pb-bubble pb-${b.speaker}`} data-kind={b.kind}>
            {b.text}
          </div>
        ))}

        {/* Pet 이 생각하는 동안의 점 세 개. 문구 대신 몸짓으로 상태를 보여준다 */}
        {phase === "thinking" && (
          <div className="pb-bubble pb-pet pb-typing" aria-hidden>
            <span /><span /><span />
          </div>
        )}
      </div>
    </div>
  );
}

const STYLES = `
.pb-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pb-scroller {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 14px 18px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.pb-bubble {
  max-width: 88%;
  padding: 10px 13px;
  border-radius: 14px;
  /* 어르신이 읽는 화면이다. 기존 13px 에서 키웠다 */
  font-size: 15px;
  line-height: 1.55;
  word-break: keep-all;
  white-space: pre-wrap;
  animation: pb-rise 0.25s ease;
}
@keyframes pb-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.pb-pet {
  align-self: flex-start;
  background: #8b5cf6;
  color: #fff;
  border-bottom-left-radius: 5px;
}
.pb-user {
  align-self: flex-end;
  background: #3a3a3a;
  color: #fff;
  border-bottom-right-radius: 5px;
}
/* Pet 이 자기 이야기를 할 때는 살짝 다른 결로 — 질문과 구분되게 */
.pb-pet[data-kind="selfDisclosure"],
.pb-pet[data-kind="remark"] {
  background: #6d4fd1;
}
.pb-pet[data-kind="promise"],
.pb-pet[data-kind="greeting"],
.pb-pet[data-kind="recall"] {
  background: #7c5cf0;
}

.pb-typing {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 12px 14px;
}
.pb-typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  animation: pb-blink 1.1s ease-in-out infinite;
}
.pb-typing span:nth-child(2) { animation-delay: 0.15s; }
.pb-typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes pb-blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .pb-bubble { animation: none; }
  .pb-typing span { animation: none; opacity: 0.7; }
}
`;
