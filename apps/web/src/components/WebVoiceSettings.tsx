import type { VoicePreferences } from '../lib/voiceTurnPolicy';
export default function WebVoiceSettings({ preferences, onAuto, onSilence }: {
  preferences: VoicePreferences; onAuto: (enabled: boolean) => void; onSilence: (seconds: 5 | 8) => void;
}) {
  return <details className="ee-web-voice-settings"><summary>음성 설정</summary>
    <label><input type="checkbox" checked={preferences.autoListen} onChange={e => onAuto(e.target.checked)} /> 질문이 끝나면 자동으로 마이크 켜기</label>
    <label>말씀을 마친 뒤 기다리는 시간 <select value={preferences.silenceSeconds} onChange={e => onSilence(Number(e.target.value) === 8 ? 8 : 5)}><option value={5}>5초</option><option value={8}>8초</option></select></label>
    <small>영상 시청 중에는 마이크가 꺼져요. 처음에는 브라우저의 마이크 허용이 필요해요.</small>
  </details>;
}
