// ============================================================================
// 콘텐츠별 대본 조회.
//
// Phase A 는 사람이 쓴 L0 대본(beats.ko.json)을 videoId 로 찾는다.
// Phase C 에서 자막 기반 생성이 들어와도 이 함수의 반환 모양은 그대로다 —
// 대본을 "만드는 주체"만 바뀌고, 쓰는 쪽은 바뀌지 않는다.
//
// 대본이 없는 영상에서도 침묵하지 않는다. 빈 배열을 돌려주면 패널은 안부만 하는
// 모드로 남고, 사용자는 아무 영상이나 틀어도 Pet 이 곁에 있다고 느낀다.
// ============================================================================

import type { ContentRef, PetBeat, PetScript } from "./types.ts";
import scriptsJson from "./beats.ko.json" with { type: "json" };
import { log } from "../obs/log.ts";

const SCRIPTS = scriptsJson as PetScript[];

export function findScript(videoId: string): PetScript | null {
  return SCRIPTS.find((s) => s.content.id === videoId) ?? null;
}

/** PetPanel 의 findBeats prop 에 그대로 꽂히는 모양 */
export function findBeatsFor(content: ContentRef | null): PetBeat[] {
  if (!content || content.provider === "none") return [];
  const script = findScript(content.id);
  if (!script) {
    log.info("script:none", { id: content.id });
    return [];
  }
  log.info("script:found", { id: content.id, beats: script.beats.length });
  return script.beats;
}

export function allScripts(): PetScript[] {
  return SCRIPTS;
}
