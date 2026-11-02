export const WEB_VOICE_KEY = 'memflix.web.voice.v1';
export interface VoicePreferences { autoListen: boolean; silenceSeconds: 5 | 8 }
export function readVoicePreferences(raw: unknown): VoicePreferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoicePreferences>;
  return { autoListen: value.autoListen !== false, silenceSeconds: value.silenceSeconds === 8 ? 8 : 5 };
}

/** VAD emits changes, not a heartbeat. Continuous speech must never count as silence. */
export class VoiceSilenceClock {
  private active = false;
  private lastVoice: number | null = null;
  private started: number;
  constructor(started: number) { this.started = started; }
  update(active: boolean, now: number) {
    if (active || this.active) this.lastVoice = now;
    this.active = active;
  }
  decision(now: number, seconds: number): 'wait' | 'empty' | 'finish' | 'limit' {
    if (now - this.started >= 60000) return 'limit';
    if (this.active) return 'wait';
    if (this.lastVoice === null) return now - this.started >= 20000 ? 'empty' : 'wait';
    return now - this.lastVoice >= seconds * 1000 ? 'finish' : 'wait';
  }
}
