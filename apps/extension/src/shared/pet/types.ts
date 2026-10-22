// ============================================================================
// Pet 이 말하는 모든 것의 타입.
//
// 이 파일의 핵심 결정은 PetTurnKind 다. 감상·자기개방·약속을 "질문 데이터에 붙는
// 문자열 필드"가 아니라 질문과 같은 급의 턴 종류로 둔다. 그래야 일방향 문진의 리듬
// (질문 → 답 → 칭찬 → 다음 질문)이 구조적으로 깨진다. 문자열 필드로 뒀다면
// 마감이 급할 때 제일 먼저 비워지는 자리가 됐을 것이다.
// ============================================================================

import type { VarcoFaceOptions } from "../../lib/varcoFace.ts";

/** varcoFace.ts 의 emotion 유니온에서 파생 — 두 곳이 어긋날 수 없게 한다 */
export type PetEmotion = NonNullable<VarcoFaceOptions["emotion"]>;

export type PetTurnKind =
  | "greeting"        // 하루의 첫 인사
  | "recall"          // 지난번 기억 언급 (유대감 ①)
  | "remark"          // 화면에 대한 Pet 의 감상
  | "selfDisclosure"  // Pet 자기 이야기 (유대감 ②)
  | "ask"             // 사용자의 답을 기다리는 유일한 종류
  | "promise";        // 약속으로 끝나는 인사 (유대감 ③)

/** 신호의 출처. Phase D 의 "play"(놀이)를 지금 넣어 둬 리포트 확장을 막지 않는다 */
export type SignalSource = "checkin" | "coview" | "play";

/**
 * 채점·리포트 전용 메타데이터.
 * 사용자 화면에 렌더되는 어떤 경로에도 흘러가지 않는다 — 이 분리가 곧 검토 4.5절의
 * 신뢰 경계다. PetTurn.text 는 사용자가 듣고, analysis 는 보호자만 본다.
 */
export interface TurnAnalysisMeta {
  source: SignalSource;
  correctAnswer?: string;
  categoryLabel?: string;
  rank?: number;
  /** 보호자 리포트의 근거 기여도 게이지 (0~100) */
  impact?: number;
}

export interface PetTurn {
  id: string;
  kind: PetTurnKind;
  /** Pet 이 실제로 말하는 문장 */
  text: string;
  emotion?: PetEmotion;
  /** kind === "ask" 일 때만. Phase A 데모용 가정 답변 (Phase B 에서 ASR 결과로 대체) */
  simulatedAnswer?: string;
  /** 답변 뒤 Pet 이 이어 말할 문장. 있으면 ack 턴으로 자동 전개된다 */
  ack?: string;
  /** 이 턴이 끝난 뒤 쉬는 시간(ms). 기본 1000 */
  restMs?: number;
  /** 보호자 '오늘 웃었던 순간' 후보로 삼을 턴인지 (유대감 ④) */
  highlight?: boolean;
  analysis?: TurnAnalysisMeta;
}

/**
 * Pet 이 끼어드는 계기.
 *
 * ★ "광고 구간"은 일부러 없다. 유튜브 광고는 본편과 같은 <video> 요소로 재생되고
 *   currentTime 이 광고 경과초로 갈아끼워진다. 그래서 광고는 끼어들 기회가 아니라
 *   모든 cue 판정을 막아야 하는 구간이다 — VideoPulse.adShowing 이 그 역할을 한다.
 * sceneChange 는 Phase C(자막 기반 생성)의 자리만 남겨 둔 것이다.
 */
export type BeatCue =
  | { at: "panel-open" }
  | { at: "seconds"; seconds: number }
  | { at: "paused-by-user" }
  | { at: "ended" }
  | { at: "sceneChange" };

export function cueKey(cue: BeatCue): string {
  return cue.at === "seconds" ? `seconds:${cue.seconds}` : cue.at;
}

/** 보호자 '오늘 웃었던 순간' 카드의 씨앗 */
export interface MomentSeed {
  context: string;
  petLine: string;
}

/** 한 번 끼어들 때 연속으로 말하는 턴 묶음 */
export interface PetBeat {
  id: string;
  cue: BeatCue;
  turns: PetTurn[];
  /**
   * true 면 영상을 멈춘다. false 면 볼륨만 낮춘다.
   * 기본은 false — 멈추지 않는 것이 기본이어야 "검사"가 아니라 "같이 보기"가 된다.
   */
  pauseVideo: boolean;
  /** 중복 방지 범위. 기본 "session" */
  once?: "session" | "day";
  moment?: MomentSeed;
}

export interface ContentRef {
  provider: "youtube" | "local" | "none";
  id: string;
  title: string;
}

/** 하나의 콘텐츠에 붙는 대본. Phase A 는 사람이 쓴 L0, Phase C 는 LLM 생성물이 같은 모양으로 들어온다 */
export interface PetScript {
  content: ContentRef;
  beats: PetBeat[];
}

export type BeatAbortReason = "navigated" | "panel-closed" | "user-resumed" | "replaced";

export type BeatOutcome =
  | { status: "completed"; answers: Record<string, string> }
  | { status: "aborted"; reason: BeatAbortReason }
  | { status: "degraded"; reason: "voice-blocked" | "voice-offline" | "deadline"; answers: Record<string, string> };
