import { useRef } from "react";
import ChatbotPanel, { type ChatbotQuestion } from "./ChatbotPanel";
import { PERSONA } from "../shared/pet/persona";

// ============================================================================
// 콘텐츠 선택 화면
// 로그인한 사용자가 체험할 콘텐츠(뉴스/드라마)를 고르는 화면.
// 주의: 이 화면은 사용자(치매위험군)가 직접 보는 화면이므로 프로그램의 목적을
// 드러내는 문구(치매/인지 등)를 절대 노출하지 않는다. 보호자용 리포트에만 표기한다.
// 데모 단계에서는 각 카테고리에서 첫 번째 콘텐츠만 실제로 재생되지만,
// 나머지도 동일하게 보이도록 "준비 중" 표시 없이 카드를 노출한다.
// 카드는 한 화면에 3개씩 보이고, 좌우 화살표로 나머지를 넘겨볼 수 있다.
// 우하단에는 Pet 챗봇이 떠서 언어 유창성(Fluency)을 가늠할 수 있는
// 질문을 "취향 기반 추천"으로만 보이게 건넨다. 로그인 버튼 클릭 직후 진입이라
// 소리 있는 자동 재생이 허용된다.
// ============================================================================

// 언어 유창성(Fluency) 측정용 대화 — 사용자에게는 취향 조사로만 보이게 한다.
// 가정 답변에는 아래 DRAMA_ITEMS에 실재하는 제목들을 섞어, "취향에 맞춰
// 준비했다"는 피드백이 화면의 목록과 자연스럽게 이어지도록 한다.
const FLUENCY_QUESTIONS: ChatbotQuestion[] = [
  {
    id: "flu-drama-5",
    question: "안녕하세요! 좋아하는 드라마 5개를 알려주세요! 취향을 바탕으로 콘텐츠를 추천해드릴게요!",
    simulatedAnswer:
      "음… 전원일기, 대장금, 그리고 불어라 미풍아… 내 딸 금사월… 아, 모두 다 김치! 이렇게 다섯 개요.",
    feedback:
      "다섯 작품 모두 잘 들었어요! 가족 이야기가 담긴 따뜻한 드라마를 좋아하시는군요. 취향에 맞춰 아래 목록을 준비했으니 마음에 드는 콘텐츠를 골라보세요!",
  },
];

interface ContentItem {
  src: string;
  label: string;
}

const NEWS_ITEMS: ContentItem[] = [
  { src: "/videos/images/news1.png", label: "영하 75도 냉동창고 취재" },
  { src: "/videos/images/news2.png", label: "한강 위를 걷는 고양이" },
  { src: "/videos/images/news3.png", label: "호우특보 기상 뉴스" },
  { src: "/videos/images/news4.png", label: "말랑이의 배신" },
  { src: "/videos/images/news5.png", label: "손흥민 월드컵 인터뷰" },
];

const DRAMA_ITEMS: ContentItem[] = [
  { src: "/videos/images/drama1.png", label: "한국기행 - 지금 여기, 여유롭게" },
  { src: "/videos/images/drama2.png", label: "불어라 미풍아" },
  { src: "/videos/images/drama3.png", label: "모두 다 김치" },
  { src: "/videos/images/drama4.png", label: "내 딸 금사월" },
];

export interface ContentSelectScreenProps {
  /** "드라마" 콘텐츠를 선택했을 때 호출 (드라마 체험으로 이동) */
  onSelectDrama: () => void;
  /** "뉴스" 콘텐츠를 선택했을 때 호출 (뉴스 체험으로 이동) */
  onSelectNews: () => void;
}

interface CarouselRowProps {
  title: string;
  items: ContentItem[];
  altPrefix: string;
  onItemClick?: (index: number) => void;
}

function CarouselRow({ title, items, altPrefix, onItemClick }: CarouselRowProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const scrollByPage = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    const maxScrollLeft = el.scrollWidth - el.clientWidth;
    if (dir === 1 && el.scrollLeft >= maxScrollLeft - 4) {
      el.scrollTo({ left: 0, behavior: "smooth" });
      return;
    }
    if (dir === -1 && el.scrollLeft <= 4) {
      el.scrollTo({ left: maxScrollLeft, behavior: "smooth" });
      return;
    }
    el.scrollBy({ left: dir * el.clientWidth, behavior: "smooth" });
  };

  return (
    <section className="csc-section">
      <h2 className="csc-section-title">{title}</h2>
      <div className="csc-carousel">
        <button type="button" className="csc-nav csc-nav-prev" aria-label="이전" onClick={() => scrollByPage(-1)}>
          ‹
        </button>
        <div className="csc-track" ref={trackRef}>
          {items.map((item, i) => (
            <button key={item.src} type="button" className="csc-item" onClick={() => onItemClick?.(i)}>
              <div className="csc-thumb">
                <img className="csc-thumb-img" src={item.src} alt={`${altPrefix} ${item.label} 썸네일`} />
              </div>
              <div className="csc-item-label">{item.label}</div>
            </button>
          ))}
        </div>
        <button type="button" className="csc-nav csc-nav-next" aria-label="다음" onClick={() => scrollByPage(1)}>
          ›
        </button>
      </div>
    </section>
  );
}

export default function ContentSelectScreen({ onSelectDrama, onSelectNews }: ContentSelectScreenProps) {
  return (
    <div className="csc-root">
      <style>{STYLES}</style>

      <div className="csc-card">
        <h1 className="csc-title">시청할 콘텐츠를 선택해 주세요</h1>

        <CarouselRow
          title="뉴스"
          items={NEWS_ITEMS}
          altPrefix="뉴스"
          onItemClick={(i) => {
            if (i === 0) onSelectNews();
          }}
        />
        <CarouselRow
          title="드라마"
          items={DRAMA_ITEMS}
          altPrefix="드라마"
          onItemClick={(i) => {
            if (i === 0) onSelectDrama();
          }}
        />
      </div>

      {/* 콘텐츠를 고르면 화면이 전환되며 언마운트되고 음성도 중단된다 */}
      <div className="csc-chatbot-dock">
        <ChatbotPanel questions={FLUENCY_QUESTIONS} title={PERSONA.defaultPetName} startDelayMs={1000} />
      </div>
    </div>
  );
}

// ============================================================================
// 스타일 (블랙 배경 + 퍼플 포인트, 다른 화면들과 동일 톤)
// ============================================================================
const STYLES = `
.csc-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  overflow-y: auto;
  background: radial-gradient(ellipse at 50% 0%, #160b2d 0%, #000 65%);
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
  color-scheme: dark;
}
.csc-card {
  width: min(1240px, 96vw);
  max-height: 94vh;
  overflow-y: auto;
  background: #141414;
  border: 1px solid #2a2a2a;
  border-radius: 18px;
  padding: 34px 48px 40px;
  box-sizing: border-box;
}
.csc-title {
  margin: 0 0 30px;
  font-size: 21px;
  font-weight: 800;
  text-align: center;
  word-break: keep-all;
}
.csc-section {
  margin-bottom: 30px;
}
.csc-section:last-child {
  margin-bottom: 0;
}
.csc-section-title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 800;
  color: #c4b5fd;
}
.csc-carousel {
  display: flex;
  align-items: center;
  gap: 8px;
}
.csc-nav {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #333;
  background: #1b1b1b;
  color: #ccc;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.csc-nav:hover {
  border-color: #8b5cf6;
  color: #c4b5fd;
}
.csc-track {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 16px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
}
.csc-track::-webkit-scrollbar {
  display: none;
}
.csc-item {
  flex: 0 0 calc((100% - 2 * 16px) / 3);
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: inherit;
  color: inherit;
  text-align: left;
}
.csc-thumb {
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  background: #1b1b1b;
  border: 1px solid #333;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #666;
  font-size: 13px;
  transition: border-color 0.15s ease;
}
.csc-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.csc-item:hover .csc-thumb {
  border-color: #8b5cf6;
}
.csc-item-label {
  font-size: 14px;
  font-weight: 600;
  color: #ddd;
}

/* 콘텐츠 카드를 가리지 않는 우하단 플로팅 도크 */
.csc-chatbot-dock {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 50;
}

@media (max-width: 640px) {
  .csc-item {
    flex-basis: calc((100% - 16px) / 2);
  }
}
`;
