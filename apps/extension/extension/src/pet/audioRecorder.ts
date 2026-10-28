export interface PcmRecordingResult {
  blob: Blob;
  durationMs: number;
  peak: number;
  rms: number;
}

export interface PcmAudioCapture {
  readonly state: "recording" | "inactive";
  stop: () => Promise<PcmRecordingResult>;
  cancel: () => Promise<void>;
}

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor {
  const constructor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!constructor) throw new Error("이 브라우저는 PCM 음성 녹음을 지원하지 않습니다.");
  return constructor;
}

function encodePcm16Wav(chunks: Float32Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function downsampleToPcm16(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16000,
): ArrayBuffer {
  const ratio = Math.max(1, inputSampleRate / outputSampleRate);
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Int16Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) sum += samples[inputIndex];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

/**
 * MediaRecorder의 WebM/Opus 인코더를 거치지 않고 마이크 PCM을 직접 WAV로 만든다.
 * 데스크톱 내장 브라우저에서 무음 Opus 패킷이 깨지는 문제를 피하기 위한 경로다.
 */
export async function startPcmAudioCapture(
  stream: MediaStream,
  onVoiceActivity?: (active: boolean) => void,
  onPcm16Chunk?: (chunk: ArrayBuffer) => void,
): Promise<PcmAudioCapture> {
  const AudioContextClass = getAudioContextConstructor();
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  // AudioWorklet 모듈 파일 없이 모든 시연 브라우저에서 동작하도록 ScriptProcessor를 사용한다.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentGain = context.createGain();
  silentGain.gain.value = 0;

  const chunks: Float32Array[] = [];
  let sampleCount = 0;
  let peak = 0;
  let squareSum = 0;
  let noiseFloor = 0.0025;
  let voiceActive = false;
  let voiceHangoverUntil = 0;
  let state: "recording" | "inactive" = "recording";

  processor.onaudioprocess = (event) => {
    if (state !== "recording") return;
    const sourceSamples = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(sourceSamples);
    chunks.push(copy);
    if (onPcm16Chunk) onPcm16Chunk(downsampleToPcm16(copy, context.sampleRate));
    sampleCount += copy.length;
    let blockPeak = 0;
    let blockSquareSum = 0;
    for (let i = 0; i < copy.length; i += 1) {
      const value = copy[i];
      peak = Math.max(peak, Math.abs(value));
      squareSum += value * value;
      blockPeak = Math.max(blockPeak, Math.abs(value));
      blockSquareSum += value * value;
    }

    // 녹음 상태 자체가 아니라 실제 음성 에너지가 감지될 때만 VAD를 켠다.
    // 짧은 음절 사이에서 아이콘이 깜빡이지 않도록 280ms hangover를 둔다.
    const blockRms = Math.sqrt(blockSquareSum / Math.max(copy.length, 1));
    const speechThreshold = Math.max(0.006, noiseFloor * 2.4);
    const speechDetected = blockRms >= speechThreshold || blockPeak >= 0.045;
    const now = performance.now();
    if (speechDetected) voiceHangoverUntil = now + 280;
    else noiseFloor = noiseFloor * 0.97 + Math.min(blockRms, 0.01) * 0.03;
    const nextVoiceActive = speechDetected || now < voiceHangoverUntil;
    if (nextVoiceActive !== voiceActive) {
      voiceActive = nextVoiceActive;
      onVoiceActivity?.(voiceActive);
    }
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);
  if (context.state === "suspended") await context.resume();

  const disconnect = async () => {
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    silentGain.disconnect();
    if (context.state !== "closed") await context.close();
  };

  return {
    get state() {
      return state;
    },
    async stop() {
      if (state !== "recording") throw new Error("이미 종료된 녹음입니다.");
      state = "inactive";
      await disconnect();
      const durationMs = sampleCount ? (sampleCount / context.sampleRate) * 1000 : 0;
      return {
        blob: encodePcm16Wav(chunks, context.sampleRate),
        durationMs,
        peak,
        rms: sampleCount ? Math.sqrt(squareSum / sampleCount) : 0,
      };
    },
    async cancel() {
      if (state !== "recording") return;
      state = "inactive";
      await disconnect();
    },
  };
}

/** 지나치게 짧거나 실질적인 음성이 없는 녹음은 서버에 보내지 않는다. */
export function recordingHasVoice(result: PcmRecordingResult): boolean {
  return result.durationMs >= 600 && result.peak >= 0.008 && result.rms >= 0.0008;
}
