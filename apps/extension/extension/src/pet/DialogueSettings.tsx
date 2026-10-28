import {useEffect,useState} from 'react';
import {DEFAULT_PREFERENCES,PREFERENCES_KEY,readPreferences,type DialoguePreferences} from './dialoguePreferences';
export default function DialogueSettings(){
  const [prefs,setPrefs]=useState(DEFAULT_PREFERENCES),[ready,setReady]=useState(false),[error,setError]=useState('');
  useEffect(()=>{void chrome.storage.local.get(PREFERENCES_KEY).then(b=>{setPrefs(readPreferences(b[PREFERENCES_KEY]));setReady(true);}).catch(()=>setError('설정을 불러오지 못했어요. 다시 열어 주세요.'));},[]);
  const update=async(change:Partial<DialoguePreferences>)=>{const next=readPreferences({...prefs,...change});try{await chrome.storage.local.set({[PREFERENCES_KEY]:next});setPrefs(next);setError('');}catch{setError('설정을 저장하지 못했어요.');}};
  return <section className="dialogue-settings" aria-label="소리와 마이크 설정"><h2>소리와 마이크</h2>
    <label><span>두리가 자동으로 말하기</span><input type="checkbox" checked={prefs.autoVoice} disabled={!ready} onChange={e=>void update({autoVoice:e.target.checked})}/></label>
    <label><span>두리의 말이 끝나면 마이크 켜기</span><input type="checkbox" checked={prefs.autoListen} disabled={!ready} onChange={e=>void update({autoListen:e.target.checked})}/></label>
    <p>‘인사 나누기’ 또는 ‘함께 보기’로 시작한 대화에서만 켜져요. 영상 시청 중에는 꺼져요. 처음에는 브라우저의 마이크 허용이 필요해요.</p>
    <label><span>말이 끝나면 자동으로 마치기</span><input type="checkbox" checked={prefs.autoFinish} disabled={!ready} onChange={e=>void update({autoFinish:e.target.checked})}/></label>
    <label>생각할 시간<select value={prefs.silenceSeconds} disabled={!ready} onChange={e=>void update({silenceSeconds:Number(e.target.value) as 5|8})}><option value={8}>말씀 후 8초 기다리기</option><option value={5}>말씀 후 5초 기다리기</option></select></label>
    <label>두리 목소리 크기<input aria-label="두리 목소리 크기" type="range" min="0" max="1" step=".1" value={prefs.volume} disabled={!ready} onChange={e=>void update({volume:Number(e.target.value)})}/></label>
    <label>말하는 빠르기<select value={prefs.speed} disabled={!ready} onChange={e=>void update({speed:Number(e.target.value)})}><option value={.8}>천천히</option><option value={.92}>편안하게</option><option value={1.1}>조금 빠르게</option></select></label>
    <p>자동 마이크를 켜면 인식한 말씀을 보여준 뒤 다음 대화로 이어져요. 소리를 끈 경우에는 ‘말하기’를 눌러 주세요.</p>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
