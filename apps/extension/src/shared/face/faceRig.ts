// ============================================================================
// 표정 계산 — 블렌드셰이프 가중치를 SVG 도형 값으로 바꾼다.
//
// FaceAvatar.tsx 가 쓰던 수식을 그대로 옮긴 것이다. 얼굴 형상(사람/강아지)과 무관한
// 계산이라 한 줄도 바꾸지 않았고, 달라진 것은 강아지에 맞춘 상수 네 개뿐이다.
// 그 상수들은 매직넘버로 흩어 두지 않고 FACE_TUNING 한 곳에 모았다.
//
// 입력이 배열이 아니라 조회 함수인 이유: 얼굴 API 를 한 번도 부르지 않은 상태에서도
// 절차적 표정(감정 프리셋)을 넣을 수 있어야 한다. 릴레이가 죽어도 감정은 보여야 한다.
// ============================================================================

export type FacsLookup = (name: string) => number;

export const FACE_TUNING = {
  /** 눈 크기 기준 반지름. 사람 13 → 강아지는 조금 더 크고 동그랗게 */
  baseEyeRy: 15,
  /** jawOpen 을 입 벌림(px)으로 바꾸는 배율. 사람 44 → 주둥이가 있어 덜 벌어져도 충분 */
  opennessScale: 38,
  /** 다물었을 때의 입 너비 기준(px). 사람 68 → 주둥이 안에 들어가야 해서 좁다 */
  mouthWidthBase: 52,
  /** 입의 세로 기준점. 사람 168 → 주둥이 위치에 맞춰 아래로 */
  mouthCenterY: 176,
} as const;

export interface RigValues {
  /** 볼 부풀림이 반영된 얼굴 가로 반지름 */
  faceRx: number;
  browLOffset: number;
  browROffset: number;
  eyeRyL: number;
  eyeRyR: number;
  /** 눈동자 세로 반지름(눈보다 클 수 없다) */
  pupilRyL: number;
  pupilRyR: number;
  /** true 면 입을 벌린 타원, false 면 다문 곡선 */
  mouthOpen: boolean;
  mouthCx: number;
  mouthCy: number;
  mouthHalfWidth: number;
  mouthOpenRy: number;
  /** 다문 입의 입꼬리 올림(px). 음수면 처진다 */
  cornerLift: number;
  /** 귀 각도(도). 듣는 중이면 쫑긋 선다 */
  earTilt: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const FACE_RX = 92;
const EAR_TILT_BASE = 12;

export function computeRig(raw: FacsLookup, earUp = 0): RigValues {
  const w = (name: string) => clamp01(raw(name) ?? 0);

  const browInnerUp = w("browInnerUp");
  const browOuterUpL = w("browOuterUpLeft");
  const browOuterUpR = w("browOuterUpRight");
  const browDownL = w("browDownLeft");
  const browDownR = w("browDownRight");

  const eyeBlinkL = w("eyeBlinkLeft");
  const eyeBlinkR = w("eyeBlinkRight");
  const eyeWideL = w("eyeWideLeft");
  const eyeWideR = w("eyeWideRight");

  const jawOpen = w("jawOpen");
  const mouthSmileL = w("mouthSmileLeft");
  const mouthSmileR = w("mouthSmileRight");
  const mouthFrownL = w("mouthFrownLeft");
  const mouthFrownR = w("mouthFrownRight");
  const mouthFunnel = w("mouthFunnel");
  const mouthPucker = w("mouthPucker");
  const mouthLeft = w("mouthLeft");
  const mouthRight = w("mouthRight");
  const cheekPuff = w("cheekPuff");

  // ---------- 눈썹 ----------
  const browLOffset = -(browInnerUp * 5 + browOuterUpL * 7) + browDownL * 6;
  const browROffset = -(browInnerUp * 5 + browOuterUpR * 7) + browDownR * 6;

  // ---------- 눈 ----------
  const base = FACE_TUNING.baseEyeRy;
  const eyeRyL = Math.max(1, base * (1 - eyeBlinkL) * (1 + eyeWideL * 0.25));
  const eyeRyR = Math.max(1, base * (1 - eyeBlinkR) * (1 + eyeWideR * 0.25));

  // ---------- 입 ----------
  const openness = jawOpen * FACE_TUNING.opennessScale;
  const narrow = Math.max(mouthFunnel, mouthPucker);
  const mouthWidth = FACE_TUNING.mouthWidthBase * (1 - narrow * 0.35);
  const cornerLift = (mouthSmileL + mouthSmileR) * 9 - (mouthFrownL + mouthFrownR) * 7;
  const shiftX = (mouthRight - mouthLeft) * 8;

  const mouthOpen = openness >= 5;

  return {
    faceRx: FACE_RX * (1 + cheekPuff * 0.06),
    browLOffset,
    browROffset,
    eyeRyL,
    eyeRyR,
    pupilRyL: Math.min(8, eyeRyL),
    pupilRyR: Math.min(8, eyeRyR),
    mouthOpen,
    mouthCx: 120 + shiftX,
    mouthCy: FACE_TUNING.mouthCenterY - cornerLift * 0.3 + (mouthOpen ? openness * 0.3 : 0),
    mouthHalfWidth: mouthWidth / 2,
    mouthOpenRy: Math.min(26, openness / 2),
    cornerLift,
    // 듣는 중에는 귀가 쫑긋 선다 — 마이크 아이콘을 대신하는 몸짓이다
    earTilt: EAR_TILT_BASE - earUp * 22,
  };
}

/** 얼굴 API 없이도 감정이 보이게 하는 절차적 프리셋 */
export type FaceMood = "neutral" | "happy" | "curious" | "sad" | "listening";

const MOOD_PRESETS: Record<FaceMood, Record<string, number>> = {
  neutral: {},
  happy: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, eyeBlinkLeft: 0.25, eyeBlinkRight: 0.25 },
  curious: { browInnerUp: 0.6, browOuterUpLeft: 0.5, browOuterUpRight: 0.5, eyeWideLeft: 0.4, eyeWideRight: 0.4 },
  sad: { mouthFrownLeft: 0.6, mouthFrownRight: 0.6, browInnerUp: 0.5 },
  listening: { eyeWideLeft: 0.25, eyeWideRight: 0.25, mouthSmileLeft: 0.3, mouthSmileRight: 0.3 },
};

export function moodLookup(mood: FaceMood): FacsLookup {
  const preset = MOOD_PRESETS[mood] ?? {};
  return (name) => preset[name] ?? 0;
}
