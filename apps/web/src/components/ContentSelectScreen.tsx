import { useEffect, useRef } from "react";
import { playVarcoTts } from "../lib/varcoTts";

const WELCOME_VOICE_ID = "3278b908-86ee-5c30-bb55-24b5b1bbc67b";

// ============================================================================
// 콘텐츠 선택 화면
// 로그인한 사용자가 체험할 콘텐츠(뉴스/예능·교양 미디어)를 고르는 화면.
// 주의: 이 화면은 사용자(치매위험군)가 직접 보는 화면이므로 프로그램의 목적을
// 드러내는 문구(치매/인지 등)를 절대 노출하지 않는다. 보호자용 리포트에만 표기한다.
// 데모 단계에서는 각 카테고리에서 첫 번째 콘텐츠만 실제로 재생되지만,
// 나머지도 동일하게 보이도록 "준비 중" 표시 없이 카드를 노출한다.
// 카드는 한 화면에 3개씩 보이고, 좌우 화살표로 나머지를 넘겨볼 수 있다.
// ============================================================================

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

const MEDIA_ITEMS: ContentItem[] = [
  { src: "/videos/images/drama1.png", label: "한국기행 - 지금 여기, 여유롭게" },
  { src: "/videos/images/drama2.png", label: "불어라 미풍아" },
  { src: "/videos/images/drama3.png", label: "모두 다 김치" },
  { src: "/videos/images/drama4.png", label: "내 딸 금사월" },
];

export interface ContentSelectScreenProps {
  /** 예능·교양 미디어를 선택했을 때 호출 */
  onSelectMedia: () => void;
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

export default function ContentSelectScreen({ onSelectMedia, onSelectNews }: ContentSelectScreenProps) {
  const welcome = "고마워요. 이제 보고 싶은 영상을 골라 저와 함께 이야기 나눠볼까요?";
  useEffect(() => playVarcoTts(welcome, WELCOME_VOICE_ID, () => {}, { speed: 0.92, pitch: 0.98 }), [welcome]);

  return (
    <div className="csc-root">
      <style>{STYLES}</style>

      <div className="csc-card">
        <h1 className="csc-title">이제 무엇을 볼까요?</h1>
        <p className="csc-intro">보고 싶은 영상을 골라 저와 함께 이야기 나눠볼까요?</p>

        <CarouselRow
          title="뉴스"
          items={NEWS_ITEMS}
          altPrefix="뉴스"
          onItemClick={(i) => {
            if (i === 0) onSelectNews();
          }}
        />
        <CarouselRow
          title="예능 · 교양"
          items={MEDIA_ITEMS}
          altPrefix="미디어"
          onItemClick={(i) => {
            if (i === 0) onSelectMedia();
          }}
        />
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
  margin: 0 0 8px;
  font-size: 25px;
  font-weight: 800;
  text-align: center;
  word-break: keep-all;
}
.csc-intro {
  margin: 0 0 30px;
  color: #b6b0c0;
  font-size: 16px;
  line-height: 1.6;
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

@media (max-width: 640px) {
  .csc-item {
    flex-basis: calc((100% - 16px) / 2);
  }
}
`;
