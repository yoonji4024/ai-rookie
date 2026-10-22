// NCSOFT VARCO Voice-to-Face(SyncFace) 연동 — 음성을 넣으면 ARKit 52종 블렌드셰이프
// 가중치 애니메이션을 돌려준다. VARCO TTS와 같은 이유(CORS 미지원)로 "/api/varco-face"
// 프록시(vite.config.ts)를 거쳐 호출한다.
const VARCO_FACE_PROXY_PATH = "/api/varco-face";

export interface VarcoFaceOptions {
  /** 기본 30 */
  fps?: number;
  /** 입술 움직임 스타일. 기본 balanced */
  lipStyle?: "balanced" | "clear" | "minimal" | "moderate";
  /** 표정 변화 스타일. 기본 natural */
  faceStyle?: "natural" | "energetic" | "stoic" | "timid";
  /** 기본 neutral */
  emotion?: "neutral" | "angry" | "happy" | "sad" | "surprise";
  neck?: "on" | "off";
  eye?: "on" | "off";
}

export interface VarcoBlendshape {
  exportFps: number;
  numPoses: number;
  numFrames: number;
  /** 52개 ARKit 블렌드셰이프 이름 (weightMat 각 행의 순서와 대응) */
  facsNames: string[];
  /** [numFrames][numPoses] 가중치 행렬 */
  weightMat: number[][];
}

export interface VarcoFaceResult {
  id: string;
  success: boolean;
  blendshape: VarcoBlendshape;
  jobid: string;
  credit: number;
}

let requestSeq = 0;

/** base64 WAV 오디오로부터 블렌드셰이프 애니메이션을 생성한다 */
export async function fetchBlendshape(
  audioBase64: string,
  options?: VarcoFaceOptions,
): Promise<VarcoFaceResult> {
  requestSeq += 1;
  const res = await fetch(VARCO_FACE_PROXY_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: `face-${Date.now()}-${requestSeq}`,
      audio: audioBase64,
      fps: options?.fps ?? 30,
      lip_style: options?.lipStyle ?? "balanced",
      face_style: options?.faceStyle ?? "natural",
      emotion: options?.emotion ?? "neutral",
      neck: options?.neck ?? "off",
      eye: options?.eye ?? "off",
    }),
  });
  if (!res.ok) throw new Error(`VARCO Face 요청 실패: ${res.status}`);
  return (await res.json()) as VarcoFaceResult;
}
