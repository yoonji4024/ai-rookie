import { useCallback, useEffect, useRef, useState } from 'react';
import { startPcmAudioCapture, recordingHasVoice, type PcmAudioCapture } from './audioRecorder';
import { startLiveTranscript, type LiveTranscriptSession } from './liveTranscript';
import { playVarcoTts } from './varcoTts';
import { readVoicePreferences, VoiceSilenceClock, WEB_VOICE_KEY } from './voiceTurnPolicy';

export type VoicePhase = 'idle' | 'speaking' | 'opening' | 'recording' | 'transcribing' | 'review';
export interface VoiceTurnResult { file: File | null; text: string; state: 'recorded' | 'silent' | 'untranscribed' }
const VOICE = '3278b908-86ee-5c30-bb55-24b5b1bbc67b';

/** One cancellable question/recording at a time, shared by greeting and watching. */
export function useVoiceTurn(onResult: (result: VoiceTurnResult) => void) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const phaseRef = useRef<VoicePhase>('idle');
  const [heard, setHeard] = useState(false), [message, setMessage] = useState('');
  const [preferences, setPreferences] = useState(() => {
    try { return readVoicePreferences(JSON.parse(localStorage.getItem(WEB_VOICE_KEY) || '{}')); }
    catch { return readVoicePreferences(null); }
  });
  const pref = useRef(preferences); pref.current = preferences;
  const resultCallback = useRef(onResult); resultCallback.current = onResult;
  const alive = useRef(true), generation = useRef(0);
  const capture = useRef<PcmAudioCapture | null>(null), stream = useRef<MediaStream | null>(null);
  const live = useRef<LiveTranscriptSession | null>(null), abort = useRef<AbortController | null>(null);
  const voice = useRef<(() => void) | null>(null), timer = useRef<number>();
  const recordRef = useRef<() => Promise<void>>(async () => {});
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const transition = useCallback((next: VoicePhase) => { phaseRef.current = next; setPhase(next); }, []);
  const closeTracks = useCallback(() => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; }, []);
  const cancel = useCallback(() => {
    generation.current++; clearInterval(timer.current); voice.current?.(); voice.current = null;
    abort.current?.abort(); abort.current = null; live.current?.cancel(); live.current = null;
    void capture.current?.cancel(); capture.current = null; closeTracks();
    if (alive.current) { transition('idle'); setHeard(false); }
  }, [closeTracks, transition]);

  const stop = useCallback(async () => {
    const recorder = capture.current; if (!recorder || phaseRef.current !== 'recording') return;
    const id = generation.current, session = live.current;
    const current = () => alive.current && id === generation.current;
    capture.current = null; clearInterval(timer.current); transition('transcribing'); setHeard(false);
    let file: File | null = null;
    try {
      const recorded = await recorder.stop(); closeTracks(); if (!current()) return;
      if (!recordingHasVoice(recorded)) {
        session?.cancel();
        setMessage('목소리가 잘 들리지 않았어요. 다시 말씀하시거나 넘어가도 괜찮아요.');
        transition('review'); resultCallback.current({ file: null, text: '', state: 'silent' }); return;
      }
      file = new File([recorded.blob], 'answer.wav', { type: 'audio/wav' });
      if (!session) throw new Error('음성 연결이 종료됐어요.');
      const text = await session.finish(); if (!current()) return;
      setMessage('이렇게 들었어요. 다르면 다시 말씀해 주세요.'); transition('review');
      resultCallback.current({ file, text, state: 'recorded' });
    } catch {
      if (!current()) return;
      setMessage(file ? '녹음은 임시 보관했어요. 글로 확인하지 못했으니 다시 말씀하시거나 넘어가 주세요.' : '녹음을 마치지 못했어요. 다시 말씀해 주세요.');
      transition('review'); resultCallback.current({ file, text: '', state: 'untranscribed' });
    } finally {
      session?.cancel();
      if (current()) { live.current = null; abort.current = null; closeTracks(); }
    }
  }, [closeTracks, transition]);
  stopRef.current = stop;

  const record = useCallback(async () => {
    if (document.hidden || ['opening', 'recording', 'transcribing'].includes(phaseRef.current)) return;
    cancel(); setMessage(''); transition('opening');
    const id = generation.current, controller = new AbortController(); abort.current = controller;
    const current = () => alive.current && id === generation.current && !document.hidden;
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current()) { opened.getTracks().forEach(t => t.stop()); return; }
      stream.current = opened;
      const session = await startLiveTranscript([], 12000, controller.signal);
      if (!current()) { session.cancel(); opened.getTracks().forEach(t => t.stop()); return; }
      live.current = session;
      const silence = new VoiceSilenceClock(Date.now());
      const recorder = await startPcmAudioCapture(opened, active => {
        if (current()) { silence.update(active, Date.now()); setHeard(active); }
      }, chunk => session.send(chunk));
      if (!current()) { await recorder.cancel(); session.cancel(); opened.getTracks().forEach(t => t.stop()); return; }
      capture.current = recorder; transition('recording');
      timer.current = window.setInterval(() => {
        if (silence.decision(Date.now(), pref.current.silenceSeconds) !== 'wait') void stopRef.current();
      }, 250);
    } catch (error) {
      if (!current()) return;
      cancel();
      setMessage(error instanceof DOMException ? '마이크 사용을 허용해 주세요. 다시 말하기를 눌러 시작할 수 있어요.' : '음성 연결을 준비하지 못했어요. 말하기를 눌러 다시 시작해 주세요.');
    }
  }, [cancel, transition]);
  recordRef.current = record;

  const speak = useCallback((text: string, listen = true) => {
    if (!text || document.hidden) return;
    cancel(); setMessage(''); transition('speaking'); const id = generation.current;
    voice.current = playVarcoTts(text, VOICE, () => {
      if (!alive.current || id !== generation.current || document.hidden) return;
      voice.current = null; transition(listen ? 'idle' : 'review');
      if (listen && pref.current.autoListen) void recordRef.current();
    }, { speed: .92, pitch: .98 }, undefined, () => {
      if (!alive.current || id !== generation.current) return;
      voice.current = null; transition('idle'); setMessage('소리를 재생하지 못했어요. 다시 듣기나 말하기를 눌러 주세요.');
    });
  }, [cancel, transition]);

  const setAutoListen = useCallback((enabled: boolean) => {
    const next = { ...pref.current, autoListen: enabled }; pref.current = next; setPreferences(next);
    try { localStorage.setItem(WEB_VOICE_KEY, JSON.stringify(next)); } catch { /* preference is still active for this page */ }
    if (!enabled) { cancel(); setMessage('자동 마이크를 껐어요. 말하기를 누르면 녹음할 수 있어요.'); }
  }, [cancel]);
  const setSilenceSeconds = useCallback((seconds: 5 | 8) => {
    const next = { ...pref.current, silenceSeconds: seconds }; pref.current = next; setPreferences(next);
    try { localStorage.setItem(WEB_VOICE_KEY, JSON.stringify(next)); } catch { /* retain in memory */ }
  }, []);
  useEffect(() => {
    alive.current = true;
    const hide = () => { if (document.hidden) { cancel(); setMessage('잠시 대화를 멈췄어요. 다시 듣기나 말하기로 이어가 주세요.'); } };
    document.addEventListener('visibilitychange', hide);
    return () => { alive.current = false; document.removeEventListener('visibilitychange', hide); cancel(); };
  }, [cancel]);
  return { phase, heard, message, preferences, speak, record, stop, cancel, setAutoListen, setSilenceSeconds };
}
