import { useCallback, useEffect, useRef, useState } from "react";
import { playVarcoTts, GRANDMA_ANSWER_VOICE_ID } from "../lib/varcoTts";
import { ORIENTATION_QUESTIONS } from "../lib/orientationQuestions";
import { PERSONA } from "../shared/pet/persona";

// ============================================================================
// 타입 정의
// ============================================================================

export interface ScoreFactor {
  /** 레이더 차트 축 이름 */
  label: string;
  /** 0~100 점수 */
  score: number;
}

export interface ScoreCategory {
  // "play" 는 Phase D(놀이 지표)의 자리다. 지금 데이터는 없지만 유니온을 미리 열어 둬
  // 나중에 타입부터 고쳐야 하는 상황을 피한다. 화면은 달라지지 않는다.
  key: "speech" | "content" | "play";
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
  /**
   * 이 질문이 나온 영상 시점(초) — [질문] 클릭 시 이 지점부터 재생.
   * 안부 대화와 놀이 신호에는 영상 시점이 없으므로 optional 이다.
   */
  videoTimestamp?: number;
}

export interface GuardianDramaReportProps {
  /** 리포트 상단에 표시할 대상자 이름 */
  patientName?: string;
  /** 대상자 생년월일 (YYYY-MM-DD) — 있으면 헤더에 나이와 함께 표시 */
  patientBirthDate?: string;
  /**
   * 점수 타일보다 위에 놓을 '오늘 웃었던 순간' 카드.
   * 보호자가 숫자보다 먼저 대화 한 조각을 보게 하려는 자리다 (검토 4.4절 8번).
   * 넘기지 않으면 아무것도 렌더되지 않아 기존 리포트가 그대로 유지된다.
   */
  momentCard?: React.ReactNode;
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

/** 검사에 사용된 드라마 영상 (public/videos/H231141.mp4) */
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

/** 회차별 발화/내용 점수 변화 추이 — 실제 서비스에서는 검사 이력 API에서 받아온다.
 * 마지막 점(6회차)은 SPEECH_SCORE/CONTENT_SCORE의 요소를 그대로 참조해 이번 검사 결과와 항상 일치시킨다. */
export const SCORE_TREND: TrendPoint[] = [
  {
    date: "2026-02-15",
    label: "1회차\n02/15",
    speechFactors: [
      { label: "버벅임", score: 74 },
      { label: "침묵 시간", score: 68 },
      { label: "발화 속도", score: 78 },
      { label: "발음 정확도", score: 82 },
      { label: "문장 완성도", score: 76 },
    ],
    contentFactors: [
      { label: "단어 수준", score: 78 },
      { label: "문맥 일치도", score: 72 },
      { label: "기억 정확도", score: 68 },
      { label: "시간·장소 지남력", score: 70 },
      { label: "논리 연결", score: 74 },
    ],
  },
  {
    date: "2026-03-15",
    label: "2회차\n03/15",
    speechFactors: [
      { label: "버벅임", score: 70 },
      { label: "침묵 시간", score: 64 },
      { label: "발화 속도", score: 75 },
      { label: "발음 정확도", score: 80 },
      { label: "문장 완성도", score: 72 },
    ],
    contentFactors: [
      { label: "단어 수준", score: 74 },
      { label: "문맥 일치도", score: 68 },
      { label: "기억 정확도", score: 63 },
      { label: "시간·장소 지남력", score: 66 },
      { label: "논리 연결", score: 71 },
    ],
  },
  {
    date: "2026-04-19",
    label: "3회차\n04/19",
    speechFactors: [
      { label: "버벅임", score: 65 },
      { label: "침묵 시간", score: 59 },
      { label: "발화 속도", score: 72 },
      { label: "발음 정확도", score: 78 },
      { label: "문장 완성도", score: 68 },
    ],
    contentFactors: [
      { label: "단어 수준", score: 71 },
      { label: "문맥 일치도", score: 65 },
      { label: "기억 정확도", score: 58 },
      { label: "시간·장소 지남력", score: 62 },
      { label: "논리 연결", score: 68 },
    ],
  },
  {
    date: "2026-05-24",
    label: "4회차\n05/24",
    speechFactors: [
      { label: "버벅임", score: 61 },
      { label: "침묵 시간", score: 55 },
      { label: "발화 속도", score: 70 },
      { label: "발음 정확도", score: 75 },
      { label: "문장 완성도", score: 65 },
    ],
    contentFactors: [
      { label: "단어 수준", score: 67 },
      { label: "문맥 일치도", score: 61 },
      { label: "기억 정확도", score: 53 },
      { label: "시간·장소 지남력", score: 57 },
      { label: "논리 연결", score: 64 },
    ],
  },
  {
    date: "2026-06-21",
    label: "5회차\n06/21",
    speechFactors: [
      { label: "버벅임", score: 56 },
      { label: "침묵 시간", score: 50 },
      { label: "발화 속도", score: 67 },
      { label: "발음 정확도", score: 73 },
      { label: "문장 완성도", score: 61 },
    ],
    contentFactors: [
      { label: "단어 수준", score: 64 },
      { label: "문맥 일치도", score: 58 },
      { label: "기억 정확도", score: 48 },
      { label: "시간·장소 지남력", score: 53 },
      { label: "논리 연결", score: 61 },
    ],
  },
  {
    date: "2026-07-20",
    label: "6회차(이번)\n07/20",
    speechFactors: SPEECH_SCORE.factors,
    contentFactors: CONTENT_SCORE.factors,
  },
];

/** 일상 내용 질문 — 내용 점수보다 발화 점수에 더 큰 영향을 주는 변수.
 * 사용자 체험 화면(App)의 질문·답도 이 데이터에서 만들어 보호자 리포트와 항상 일치시킨다. */
export const DAILY_QUESTIONS: ReportQuestion[] = [
  {
    id: "d1",
    rank: 1,
    impact: 85,
    question: "저 남자 대학 가요제에서 몇등했대요?",
    correctAnswer: "제2회 대학가요제에서 대상(1등)을 받았다.",
    userAnswer: "글쎄요… 1등이었나? 등수는 잘 기억이 안 나네요.",
    videoTimestamp: 188,
  },
  {
    id: "d2",
    rank: 2,
    impact: 70,
    question: "저 부부는 언제 만났대요? 완전 잉꼬부부시다.",
    correctAnswer: "대학교 1학년 때 캠퍼스 커플로 만나 지금까지 45년째 함께하고 있다.",
    userAnswer: "음… 만난 지 얼마 안 됐다고 했던 것 같은데, 잘 모르겠어요.",
    videoTimestamp: 275,
  },
];

/** 진단용 질문 — 발화 점수와 내용 점수 모두에 영향을 주는 변수 */
export const DIAGNOSTIC_QUESTIONS: ReportQuestion[] = [
  {
    id: "x1",
    rank: 1,
    impact: 90,
    question: "남자를 여고생들이 따라 다닌 이유가 뭐라고 했어요?",
    correctAnswer: "대학가요제에서 대상을 받고 유명해져서(부산 시민들이 다 알아볼 정도의 '부산 대세남'이 되어서) 여고생들이 따라다녔다.",
    userAnswer: "그냥 인기가 많았대요… 왜 그런지는 모르겠어요.",
    videoTimestamp: 265,
  },
  {
    id: "x2",
    rank: 2,
    impact: 75,
    question: "저 남자는 왜 지붕위에 올라가있는거에요?",
    correctAnswer: "자신이 직접 지은 트리하우스(아지트)의 지붕을 보수하기 위해 올라가 있다.",
    userAnswer: "글쎄요, 그냥 구경하러 올라간 거 아니에요?",
    videoTimestamp: 365,
  },
];

/** 로그인 챗봇의 지남력 문진을 리포트 표시용으로 매핑 — 영상이 없으므로 videoTimestamp 없음.
 *  주의: App.tsx의 USER_QUESTIONS(영상 플레이어 질문)로 새어 들어가지 않도록 export 하지
 *  않고 DAILY/DIAGNOSTIC_QUESTIONS에도 합치지 않는다. */
const ORIENTATION_REPORT_QUESTIONS = ORIENTATION_QUESTIONS.map((o) => ({
  id: o.id,
  rank: o.rank,
  categoryLabel: o.categoryLabel,
  question: o.question,
  correctAnswer: o.correctAnswer,
  // 리포트의 "사용자 답" = 로그인 챗봇의 시뮬레이션 답변
  userAnswer: o.simulatedAnswer,
}));

// ============================================================================
// 재생 시뮬레이션 영역
// 실제 서비스에서는 검사 중 녹음된 사용자 답변 음성 파일(URL)을 <audio>로
// 재생하도록 이 함수를 교체한다. 데모에서는 NCSOFT VARCO Voice TTS API로
// 답변 텍스트를 어르신 목소리로 합성해 재생하는 것으로 대신한다.
// ============================================================================
function playUserAnswerRecording(answerText: string, onEnd: () => void): () => void {
  return playVarcoTts(answerText, GRANDMA_ANSWER_VOICE_ID, onEnd);
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

function avgOf(factors: ScoreFactor[]): number {
  const sum = factors.reduce((acc, f) => acc + f.score, 0);
  return Math.round(sum / factors.length);
}

function totalOf(category: ScoreCategory): number {
  return avgOf(category.factors);
}

/** 경중 표시는 신호등 색: 초록(양호) → 노랑(위험) → 빨강(심각) */
function gradeOf(total: number): { label: string; color: string } {
  if (total >= 75) return { label: "양호", color: "#22c55e" };
  if (total >= 55) return { label: "위험", color: "#facc15" };
  return { label: "심각", color: "#ef4444" };
}

/** 배지 글씨 색: 라이트 모드(그리고 항상 화이트인 PDF)는 검정, 다크 모드는 등급 색 그대로 */
function gradeTextColor(grade: { color: string }, theme: "dark" | "light"): string {
  return theme === "dark" ? grade.color : "#1a1a1a";
}

/** 레이더 차트 옆에 보여줄, 해당 영역 결과를 한두 문장으로 요약 */
function summarizeCategory(category: ScoreCategory, total: number): string {
  const grade = gradeOf(total);
  const [weakest, second] = [...category.factors].sort((a, b) => a.score - b.score);
  return `${weakest.label}(${weakest.score}점), ${second.label}(${second.score}점) 항목에서 특히 낮은 점수가 나왔어요. 전반적으로 ${grade.label} 수준으로 평가돼요.`;
}

/** 특정 회차의 발화/내용 총점 */
function trendScoreOf(point: TrendPoint, key: "speech" | "content"): number {
  return avgOf(key === "speech" ? point.speechFactors : point.contentFactors);
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

      <polygon
        points={dataPolygon}
        fill={accent}
        fillOpacity={0.22}
        stroke={accent}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {dataPoints.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={4} fill="var(--gdr-card-bg-2)" stroke={accent} strokeWidth={2} />
      ))}

      {factors.map((f, i) => {
        const [x, y] = pointAt(i, radius + 22);
        const cos = Math.cos(angleAt(i));
        const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
        return (
          <text key={f.label} x={x} y={y} textAnchor={anchor} fill={labelColor} fontSize={12}>
            <tspan x={x} dy={-2}>{f.label}</tspan>
            <tspan x={x} dy={15} fill={accent} fontWeight={700}>{f.score}점</tspan>
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
  const contentScores = data.map((d) => avgOf(d.contentFactors));

  const linePath = (scores: number[]) =>
    scores.map((s, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(s).toFixed(1)}`).join(" ");

  // 신호등 등급 구간을 배경 밴드로 깔아 점수가 어느 등급대에 있는지 한눈에 보이게 한다
  const bands = [
    { from: 0, to: 55, color: "#ef4444" },
    { from: 55, to: 75, color: "#facc15" },
    { from: 75, to: 100, color: "#22c55e" },
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
            <div className={`gdr-trend-delta${delta > 0 ? " gdr-delta-up" : delta < 0 ? " gdr-delta-down" : ""}`}>
              지난 검사 대비 {delta === 0 ? "변화 없음" : `${delta > 0 ? "+" : ""}${delta}점`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 종합 리포트에 들어가는, 클릭 상호작용 없는 정적 질문 목록 (인쇄/PDF용) */
function renderReportQuestionList(questions: ReportQuestion[]) {
  const sorted = [...questions].sort((a, b) => a.rank - b.rank);
  return (
    <ol className="gdr-report-qlist">
      {sorted.map((q) => (
        <li key={q.id} className="gdr-report-qitem">
          <div className="gdr-report-q-meta">
            치매 의심 근거 기여도 {q.rank}위 · {q.impact}%
          </div>
          <div className="gdr-report-q-question">{q.question}</div>
          <div className="gdr-report-q-answer gdr-report-q-correct">
            <b>모범답안</b> {q.correctAnswer}
          </div>
          <div className="gdr-report-q-answer">
            <b>사용자 답</b> {q.userAnswer}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 종합 리포트의 지남력 문진 목록 — 기여도 대신 지남력 분류를 메타로 표시한다.
 *  .gdr-report-qitem 클래스 규약을 따르므로 PDF 내보내기의 항목 단위 분할이 그대로 적용된다 */
function renderOrientationReportList() {
  const sorted = [...ORIENTATION_REPORT_QUESTIONS].sort((a, b) => a.rank - b.rank);
  return (
    <ol className="gdr-report-qlist">
      {sorted.map((q) => (
        <li key={q.id} className="gdr-report-qitem">
          <div className="gdr-report-q-meta">지남력 문진 · {q.categoryLabel}</div>
          <div className="gdr-report-q-question">{q.question}</div>
          <div className="gdr-report-q-answer gdr-report-q-correct">
            <b>기준 답안</b> {q.correctAnswer}
          </div>
          <div className="gdr-report-q-answer">
            <b>사용자 답</b> {q.userAnswer}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ============================================================================
// 메인 컴포넌트
// ============================================================================

/** [이전]/[다음] 버튼으로 좌우 슬라이드 이동하는 화면 수 (요약 → 지남력 문진 → 일상 질문 → 진단 질문) */
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
  momentCard,
}: GuardianDramaReportProps) {
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
      for (const el of chunkEls) {
        const canvas = await captureNode(el);
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        if (placedAny && cursorY + imgHeight > pageBottomLimit) {
          pdf.addPage();
          cursorY = marginPt;
        }
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", marginPt, cursorY, imgWidth, imgHeight);
        cursorY += imgHeight + gapPt;
        placedAny = true;
      }

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      pdf.save(`${patientName}_종합리포트_${today}.pdf`);
    } finally {
      setExportingPdf(false);
    }
  }, [exportingPdf, patientName]);

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
    // 안부 대화와 놀이 신호에는 영상 시점이 없다. 그런 항목은 재생할 클립이 없으므로
    // 조용히 넘어간다 — 호출부에서도 [질문] 버튼을 숨긴다.
    const timestamp = q.videoTimestamp;
    if (timestamp === undefined) return;

    const video = clipVideoRefs[kind].current;
    if (video) {
      video.muted = false;
      video.volume = 1;
      initialSeekRef.current = true;
      video.currentTime = timestamp;
      void video.play().catch(() => {});
    }
    setActiveClip({ timestamp, kind });
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

  // ReportQuestion 외에 지남력 문진 항목도 재생할 수 있도록 필요한 필드만 받는다
  const handlePlayAnswer = useCallback((q: { id: string; userAnswer: string }) => {
    setPlayingAnswerId((current) => {
      stopAnswerPlaybackRef.current?.();
      stopAnswerPlaybackRef.current = null;
      if (current === q.id) {
        return null;
      }
      stopAnswerPlaybackRef.current = playUserAnswerRecording(q.userAnswer, () => {
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

  // 키보드 ←/→ 로도 이전/다음 화면 이동.
  // 영상 탐색·입력 중이거나 차트 오버레이가 열려 있을 때는 화면을 넘기지 않는다.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
                  치매 의심 근거 기여도 <b>{q.rank}위</b>
                  <span className="gdr-impact-num">{q.impact}%</span>
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
                  <CheckIcon /> 모범답안
                </span>
                <p>{q.correctAnswer}</p>
              </div>

              <div className="gdr-a-block gdr-a-user">
                <button
                  className={`gdr-chip gdr-chip-answer${playingAnswerId === q.id ? " gdr-chip-playing" : ""}`}
                  onClick={() => handlePlayAnswer(q)}
                  aria-label="사용자의 녹음된 답변 재생"
                >
                  {playingAnswerId === q.id ? (
                    <>
                      <StopIcon /> 재생 중
                    </>
                  ) : (
                    <>
                      <SpeakerIcon /> 사용자 답
                    </>
                  )}
                </button>
                <p>{q.userAnswer}</p>
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

  // 지남력 문진 카드 — 로그인 대화라 영상 클립이 없으므로 renderQuestionBlock과 달리
  // [▶ 질문] 버튼·영상 패널 없이 같은 카드 스타일만 재사용한다.
  const renderOrientationBlock = () => {
    const sorted = [...ORIENTATION_REPORT_QUESTIONS].sort((a, b) => a.rank - b.rank);
    return (
      <div className="gdr-q-stage">
        <div className="gdr-q-scroller">
          {sorted.map((q, idx) => (
            <div key={q.id} className="gdr-q-slide">
              <div className="gdr-q-card">
                <div className="gdr-q-meta">
                  <span className="gdr-rank">
                    지남력 문진 <b>{q.categoryLabel}</b>
                  </span>
                  <div className="gdr-dots" aria-label={`${idx + 1} / ${sorted.length}`}>
                    {sorted.map((_, i) => (
                      <span key={i} className={`gdr-dot${i === idx ? " gdr-dot-active" : ""}`} />
                    ))}
                  </div>
                </div>

                <div className="gdr-q-block">
                  <span className="gdr-chip gdr-chip-question gdr-chip-static">질문</span>
                  <p className="gdr-q-text">{q.question}</p>
                </div>

                <div className="gdr-a-block gdr-a-correct">
                  <span className="gdr-a-label">
                    <CheckIcon /> 기준 답안
                  </span>
                  <p>{q.correctAnswer}</p>
                </div>

                <div className="gdr-a-block gdr-a-user">
                  <button
                    className={`gdr-chip gdr-chip-answer${playingAnswerId === q.id ? " gdr-chip-playing" : ""}`}
                    onClick={() => handlePlayAnswer(q)}
                    aria-label="사용자의 녹음된 답변 재생"
                  >
                    {playingAnswerId === q.id ? (
                      <>
                        <StopIcon /> 재생 중
                      </>
                    ) : (
                      <>
                        <SpeakerIcon /> 사용자 답
                      </>
                    )}
                  </button>
                  <p>{q.userAnswer}</p>
                </div>

                {idx < sorted.length - 1 && <div className="gdr-scroll-hint">블록을 스크롤하면 다음 질문 ↓</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const overlayAccent = "#8b5cf6";

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
            {patientName} 님의 검사 결과
          </h1>
          {patientBirthDate && formatBirthWithAge(patientBirthDate) && (
            <div className="gdr-header-sub">{formatBirthWithAge(patientBirthDate)}</div>
          )}
        </header>

        {momentCard}

        <div className="gdr-tiles">
          {[SPEECH_SCORE, CONTENT_SCORE].map((cat) => {
            const total = totalOf(cat);
            const grade = gradeOf(total);
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
                  {total}
                  <span className="gdr-tile-unit">점</span>
                </div>
                <div
                  className="gdr-tile-grade"
                  style={{ color: gradeTextColor(grade, theme), borderColor: `${grade.color}55`, background: `${grade.color}1a` }}
                >
                  <span className="gdr-grade-dot" style={{ background: grade.color }} />
                  {grade.label}
                </div>
                <div className="gdr-tile-desc">{cat.description}</div>
                <div className="gdr-tile-hint">클릭하면 상세 차트가 열려요</div>
              </div>
            );
          })}
        </div>

        <div className="gdr-summary-actions">
          <button type="button" className="gdr-secondary-btn" onClick={() => setOverlay({ kind: "trend" })}>
            <TrendIcon /> 점수 변화 추이 보기
          </button>
          <button type="button" className="gdr-secondary-btn" onClick={() => setOverlay({ kind: "report" })}>
            <ReportIcon /> 종합 리포트 보기
          </button>
        </div>

        <div className="gdr-scroll-hint">아래 [다음] 버튼을 누르면 질문별 상세 결과가 나와요 →</div>
      </section>

      {/* ================= 화면 2 · 지남력 문진 (로그인 대화) ================= */}
      <section className="gdr-section gdr-part-section">
        <div className="gdr-part-head">
          <h2 className="gdr-part-title">안부 대화</h2>
          <p className="gdr-part-desc">
            하루를 시작할 때 {PERSONA.defaultPetName}가 일상 안부처럼 나눈 대화예요. 오늘의 <b>시간·장소·사람</b>을 얼마나
            정확히 인지하고 있는지(지남력)를 확인하며, 결과는 <b>내용 점수의 시간·장소 지남력</b> 항목에 반영돼요.
          </p>
        </div>
        {renderOrientationBlock()}
      </section>

      {/* ================= 화면 3 · 일상 내용 질문 ================= */}
      <section className="gdr-section gdr-part-section">
        <div className="gdr-part-head">
          <h2 className="gdr-part-title">일상 내용 질문</h2>
          <p className="gdr-part-desc">
            영상에 대한 일상적이고 간단한 질문이에요. 답변 결과는 <b>발화 점수</b>에 더 큰 영향을 줘요.
            치매 의심 판단의 근거로 쓰인 정도가 큰 질문부터 보여드려요.
          </p>
        </div>
        {renderQuestionBlock(DAILY_QUESTIONS, "daily")}
      </section>

      {/* ================= 화면 4 · 진단용 질문 ================= */}
      <section className="gdr-section gdr-part-section">
        <div className="gdr-part-head">
          <h2 className="gdr-part-title">진단용 질문</h2>
          <p className="gdr-part-desc">
            기억 회상과 이해력을 확인하는 질문이에요. 답변 결과는 <b>발화 점수와 내용 점수 모두</b>에 영향을 줘요.
          </p>
        </div>
        {renderQuestionBlock(DIAGNOSTIC_QUESTIONS, "diagnostic")}
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
        <div className="gdr-overlay" onClick={(e) => e.target === e.currentTarget && setOverlay(null)}>
          {overlay.kind === "category" && (() => {
            const category = overlay.category;
            const total = totalOf(category);
            const grade = gradeOf(total);
            return (
              <div className="gdr-overlay-card">
                <div className="gdr-overlay-head">
                  <div>
                    <div className="gdr-overlay-title">{category.name} 상세</div>
                    <div className="gdr-overlay-total">
                      총점 <b className="gdr-overlay-total-num">{total}점</b>
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
                    <div className="gdr-overlay-summary-title">{category.name.replace(" 점수", "")}파트 진단 요약</div>
                    <p>{summarizeCategory(category, total)}</p>
                  </div>
                </div>
              </div>
            );
          })()}

          {overlay.kind === "trend" && (
            <div className="gdr-overlay-card">
              <div className="gdr-overlay-head">
                <div>
                  <div className="gdr-overlay-title">점수 변화 추이</div>
                  <div className="gdr-overlay-total">검사를 받을 때마다 발화·내용 점수가 어떻게 변해왔는지 보여드려요</div>
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
                <TrendLineChart data={SCORE_TREND} onPointClick={(point) => setOverlay({ kind: "session", point })} />
              </div>
              <div className="gdr-trend-hint">회차(점)를 클릭하면 그 날 검사의 상세 결과를 볼 수 있어요</div>

              {renderTrendCards(SCORE_TREND, theme)}
            </div>
          )}

          {overlay.kind === "session" && (() => {
            const point = overlay.point;
            const speechTotal = avgOf(point.speechFactors);
            const contentTotal = avgOf(point.contentFactors);
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
                  <h3>{patientName} 님의 검사 결과</h3>
                  {patientBirthDate && formatBirthWithAge(patientBirthDate) && (
                    <div className="gdr-header-sub">{formatBirthWithAge(patientBirthDate)}</div>
                  )}
                </header>

                <div className="gdr-report-tiles">
                  {[SPEECH_SCORE, CONTENT_SCORE].map((cat) => {
                    const total = totalOf(cat);
                    const grade = gradeOf(total);
                    return (
                      <div key={cat.key} className="gdr-report-tile">
                        <div className="gdr-report-tile-head">
                          <span className="gdr-tile-name">{cat.name}</span>
                          <span
                            className="gdr-tile-grade"
                            style={{ color: "#1a1a1a", borderColor: `${grade.color}55`, background: `${grade.color}1a` }}
                          >
                            <span className="gdr-grade-dot" style={{ background: grade.color }} />
                            {grade.label} · {total}점
                          </span>
                        </div>
                        <RadarChart factors={cat.factors} accent={overlayAccent} size={220} labelColor="#1a1a1a" />
                        <p className="gdr-report-tile-summary">{summarizeCategory(cat, total)}</p>
                      </div>
                    );
                  })}
                </div>

                <section className="gdr-report-section">
                  <h4>점수 변화 추이</h4>
                  <div className="gdr-trend-legend">
                    <span className="gdr-legend-item">
                      <i style={{ background: TREND_SPEECH_COLOR }} /> 발화 점수
                    </span>
                    <span className="gdr-legend-item">
                      <i style={{ background: TREND_CONTENT_COLOR }} /> 내용 점수
                    </span>
                  </div>
                  <div className="gdr-trend-chart-wrap">
                    <TrendLineChart data={SCORE_TREND} />
                  </div>
                </section>

                <section className="gdr-report-section">
                  <h4>지남력 문진 결과 (로그인 대화)</h4>
                  {renderOrientationReportList()}
                </section>

                <section className="gdr-report-section">
                  <h4>일상 내용 질문 결과</h4>
                  {renderReportQuestionList(DAILY_QUESTIONS)}
                </section>

                <section className="gdr-report-section">
                  <h4>진단용 질문 결과</h4>
                  {renderReportQuestionList(DIAGNOSTIC_QUESTIONS)}
                </section>
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
  --gdr-text-faint: #666;
  --gdr-text-faint-2: #777;
  --gdr-text-faint-3: #ccc;
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
  --gdr-text-faint: #888;
  --gdr-text-faint-2: #888;
  --gdr-text-faint-3: #555;
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
  color: #c4b5fd;
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
  color: #c4b5fd;
  background: linear-gradient(135deg, rgba(167, 139, 250, 0.22), rgba(139, 92, 246, 0.1));
  border: 1px solid rgba(139, 92, 246, 0.4);
  padding: 5px 14px;
  border-radius: 999px;
}
.gdr-rank b {
  color: #7c3aed;
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
  color: #a78bfa;
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
/* 지남력 문진 카드의 질문 라벨 — 영상 클립이 없어 클릭할 수 없는 정적 칩 */
.gdr-chip-static {
  cursor: default;
  pointer-events: none;
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
  color: #a78bfa;
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
.gdr-secondary-btn:hover {
  border-color: #8b5cf6;
  color: #8b5cf6;
  transform: translateY(-1px);
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
  color: #a78bfa;
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
  color: #a78bfa;
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
  color: #a78bfa;
}

`;
