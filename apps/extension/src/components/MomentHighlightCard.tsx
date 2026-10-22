import type { MomentCard } from "../shared/pet/memory";

// ============================================================================
// 보호자 화면의 '오늘 웃었던 순간' 카드 (유대감 ④).
//
// 이 카드는 점수 타일보다 **위에** 온다. 보호자가 리포트를 열었을 때 숫자보다 먼저
// 손녀 같은 대화 한 조각을 보게 하려는 것이다. 그것이 "검사 결과지"와 "관계의 기록"의
// 차이다 (검토 4.4절 8번).
//
// 규칙 두 가지:
//  1. 지표·점수·의학 용어를 하나도 쓰지 않는다. 이 카드만은 그냥 따뜻해야 한다.
//  2. 높이를 200px 이하로 묶는다. PDF 내보내기가 DOM 노드 단위로 조각을 만드는데
//     조각 축소 로직이 없어서, 한 조각이 페이지 높이를 넘으면 잘린다. 새 카드가
//     그 문제를 건드리지 않게 한다.
// ============================================================================

export interface MomentHighlightCardProps {
  moment: MomentCard | null;
  petName: string;
}

export default function MomentHighlightCard({ moment, petName }: MomentHighlightCardProps) {
  // 카드가 없으면 아무것도 렌더하지 않는다 — 기존 리포트를 깨지 않는다
  if (!moment) return null;

  return (
    <>
      {/* style 을 섹션 밖에 둔다 — 안에 두면 카드의 textContent 에 CSS 가 섞여
          화면을 읽어 검증하는 쪽에서 엉뚱한 문자열을 보게 된다 */}
      <style>{STYLES}</style>
      <section className="mhc-card">
      <div className="mhc-head">
        <span className="mhc-kicker">오늘 웃었던 순간</span>
        <span className="mhc-meta">
          {moment.date}
          {moment.contentTitle ? ` · ${moment.contentTitle}` : ""}
        </span>
      </div>

      <blockquote className="mhc-quote">{moment.quote}</blockquote>

      <div className="mhc-pet">
        <span className="mhc-pet-name">{petName}</span>
        <span className="mhc-pet-line">{moment.petLine}</span>
      </div>
      </section>
    </>
  );
}

const STYLES = `
.mhc-card {
  /* PDF 조각이 페이지를 넘지 않도록 높이를 묶어 둔다 */
  max-height: 200px;
  overflow: hidden;
  box-sizing: border-box;
  width: min(624px, 100%);
  margin: 0 auto 22px;
  padding: 16px 20px 18px;
  border-radius: 14px;
  border: 1px solid var(--gdr-card-border, #2a2a2a);
  background: var(--gdr-card-bg-2, #191622);
}
.mhc-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.mhc-kicker {
  font-size: 12px;
  font-weight: 800;
  color: #c4b5fd;
  flex: 0 0 auto;
}
.mhc-meta {
  font-size: 11.5px;
  color: var(--gdr-text-secondary, #8a8398);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mhc-quote {
  margin: 0 0 12px;
  padding-left: 12px;
  border-left: 3px solid #8b5cf6;
  font-size: 15px;
  line-height: 1.6;
  color: var(--gdr-text-primary, #efeaf7);
  word-break: keep-all;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mhc-pet {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
.mhc-pet-name {
  flex: 0 0 auto;
  font-weight: 800;
  color: #a78bfa;
}
.mhc-pet-line {
  color: var(--gdr-text-secondary, #8a8398);
  word-break: keep-all;
}
`;
