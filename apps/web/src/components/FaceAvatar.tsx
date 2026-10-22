import { useMemo } from "react";

export interface FaceAvatarProps {
  /** 현재 프레임의 52개 ARKit 블렌드셰이프 가중치 */
  weights: number[];
  /** weights 배열 순서와 대응하는 이름 목록 */
  facsNames: string[];
  size?: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * VARCO Voice-to-Face가 돌려주는 ARKit 52 블렌드셰이프 중 표정에 영향이 큰 항목만 골라
 * 눈썹/눈/입 세 부위를 간단한 SVG 도형으로 움직이는 2D 일러스트 얼굴.
 * 실제 3D 리깅 모델 없이 핵심 표정만 표현하는 것이 목표다.
 */
export default function FaceAvatar({ weights, facsNames, size = 320 }: FaceAvatarProps) {
  const indexOf = useMemo(() => {
    const map: Record<string, number> = {};
    facsNames.forEach((name, i) => (map[name] = i));
    return map;
  }, [facsNames]);

  const w = (name: string) => clamp01(weights[indexOf[name]] ?? 0);

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
  const cheekPuffL = w("cheekPuff");

  // ---------- 눈썹 ----------
  const browLOffset = -(browInnerUp * 5 + browOuterUpL * 7) + browDownL * 6;
  const browROffset = -(browInnerUp * 5 + browOuterUpR * 7) + browDownR * 6;

  // ---------- 눈 ----------
  const baseEyeRy = 13;
  const eyeRyL = Math.max(1, baseEyeRy * (1 - eyeBlinkL) * (1 + eyeWideL * 0.25));
  const eyeRyR = Math.max(1, baseEyeRy * (1 - eyeBlinkR) * (1 + eyeWideR * 0.25));

  // ---------- 입 ----------
  const openness = jawOpen * 44; // px
  const narrow = Math.max(mouthFunnel, mouthPucker);
  const mouthWidth = 68 * (1 - narrow * 0.35);
  const cornerLift = (mouthSmileL + mouthSmileR) * 9 - (mouthFrownL + mouthFrownR) * 7;
  const shiftX = (mouthRight - mouthLeft) * 8;
  const cheekPuffScale = 1 + cheekPuffL * 0.06;

  const cx = 120 + shiftX;
  const cy = 168;
  const halfW = mouthWidth / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      role="img"
      aria-label="음성에 맞춰 움직이는 얼굴 애니메이션"
    >
      {/* 얼굴 바탕 */}
      <ellipse cx="120" cy="128" rx={92 * cheekPuffScale} ry="100" fill="var(--face-skin, #ffd9b3)" />
      {/* 귀 */}
      <ellipse cx="30" cy="128" rx="10" ry="16" fill="var(--face-skin, #ffd9b3)" />
      <ellipse cx="210" cy="128" rx="10" ry="16" fill="var(--face-skin, #ffd9b3)" />

      {/* 눈썹 */}
      <path
        d={`M 65 ${92 + browLOffset} Q 85 ${82 + browLOffset} 105 ${92 + browLOffset}`}
        stroke="var(--face-brow, #6b4a34)"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d={`M 135 ${92 + browROffset} Q 155 ${82 + browROffset} 175 ${92 + browROffset}`}
        stroke="var(--face-brow, #6b4a34)"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
      />

      {/* 눈 */}
      <ellipse cx="85" cy="112" rx="16" ry={eyeRyL} fill="#fff" />
      <ellipse cx="85" cy="112" rx="7" ry={Math.min(7, eyeRyL)} fill="#2b2320" />
      <ellipse cx="155" cy="112" rx="16" ry={eyeRyR} fill="#fff" />
      <ellipse cx="155" cy="112" rx="7" ry={Math.min(7, eyeRyR)} fill="#2b2320" />

      {/* 볼 */}
      <ellipse cx="60" cy="150" rx="14" ry="9" fill="#ff9d8a" opacity="0.35" />
      <ellipse cx="180" cy="150" rx="14" ry="9" fill="#ff9d8a" opacity="0.35" />

      {/* 입 */}
      {openness < 5 ? (
        <path
          d={`M ${cx - halfW} ${cy} Q ${cx} ${cy - cornerLift} ${cx + halfW} ${cy}`}
          stroke="var(--face-mouth, #a24a3f)"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <ellipse
          cx={cx}
          cy={cy - cornerLift * 0.3 + openness * 0.3}
          rx={halfW}
          ry={Math.min(30, openness / 2)}
          fill="var(--face-mouth-open, #7a2e22)"
        />
      )}
    </svg>
  );
}
