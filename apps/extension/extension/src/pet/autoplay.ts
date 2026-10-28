import { withDeadline } from "../../../src/shared/obs/deadline";

// ============================================================================
// 지금 소리를 낼 수 있는가.
//
// 실측(Chromium 141): 페이지에 띄운 확장 iframe 은 allow="autoplay" 로 위임받아도,
// *페이지에서* 사용자가 한 번이라도 누른 뒤에야 소리를 낸다. 주소창으로 바로 연 영상
// 페이지에서는 막힌다. 그때 두리는 자고 있다가, 누르면(또는 페이지에서 무언가 누르면) 깨어난다.
// (예전 사이드 패널은 확장 문서 자체가 허용 대상이라 클릭이 필요 없었다.)
// ============================================================================

/** 0.1초짜리 무음 WAV */
export const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

/**
 * 무음 재생을 시도해 본다. play() 가 영영 settle 하지 않는 경우까지 막으려고 마감 시한을 건다.
 * 결과와 그 순간의 클릭 이력을 문서에 남긴다 — 종단 검증(verify/verify-e2e.mjs)이 읽는다.
 * 나중에 바깥에서 재면 검증 도구의 조작이 클릭 이력에 섞인다.
 */
export async function canAutoplay(): Promise<boolean> {
  const activated = navigator.userActivation?.hasBeenActive ?? null;
  const attempt = new Audio(SILENT_WAV).play().then(
    () => true,
    () => false,
  );
  const ok = await withDeadline(attempt, 1500, "autoplay-probe", () => false);
  document.documentElement.dataset.autoplayProbe = ok ? "played" : "blocked";
  document.documentElement.dataset.activatedAtProbe = String(activated);
  return ok;
}
