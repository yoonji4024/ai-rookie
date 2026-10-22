// ============================================================================
// 화면에 떠 있는 두리의 위치 계산.
//
// 위치는 "어느 모서리에 붙어 있고, 그 모서리에서 얼마나 떨어져 있나"로 저장한다.
// 화면 크기가 바뀌어도(창 크기 조절, 전체화면 전환) 사용자가 둔 구석을 지키기 위해서다.
// 왼쪽 위 좌표로 저장하면 창을 줄였을 때 오른쪽 아래에 두었던 두리가 화면 밖으로 사라진다.
//
// 상자(box)는 강아지와 말풍선을 함께 담은 영역(확장에서는 iframe)이고, 강아지는 늘 상자의
// 붙은 모서리 쪽 구석에 있다(FloatingPet 이 그렇게 배치한다). 그래서 상자가 커지고 작아져도
// 붙은 모서리 기준 오프셋만 지키면 강아지는 제자리다.
//
// ★ 이 모듈은 content script(extension/src/content/petOverlay.ts)도 가져다 쓴다.
//   content script 는 다른 청크와 런타임 값을 공유하면 안 된다(CRXJS 가 동적 로더로 바꾼다).
//   그러니 확장 쪽에서는 content script 만 이 파일을 import 해야 한다 — 그러면 그 청크에
//   그대로 인라인된다. scripts/check-ext.mjs 가 위반을 잡는다.
// ============================================================================

export interface FloatPosition {
  h: "left" | "right";
  /** 붙은 가로 모서리에서 상자까지의 거리(px) */
  x: number;
  v: "top" | "bottom";
  /** 붙은 세로 모서리에서 상자까지의 거리(px) */
  y: number;
}

/** 강아지가 붙은 모서리 — FloatingPet 이 말풍선을 반대쪽으로 키우는 기준 */
export type FloatAnchor = Pick<FloatPosition, "h" | "v">;

export interface Size {
  width: number;
  height: number;
}

/** FloatingPet 의 .fp-dog 크기와 .fp-root 여백. 둘이 어긋나면 모서리 판정이 틀어진다 */
export const DOG_PX = 96;
export const ROOT_PAD_PX = 12;
/** 화면 가장자리와 강아지 사이에 남길 최소 여백 */
const EDGE_PX = 4;

export const DEFAULT_POSITION: FloatPosition = { h: "right", x: 16, v: "bottom", y: 16 };

/** 끄는 중: 포인터가 움직인 만큼 상자를 옮긴다(붙은 모서리는 그대로) */
export function moveBy(p: FloatPosition, dx: number, dy: number): FloatPosition {
  return {
    h: p.h,
    x: p.h === "right" ? p.x - dx : p.x + dx,
    v: p.v,
    y: p.v === "bottom" ? p.y - dy : p.y + dy,
  };
}

/** 강아지 중심의 화면 좌표 */
export function dogCenter(p: FloatPosition, viewport: Size): { x: number; y: number } {
  const half = DOG_PX / 2 + ROOT_PAD_PX;
  return {
    x: p.h === "right" ? viewport.width - p.x - half : p.x + half,
    y: p.v === "bottom" ? viewport.height - p.y - half : p.y + half,
  };
}

/**
 * 끌기를 놓았을 때: 강아지가 화면의 어느 사분면에 있는지 보고 가까운 모서리에 다시 붙인다.
 * 왼쪽 위로 끌어다 놓으면 이제 말풍선이 오른쪽 아래로 자란다 — 화면 밖으로 자라지 않게.
 */
export function reanchor(p: FloatPosition, viewport: Size): FloatPosition {
  const c = dogCenter(p, viewport);
  const half = DOG_PX / 2 + ROOT_PAD_PX;
  const h = c.x > viewport.width / 2 ? "right" : "left";
  const v = c.y > viewport.height / 2 ? "bottom" : "top";
  return {
    h,
    x: h === "right" ? viewport.width - c.x - half : c.x - half,
    v,
    y: v === "bottom" ? viewport.height - c.y - half : c.y - half,
  };
}

/** 강아지가 화면 밖으로 나가지 않게 당긴다 (창을 줄였을 때, 끌다가 밖으로 던졌을 때) */
export function clampPosition(p: FloatPosition, viewport: Size): FloatPosition {
  const min = EDGE_PX - ROOT_PAD_PX;
  const maxX = Math.max(min, viewport.width - DOG_PX - ROOT_PAD_PX - EDGE_PX);
  const maxY = Math.max(min, viewport.height - DOG_PX - ROOT_PAD_PX - EDGE_PX);
  return { ...p, x: Math.min(maxX, Math.max(min, p.x)), y: Math.min(maxY, Math.max(min, p.y)) };
}

/** CSS 로 바로 쓸 수 있는 값. 붙지 않은 쪽은 auto 로 풀어 둔다 */
export function toCss(p: FloatPosition): { left: string; right: string; top: string; bottom: string } {
  const px = (n: number) => `${Math.round(n)}px`;
  return {
    left: p.h === "left" ? px(p.x) : "auto",
    right: p.h === "right" ? px(p.x) : "auto",
    top: p.v === "top" ? px(p.y) : "auto",
    bottom: p.v === "bottom" ? px(p.y) : "auto",
  };
}

/** 저장소에서 읽은 값을 믿지 않는다 — 모양이 어긋나면 기본 자리로 */
export function reviveFloatPosition(raw: unknown): FloatPosition {
  const r = raw as Partial<FloatPosition> | null;
  if (
    r &&
    (r.h === "left" || r.h === "right") &&
    (r.v === "top" || r.v === "bottom") &&
    typeof r.x === "number" &&
    Number.isFinite(r.x) &&
    typeof r.y === "number" &&
    Number.isFinite(r.y)
  ) {
    return { h: r.h, x: r.x, v: r.v, y: r.y };
  }
  return { ...DEFAULT_POSITION };
}
