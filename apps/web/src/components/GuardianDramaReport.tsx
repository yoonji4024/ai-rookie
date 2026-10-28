import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLatestReport, type ReportResponse } from "../lib/scoreApi";

// ============================================================================
// 타입 정의
// ============================================================================

export interface ScoreFactor {
  /** 레이더 차트 축 이름 */
  label: string;
  /** 0~100 점수 */
  score: number;
  /** false면 추출 실패/입력 부재로 계산하지 못한 축이다. 0점으로 해석하면 안 된다. */
  available?: boolean;
  /** false면 객관적 규칙으로 계산됐지만 인지 저하 판별력은 아직 파일럿 검증 전이다. */
  validated?: boolean | null;
  /** 질문별 점수·측정 문항 수 등 보호자 설명에 사용할 계산 근거. */
  detail?: Record<string, unknown> | null;
}

export interface ScoreCategory {
  key: "speech" | "content";
  name: string;
  /** 타일에 표시할 짧은 설명 */
  description: string;
  /** 레이더 차트를 구성하는 5가지 요소 */
  factors: ScoreFactor[];
}

export interface ReportQuestion {
  id: string;
  /** 치매 의심도 근거 기여 순위 (1이 가장 큼, 화면에는 이 순서대로 표시) */
  rank: number;
  /** 치매 의심도 근거 기여도 (0~100, 게이지 표시용) */
  impact: number;
  question: string;
  correctAnswer: string;
  /** (데모용) 치매위험군 사용자의 답. 실제 서비스에서는 ASR 결과 텍스트로 대체된다 */
  userAnswer: string;
  /** 이 질문이 나온 영상 시점(초) — [질문] 클릭 시 이 지점부터 재생 */
  videoTimestamp: number;
  /** 고정 시연 질문의 정답 핵심어 */
  answerKeywords?: string[];
  /** 검사 중 녹음한 실제 사용자 음성. 합성 음성으로 대체하지 않는다. */
  recordingUrl?: string | null;
}

export interface GuardianDramaReportProps {
  /** 리포트 상단에 표시할 대상자 이름 */
  patientName?: string;
  /** 대상자 생년월일 (YYYY-MM-DD) — 있으면 헤더에 나이와 함께 표시 */
  patientBirthDate?: string;
  /** 방금 사용자 체험에서 받은 실제 분석 결과 */
  report?: ReportResponse | null;
}

/** 검사 회차별 발화/내용 점수 한 점 — 각 회차의 세부 요소 점수까지 담아 회차 클릭 시 상세 결과를 보여줄 수 있게 한다 */
export interface TrendPoint {
  date: string;
  /** 그래프 X축에 표시할 짧은 라벨 */
  label: string;
  speechFactors: ScoreFactor[];
  contentFactors: ScoreFactor[];
}

// ============================================================================
// 데모용 목업 데이터
// 실제 서비스에서는 서버에서 채점 결과 JSON을 받아 이 형태로 매핑한다.
// 영상: EBS 한국기행 "지금 여기, 여유롭게" - 대학가요제 대상 출신 병진 씨 부부 이야기
// ============================================================================

/** 관찰에 사용된 예능·교양 미디어 (public/videos/H231141.mp4) */
const VIDEO_SRC = "/videos/H231141.mp4";

/** [질문] 클릭 시 타임스탬프부터 이 길이(초)만큼만 재생하고 멈춘다 */
const QUESTION_CLIP_SECONDS = 8;

const SPEECH_SCORE: ScoreCategory = {
  key: "speech",
  name: "발화 점수",
  description: "말의 유창성과 전달력을 평가해요",
  factors: [
    { label: "버벅임", score: 52 },
    { label: "침묵 시간", score: 46 },
    { label: "발화 속도", score: 64 },
    { label: "발음 정확도", score: 71 },
    { label: "문장 완성도", score: 57 },
  ],
};

const CONTENT_SCORE: ScoreCategory = {
  key: "content",
  name: "내용 점수",
  description: "답변 내용의 정확성과 수준을 평가해요",
  factors: [
    { label: "단어 수준", score: 60 },
    { label: "문맥 일치도", score: 54 },
    { label: "기억 정확도", score: 43 },
    { label: "시간·장소 지남력", score: 49 },
    { label: "논리 연결", score: 58 },
  ],
};

/** 점수 추세는 백엔드 SQLite에 저장된 실제 사용자별 검사 이력만 사용한다. */

/** 일상 내용 질문 — 내용 점수보다 발화 점수에 더 큰 영향을 주는 변수.
 * 사용자 체험 화면(App)의 질문·답도 이 데이터에서 만들어 보호자 리포트와 항상 일치시킨다. */
export const DAILY_QUESTIONS: ReportQuestion[] = [
  {
    id: "d1",
    rank: 1,
    impact: 85,
    question: "아까 저분이 대학가요제에서 큰 상을 받았다고 했죠. 무슨 상을 받았죠?",
    correctAnswer: "제2회 대학가요제에서 대상(1등)을 받았다.",
    userAnswer: "글쎄요… 1등이었나? 등수는 잘 기억이 안 나네요.",
    videoTimestamp: 184,
    answerKeywords: ["대상", "1등"],
  },
  {
    id: "d2",
    rank: 2,
    impact: 70,
    question: "두 분이 참 다정해 보이네요. 처음 만난 때가 언제라고 했죠?",
    correctAnswer: "대학교 1학년 때 캠퍼스 커플로 만나 지금까지 45년째 함께하고 있다.",
    userAnswer: "음… 만난 지 얼마 안 됐다고 했던 것 같은데, 잘 모르겠어요.",
    videoTimestamp: 326,
    answerKeywords: ["대학교", "1학년", "캠퍼스", "45년"],
  },
];

/** 진단용 질문 — 발화 점수와 내용 점수 모두에 영향을 주는 변수 */
export const DIAGNOSTIC_QUESTIONS: ReportQuestion[] = [
  {
    id: "x1",
    rank: 1,
    impact: 90,
    question: "학생들이 저분을 많이 따라다녔다고 했죠. 왜 그랬죠?",
    correctAnswer: "대학가요제에서 대상을 받고 유명해져서(부산 시민들이 다 알아볼 정도의 '부산 대세남'이 되어서) 여고생들이 따라다녔다.",
    userAnswer: "그냥 인기가 많았대요… 왜 그런지는 모르겠어요.",
    videoTimestamp: 263,
    answerKeywords: ["대학가요제", "대상", "유명", "인기"],
  },
  {
    id: "x2",
    rank: 2,
    impact: 75,
    question: "저분이 지붕 위에 올라가 계시네요. 거기서 뭘 하고 있었죠?",
    correctAnswer: "자신이 직접 지은 트리하우스(아지트)의 지붕을 보수하기 위해 올라가 있다.",
    userAnswer: "글쎄요, 그냥 구경하러 올라간 거 아니에요?",
    videoTimestamp: 370,
    answerKeywords: ["트리하우스", "지붕", "보수", "고치"],
  },
];

// ============================================================================
// 실제 사용자 녹음 재생
// 보호자에게는 합성 음성이 아니라 검사 중 저장된 원본 음성만 들려준다.
// ============================================================================
function playUserAnswerRecording(recordingUrl: string, onEnd: () => void): () => void {
  const audio = new Audio(recordingUrl);
  let stopped = false;
  audio.onended = onEnd;
  audio.onerror = onEnd;
  audio.play().catch(() => {
    if (!stopped) onEnd();
  });
  return () => {
    stopped = true;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
  };
}

// ============================================================================
// 유틸
// ============================================================================

function formatBirthWithAge(birthDate: string): string | null {
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age -= 1;
  return `${birth.getFullYear()}년 ${birth.getMonth() + 1}월 ${birth.getDate()}일생 (만 ${age}세)`;
}

function ageFromBirthDate(birthDate?: string | null): number | null {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age -= 1;
  return age;
}

function avgOf(factors: ScoreFactor[]): number {
  const available = factors.filter((f) => f.available !== false);
  if (available.length === 0) return 0;
  const sum = available.reduce((acc, f) => acc + f.score, 0);
  return Math.round(sum / available.length);
}

/**
 * 보호자용 내용 총점의 잠정 가중치.
 * 회상·지남력 중심의 임상 문헌 우선순위와 현재 MEMFLIX 과제 구조를 반영하되,
 * 진단 도구의 공식 배점으로 오해하지 않도록 세부 원점수는 그대로 함께 보여준다.
 */
const CONTENT_SCORE_WEIGHTS: Record<string, number> = {
  "기억 정확도": 0.40,
  "시간·장소 지남력": 0.25,
  "문맥 일치도": 0.15,
  "논리 연결": 0.15,
  "단어 수준": 0.05,
};

function weightedContentTotal(factors: ScoreFactor[]): number {
  const available = factors.filter((factor) => factor.available !== false);
  if (available.length === 0) return 0;
  const weighted = available.map((factor) => ({
    score: factor.score,
    weight: CONTENT_SCORE_WEIGHTS[factor.label] ?? 0,
  }));
  const weightSum = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (weightSum <= 0) return avgOf(available);
  return Math.round(
    weighted.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum,
  );
}

function totalOf(category: ScoreCategory): number {
  return category.key === "content"
    ? weightedContentTotal(category.factors)
    : avgOf(category.factors);
}

function categoryDisplay(category: ScoreCategory, personalBaseline = false): {
  available: boolean;
  total: number;
  grade: { label: string; color: string };
} {
  const available = category.factors.some((factor) => factor.available !== false);
  const total = totalOf(category);
  const observationalSpeech = category.key === "speech"
    && category.factors.some((factor) => factor.validated === false);
  return {
    available,
    total,
    grade: available
      ? observationalSpeech
        ? { label: "참고 관찰", color: "#a78bfa" }
        : personalBaseline
        ? { label: "개인 기준선", color: "#a78bfa" }
        : gradeOf(total)
      : { label: "측정 불가", color: "#94a3b8" },
  };
}

/** 진단 등급이 아니라 관찰 안내 단계다. */
function gradeOf(total: number): { label: string; color: string } {
  if (total >= 85) return { label: "양호", color: "#22c55e" };
  if (total >= 50) return { label: "관찰 필요", color: "#facc15" };
  return { label: "주의 관찰", color: "#ef4444" };
}

/** 배지 글씨 색: 라이트 모드(그리고 항상 화이트인 PDF)는 검정, 다크 모드는 등급 색 그대로 */
function gradeTextColor(grade: { color: string }, theme: "dark" | "light"): string {
  return theme === "dark" ? grade.color : "#1a1a1a";
}

/** 레이더 차트 옆에 보여줄, 해당 영역 결과를 한두 문장으로 요약 */
function summarizeCategory(category: ScoreCategory, total: number, personalBaseline = false): string {
  const grade = gradeOf(total);
  const available = category.factors.filter((f) => f.available !== false).sort((a, b) => a.score - b.score);
  const unavailable = category.factors.length - available.length;
  if (available.length === 0) return "이번 입력에서는 이 영역을 계산하지 못했어요.";
  if (category.key === "speech" && category.factors.some((factor) => factor.validated === false)) {
    const ceilingNames = available
      .filter((factor) => factor.detail?.score_ceiling === true)
      .map((factor) => factor.label);
    const ceilingNote = ceilingNames.length > 0
      ? ` ‘${ceilingNames.join("·")}’ 항목은 참조분포 상단에 닿은 값으로, '완벽하다'는 의미는 아니에요.`
      : "";
    return `실제 녹음에서 계산한 발화 관찰값은 ${total}점이에요.${ceilingNote} 짧은 문답 환경의 절대 등급으로 단정하지 않고, 같은 조건에서 반복한 변화와 실제 목소리를 함께 살펴봐요.`;
  }
  if (personalBaseline) {
    return `이번 ${category.name} ${total}점은 동일 연령대와 비교한 등급이 아니라, 다음 회차의 변화를 살펴보기 위한 개인 기준선이에요.`;
  }
  const belowGood = available.filter((factor) => factor.score < 85);
  if (belowGood.length === 0) {
    if (unavailable > 0) {
      return `계산 가능한 ${available.length}개 항목은 양호한 범위예요. 발화량이 더 필요한 ${unavailable}개 항목은 점수에서 제외했어요.`;
    }
    return "모든 세부 항목이 양호한 범위로 나타났어요. 이번 결과는 진단이 아닌 관찰 참고 자료예요.";
  }
  const names = belowGood.slice(0, 2).map((f) => `${f.label}(${f.score}점)`).join(", ");
  if (total >= 85) {
    return `${names} 항목이 다른 항목보다 상대적으로 낮았지만, 전체는 양호한 범위예요. 한 번의 결과보다 이후 변화 추이를 함께 참고해 주세요.`;
  }
  return `${names} 항목을 다음 관찰에서 함께 살펴보면 좋아요. 이번 결과는 ${grade.label} 단계이며 진단이 아닌 관찰 참고 자료예요.`;
}

/** 특정 회차의 발화/내용 총점 */
function trendScoreOf(point: TrendPoint, key: "speech" | "content"): number {
  return key === "speech"
    ? avgOf(point.speechFactors)
    : weightedContentTotal(point.contentFactors);
}

/** 직전 회차 대비 점수 증감 (양수 = 개선, 음수 = 악화) */
function trendDelta(data: TrendPoint[], key: "speech" | "content"): number {
  if (data.length < 2) return 0;
  return trendScoreOf(data[data.length - 1], key) - trendScoreOf(data[data.length - 2], key);
}

// ============================================================================
// 레이더 차트 (외부 라이브러리 없이 SVG로 직접 렌더링)
// ============================================================================

function RadarChart({
  factors,
  accent,
  size = 300,
  labelColor = "var(--gdr-text-secondary)",
}: {
  factors: ScoreFactor[];
  accent: string;
  size?: number;
  /** 축 이름 라벨 색 — PDF로 내보낼 때는 html2canvas가 SVG의 CSS 변수 fill을 안정적으로
   *  옮기지 못할 수 있어 검정 계열 실제 색상 값을 직접 넘긴다 */
  labelColor?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.33;
  const n = factors.length;

  const angleAt = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointAt = (i: number, r: number): [number, number] => [
    cx + r * Math.cos(angleAt(i)),
    cy + r * Math.sin(angleAt(i)),
  ];
  const polygon = (r: number) =>
    factors.map((_, i) => pointAt(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");

  const allAvailable = factors.every((f) => f.available !== false);
  const dataPoints = factors.map((f, i) => pointAt(i, (radius * f.score) / 100));
  const dataPolygon = dataPoints.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");

  // 좌우 축 라벨이 잘리지 않도록 뷰포트를 양옆으로 45px씩 넓힌다
  const hPad = 45;
  return (
    <svg
      width={size + hPad * 2}
      height={size}
      viewBox={`${-hPad} 0 ${size + hPad * 2} ${size}`}
      role="img"
      aria-label="요소별 점수 레이더 차트"
    >
      {[0.25, 0.5, 0.75, 1].map((ratio) => (
        <polygon
          key={ratio}
          points={polygon(radius * ratio)}
          fill="none"
          stroke="rgba(139, 92, 246, 0.16)"
          strokeWidth={1}
        />
      ))}
      {factors.map((_, i) => {
        const [x, y] = pointAt(i, radius);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(139, 92, 246, 0.16)" strokeWidth={1} />;
      })}

      {allAvailable && (
        <polygon
          points={dataPolygon}
          fill={accent}
          fillOpacity={0.22}
          stroke={accent}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      )}
      {dataPoints.map(([x, y], i) => factors[i].available === false ? null : (
        <circle key={i} cx={x} cy={y} r={4} fill="var(--gdr-card-bg-2)" stroke={accent} strokeWidth={2} />
      ))}

      {factors.map((f, i) => {
        const [x, y] = pointAt(i, radius + 22);
        const cos = Math.cos(angleAt(i));
        const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
        return (
          <text key={f.label} x={x} y={y} textAnchor={anchor} fill={labelColor} fontSize={12}>
            <tspan x={x} dy={-2}>{f.label}</tspan>
            <tspan x={x} dy={15} fill={accent} fontWeight={700}>
              {f.available === false
                ? f.detail?.reason === "현재 규준보다 짧은 발화라 안정적으로 비교하지 않음"
                  ? "문답 길이상 제외"
                  : "측정 불가"
                : f.detail?.score_ceiling === true
                  ? `${f.score}점 · 참조 상단`
                  : `${f.score}점${f.detail?.confidence === "low" || f.detail?.confidence === "moderate" ? " · 참고" : ""}`}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}

// ============================================================================
// 발화/내용 점수 변화 추이 선 그래프 (외부 라이브러리 없이 SVG로 직접 렌더링)
// ============================================================================

const TREND_SPEECH_COLOR = "#8b5cf6";
const TREND_CONTENT_COLOR = "#38bdf8";

function TrendLineChart({
  data,
  onPointClick,
}: {
  data: TrendPoint[];
  /** 지정하면 회차(점) 클릭이 가능해지고, 해당 열에 hover 강조가 표시된다 */
  onPointClick?: (point: TrendPoint, index: number) => void;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 760;
  const height = 320;
  const padTop = 20;
  const padBottom = 46;
  const padLeft = 34;
  // 마지막 회차 라벨("6회차(이번)")이 다른 라벨보다 길어 우측 여백을 넉넉히 둔다
  const padRight = 46;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const n = data.length;
  const colW = n <= 1 ? chartW : chartW / (n - 1);

  const xAt = (i: number) => padLeft + (n === 1 ? chartW / 2 : (chartW * i) / (n - 1));
  const yAt = (score: number) => padTop + chartH * (1 - score / 100);

  const speechScores = data.map((d) => avgOf(d.speechFactors));
  const contentScores = data.map((d) => weightedContentTotal(d.contentFactors));

  const linePath = (scores: number[]) =>
    scores.map((s, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(s).toFixed(1)}`).join(" ");

  // 신호등 등급 구간을 배경 밴드로 깔아 점수가 어느 등급대에 있는지 한눈에 보이게 한다
  const bands = [
    { from: 0, to: 50, color: "#ef4444" },
    { from: 50, to: 85, color: "#facc15" },
    { from: 85, to: 100, color: "#22c55e" },
  ];

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="발화 점수와 내용 점수의 회차별 변화 추이 그래프"
    >
      {bands.map((b) => (
        <rect
          key={b.from}
          x={padLeft}
          y={yAt(b.to)}
          width={chartW}
          height={yAt(b.from) - yAt(b.to)}
          fill={b.color}
          fillOpacity={0.07}
        />
      ))}
      {[0, 20, 40, 60, 80, 100].map((v) => (
        <g key={v}>
          <line x1={padLeft} y1={yAt(v)} x2={width - padRight} y2={yAt(v)} stroke="var(--gdr-border)" strokeWidth={1} />
          <text x={padLeft - 8} y={yAt(v)} dy={4} textAnchor="end" fontSize={10} fill="var(--gdr-text-faint)">
            {v}
          </text>
        </g>
      ))}

      <path d={linePath(contentScores)} fill="none" stroke={TREND_CONTENT_COLOR} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      <path d={linePath(speechScores)} fill="none" stroke={TREND_SPEECH_COLOR} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

      {data.map((d, i) => {
        const lines = d.label.split("\n");
        const hovered = hoverIndex === i;
        return (
          <g
            key={d.date}
            onMouseEnter={() => onPointClick && setHoverIndex(i)}
            onMouseLeave={() => onPointClick && setHoverIndex((h) => (h === i ? null : h))}
            onClick={() => onPointClick?.(d, i)}
            style={{ cursor: onPointClick ? "pointer" : "default" }}
          >
            {onPointClick && (() => {
              // hover 강조 영역이 배경 밴드(등급 구간) 폭을 벗어나지 않도록 양끝 열은 잘라낸다
              const left = Math.max(padLeft, xAt(i) - colW / 2);
              const right = Math.min(padLeft + chartW, xAt(i) + colW / 2);
              return (
                <rect
                  x={left}
                  y={padTop}
                  width={right - left}
                  height={chartH}
                  fill={hovered ? "rgba(139, 92, 246, 0.1)" : "transparent"}
                />
              );
            })()}
            <circle cx={xAt(i)} cy={yAt(contentScores[i])} r={hovered ? 6 : 4} fill="var(--gdr-card-bg-2)" stroke={TREND_CONTENT_COLOR} strokeWidth={2} />
            <circle cx={xAt(i)} cy={yAt(speechScores[i])} r={hovered ? 6 : 4} fill="var(--gdr-card-bg-2)" stroke={TREND_SPEECH_COLOR} strokeWidth={2} />
            <text
              x={xAt(i)}
              y={height - padBottom + 16}
              textAnchor="middle"
              fontSize={10.5}
              fill={hovered ? "#8b5cf6" : "var(--gdr-text-muted)"}
              fontWeight={hovered ? 700 : 400}
            >
              {lines.map((line, li) => (
                <tspan key={li} x={xAt(i)} dy={li === 0 ? 0 : 13}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ============================================================================
// 아이콘 (DramaScenePlayer와 동일한 선형 SVG 톤으로 통일 — 이모지/유니코드 기호 대신 사용)
// ============================================================================

function PlayIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M10 8.5v7l6-3.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}
function SpeakerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 21h14" />
    </svg>
  );
}
function TrendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 17l5-6 4 3 6-8" />
      <path d="M3 21h18" />
    </svg>
  );
}
function ReportIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M9 12h6M9 16h6M9 8h3" />
    </svg>
  );
}
function BackIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

/** 그래프 X축 라벨("1회차\n02/15")을 한 줄 텍스트로 변환 */
function formatTrendLabel(label: string): string {
  return label.split("\n").join(" · ");
}

/** 추이 오버레이·종합 리포트에서 공통으로 쓰는 발화/내용 점수 요약 카드 두 장 */
function renderTrendCards(data: TrendPoint[], theme: "dark" | "light") {
  return (
    <div className="gdr-trend-cards">
      {(["speech", "content"] as const).map((key) => {
        const latest = trendScoreOf(data[data.length - 1], key);
        const delta = trendDelta(data, key);
        const grade = gradeOf(latest);
        const name = key === "speech" ? "발화 점수" : "내용 점수";
        return (
          <div key={key} className="gdr-trend-card">
            <div className="gdr-trend-card-name">{name}</div>
            <div className="gdr-trend-card-score">
              {latest}
              <span className="gdr-tile-unit">점</span>
            </div>
            <div
              className="gdr-tile-grade"
              style={{ color: gradeTextColor(grade, theme), borderColor: `${grade.color}55`, background: `${grade.color}1a` }}
            >
              <span className="gdr-grade-dot" style={{ background: grade.color }} />
              {grade.label}
            </div>
            <div className={`gdr-trend-delta${data.length > 1 && delta > 0 ? " gdr-delta-up" : data.length > 1 && delta < 0 ? " gdr-delta-down" : ""}`}>
              {data.length < 2
                ? "첫 관찰 결과"
                : `지난 검사 대비 ${delta === 0 ? "변화 없음" : `${delta > 0 ? "+" : ""}${delta}점`}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 종합 리포트에 들어가는, 클릭 상호작용 없는 정적 질문 목록 (인쇄/PDF용) */
function renderReportQuestionList(
  questions: ReportQuestion[],
  correctLabel = "영상 속 내용",
) {
  const sorted = [...questions].sort((a, b) => a.rank - b.rank);
  return (
    <ol className="gdr-report-qlist">
      {sorted.map((q) => (
        <li key={q.id} className="gdr-report-qitem">
          <div className="gdr-report-q-meta">
            관찰 질문 {q.rank}
          </div>
          <div className="gdr-report-q-question">{q.question}</div>
          <div className="gdr-report-q-answer gdr-report-q-correct">
            <b>{correctLabel}</b> {q.correctAnswer}
          </div>
          <div className="gdr-report-q-answer">
            <b>사용자 답</b> {q.userAnswer || "음성 인식 실패 — 답변을 확인할 수 없습니다."}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ============================================================================
// 메인 컴포넌트
// ============================================================================

/** [이전]/[다음] 버튼으로 좌우 슬라이드 이동하는 화면 수 */
const SCREEN_COUNT = 4;

type OverlayState =
  | { kind: "category"; category: ScoreCategory }
  | { kind: "trend" }
  | { kind: "session"; point: TrendPoint }
  | { kind: "report" }
  | null;
type QuestionKind = "daily" | "diagnostic";
type ActiveClipState = { timestamp: number; kind: QuestionKind } | null;

export default function GuardianDramaReport({
  patientName = "김순자",
  patientBirthDate,
  report,
}: GuardianDramaReportProps) {
  // 채점 백엔드(ai-rookie)에서 받아온 점수. 백엔드가 꺼져 있거나 실패하면
  // null로 남고, 아래 speechScore/contentScore가 목업 상수로 폴백한다.
  // → 시연 중 API 장애가 화면을 깨뜨리지 않는다.
  const [remote, setRemote] = useState<ReportResponse | null>(report ?? null);
  /** 점수 출처 표시 — 실제 채점인지 목업인지 화면에서 구분하기 위함 */
  const [scoreSource, setScoreSource] = useState<"demo" | "partial" | "scored" | "local">(
    report?.analysisMode ?? "local",
  );

  useEffect(() => {
    let alive = true;
    let loading = false;
    const cacheKey = `memflix-latest-report:${patientName.trim() || "anonymous"}`;
    if (report) {
      setRemote(report);
      setScoreSource(report.analysisMode);
      return () => {
        alive = false;
      };
    }

    const loadLatest = async () => {
      if (loading) return;
      loading = true;
      try {
        // 로컬 캐시에 이전 실패 리포트가 남아 있을 수 있으므로 서버에서 가장 최근에
        // 완료된 세션을 우선 가져온다.
        const r = await fetchLatestReport(patientName);
        if (!alive) return;
        setRemote(r);
        setScoreSource(r.analysisMode);
        window.localStorage.setItem(cacheKey, JSON.stringify(r));
      } catch {
        // 서버가 꺼져 있을 때만 같은 로그인 사용자의 마지막 완료본을 사용한다.
        try {
          const cached = window.localStorage.getItem(cacheKey);
          if (!cached || !alive) return;
          const parsed = JSON.parse(cached) as ReportResponse;
          setRemote(parsed);
          setScoreSource(parsed.analysisMode);
        } catch {
          // 캐시도 읽을 수 없으면 목업 상수 유지
        }
      } finally {
        loading = false;
      }
    };

    void loadLatest();
    // 새 분석이 진행 중일 때 보호자가 먼저 로그인해도 완료되는 즉시 최신 세션으로
    // 자동 교체한다. 사용자가 수동 새로고침 시점을 맞출 필요가 없다.
    const pollTimer = window.setInterval(() => void loadLatest(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(pollTimer);
    };
  }, [patientName, patientBirthDate, report]);

  const speechScore = remote?.speechScore ?? SPEECH_SCORE;
  const contentScore = remote?.contentScore ?? CONTENT_SCORE;
  const displayPatientName = remote?.patientName ?? patientName;
  const displayPatientBirthDate = remote?.patientBirthDate ?? patientBirthDate;
  const remoteQuestions = remote?.questions ?? [];
  const profileQuestions = remoteQuestions.filter((q) => q.id.startsWith("p-"));
  const orientationQuestions = remoteQuestions.filter((q) => q.id.startsWith("o-"));
  const dailyQuestions = remoteQuestions.filter((q) => q.id.startsWith("d") || q.id.startsWith("n"));
  const diagnosticQuestions = remoteQuestions.filter((q) => q.id.startsWith("x"));
  const reflectionQuestions = remoteQuestions.filter((q) => q.id.startsWith("f-"));
  const shownDailyQuestions = dailyQuestions.length ? dailyQuestions : DAILY_QUESTIONS;
  const shownDiagnosticQuestions = diagnosticQuestions.length ? diagnosticQuestions : DIAGNOSTIC_QUESTIONS;
  const backendTrend = remote?.trend ?? [];
  const now = new Date();
  // DB 도입 전에 브라우저에 저장된 실제 리포트에는 trend 필드가 없을 수 있다.
  // 이 경우에도 가짜 과거값은 만들지 않고 현재 실제 결과 한 건만 보여준다.
  const trendData = remote && scoreSource !== "demo"
    ? backendTrend.length > 0
      ? backendTrend
      : [{
          date: now.toISOString(),
          label: `1회차(이번)\n${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`,
          speechFactors: speechScore.factors,
          contentFactors: contentScore.factors,
        }]
    : [];
  const hasUnavailableFactors = [...speechScore.factors, ...contentScore.factors]
    .some((factor) => factor.available === false);
  const sourceLabel = scoreSource === "scored"
    ? hasUnavailableFactors
      ? "실제 녹음 분석 · 일부 항목 측정 제외"
      : "실제 녹음 분석 완료"
    : scoreSource === "partial"
      ? remote?.notice?.includes("시연용 전사")
        ? "실제 녹음 분석 · 일부 답변 시연 전사 사용"
        : "실제 녹음 분석 · 일부 답변 측정 불가"
      : "화면 확인용 예시 데이터";
  const shortExcludedFactors = contentScore.factors.filter((factor) =>
    factor.available !== false
    && (factor.detail?.confidence === "low" || factor.detail?.confidence === "moderate")
  );
  const shortDetail = shortExcludedFactors[0]?.detail;
  const nMorphemes = Number(shortDetail?.n_morphemes ?? 0);
  const referenceMin = Number(shortDetail?.reference_min ?? 0);
  const shortExclusionNotice = shortExcludedFactors.length > 0 && nMorphemes > 0 && referenceMin > 0
    ? `실제 녹음과 응답을 모두 분석했습니다. ${shortExcludedFactors.map((factor) => factor.label).join("·")}은 비교적 짧은 문답에서 계산한 참고 관찰값이므로 신뢰도를 함께 표시합니다.`
    : "";
  // 예전 저장 리포트의 포괄적인 안내도 현재 factor 근거가 있으면 구체적으로
  // 풀어 쓴다. STT 제한이 실제로 있었던 partial 리포트의 고지는 덮지 않는다.
  const resultNotice = scoreSource === "scored" && shortExclusionNotice
    ? shortExclusionNotice
    : remote?.notice || "이 결과는 진단이 아닌 인지 변화 관찰을 위한 참고 자료입니다.";
  const registeredAge = ageFromBirthDate(displayPatientBirthDate);
  const referenceMode = remote?.referenceMode
    ?? (registeredAge !== null && registeredAge >= 60 && registeredAge <= 79
      ? "older_reference"
      : "personal_baseline");
  const personalBaseline = referenceMode === "personal_baseline";
  const referenceNotice = remote?.referenceNotice
    ?? (registeredAge === null
      ? "생년월일이 없어 이번 결과를 개인 변화 관찰의 첫 기준선으로 기록해요."
      : personalBaseline
        ? `만 ${registeredAge}세 · 현재 동일 연령대 참조 규준이 없어 집단 비교 대신 개인 변화 추이를 중심으로 살펴봐요.`
        : `만 ${registeredAge}세 · 현재 60~79세 한국어 참조 범위와 개인 변화 추이를 함께 살펴봐요.`);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return window.localStorage.getItem("gdr-theme") === "light" ? "light" : "dark";
  });
  useEffect(() => {
    window.localStorage.setItem("gdr-theme", theme);
  }, [theme]);

  const [overlay, setOverlay] = useState<OverlayState>(null);
  const [activeClip, setActiveClip] = useState<ActiveClipState>(null);
  const [playingAnswerId, setPlayingAnswerId] = useState<string | null>(null);
  const [screen, setScreen] = useState(0);
  const [exportingPdf, setExportingPdf] = useState(false);
  const dailyVideoRef = useRef<HTMLVideoElement>(null);
  const diagnosticVideoRef = useRef<HTMLVideoElement>(null);
  const clipVideoRefs = { daily: dailyVideoRef, diagnostic: diagnosticVideoRef };
  // [질문] 클릭으로 발생한 최초의 프로그램적 seek을 사용자 탐색과 구분하기 위한 플래그
  const initialSeekRef = useRef(false);
  // PDF로 내보낼 영역 — 종합 리포트 본문만 캡처하고 상단 버튼들은 제외한다
  const reportCaptureRef = useRef<HTMLDivElement>(null);
  // 현재 재생 중인 답변 음성을 멈추는 함수 — playUserAnswerRecording이 반환한 정지 함수를 보관해둔다
  const stopAnswerPlaybackRef = useRef<(() => void) | null>(null);

  // 종합 리포트를 이미지로 캡처해 PDF 파일로 내려받는다.
  // html2canvas/jsPDF는 이 화면에서만 쓰이므로 번들 크기를 위해 클릭 시점에 동적 로드한다.
  const handleExportReportPdf = useCallback(async () => {
    const node = reportCaptureRef.current;
    if (!node || exportingPdf) return;
    setExportingPdf(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);

      // 현재 보고 있는 테마(다크/라이트)와 무관하게 PDF는 항상 화이트 모드로 뽑는다.
      // 실제 화면은 그대로 두고, html2canvas가 렌더링용으로 만드는 사본(clone) 문서에만
      // data-theme="light"를 강제해 라이트 테마 CSS 변수가 적용되게 한다.
      const captureNode = (el: HTMLElement) =>
        html2canvas(el, {
          backgroundColor: "#ffffff",
          scale: 2,
          onclone: (clonedDoc) => {
            clonedDoc.querySelector(".gdr-root")?.setAttribute("data-theme", "light");
          },
        });

      // 리포트를 통째로 캡처해 한 장의 긴 이미지를 자르는 대신, 헤더/점수 요약/추이 섹션/
      // 질문 하나하나를 각각 독립된 이미지로 캡처한다. 이렇게 하면 질문 한 덩어리
      // (.gdr-report-qitem)가 페이지 경계에서 잘릴 일이 아예 없다 — 조각 자체가 이미
      // 하나의 완결된 이미지이기 때문이다.
      const chunkEls: HTMLElement[] = [];
      const header = node.querySelector<HTMLElement>(".gdr-report-header");
      if (header) chunkEls.push(header);
      const source = node.querySelector<HTMLElement>(".gdr-report-source");
      if (source) chunkEls.push(source);
      const advisory = node.querySelector<HTMLElement>(".gdr-report-advisory");
      if (advisory) chunkEls.push(advisory);
      const tiles = node.querySelector<HTMLElement>(".gdr-report-tiles");
      if (tiles) chunkEls.push(tiles);
      node.querySelectorAll<HTMLElement>(".gdr-report-section").forEach((section) => {
        const qitems = Array.from(section.querySelectorAll<HTMLElement>(".gdr-report-qitem"));
        if (qitems.length === 0) {
          // 추이 섹션처럼 안에 질문 목록이 없는 섹션은 통째로 한 조각으로 캡처
          chunkEls.push(section);
          return;
        }
        const heading = section.querySelector<HTMLElement>("h4");
        if (heading) chunkEls.push(heading);
        qitems.forEach((q) => chunkEls.push(q));
      });

      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const marginPt = 24;
      const gapPt = 12;
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pageWidth - marginPt * 2;
      const pageBottomLimit = pageHeight - marginPt;

      let cursorY = marginPt;
      let placedAny = false;
      for (let index = 0; index < chunkEls.length; index += 1) {
        const el = chunkEls[index];
        const canvas = await captureNode(el);
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        let requiredHeight = imgHeight;
        // 섹션 제목 바로 다음에 첫 질문 카드가 오는 경우 둘이 같은 페이지에
        // 들어갈 공간이 있는지 함께 계산한다. 제목만 페이지 아래에 홀로 남는
        // 어색한 PDF 줄바꿈을 막는다.
        if (el.tagName === "H4" && chunkEls[index + 1]) {
          const nextCanvas = await captureNode(chunkEls[index + 1]);
          requiredHeight += gapPt + (nextCanvas.height * imgWidth) / nextCanvas.width;
        }
        if (placedAny && cursorY + requiredHeight > pageBottomLimit) {
          pdf.addPage();
          cursorY = marginPt;
        }
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", marginPt, cursorY, imgWidth, imgHeight);
        cursorY += imgHeight + gapPt;
        placedAny = true;
      }

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      pdf.save(`${displayPatientName}_종합리포트_${today}.pdf`);
    } finally {
      setExportingPdf(false);
    }
  }, [displayPatientName, exportingPdf]);

  // 컴포넌트가 사라질 때 재생 중인 답변 음성 정리
  useEffect(() => {
    return () => stopAnswerPlaybackRef.current?.();
  }, []);

  // [질문] 클릭 → 해당 타임스탬프로 이동해 재생.
  // 소리가 나려면(자동재생 정책) 반드시 클릭 핸들러 안에서 직접 play()를 불러야 한다.
  const handleOpenClip = (q: ReportQuestion, kind: QuestionKind) => {
    (Object.keys(clipVideoRefs) as QuestionKind[]).forEach((k) => {
      if (k !== kind) clipVideoRefs[k].current?.pause();
    });
    const video = clipVideoRefs[kind].current;
    if (video) {
      video.muted = false;
      video.volume = 1;
      initialSeekRef.current = true;
      video.currentTime = q.videoTimestamp;
      void video.play().catch(() => {});
    }
    setActiveClip({ timestamp: q.videoTimestamp, kind });
  };

  const handleCloseClip = (kind: QuestionKind) => {
    clipVideoRefs[kind].current?.pause();
    setActiveClip(null);
  };

  // 질문과 관련된 구간(QUESTION_CLIP_SECONDS)까지만 재생하고 자동 정지.
  // 단, 사용자가 재생바를 직접 옮기거나 자동 정지 후 다시 재생을 누르면
  // "직접 보고 싶다"는 뜻이므로 구간 제한을 해제하고 자유롭게 볼 수 있게 한다.
  useEffect(() => {
    if (!activeClip) return;
    const video = clipVideoRefs[activeClip.kind].current;
    if (!video) return;
    const clipEnd = activeClip.timestamp + QUESTION_CLIP_SECONDS;
    let restricted = true;
    let autoPaused = false;

    const pauseAtClipEnd = () => {
      if (restricted && video.currentTime >= clipEnd) {
        autoPaused = true;
        video.pause();
      }
    };
    const releaseOnUserSeek = () => {
      if (initialSeekRef.current) {
        initialSeekRef.current = false; // [질문] 클릭이 만든 최초 seek은 무시
        return;
      }
      restricted = false;
    };
    const releaseOnResume = () => {
      if (autoPaused) restricted = false;
    };

    video.addEventListener("timeupdate", pauseAtClipEnd);
    video.addEventListener("seeked", releaseOnUserSeek);
    video.addEventListener("play", releaseOnResume);
    return () => {
      video.removeEventListener("timeupdate", pauseAtClipEnd);
      video.removeEventListener("seeked", releaseOnUserSeek);
      video.removeEventListener("play", releaseOnResume);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip]);

  const handlePlayAnswer = useCallback((q: ReportQuestion) => {
    if (!q.recordingUrl) return;
    setPlayingAnswerId((current) => {
      stopAnswerPlaybackRef.current?.();
      stopAnswerPlaybackRef.current = null;
      if (current === q.id) {
        return null;
      }
      stopAnswerPlaybackRef.current = playUserAnswerRecording(q.recordingUrl!, () => {
        stopAnswerPlaybackRef.current = null;
        setPlayingAnswerId(null);
      });
      return q.id;
    });
  }, []);

  // [이전]/[다음] 버튼으로 화면을 좌우 슬라이드 전환.
  // 화면을 떠날 때 재생 중이던 영상·답변 음성은 정리한다.
  const goToScreen = (next: number) => {
    const clamped = Math.max(0, Math.min(SCREEN_COUNT - 1, next));
    if (clamped === screen) return;
    stopAnswerPlaybackRef.current?.();
    stopAnswerPlaybackRef.current = null;
    setPlayingAnswerId(null);
    dailyVideoRef.current?.pause();
    diagnosticVideoRef.current?.pause();
    setActiveClip(null);
    setScreen(clamped);
  };

  // 키보드 ←/→ 로도 이전/다음 화면 이동. 상세창은 Escape로 닫는다.
  // 영상 탐색·입력 중이거나 차트 오버레이가 열려 있을 때는 화면을 넘기지 않는다.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlay) {
        e.preventDefault();
        setOverlay(null);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (overlay) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(target.tagName)) return;
      e.preventDefault();
      goToScreen(screen + (e.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, overlay]);

  // 질문들은 한 화면의 블록 안에 들어가고, 블록 내부를 스크롤하면 다음 질문으로 넘어간다.
  // [질문] 클릭 시 블록이 왼쪽으로 밀리고 오른쪽에 같은 크기의 영상 패널이 열린다.
  const renderQuestionBlock = (questions: ReportQuestion[], kind: QuestionKind) => {
    const sorted = [...questions].sort((a, b) => a.rank - b.rank);
    const clip = activeClip?.kind === kind ? activeClip : null;
    return (
      <div className={`gdr-q-stage${clip ? " gdr-stage-video" : ""}`}>
        <div className="gdr-q-scroller">
        {sorted.map((q, idx) => (
          <div key={q.id} className="gdr-q-slide">
            <div className="gdr-q-card">
              <div className="gdr-q-meta">
                <span className="gdr-rank">
                  관찰 질문 <b>{q.rank}</b>
                </span>
                <div className="gdr-dots" aria-label={`${idx + 1} / ${sorted.length}`}>
                  {sorted.map((_, i) => (
                    <span key={i} className={`gdr-dot${i === idx ? " gdr-dot-active" : ""}`} />
                  ))}
                </div>
              </div>

              <div className="gdr-q-block">
                <button
                  className="gdr-chip gdr-chip-question"
                  onClick={() => handleOpenClip(q, kind)}
                  aria-label="이 질문이 나온 영상 장면 재생"
                >
                  <PlayIcon /> 질문
                </button>
                <p className="gdr-q-text">{q.question}</p>
              </div>

              <div className="gdr-a-block gdr-a-correct">
                <span className="gdr-a-label">
                  <CheckIcon /> 영상 속 내용
                </span>
                <p>{q.correctAnswer}</p>
              </div>

              <div className="gdr-a-block gdr-a-user">
                <button
                  className={`gdr-chip gdr-chip-answer${playingAnswerId === q.id ? " gdr-chip-playing" : ""}`}
                  onClick={() => handlePlayAnswer(q)}
                  disabled={!q.recordingUrl}
                  aria-label={q.recordingUrl ? "사용자의 실제 녹음 재생" : "저장된 녹음 없음"}
                >
                  {playingAnswerId === q.id ? (
                    <>
                      <StopIcon /> 재생 중
                    </>
                  ) : (
                    <>
                      <SpeakerIcon /> 실제 목소리
                    </>
                  )}
                </button>
                <p>{q.userAnswer || "음성 인식 실패 — 답변을 확인할 수 없습니다."}</p>
              </div>

              {idx < sorted.length - 1 && <div className="gdr-scroll-hint">블록을 스크롤하면 다음 질문 ↓</div>}
            </div>
          </div>
        ))}
        </div>

        {/* 오른쪽 영상 패널: [질문] 클릭 시 열리고, 질문 블록과 같은 크기로 나란히 표시.
            클릭 시점에 video 요소가 이미 존재해야 소리 있는 재생이 허용되므로 항상 마운트해 둔다 */}
        <div className="gdr-video-panel" aria-hidden={!clip}>
          <div className="gdr-video-head">
            <span className="gdr-video-title">
              <PlayIcon /> 질문이 나온 장면
            </span>
            <button className="gdr-close-btn" onClick={() => handleCloseClip(kind)} aria-label="영상 닫기">
              <CloseIcon />
            </button>
          </div>
          <video
            ref={clipVideoRefs[kind]}
            className="gdr-panel-video"
            src={VIDEO_SRC}
            controls
            playsInline
            preload="metadata"
          />
          <div className="gdr-video-note">
            질문과 관련된 {QUESTION_CLIP_SECONDS}초 구간만 재생 후 멈춰요 · 재생바를 움직이면 자유롭게 볼 수 있어요
          </div>
        </div>
      </div>
    );
  };

  const renderOrientationBlock = (questions: ReportQuestion[]) => (
    <div className="gdr-q-stage">
      <div className="gdr-q-scroller">
        {questions.length === 0 ? (
          <div className="gdr-q-slide">
            <div className="gdr-q-card gdr-orientation-empty">
              이번 기록에는 시청 전 날짜·요일·장소 문답이 없어요.
            </div>
          </div>
        ) : questions.map((q, idx) => (
          <div key={q.id} className="gdr-q-slide">
            <div className="gdr-q-card">
              <div className="gdr-q-meta">
                <span className="gdr-rank">시청 전 문답 <b>{idx + 1}</b></span>
                <div className="gdr-dots" aria-label={`${idx + 1} / ${questions.length}`}>
                  {questions.map((_, dotIndex) => (
                    <span key={dotIndex} className={`gdr-dot${dotIndex === idx ? " gdr-dot-active" : ""}`} />
                  ))}
                </div>
              </div>
              <div className="gdr-q-block">
                <span className="gdr-chip gdr-chip-question">안부 질문</span>
                <p className="gdr-q-text">{q.question}</p>
              </div>
              <div className="gdr-a-block gdr-a-correct">
                <span className="gdr-a-label"><CheckIcon /> 확인 기준</span>
                <p>{q.correctAnswer}</p>
              </div>
              <div className="gdr-a-block gdr-a-user">
                <button
                  className={`gdr-chip gdr-chip-answer${playingAnswerId === q.id ? " gdr-chip-playing" : ""}`}
                  onClick={() => handlePlayAnswer(q)}
                  disabled={!q.recordingUrl}
                  aria-label={q.recordingUrl ? "사용자의 실제 녹음 재생" : "저장된 녹음 없음"}
                >
                  {playingAnswerId === q.id ? <><StopIcon /> 재생 중</> : <><SpeakerIcon /> 실제 목소리</>}
                </button>
                <p>{q.userAnswer || "음성 인식 실패 — 실제 목소리로 확인해 주세요."}</p>
              </div>
              {idx < questions.length - 1 && <div className="gdr-scroll-hint">블록을 스크롤하면 다음 질문 ↓</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const overlayAccent = theme === "dark" ? "#a78bfa" : "#6d28d9";

  return (
    <div className="gdr-root" data-theme={theme}>
      <style>{STYLES}</style>

      <button
        type="button"
        className="gdr-theme-toggle"
        onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        aria-label={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>

      {/* 좌우 슬라이드 트랙: [이전]/[다음] 버튼으로 화면 단위 이동 */}
      <div className="gdr-track" style={{ transform: `translateX(-${screen * 100}%)` }}>

      {/* ================= 화면 1 · 점수 요약 ================= */}
      <section className="gdr-section gdr-summary">
        <header className="gdr-header">
          <div className="gdr-header-kicker">보호자 리포트</div>
          <h1 className="gdr-header-title">
            {displayPatientName} 님의 이번 관찰 결과
          </h1>
          {displayPatientBirthDate && formatBirthWithAge(displayPatientBirthDate) && (
            <div className="gdr-header-sub">{formatBirthWithAge(displayPatientBirthDate)}</div>
          )}
        </header>

        <div className={`gdr-source-banner gdr-source-${scoreSource}`} role="status">
          <b>{sourceLabel}</b>
          <span>{resultNotice}</span>
        </div>

        <div className="gdr-reference-note">
          <b>{personalBaseline ? "개인 변화 관찰" : "연령 참조 범위"}</b>
          <span>{referenceNotice}</span>
        </div>

        <div className="gdr-advisory-note">
          <b>전문가 자문 기반 설계</b>
          <span>질문 구성과 결과 표현은 관련 분야 전문가의 자문을 받아 설계했으며, 의료적 진단을 대신하지 않습니다.</span>
        </div>

        <div className="gdr-tiles">
          {[speechScore, contentScore].map((cat) => {
            const { available, total, grade } = categoryDisplay(cat, personalBaseline);
            const measuredCount = cat.factors.filter((factor) => factor.available !== false).length;
            return (
              <div
                key={cat.key}
                className={`gdr-tile${overlay?.kind === "category" && overlay.category.key === cat.key ? " gdr-tile-active" : ""}`}
                onClick={() => setOverlay({ kind: "category", category: cat })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setOverlay({ kind: "category", category: cat })}
              >
                <div className="gdr-tile-name">{cat.name}</div>
                <div className="gdr-tile-total">
                  {available ? total : "—"}
                  {available && <span className="gdr-tile-unit">점</span>}
                </div>
                <div
                  className="gdr-tile-grade"
                  style={{ color: gradeTextColor(grade, theme), borderColor: `${grade.color}55`, background: `${grade.color}1a` }}
                >
                  <span className="gdr-grade-dot" style={{ background: grade.color }} />
                  {grade.label}
                </div>
                <div className="gdr-tile-desc">{cat.description}</div>
                <div className="gdr-tile-hint">
                  {measuredCount < cat.factors.length
                    ? `${cat.factors.length}개 중 ${measuredCount}개 항목 기준 · 상세 사유 보기`
                    : "클릭하면 상세 차트가 열려요"}
                </div>
              </div>
            );
          })}
        </div>

        <div className="gdr-summary-actions">
          <button
            type="button"
            className="gdr-secondary-btn"
            disabled={trendData.length === 0}
            onClick={() => setOverlay({ kind: "trend" })}
          >
            <TrendIcon /> {trendData.length === 0
              ? "검사 이력 없음"
              : trendData.length === 1
                ? "첫 관찰 결과 보기"
                : "점수 변화 추이 보기"}
          </button>
          <button type="button" className="gdr-secondary-btn" onClick={() => setOverlay({ kind: "report" })}>
            <ReportIcon /> 종합 리포트 보기
          </button>
        </div>

        <div className="gdr-scroll-hint">아래 [다음] 버튼을 누르면 질문별 상세 결과가 나와요 →</div>
      </section>

      {/* ================= 화면 2 · 시청 전 지남력 문답 ================= */}
      <section className="gdr-section gdr-part-section">
        <div className="gdr-part-head">
          <h2 className="gdr-part-title">시청 전 기본 정보·날짜·장소 문답</h2>
          <p className="gdr-part-desc">
            로그인 직후 편안한 안부 대화로 오늘의 날짜·요일과 현재 장소를 확인했어요.
            답변 텍스트와 <b>실제 녹음 목소리</b>를 함께 살펴볼 수 있어요.
          </p>
        </div>
        {renderOrientationBlock([...profileQuestions, ...orientationQuestions])}
      </section>

      {/* ================= 화면 3 · 미디어 일상 질문 ================= */}
      <section className="gdr-section gdr-part-section">
        <div className="gdr-part-head">
          <h2 className="gdr-part-title">일상 내용 질문</h2>
          <p className="gdr-part-desc">
            영상에 대한 일상적이고 간단한 질문이에요. 답변 결과는 <b>발화 점수</b>에 더 큰 영향을 줘요.
            답변에서 확인된 객관적 관찰 근거를 질문별로 보여드려요.
          </p>
        </div>
        {renderQuestionBlock(shownDailyQuestions, "daily")}
      </section>

      {/* ================= 화면 4 · 회상 확인 질문 ================= */}
      <section className="gdr-section gdr-part-section">
        <div className="gdr-part-head">
          <h2 className="gdr-part-title">회상 확인 질문</h2>
          <p className="gdr-part-desc">
            기억 회상과 이해력을 확인하는 질문이에요. 답변 결과는 <b>발화 점수와 내용 점수 모두</b>에 영향을 줘요.
          </p>
        </div>
        {renderQuestionBlock(shownDiagnosticQuestions, "diagnostic")}
      </section>

      </div>

      {/* 하단 [이전]/[다음] 화면 내비게이션 */}
      <nav className="gdr-nav" aria-label="리포트 화면 이동">
        <button
          className="gdr-nav-btn"
          onClick={() => goToScreen(screen - 1)}
          disabled={screen === 0}
        >
          ‹ 이전
        </button>
        <span className="gdr-nav-status">
          {screen + 1} / {SCREEN_COUNT}
        </span>
        <button
          className="gdr-nav-btn"
          onClick={() => goToScreen(screen + 1)}
          disabled={screen === SCREEN_COUNT - 1}
        >
          다음 ›
        </button>
      </nav>

      {/* ================= 오버레이: 카테고리 상세 / 추이 / 회차 상세 / 종합 리포트 ================= */}
      {overlay && (
        <div
          className="gdr-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="보호자 리포트 상세"
          onClick={(e) => e.target === e.currentTarget && setOverlay(null)}
        >
          {overlay.kind === "category" && (() => {
            const category = overlay.category;
            const { available, total, grade } = categoryDisplay(category, personalBaseline);
            return (
              <div className="gdr-overlay-card">
                <div className="gdr-overlay-head">
                  <div>
                    <div className="gdr-overlay-title">{category.name} 상세</div>
                    <div className="gdr-overlay-total">
                      총점 <b className="gdr-overlay-total-num">{available ? `${total}점` : "측정 불가"}</b>
                      <span
                        className="gdr-tile-grade gdr-overlay-grade"
                        style={{ color: gradeTextColor(grade, theme), borderColor: `${grade.color}55`, background: `${grade.color}1a` }}
                      >
                        <span className="gdr-grade-dot" style={{ background: grade.color }} />
                        {grade.label}
                      </span>
                    </div>
                  </div>
                  <button className="gdr-close-btn" onClick={() => setOverlay(null)} aria-label="차트 닫기">
                    <CloseIcon />
                  </button>
                </div>

                <div className="gdr-overlay-body">
                  <RadarChart factors={category.factors} accent={overlayAccent} />
                  <div className="gdr-overlay-summary">
                    <div className="gdr-overlay-summary-title">{category.name.replace(" 점수", "")} 영역 관찰 요약</div>
                    <p>{summarizeCategory(category, total, personalBaseline)}</p>
                  </div>
                </div>
              </div>
            );
          })()}

          {overlay.kind === "trend" && (
            <div className="gdr-overlay-card">
              <div className="gdr-overlay-head">
                <div>
                  <div className="gdr-overlay-title">{trendData.length < 2 ? "첫 관찰 결과" : "점수 변화 추이"}</div>
                  <div className="gdr-overlay-total">
                    {trendData.length < 2
                      ? "첫 번째 실제 관찰 결과예요. 다음 검사부터 변화 추이가 이어져요."
                      : "사용할 때마다 발화·내용 점수가 어떻게 변해왔는지 보여드려요"}
                  </div>
                </div>
                <button className="gdr-close-btn" onClick={() => setOverlay(null)} aria-label="닫기">
                  <CloseIcon />
                </button>
              </div>

              <div className="gdr-trend-legend">
                <span className="gdr-legend-item">
                  <i style={{ background: TREND_SPEECH_COLOR }} /> 발화 점수
                </span>
                <span className="gdr-legend-item">
                  <i style={{ background: TREND_CONTENT_COLOR }} /> 내용 점수
                </span>
              </div>

              <div className="gdr-trend-chart-wrap">
                <TrendLineChart data={trendData} onPointClick={(point) => setOverlay({ kind: "session", point })} />
              </div>
              <div className="gdr-trend-hint">
                {trendData.length < 2
                  ? "첫 관찰 결과의 점수를 보여드려요"
                  : "회차(점)를 클릭하면 그 날 검사의 상세 결과를 볼 수 있어요"}
              </div>

              {renderTrendCards(trendData, theme)}
            </div>
          )}

          {overlay.kind === "session" && (() => {
            const point = overlay.point;
            const speechTotal = avgOf(point.speechFactors);
            const contentTotal = weightedContentTotal(point.contentFactors);
            return (
              <div className="gdr-overlay-card">
                <div className="gdr-overlay-head">
                  <div>
                    <button
                      type="button"
                      className="gdr-back-btn"
                      onClick={() => setOverlay({ kind: "trend" })}
                    >
                      <BackIcon /> 추이로 돌아가기
                    </button>
                    <div className="gdr-overlay-title">{formatTrendLabel(point.label)} 검사 상세</div>
                  </div>
                  <button className="gdr-close-btn" onClick={() => setOverlay(null)} aria-label="닫기">
                    <CloseIcon />
                  </button>
                </div>

                <div className="gdr-session-grid">
                  {[
                    { name: "발화 점수", factors: point.speechFactors, total: speechTotal },
                    { name: "내용 점수", factors: point.contentFactors, total: contentTotal },
                  ].map((c) => {
                    const grade = gradeOf(c.total);
                    return (
                      <div key={c.name} className="gdr-session-col">
                        <div className="gdr-overlay-total">
                          {c.name} <b className="gdr-overlay-total-num">{c.total}점</b>
                          <span
                            className="gdr-tile-grade gdr-overlay-grade"
                            style={{ color: gradeTextColor(grade, theme), borderColor: `${grade.color}55`, background: `${grade.color}1a` }}
                          >
                            <span className="gdr-grade-dot" style={{ background: grade.color }} />
                            {grade.label}
                          </span>
                        </div>
                        <RadarChart factors={c.factors} accent={overlayAccent} size={220} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {overlay.kind === "report" && (
            <div className="gdr-overlay-card gdr-overlay-card-report">
              <div className="gdr-overlay-head">
                <div className="gdr-overlay-title">종합 리포트</div>
                <div className="gdr-report-actions">
                  <button
                    type="button"
                    className="gdr-pdf-btn"
                    onClick={handleExportReportPdf}
                    disabled={exportingPdf}
                  >
                    <DownloadIcon /> {exportingPdf ? "PDF 생성 중…" : "PDF로 저장"}
                  </button>
                  <button className="gdr-close-btn" onClick={() => setOverlay(null)} aria-label="닫기">
                    <CloseIcon />
                  </button>
                </div>
              </div>

              <div className="gdr-report" ref={reportCaptureRef}>
                <header className="gdr-report-header">
                  <div className="gdr-header-kicker">보호자 종합 리포트</div>
                  <h3>{displayPatientName} 님의 이번 관찰 결과</h3>
                  {displayPatientBirthDate && formatBirthWithAge(displayPatientBirthDate) && (
                    <div className="gdr-header-sub">{formatBirthWithAge(displayPatientBirthDate)}</div>
                  )}
                </header>

                <div className={`gdr-report-source gdr-source-${scoreSource}`}>
                  <b>{sourceLabel}</b>
                  <span>{resultNotice}</span>
                </div>

                <div className="gdr-report-advisory">
                  <b>{personalBaseline ? "개인 변화 관찰" : "연령 참조 범위"}</b>
                  <span>{referenceNotice}</span>
                </div>

                <div className="gdr-report-advisory">
                  <b>전문가 자문 기반 설계</b>
                  <span>질문 구성과 결과 표현은 관련 분야 전문가의 자문을 받아 설계했으며, 의료적 진단을 대신하지 않습니다.</span>
                </div>

                <div className="gdr-report-tiles">
                  {[speechScore, contentScore].map((cat) => {
                    const { available, total, grade } = categoryDisplay(cat, personalBaseline);
                    const measuredCount = cat.factors.filter((factor) => factor.available !== false).length;
                    return (
                      <div key={cat.key} className="gdr-report-tile">
                        <div className="gdr-report-tile-head">
                          <span className="gdr-tile-name">{cat.name}</span>
                          <span
                            className="gdr-tile-grade"
                            style={{ color: gradeTextColor(grade, theme), borderColor: `${grade.color}55`, background: `${grade.color}1a` }}
                          >
                            <span className="gdr-grade-dot" style={{ background: grade.color }} />
                            {available
                              ? `${grade.label} · ${total}점 (${measuredCount}/${cat.factors.length}개 항목)`
                              : "측정 불가"}
                          </span>
                        </div>
                        <RadarChart factors={cat.factors} accent={overlayAccent} size={220} labelColor="var(--gdr-text-secondary)" />
                        <p className="gdr-report-tile-summary">{summarizeCategory(cat, total, personalBaseline)}</p>
                      </div>
                    );
                  })}
                </div>

                <section className="gdr-report-section">
                  <h4>{trendData.length < 2 ? "첫 관찰 결과" : "점수 변화 추이"}</h4>
                  <div className="gdr-trend-legend">
                    <span className="gdr-legend-item">
                      <i style={{ background: TREND_SPEECH_COLOR }} /> 발화 점수
                    </span>
                    <span className="gdr-legend-item">
                      <i style={{ background: TREND_CONTENT_COLOR }} /> 내용 점수
                    </span>
                  </div>
                  <div className="gdr-trend-chart-wrap">
                    <TrendLineChart data={trendData} />
                  </div>
                </section>

                <section className="gdr-report-section">
                  <h4>시청 전 생일 확인</h4>
                  {renderReportQuestionList(profileQuestions, "등록 생년월일")}
                </section>

                <section className="gdr-report-section">
                  <h4>시청 전 날짜·장소 문답</h4>
                  {renderReportQuestionList(orientationQuestions, "확인 기준")}
                </section>

                <section className="gdr-report-section">
                  <h4>일상 내용 질문 결과</h4>
                  {renderReportQuestionList(shownDailyQuestions)}
                </section>

                <section className="gdr-report-section">
                  <h4>회상 확인 질문 결과</h4>
                  {renderReportQuestionList(shownDiagnosticQuestions)}
                </section>

                {reflectionQuestions.length > 0 && (
                  <section className="gdr-report-section">
                    <h4>영상 감상 자유대화</h4>
                    {renderReportQuestionList(reflectionQuestions, "정답이 없는 자유 감상")}
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// ============================================================================
// 스타일 (블랙 배경 + 퍼플 포인트 — 치매 인식 캠페인 색상. 경중 표시는 신호등 색)
// ============================================================================
const STYLES = `
.gdr-root {
  --gdr-bg: #000;
  --gdr-text: #fff;
  --gdr-card-bg: #141414;
  --gdr-card-bg-2: #0d0d0d;
  --gdr-card-bg-3: #1b1b1b;
  --gdr-border: #2a2a2a;
  --gdr-border-2: #262626;
  --gdr-text-secondary: #ddd;
  --gdr-text-muted: #999;
  --gdr-text-muted-2: #aaa;
  --gdr-text-muted-3: #bbb;
  --gdr-text-faint: #888;
  --gdr-text-faint-2: #8a8a8a;
  --gdr-text-faint-3: #ccc;
  --gdr-accent-text: #c4b5fd;
  --gdr-accent-strong: #a78bfa;
  --gdr-status-good: #86efac;
  --gdr-status-warn: #fde047;
  --gdr-status-demo: #fdba74;
  --gdr-shadow-soft: rgba(0, 0, 0, 0.3);
  --gdr-shadow-med: rgba(0, 0, 0, 0.35);
  --gdr-shadow-strong: rgba(0, 0, 0, 0.7);
  --gdr-nav-bg: rgba(13, 13, 13, 0.88);
  --gdr-close-bg: rgba(255, 255, 255, 0.12);
  --gdr-overlay-backdrop: rgba(0, 0, 0, 0.78);
  --gdr-scrollbar-thumb: #3a3a3a;
  --gdr-chip-neutral-bg: #333;
  --gdr-chip-neutral-text: #fff;
  --gdr-disabled-bg: #222;
  --gdr-disabled-text: #555;
  --gdr-heading-grad-start: #ffffff;

  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--gdr-bg);
  color: var(--gdr-text);
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
}
.gdr-root[data-theme="light"] {
  --gdr-bg: #f6f4fb;
  --gdr-text: #1a1a2e;
  --gdr-card-bg: #ffffff;
  --gdr-card-bg-2: #f1eef9;
  --gdr-card-bg-3: #eeecf5;
  --gdr-border: #e3e0ee;
  --gdr-border-2: #e8e5f1;
  --gdr-text-secondary: #333;
  --gdr-text-muted: #666;
  --gdr-text-muted-2: #666;
  --gdr-text-muted-3: #555;
  --gdr-text-faint: #666;
  --gdr-text-faint-2: #666;
  --gdr-text-faint-3: #555;
  --gdr-accent-text: #6d28d9;
  --gdr-accent-strong: #6d28d9;
  --gdr-status-good: #166534;
  --gdr-status-warn: #854d0e;
  --gdr-status-demo: #9a3412;
  --gdr-shadow-soft: rgba(139, 92, 246, 0.12);
  --gdr-shadow-med: rgba(139, 92, 246, 0.16);
  --gdr-shadow-strong: rgba(80, 60, 120, 0.22);
  --gdr-nav-bg: rgba(255, 255, 255, 0.9);
  --gdr-close-bg: rgba(0, 0, 0, 0.06);
  --gdr-overlay-backdrop: rgba(255, 255, 255, 0.72);
  --gdr-scrollbar-thumb: #cfc9e6;
  --gdr-chip-neutral-bg: #e9e6f3;
  --gdr-chip-neutral-text: #2a2a2a;
  --gdr-disabled-bg: #e5e2ee;
  --gdr-disabled-text: #aaa;
  --gdr-heading-grad-start: #2a1a52;
}

.gdr-root button:focus-visible,
.gdr-root [role="button"]:focus-visible {
  outline: 3px solid var(--gdr-accent-strong);
  outline-offset: 3px;
}

.gdr-theme-toggle {
  position: absolute;
  top: 18px;
  right: 18px;
  z-index: 200;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--gdr-border);
  background: var(--gdr-card-bg);
  color: var(--gdr-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.gdr-theme-toggle:hover {
  border-color: #8b5cf6;
  color: #8b5cf6;
}

/* 화면들을 가로로 나란히 놓고 translateX로 좌우 슬라이드 */
.gdr-track {
  display: flex;
  width: 100%;
  height: 100%;
  transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

.gdr-section {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px 84px;
  box-sizing: border-box;
}

/* ---------- 화면 1: 점수 요약 ---------- */
.gdr-summary {
  background: var(--gdr-bg);
}
.gdr-header {
  text-align: center;
  margin-bottom: 44px;
  animation: gdr-fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.gdr-header-kicker {
  color: #8b5cf6;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.14em;
  margin-bottom: 12px;
}
.gdr-header-title {
  margin: 0 0 10px;
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, var(--gdr-heading-grad-start) 15%, #c4b5fd 65%, #8b5cf6 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.gdr-root[data-theme="light"] .gdr-header-title {
  background: none;
  -webkit-background-clip: initial;
  background-clip: initial;
  color: var(--gdr-text);
}
.gdr-header-sub {
  color: var(--gdr-text-muted);
  font-size: 14px;
}
.gdr-source-banner {
  width: min(820px, 92vw);
  margin: 0 auto 18px;
  padding: 12px 16px;
  border: 1px solid var(--gdr-border);
  border-radius: 12px;
  background: var(--gdr-card-bg-3);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--gdr-text-secondary);
  font-size: 14px;
  line-height: 1.5;
  text-align: center;
}
.gdr-source-banner b { color: var(--gdr-accent-text); white-space: nowrap; }
.gdr-advisory-note {
  width: min(820px, 92vw);
  margin: -6px auto 18px;
  padding: 11px 16px;
  border-radius: 12px;
  border: 1px solid rgba(139, 92, 246, 0.32);
  background: rgba(139, 92, 246, 0.08);
  display: flex;
  justify-content: center;
  gap: 10px;
  color: var(--gdr-text-muted);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}
.gdr-advisory-note b { color: var(--gdr-accent-text); white-space: nowrap; }
.gdr-reference-note {
  width: min(900px, 92vw); display: flex; gap: 14px; align-items: center;
  margin: -4px auto 18px; padding: 13px 18px; box-sizing: border-box;
  border: 1px solid var(--gdr-border); border-radius: 14px;
  background: var(--gdr-card-bg); color: var(--gdr-text-secondary);
  font-size: 14px; line-height: 1.55;
}
.gdr-reference-note b { color: var(--gdr-accent-text); white-space: nowrap; }
.gdr-source-scored { border-color: rgba(34, 197, 94, 0.45); }
.gdr-source-scored b { color: var(--gdr-status-good); }
.gdr-source-partial { border-color: rgba(250, 204, 21, 0.45); }
.gdr-source-partial b { color: var(--gdr-status-warn); }
.gdr-source-demo,
.gdr-source-local { border-color: rgba(251, 146, 60, 0.45); }
.gdr-source-demo b,
.gdr-source-local b { color: var(--gdr-status-demo); }

@keyframes gdr-fade-up {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}

.gdr-tiles {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  justify-content: center;
}
.gdr-tile {
  width: 300px;
  padding: 30px 28px;
  border-radius: 18px;
  border: 1px solid transparent;
  background:
    linear-gradient(var(--gdr-card-bg), var(--gdr-card-bg)) padding-box,
    linear-gradient(135deg, rgba(167, 139, 250, 0.4), rgba(255, 255, 255, 0.05) 45%, rgba(139, 92, 246, 0.18) 100%) border-box;
  box-shadow: 0 10px 28px var(--gdr-shadow-soft);
  cursor: pointer;
  text-align: center;
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  animation: gdr-fade-up 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: 0.06s;
}
.gdr-tile:nth-child(2) {
  animation-delay: 0.14s;
}
.gdr-tile:hover,
.gdr-tile-active {
  transform: translateY(-6px);
  box-shadow: 0 16px 40px rgba(139, 92, 246, 0.24);
  background:
    linear-gradient(var(--gdr-card-bg), var(--gdr-card-bg)) padding-box,
    linear-gradient(135deg, #a78bfa, rgba(255, 255, 255, 0.1) 45%, #8b5cf6 100%) border-box;
}
.gdr-tile-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--gdr-text-secondary);
}
.gdr-tile-total {
  font-size: 64px;
  font-weight: 800;
  line-height: 1.15;
  margin: 8px 0 2px;
  background: linear-gradient(135deg, var(--gdr-heading-grad-start) 0%, #c4b5fd 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.gdr-root[data-theme="light"] .gdr-tile-total {
  background: none;
  -webkit-background-clip: initial;
  background-clip: initial;
  color: var(--gdr-text);
}
.gdr-tile-unit {
  font-size: 22px;
  font-weight: 600;
  margin-left: 4px;
  color: var(--gdr-text-faint);
}
.gdr-tile-grade {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 700;
  margin: 4px 0 14px;
  padding: 5px 13px;
  border-radius: 999px;
  border: 1px solid;
}
.gdr-grade-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.gdr-tile-desc {
  font-size: 13px;
  color: var(--gdr-text-muted);
  line-height: 1.5;
}
.gdr-tile-hint {
  margin-top: 16px;
  font-size: 11.5px;
  color: var(--gdr-text-faint);
}

.gdr-scroll-hint {
  margin-top: 36px;
  color: var(--gdr-text-faint-2);
  font-size: 12.5px;
  text-align: center;
  animation: gdr-bob 2s ease-in-out infinite;
}
@keyframes gdr-bob {
  0%, 100% { transform: translateY(0); opacity: 0.7; }
  50% { transform: translateY(5px); opacity: 1; }
}

/* ---------- 하단 [이전]/[다음] 화면 내비게이션 ---------- */
.gdr-nav {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  border-radius: 999px;
  background: var(--gdr-nav-bg);
  border: 1px solid var(--gdr-border);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.gdr-nav-btn {
  border: none;
  border-radius: 999px;
  padding: 9px 20px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  background: linear-gradient(135deg, #a78bfa, #7c3aed);
  color: #fff;
  transition: filter 0.15s ease;
}
.gdr-nav-btn:hover:not(:disabled) {
  filter: brightness(1.12);
}
.gdr-nav-btn:disabled {
  background: var(--gdr-disabled-bg);
  color: var(--gdr-disabled-text);
  cursor: default;
}
.gdr-nav-status {
  min-width: 44px;
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--gdr-text-faint-3);
}

/* ---------- 화면 2: 레이더 차트 오버레이 ---------- */
.gdr-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--gdr-overlay-backdrop);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.gdr-overlay-card {
  width: min(720px, 92vw);
  max-height: 88vh;
  overflow-y: auto;
  border-radius: 18px;
  border: 1px solid transparent;
  background:
    linear-gradient(var(--gdr-card-bg), var(--gdr-card-bg)) padding-box,
    linear-gradient(135deg, rgba(167, 139, 250, 0.4), rgba(255, 255, 255, 0.05) 50%, rgba(139, 92, 246, 0.15) 100%) border-box;
  box-shadow: 0 24px 70px var(--gdr-shadow-strong);
  padding: 24px 28px;
  animation: gdr-fade-up 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.gdr-overlay-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.gdr-overlay-title {
  font-size: 20px;
  font-weight: 800;
}
.gdr-overlay-total {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  font-size: 14px;
  color: var(--gdr-text-muted-3);
}
.gdr-overlay-total-num {
  background: linear-gradient(135deg, var(--gdr-heading-grad-start) 0%, #c4b5fd 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-size: 17px;
}
.gdr-overlay-grade {
  margin: 0;
}
.gdr-overlay-body {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  justify-content: center;
}
.gdr-overlay-summary {
  flex: 1;
  min-width: 220px;
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(139, 92, 246, 0.08);
  border: 1px solid rgba(139, 92, 246, 0.25);
}
.gdr-overlay-summary-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--gdr-accent-text);
  text-decoration: underline;
  text-underline-offset: 3px;
  margin-bottom: 8px;
}
.gdr-overlay-summary p {
  margin: 0;
  color: var(--gdr-text-secondary);
  font-size: 13.5px;
  line-height: 1.7;
  word-break: keep-all;
}
.gdr-overlay-hint {
  margin-top: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--gdr-text-faint);
}

.gdr-close-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--gdr-close-bg);
  color: var(--gdr-text);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}
.gdr-close-btn:hover {
  background: #8b5cf6;
}

/* ---------- 화면 3·4: 질문 섹션 (헤더 + 내부 스크롤 블록) ---------- */
.gdr-part-section {
  background: var(--gdr-bg);
  justify-content: flex-start;
  padding: 52px 24px 84px; /* 하단 여백은 [이전]/[다음] 내비게이션 자리 */
  gap: 16px;
}
.gdr-part-head {
  text-align: center;
}
.gdr-part-title {
  margin: 0 0 10px;
  font-size: 26px;
  font-weight: 800;
}
.gdr-part-title::after {
  content: "";
  display: block;
  width: 48px;
  height: 4px;
  border-radius: 2px;
  background: #8b5cf6;
  margin: 10px auto 0;
}
.gdr-part-desc {
  color: var(--gdr-text-muted-2);
  font-size: 13.5px;
  line-height: 1.7;
  max-width: 620px;
  margin: 0;
}

/* 무대: 질문 블록 + (열렸을 때) 영상 패널을 나란히 배치.
   섹션에서 헤더를 뺀 나머지 공간을 전부 차지한다 */
.gdr-q-stage {
  display: flex;
  align-items: stretch;
  justify-content: center;
  width: min(1400px, 96vw);
  flex: 1 1 auto;
  min-height: 0;
}

/* 질문 블록: 이 블록 내부를 스크롤하면 다음 질문으로 스냅 이동 */
.gdr-q-scroller {
  width: min(980px, 94vw);
  height: 100%;
  flex-shrink: 0;
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  scroll-behavior: smooth;
  border-radius: 18px;
  border: 1px solid var(--gdr-border);
  background: var(--gdr-card-bg-2);
  transition: width 0.35s ease;
  scrollbar-width: thin;
  scrollbar-color: var(--gdr-scrollbar-thumb) transparent;
}
.gdr-q-scroller::-webkit-scrollbar {
  width: 6px;
}
.gdr-q-scroller::-webkit-scrollbar-track {
  background: transparent;
}
.gdr-q-scroller::-webkit-scrollbar-thumb {
  background: var(--gdr-scrollbar-thumb);
  border-radius: 3px;
}
.gdr-q-scroller::-webkit-scrollbar-thumb:hover {
  background: #8b5cf6;
}
.gdr-orientation-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--gdr-text-muted);
  font-size: 17px;
  text-align: center;
}

/* 영상이 열리면 블록이 왼쪽으로 밀리고 오른쪽 패널이 같은 크기로 등장 */
.gdr-stage-video .gdr-q-scroller {
  width: min(680px, 47vw);
}
.gdr-video-panel {
  width: 0;
  opacity: 0;
  margin-left: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 18px;
  border: 1px solid transparent;
  background: var(--gdr-card-bg-2);
  transition: width 0.35s ease, opacity 0.3s ease, margin-left 0.35s ease;
}
.gdr-stage-video .gdr-video-panel {
  width: min(680px, 47vw);
  opacity: 1;
  margin-left: 18px;
  border-color: var(--gdr-border);
}
.gdr-video-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
}
.gdr-video-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--gdr-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gdr-panel-video {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
  background: #000;
}
.gdr-video-note {
  padding: 10px 14px;
  font-size: 11.5px;
  color: var(--gdr-text-faint-2);
  text-align: center;
}
.gdr-q-slide {
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  box-sizing: border-box;
}
/* 카드 하나 = 질문 하나. 슬라이드 전체를 꽉 채운다 */
.gdr-q-card {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-radius: 18px;
  border: 1px solid transparent;
  background:
    linear-gradient(var(--gdr-card-bg), var(--gdr-card-bg)) padding-box,
    linear-gradient(135deg, rgba(139, 92, 246, 0.35), rgba(255, 255, 255, 0.04) 50%, rgba(139, 92, 246, 0.12) 100%) border-box;
  box-shadow: 0 20px 50px var(--gdr-shadow-med);
  padding: 32px 42px;
  box-sizing: border-box;
  animation: gdr-fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.gdr-q-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 28px;
  flex-wrap: wrap;
}
.gdr-rank {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 700;
  color: var(--gdr-accent-text);
  background: linear-gradient(135deg, rgba(167, 139, 250, 0.22), rgba(139, 92, 246, 0.1));
  border: 1px solid rgba(139, 92, 246, 0.4);
  padding: 5px 14px;
  border-radius: 999px;
}
.gdr-rank b {
  color: var(--gdr-accent-strong);
  font-size: 15px;
  margin-left: 4px;
}
.gdr-dots {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
}
.gdr-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gdr-scrollbar-thumb);
  transition: background 0.2s ease, transform 0.2s ease;
}
.gdr-dot-active {
  background: #8b5cf6;
  transform: scale(1.35);
}
.gdr-impact-num {
  margin-left: 9px;
  padding-left: 9px;
  border-left: 1px solid rgba(139, 92, 246, 0.4);
  font-size: 12.5px;
  color: var(--gdr-accent-strong);
  font-weight: 700;
}

.gdr-q-block {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 22px;
}
.gdr-q-text {
  margin: 5px 0 0;
  font-size: 23px;
  font-weight: 700;
  line-height: 1.45;
  word-break: keep-all;
}

.gdr-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: none;
  border-radius: 999px;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
  white-space: nowrap;
}
.gdr-chip:hover {
  transform: scale(1.05);
}
.gdr-chip-question {
  background: #8b5cf6;
  color: #fff;
}
.gdr-chip-question:hover {
  background: #a78bfa;
}
.gdr-chip-answer {
  background: var(--gdr-chip-neutral-bg);
  color: var(--gdr-chip-neutral-text);
}
.gdr-chip-answer:hover {
  background: #8b5cf6;
}
.gdr-chip-playing {
  background: #8b5cf6;
  animation: gdr-pulse 1.1s ease-in-out infinite;
}
@keyframes gdr-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.5); }
  50% { box-shadow: 0 0 0 10px rgba(139, 92, 246, 0); }
}

.gdr-a-block {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 18px 22px;
  border-radius: 14px;
  background: var(--gdr-card-bg-3);
  margin-bottom: 14px;
}
.gdr-a-block p {
  margin: 5px 0 0;
  font-size: 16.5px;
  line-height: 1.6;
  color: var(--gdr-text-secondary);
  word-break: keep-all;
}
.gdr-a-correct {
  border: 1.5px solid #8b5cf6;
}
.gdr-a-label {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--gdr-accent-strong);
  padding: 8px 4px;
}
.gdr-q-card .gdr-scroll-hint {
  margin-top: 26px;
}

/* ---------- 화면 1: 요약 화면 하단 보조 버튼 (추이 보기 / 종합 리포트 보기) ---------- */
.gdr-summary-actions {
  display: flex;
  gap: 14px;
  margin-top: 28px;
  flex-wrap: wrap;
  justify-content: center;
}
.gdr-secondary-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(139, 92, 246, 0.4);
  border-radius: 999px;
  padding: 10px 22px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--gdr-text-secondary);
  background: var(--gdr-card-bg);
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
}
.gdr-secondary-btn:hover:not(:disabled) {
  border-color: #8b5cf6;
  color: #8b5cf6;
  transform: translateY(-1px);
}
.gdr-secondary-btn:disabled {
  cursor: default;
  opacity: 0.55;
}

.gdr-pdf-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(139, 92, 246, 0.4);
  border-radius: 999px;
  padding: 9px 20px;
  font-size: 13.5px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #a78bfa, #7c3aed);
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.15s ease;
  white-space: nowrap;
}
.gdr-pdf-btn:hover:not(:disabled) {
  filter: brightness(1.12);
  transform: translateY(-1px);
}
.gdr-pdf-btn:disabled {
  background: var(--gdr-disabled-bg);
  color: var(--gdr-disabled-text);
  border-color: transparent;
  cursor: default;
}

.gdr-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 0 0 8px;
  margin: 0;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--gdr-accent-strong);
  cursor: pointer;
}
.gdr-back-btn:hover {
  color: #8b5cf6;
}

/* ---------- 오버레이 공용: 추이 차트 · 요약 카드 ---------- */
.gdr-trend-hint {
  margin-top: 6px;
  text-align: center;
  font-size: 12px;
  color: var(--gdr-text-faint);
}
.gdr-trend-legend {
  display: flex;
  justify-content: center;
  gap: 22px;
  margin-bottom: 6px;
}
.gdr-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--gdr-text-secondary);
}
.gdr-legend-item i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.gdr-trend-chart-wrap {
  width: 100%;
}
.gdr-trend-cards {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 8px;
}
.gdr-trend-card {
  width: 220px;
  padding: 18px 20px;
  border-radius: 14px;
  background: var(--gdr-card-bg-3);
  border: 1px solid var(--gdr-border-2);
  text-align: center;
}
.gdr-trend-card-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--gdr-text-secondary);
}
.gdr-trend-card-score {
  font-size: 36px;
  font-weight: 800;
  margin: 6px 0 8px;
  color: var(--gdr-text);
}
.gdr-trend-delta {
  margin-top: 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--gdr-text-muted);
}
.gdr-delta-up {
  color: #22c55e;
}
.gdr-delta-down {
  color: #ef4444;
}

/* ---------- 오버레이: 회차별 검사 상세 (레이더 차트 2개) ---------- */
.gdr-session-grid {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  justify-content: center;
}
.gdr-session-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

/* ---------- 오버레이: 종합 리포트 (요약 + 추이 + 질문 상세를 모은 인쇄/PDF용 화면) ---------- */
.gdr-overlay-card-report {
  width: min(920px, 95vw);
  max-height: 90vh;
}
.gdr-report-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.gdr-report {
  display: flex;
  flex-direction: column;
  gap: 30px;
  padding-top: 6px;
}
.gdr-report-header {
  text-align: center;
}
.gdr-report-header h3 {
  margin: 6px 0 4px;
  font-size: 22px;
  font-weight: 800;
  color: var(--gdr-text);
}
.gdr-report-source {
  width: 100%;
  padding: 12px 16px;
  border-radius: 10px;
  border: 1px solid var(--gdr-border-2);
  background: var(--gdr-card-bg-3);
  color: var(--gdr-text-muted-2);
  font-size: 12.5px;
  line-height: 1.55;
  text-align: center;
}
.gdr-report-source b {
  display: block;
  margin-bottom: 3px;
  color: var(--gdr-text);
}
.gdr-report-advisory {
  width: 100%;
  padding: 11px 16px;
  border-radius: 10px;
  border: 1px solid rgba(139, 92, 246, 0.3);
  background: rgba(139, 92, 246, 0.07);
  color: var(--gdr-text-muted-2);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
.gdr-report-advisory b {
  color: var(--gdr-text);
  margin-right: 8px;
}
.gdr-report-tiles {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  justify-content: center;
}
.gdr-report-tile {
  flex: 1 1 320px;
  max-width: 380px;
  padding: 20px 22px;
  border-radius: 14px;
  background: var(--gdr-card-bg-3);
  border: 1px solid var(--gdr-border-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.gdr-report-tile-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.gdr-report-tile-summary {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--gdr-text-muted-2);
  word-break: keep-all;
}
.gdr-report-section {
  border-top: 1px solid var(--gdr-border);
  padding-top: 22px;
}
.gdr-report-section h4 {
  margin: 0 0 16px;
  text-align: center;
  font-size: 16px;
  font-weight: 800;
  color: var(--gdr-text);
}
.gdr-report-qlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gdr-report-qitem {
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--gdr-card-bg-3);
  border: 1px solid var(--gdr-border-2);
}
.gdr-report-q-meta {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--gdr-accent-strong);
  margin-bottom: 6px;
}
.gdr-report-q-question {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 8px;
  word-break: keep-all;
}
.gdr-report-q-answer {
  font-size: 13px;
  line-height: 1.6;
  color: var(--gdr-text-secondary);
  word-break: keep-all;
}
.gdr-report-q-answer b {
  color: var(--gdr-text-muted);
  font-weight: 700;
  margin-right: 6px;
}
.gdr-report-q-correct b {
  color: var(--gdr-accent-strong);
}

`;
