// ============================================================================
// 미리 구워 둔 음성 캐시.
//
// Phase A 의 Pet 대사는 전부 사전에 알려져 있다. 그러면 런타임에 합성할 이유가 없다.
// 빌드 타임에 한 번 구워 확장 번들에 넣어 두면:
//   - 발표장 네트워크가 0이어도 시나리오가 완주된다
//   - 첫 발화까지의 침묵(합성 왕복)이 사라진다
//   - VARCO 크레딧이 시연 횟수와 무관해진다
// 릴레이는 그래서 크리티컬 패스에서 빠진다.
// ============================================================================

import { log } from "../obs/log.ts";
import type { FaceTrack } from "./speak.ts";

export interface BakedVoice {
  /** 재생 가능한 URL (Blob). 호출자가 revoke 하지 않는다 — 캐시가 소유한다 */
  audioUrl: string;
  face: FaceTrack | null;
}

/** 텍스트 + 목소리 + 속도로 결정되는 캐시 키. bake 스크립트와 같은 방식이어야 한다 */
export async function cacheKey(text: string, voiceId: string, speed = 1): Promise<string> {
  const payload = `${voiceId}|${speed}|${text}`;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackKey(payload);
  const bytes = new TextEncoder().encode(payload);
  const digest = await subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** SubtleCrypto 는 보안 컨텍스트에서만 있다. 없으면 약한 해시로 대신한다 */
function fallbackKey(payload: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < payload.length; i += 1) {
    const c = payload.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

/** base64 WAV → Blob URL. data: URI 보다 큰 오디오에 안전하다 */
export function base64WavToBlobUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

export interface VoiceCache {
  /** 구워 둔 음성이 있으면 돌려준다. 없으면 null */
  lookup(key: string): Promise<BakedVoice | null>;
  /** 런타임 합성 결과를 이 세션 동안 재사용한다 */
  put(key: string, audioBase64: string, face: FaceTrack | null): BakedVoice;
  /** 구워 둔 대사의 키 목록 (옵션 페이지의 "캐시 없는 대사" 표시용) */
  bakedKeys(): Set<string>;
  dispose(): void;
}

interface VoiceIndex {
  keys: string[];
}

/**
 * @param assetUrl 호스트가 주는 에셋 경로 해석기
 * @param fetchIndex index.json 을 읽어 어떤 키가 구워져 있는지 미리 안다.
 *   없는 키를 매번 404 로 두드리는 것을 막는다.
 */
export function createVoiceCache(assetUrl: (path: string) => string): VoiceCache {
  const memo = new Map<string, BakedVoice>();
  const owned: string[] = [];
  let baked: Set<string> | null = null;
  let indexLoading: Promise<Set<string>> | null = null;

  async function loadIndex(): Promise<Set<string>> {
    if (baked) return baked;
    if (!indexLoading) {
      indexLoading = (async () => {
        try {
          const res = await fetch(assetUrl("voice/index.json"), { signal: AbortSignal.timeout(4000) });
          if (!res.ok) throw new Error(`http-${res.status}`);
          const data = (await res.json()) as VoiceIndex;
          const set = new Set(data.keys ?? []);
          log.info("voice:index-loaded", { count: set.size });
          baked = set;
          return set;
        } catch (err) {
          // 구워 둔 음성이 없는 것은 정상 상태다 (아직 bake 를 안 돌렸을 수 있다)
          log.info("voice:index-missing", { reason: String(err) });
          baked = new Set<string>();
          return baked;
        }
      })();
    }
    return indexLoading;
  }

  return {
    async lookup(key) {
      const hit = memo.get(key);
      if (hit) return hit;

      const index = await loadIndex();
      if (!index.has(key)) return null;

      try {
        const [wav, face] = await Promise.all([
          fetch(assetUrl(`voice/${key}.wav`), { signal: AbortSignal.timeout(6000) }),
          fetch(assetUrl(`voice/${key}.bs.json`), { signal: AbortSignal.timeout(6000) }).catch(() => null),
        ]);
        if (!wav.ok) throw new Error(`wav-${wav.status}`);
        const blobUrl = URL.createObjectURL(await wav.blob());
        owned.push(blobUrl);
        const track = face && face.ok ? ((await face.json()) as FaceTrack) : null;
        const value: BakedVoice = { audioUrl: blobUrl, face: track };
        memo.set(key, value);
        return value;
      } catch (err) {
        log.warn("voice:baked-read-failed", { key, reason: String(err) });
        return null;
      }
    },

    put(key, audioBase64, face) {
      const url = base64WavToBlobUrl(audioBase64);
      owned.push(url);
      const value: BakedVoice = { audioUrl: url, face };
      memo.set(key, value);
      return value;
    },

    bakedKeys() {
      return baked ?? new Set<string>();
    },

    dispose() {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.length = 0;
      memo.clear();
    },
  };
}
