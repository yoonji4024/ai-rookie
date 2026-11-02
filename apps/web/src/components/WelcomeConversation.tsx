import {useEffect,useRef,useState} from 'react';
import {WELCOME_INVITATION} from '../lib/welcomeSpeech';
import {Brand} from './MediaLibrary';
import {welcomeState,startWelcome,finishWelcome,type Account,type WelcomePlan,type WelcomeAnswer} from '../lib/portalApi';
import {useVoiceTurn,type VoiceTurnResult} from '../lib/useVoiceTurn';
import WebVoiceSettings from './WebVoiceSettings';

type Phase='loading'|'intro'|'ready'|'saving'|'error';
export default function WelcomeConversation({account,onDone,onLogout}:{account:Account;onDone:()=>void;onLogout:()=>void}){
 const [plan,setPlan]=useState<WelcomePlan|null>(null),[phase,setPhase]=useState<Phase>('loading'),[index,setIndex]=useState(0),[message,setMessage]=useState(''),[transcript,setTranscript]=useState('');
 const alive=useRef(true),answers=useRef<WelcomeAnswer[]>([]),files=useRef<File[]>([]),locked=useRef(false),advance=useRef<number>();
 const nextRef=useRef<()=>void>(()=>{});
 const p=plan?.prompts?.[index];
 const voice=useVoiceTurn((result:VoiceTurnResult)=>{
  if(!p)return;
  const name=p.id+'.wav';files.current=files.current.filter(f=>f.name!==name);
  if(result.file)files.current.push(new File([result.file],name,{type:'audio/wav'}));
  answers.current=[...answers.current.filter(a=>a.id!==p.id),{id:p.id,userAnswer:result.text,state:result.state}];
  setTranscript(result.text);
 });
 const halt=()=>{clearTimeout(advance.current);voice.cancel()};
 useEffect(()=>{alive.current=true;let current=true;void(async()=>{
  try{let value=await welcomeState();if(!current)return;if(['complete','partial','skipped'].includes(value.state)){onDone();return}
   if(value.state==='needed')value=await startWelcome(Intl.DateTimeFormat().resolvedOptions().timeZone);
   if(!current)return;setPlan(value);if(value.state!=='ready'||!value.prompts?.length)throw new Error('인사를 준비하지 못했어요. 영상을 먼저 봐도 괜찮아요.');setPhase('intro');
  }catch(e){if(current){setMessage(e instanceof Error?e.message:'인사를 준비하지 못했어요.');setPhase('error')}}
 })();return()=>{current=false;alive.current=false;clearTimeout(advance.current);voice.cancel()};},[]);
 useEffect(()=>{
  if(phase==='intro')voice.speak(WELCOME_INVITATION,false);
  else if(phase==='ready'&&p)voice.speak(p.question);
  return()=>voice.cancel();
 },[phase,index,plan?.id,voice.speak,voice.cancel]);
 const finish=async()=>{
  if(locked.current||!plan?.id)return;locked.current=true;halt();setPhase('saving');setMessage('');
  try{await finishWelcome(plan.id,answers.current,files.current);if(alive.current)onDone()}
  catch(e){if(alive.current){setMessage(e instanceof Error?e.message:'기록 저장을 확인하지 못했어요.');setPhase('error')}}finally{locked.current=false}
 };
 const next=()=>{halt();setMessage('');setTranscript('');if(index+1<(plan?.prompts?.length??0))setIndex(i=>i+1);else void finish()};
 nextRef.current=next;
 useEffect(()=>{
  if(phase!=='ready'||voice.phase!=='review'||!transcript||!voice.preferences.autoListen)return;
  advance.current=window.setTimeout(()=>{if(!document.hidden)nextRef.current()},4500);
  return()=>clearTimeout(advance.current);
 },[phase,voice.phase,voice.preferences.autoListen,transcript,index]);
 const reviewing=voice.phase==='review',recording=voice.phase==='recording';
 const working=['opening','transcribing'].includes(voice.phase);
 const last=index+1>=(plan?.prompts?.length??0);
 return <div className="ee-app"><header className="ee-header"><Brand/><button className="ee-secondary" onClick={()=>{halt();onLogout()}}>로그아웃</button></header><main className="ee-hello"><p className="ee-hello-greeting">반가워요, <strong>{account.displayName} 님</strong></p><div className="ee-hello-card">
 {phase==='loading'?<p role="status">인사를 준비하고 있어요.</p>:phase==='intro'?<><div className="ee-hello-mark" aria-hidden>♪</div><h1><em className="ee-hl">영상을 보기 전에,</em><br/>잠깐 이야기 나눌까요?</h1><p>오늘 하루와 계신 곳 이야기를 듣고 싶어요.<br/>편하게 말씀해 주세요.</p>{voice.message&&<><p role="status">{voice.message}</p><button className="ee-text-button" onClick={()=>voice.speak(WELCOME_INVITATION,false)}>인사 다시 듣기</button></>}<button className="ee-primary" onClick={()=>setPhase('ready')}>좋아요, 이야기해요</button><button className="ee-text-button" onClick={()=>void finish()}>영상을 먼저 볼게요</button><small className="ee-hello-privacy">말씀하신 목소리는 기록으로 남고, 연결을 허용한 가족과 함께 볼 수 있어요.</small></>:
 phase==='saving'?<p role="status">이야기를 남겨두고 있어요.</p>:phase==='error'?<><h1>영상을 먼저 봐도 괜찮아요.</h1><p className="ee-form-error" role="alert">{message}</p>{plan?.state==='ready'&&<button className="ee-secondary" onClick={()=>void finish()}>기록 저장 다시 확인</button>}<button className="ee-primary" onClick={onDone}>영상 보러 가기</button></>:
 <><div className="ee-hello-dots" aria-label={`${index+1}번째 이야기`}>{plan?.prompts?.map((item,i)=><i key={item.id} className={index===i?'active':''}/>)}</div><h1>{p?.question}</h1>
 <p className="ee-hello-status" role="status">{voice.phase==='opening'?'마이크를 연결하고 있어요.':recording?(voice.heard?'네, 듣고 있어요.':`편하게 말씀해 주세요. 말씀을 마치고 ${voice.preferences.silenceSeconds}초 쉬면 자동으로 마쳐요.`):voice.phase==='transcribing'?'말씀을 글로 확인하고 있어요.':voice.phase==='speaking'?'두리가 이야기하고 있어요.':voice.message||'천천히 떠올려도 괜찮아요.'}</p>
 {transcript&&<p className="ee-hello-transcript">{transcript}</p>}
 <div className="ee-hello-actions">{!working&&!recording&&voice.phase!=='speaking'&&<><button className="ee-secondary" onClick={()=>{clearTimeout(advance.current);if(p)voice.speak(p.question,!transcript)}}>다시 듣기</button><button className={reviewing?'ee-secondary':'ee-primary'} onClick={()=>{clearTimeout(advance.current);setTranscript('');void voice.record()}}>{reviewing?'다시 말하기':'말하기'}</button></>}{recording&&<button className="ee-primary" onClick={()=>void voice.stop()}>말 다 했어요</button>}{!working&&!recording&&<button className={reviewing?'ee-primary':'ee-secondary'} onClick={next}>{last?'영상 보러 가기':reviewing?'다음으로':'이 이야기는 건너뛸게요'}</button>}</div><button className="ee-text-button" disabled={working||recording} onClick={()=>void finish()}>오늘은 여기까지 이야기할게요</button><small>말하기 어려운 이야기는 편하게 건너뛰어도 괜찮아요.</small></>}
 {['intro','ready'].includes(phase)&&<WebVoiceSettings preferences={voice.preferences} onAuto={voice.setAutoListen} onSilence={voice.setSilenceSeconds}/>}
 </div></main></div>;
}
