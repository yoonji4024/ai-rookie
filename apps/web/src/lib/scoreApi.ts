/**
 * 채점 백엔드(ai-rookie) 클라이언트.
 *
 * 백엔드가 프론트의 타입(ScoreFactor / ScoreCategory / ReportQuestion)을 그대로
 * 반환하므로 변환이 필요 없다. 축 이름도 양쪽이 동일하다.
 *
 * 백엔드 실행:
 *   cd ../ai-rookie && python3 -m uvicorn src.api.server:app --port 8000
 *
 * 호출 경로는 /api/score/* — vite dev 프록시가 백엔드로 중계한다.
 * API 키는 백엔드에만 있고 브라우저로 내려오지 않는다.
 */

import type {
  ReportQuestion,
  ScoreCategory,
  TrendPoint,
} from "../components/GuardianDramaReport";

export interface Interpretation {
  summary: string;
  axisComments: Record<string, string>;
  caveats: string;
  recommendation: string;
  /** 축별로 해석이 인용한 근거 ID */
  evidenceIds: Record<string, string[]>;
  /** 검증 에이전트 통과 여부 — false면 화면에 해석을 띄우지 않는 편이 안전 */
  verified: boolean;
  verifyIssues: string[];
}

export interface ReportResponse {
  patientName: string | null;
  patientBirthDate: string | null;
  speechScore: ScoreCategory;
  contentScore: ScoreCategory;
  questions: ReportQuestion[];
  trend: TrendPoint[];
  interpretation: Interpretation | null;
  /** scored=실제 전체 분석, partial=일부 축 결측, demo=예시 데이터 */
  analysisMode: "scored" | "partial" | "demo";
  notice: string;
  referenceMode: "older_reference" | "personal_baseline";
  referenceNotice: string;
  analysisVersion?: number;
}

/** 질문 1건에 대한 응답. audio는 별도 File로 넘긴다. */
export interface AnswerInput {
  id: string;
  question: string;
  correctAnswer?: string;
  /** 비워두면 백엔드가 STT로 채운다 */
  userAnswer?: string;
  /** A.X STT가 WAF에 막힌 시연 환경에서만 쓰는, 화면에 고지되는 대체 전사 */
  fallbackAnswer?: string;
  /** recorded=실제 녹음 전사 대상, demo=마이크 장애로 시연 대본 사용 */
  transcriptSource?: "recorded" | "demo";
  videoTimestamp?: number;
  /** 함께 올리는 오디오 파일명 (audio 배열의 File.name과 일치해야 함) */
  audioFilename?: string;
  /** 고정 시연 질문의 정답 핵심어. 회상 2축의 결정적 규칙 채점에 사용한다. */
  answerKeywords?: string[];
}

const BASE = "/api/score";

/**
 * 세션 오디오 + 응답 → 리포트.
 * 백엔드가 꺼져 있거나 실패하면 예외를 던진다. 호출부에서 목업으로 폴백할 것.
 */
export async function fetchReport(params: {
  answers: AnswerInput[];
  audio?: File[];
  patientName?: string;
  patientBirthDate?: string;
  contentId?: string;
  signal?: AbortSignal;
}): Promise<ReportResponse> {
  const fd = new FormData();
  fd.append("answers", JSON.stringify(params.answers));
  if (params.patientName) fd.append("patientName", params.patientName);
  if (params.patientBirthDate) fd.append("patientBirthDate", params.patientBirthDate);
  if (params.contentId) fd.append("contentId", params.contentId);
  for (const f of params.audio ?? []) fd.append("audio", f, f.name);

  const res = await fetch(`${BASE}/report`, {
    method: "POST",
    body: fd,
    signal: params.signal,
  });
  if (!res.ok) throw new Error(`채점 API 실패: ${res.status}`);
  return (await res.json()) as ReportResponse;
}

/** 질문 한 건의 실제 녹음을 A.X STT로 전사한다. */
export async function fetchTranscript(
  audio: File,
  answerKeywords: string[] = [],
  signal?: AbortSignal,
): Promise<string> {
  const fd = new FormData();
  fd.append("audio", audio, audio.name);
  fd.append("answerKeywords", JSON.stringify(answerKeywords));
  const res = await fetch(`${BASE}/transcribe`, {
    method: "POST",
    body: fd,
    signal,
  });
  if (!res.ok) throw new Error(`A.X STT 실패: ${res.status}`);
  const data = (await res.json()) as { text?: string };
  return data.text?.trim() ?? "";
}

/** 전사된 실제 답변에 근거한 짧은 시청 동반 반응을 생성한다. */
export async function fetchEmpatheticReply(params: {
  questionId?: string;
  question: string;
  correctAnswer?: string;
  userAnswer: string;
  answerKeywords?: string[];
  opener?: string;
  variationKey?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await fetch(`${BASE}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: params.signal,
    body: JSON.stringify({
      questionId: params.questionId ?? "",
      question: params.question,
      correctAnswer: params.correctAnswer ?? "",
      userAnswer: params.userAnswer,
      answerKeywords: params.answerKeywords ?? [],
      opener: params.opener ?? "",
      variationKey: params.variationKey ?? "",
    }),
  });
  if (!res.ok) throw new Error(`동적 공감 응답 실패: ${res.status}`);
  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim() ?? "";
  if (!text) throw new Error("동적 공감 응답이 비어 있습니다.");
  return text;
}

/**
 * 오디오 없이 응답 텍스트만으로 리포트 요청.
 *
 * 백엔드에 참조분포(configs/scoring_model.json)가 있고 오디오가 함께 오면 실제 채점,
 * 없으면 같은 스키마의 목업을 돌려준다(interpretation.caveats에 사유가 담김).
 * → 화면은 어느 쪽이든 깨지지 않는다.
 */
export async function fetchSessionReport(params: {
  answers: AnswerInput[];
  audio?: File[];
  patientName?: string;
  patientBirthDate?: string;
}): Promise<ReportResponse> {
  return fetchReport(params);
}

/**
 * 가장 최근 세션의 실제 채점 결과.
 *
 * 시연 흐름: 앞에서 녹음·채점 → 브라우저 새로고침 → 방금 그 사람의 점수가 화면에.
 * 저장된 세션이 없으면 백엔드가 목업을 돌려주므로 화면이 비지 않는다.
 */
export async function fetchLatestReport(patientName?: string): Promise<ReportResponse> {
  const query = patientName ? `?patientName=${encodeURIComponent(patientName)}` : "";
  const res = await fetch(`${BASE}/report/latest${query}`);
  if (!res.ok) throw new Error(`최근 세션 조회 실패: ${res.status}`);
  return (await res.json()) as ReportResponse;
}

/** 백엔드 없이 렌더 확인용 — 프론트 목업과 같은 스키마 */
export async function fetchMockReport(): Promise<ReportResponse> {
  const res = await fetch(`${BASE}/report/mock`);
  if (!res.ok) throw new Error(`mock 실패: ${res.status}`);
  return (await res.json()) as ReportResponse;
}

/**
 * 백엔드가 떠 있는지 + 참조분포가 로드됐는지.
 * 실패하면 null — 호출부에서 목업 모드로 전환하는 신호로 쓴다.
 */
export async function checkHealth(): Promise<{
  ok: boolean;
  scoring_model: boolean;
  content_model: boolean;
  tts: boolean;
} | null> {
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
