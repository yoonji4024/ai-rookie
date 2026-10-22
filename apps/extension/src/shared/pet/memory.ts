// ============================================================================
// Pet 의 기억 — 저장 스키마와 순수 조작 함수.
//
// 검토 문서 4.4절 1번. 유대감의 가장 강한 신호는 "어제 한 말을 기억하는 것"이다.
// 그래서 기억은 부가 기능이 아니라 아침 인사와 약속이 딛고 서는 데이터다.
//
// 신뢰 경계(검토 4.5절): MemoryNote 는 사용자와 Pet 사이의 사적인 이야기이고,
// MomentCard 는 보호자에게 보여도 되는 조각이다. **MemoryNote 를 MomentCard 로
// 바꾸는 함수는 이 파일에 없고, 앞으로도 두지 않는다.** 회상 대화가 보호자 화면으로
// 새어 나갈 경로를 타입 수준에서 막는 것이 목적이다.
// ============================================================================

import { dayKey, daysBetween } from "../time/now.ts";
import { PERSONA } from "./persona.ts";

export type MemoryTheme = "health" | "family" | "taste" | "event";

export interface MemoryNote {
  theme: MemoryTheme;
  /** 그 화제가 나온 사용자 발화 한 문장 */
  quote: string;
  /** YYYY-MM-DD */
  recordedOn: string;
}

export interface PetPromise {
  /** YYYY-MM-DD */
  madeOn: string;
  text: string;
  /** 다음 인사에서 되짚을 짧은 키워드 ("한국기행 뒷부분") */
  keyword: string;
}

export interface MomentCard {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** 그 순간 Pet 이 한 말 */
  petLine: string;
  /** 사용자 발화 발췌 — 잘라서 담는다. 전문은 보호자에게 가지 않는다 */
  quote: string;
  context: string;
  contentTitle: string;
}

export interface PetMemory {
  /** 스키마 버전. 구조가 바뀌면 올리고 마이그레이션한다 */
  schema: 1;
  petName: string;
  /** Pet 이 사용자를 부르는 말 */
  userHonorific: string;
  createdOn: string;
  /** 마지막으로 만난 날. null 이면 오늘이 첫 만남 */
  lastMetOn: string | null;
  streakDays: number;
  /** 지난 세션 끝에 한 약속 — 다음 아침 인사의 재료 */
  openPromise: PetPromise | null;
  notes: MemoryNote[];
  /** 최신 것부터, 최대 MAX_MOMENTS 개 */
  moments: MomentCard[];
}

export const MEMORY_KEY = "memflix.pet.memory";
export const MAX_NOTES = 12;
export const MAX_MOMENTS = 3;
/** 보호자에게 넘어가는 발췌의 상한 — 회상 대화 전문이 흘러가지 않게 한다 */
export const QUOTE_MAX_CHARS = 120;

export function createMemory(today = dayKey()): PetMemory {
  return {
    schema: 1,
    petName: PERSONA.defaultPetName,
    userHonorific: PERSONA.defaultHonorific,
    createdOn: today,
    lastMetOn: null,
    streakDays: 0,
    openPromise: null,
    notes: [],
    moments: [],
  };
}

/**
 * 저장된 값을 안전하게 받아들인다.
 * 저장소가 비었거나 손상됐어도 Pet 은 말할 수 있어야 하므로 절대 throw 하지 않는다.
 */
export function reviveMemory(raw: unknown, today = dayKey()): PetMemory {
  const base = createMemory(today);
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Partial<PetMemory>;
  if (r.schema !== 1) return base; // 미래 스키마는 무시하고 새로 시작한다

  return {
    schema: 1,
    petName: typeof r.petName === "string" && r.petName ? r.petName : base.petName,
    userHonorific:
      typeof r.userHonorific === "string" && r.userHonorific ? r.userHonorific : base.userHonorific,
    createdOn: typeof r.createdOn === "string" ? r.createdOn : base.createdOn,
    lastMetOn: typeof r.lastMetOn === "string" ? r.lastMetOn : null,
    streakDays: Number.isFinite(r.streakDays) ? Number(r.streakDays) : 0,
    openPromise: isPromise(r.openPromise) ? r.openPromise : null,
    notes: Array.isArray(r.notes) ? r.notes.filter(isNote).slice(-MAX_NOTES) : [],
    moments: Array.isArray(r.moments) ? r.moments.filter(isMoment).slice(0, MAX_MOMENTS) : [],
  };
}

function isNote(v: unknown): v is MemoryNote {
  const n = v as MemoryNote;
  return !!n && typeof n.quote === "string" && typeof n.recordedOn === "string";
}

function isPromise(v: unknown): v is PetPromise {
  const p = v as PetPromise;
  return !!p && typeof p.text === "string" && typeof p.madeOn === "string";
}

function isMoment(v: unknown): v is MomentCard {
  const m = v as MomentCard;
  return !!m && typeof m.id === "string" && typeof m.quote === "string" && typeof m.date === "string";
}

/** 만남을 기록한다. 연속 접속일은 하루 차이일 때만 이어진다 */
export function touchMeeting(memory: PetMemory, today = dayKey()): PetMemory {
  if (memory.lastMetOn === today) return memory;
  const gap = memory.lastMetOn === null ? null : daysBetween(memory.lastMetOn, today);
  return {
    ...memory,
    lastMetOn: today,
    streakDays: gap === 1 ? memory.streakDays + 1 : 1,
  };
}

/** 같은 주제의 기억은 최신 것으로 갈아끼운다 — 오래된 사실을 우기지 않기 위해 */
export function rememberNote(memory: PetMemory, note: MemoryNote): PetMemory {
  const others = memory.notes.filter((n) => n.theme !== note.theme);
  return { ...memory, notes: [...others, note].slice(-MAX_NOTES) };
}

export function latestNote(memory: PetMemory): MemoryNote | null {
  return memory.notes.length > 0 ? memory.notes[memory.notes.length - 1] : null;
}

export function rememberMoment(memory: PetMemory, moment: MomentCard): PetMemory {
  return { ...memory, moments: [moment, ...memory.moments].slice(0, MAX_MOMENTS) };
}

/** 보호자에게 넘길 발췌를 자른다 */
export function clipQuote(text: string, max = QUOTE_MAX_CHARS): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
