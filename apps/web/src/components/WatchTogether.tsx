import {useEffect,useRef,useState} from 'react';
import {nextWatchCue,requiredWatchEnd,cueIsAligned,formatVideoTime,type WatchCue} from '../lib/watchTimeline';
import Duri from "./Duri";
import {Brand} from './MediaLibrary';
import {saveWatch,type WatchPlan} from '../lib/portalApi';
import {fetchEmpatheticReply,type AnswerInput} from '../lib/scoreApi';
import {useVoiceTurn,type VoiceTurnResult} from '../lib/useVoiceTurn';
import WebVoiceSettings from './WebVoiceSettings';
import {nextDemoPosition} from '../lib/demoMode';

type Prompt=WatchPlan['prompts'][number];
type Player={getCurrentTime?:()=>number;getDuration?:()=>number;getPlayerState?:()=>number;playVideo?:()=>void;pauseVideo?:()=>void;seekTo?:(time:number,allow:boolean)=>void;destroy?:()=>void};
type YTApi={Player:new(element:HTMLElement,options?:object)=>Player};
type PlaybackFailure={message:string;retryable:boolean};
function playbackFailure(code?:number):PlaybackFailure{
 if(code===101||code===150)return {message:'이 영상은 YouTube에서 다른 사이트의 재생을 허용하지 않아요. 다른 영상을 골라 함께 볼까요?',retryable:false};
 if(code===100)return {message:'이 영상은 삭제되었거나 비공개로 바뀌어 볼 수 없어요. 다른 영상을 골라 주세요.',retryable:false};
 if(code===153)return {message:'YouTube가 이 화면의 연결 정보를 확인하지 못했어요. Chrome에서 MEMFLIX를 열어 다시 시도해 주세요.',retryable:true};
 return {message:'지금 영상에 연결하지 못했어요. 다시 연결하거나 다른 영상을 골라 주세요.',retryable:true};
}
let loadingYT:Promise<YTApi>|undefined;
function youtube():Promise<YTApi>{
 const w=window as unknown as {YT?:YTApi;onYouTubeIframeAPIReady?:()=>void};
 if(w.YT?.Player)return Promise.resolve(w.YT);if(loadingYT)return loadingYT;
 loadingYT=new Promise<YTApi>((resolve,reject)=>{const timer=window.setTimeout(()=>reject(new Error('영상 연결이 늦어지고 있어요.')),15000);const before=w.onYouTubeIframeAPIReady;w.onYouTubeIframeAPIReady=()=>{before?.();window.clearTimeout(timer);if(w.YT)resolve(w.YT)};let script=document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');if(!script){script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';document.head.appendChild(script)}script.addEventListener('error',()=>{window.clearTimeout(timer);reject(new Error('영상에 연결하지 못했어요.'));},{once:true})}).catch(e=>{loadingYT=undefined;throw e});return loadingYT;
}
export default function WatchTogether({plan,onBack,demoMode=false}:{plan:WatchPlan;onBack:()=>void;demoMode?:boolean}){
 const host=useRef<HTMLDivElement>(null),player=useRef<Player|null>(null);
 const [active,setActive]=useState<Prompt|null>(null),activeRef=useRef<Prompt|null>(null),done=useRef(new Set<string>()),answers=useRef<AnswerInput[]>([]),audio=useRef<File[]>([]);
 const [ready,setReady]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0),[reply,setReply]=useState(''),[caption,setCaption]=useState(''),[saveState,setSaveState]=useState<'idle'|'saving'|'saved'|'error'>('idle'),[finished,setFinished]=useState(false);
 const [videoFailure,setVideoFailure]=useState<PlaybackFailure|null>(null),[playback,setPlayback]=useState<'loading'|'ready'|'playing'|'paused'|'buffering'|'ended'>('loading');
 const failedPlayback=useRef(false),playbackEpoch=useRef(0);
 const begun=useRef(false),ended=useRef(false),position=useRef(plan.segment.start),mounted=useRef(true),saving=useRef(false),saveAttempted=useRef(false);
 const open=useRef<(p:Prompt)=>void>(()=>{}),finish=useRef<(skip?:boolean)=>Promise<void>>(async()=>{});
 const replyRequest=useRef<AbortController|null>(null),advanceTimer=useRef<number>();
 const clearReply=()=>{replyRequest.current?.abort();replyRequest.current=null;clearTimeout(advanceTimer.current)};
 const voice=useVoiceTurn((result:VoiceTurnResult)=>{
  const p=activeRef.current;if(!p||failedPlayback.current)return;
  const file=result.file?new File([result.file],`${p.id}.wav`,{type:'audio/wav'}):null;
  audio.current=audio.current.filter(f=>f.name!==`${p.id}.wav`);if(file)audio.current.push(file);
  const item:AnswerInput={id:p.id,question:p.question,userAnswer:result.text,videoTimestamp:position.current,transcriptSource:'recorded',answerKeywords:[],...(file?{audioFilename:file.name}:{})};
  answers.current=[...answers.current.filter(a=>a.id!==p.id),item];setCaption(result.text);
  if(result.state!=='recorded')return;
  // Empathy is supplemental: a slow provider never holds the next action hostage.
  const controller=new AbortController();replyRequest.current=controller;
  const timeout=window.setTimeout(()=>controller.abort(),3000);
  void fetchEmpatheticReply({questionId:p.id,question:p.question,userAnswer:result.text,correctAnswer:'',answerKeywords:[],signal:controller.signal}).then(text=>{
   if(mounted.current&&!controller.signal.aborted&&activeRef.current?.id===p.id)setReply(text);
  }).catch(()=>{}).finally(()=>window.clearTimeout(timeout));
 });
 const state=voice.phase==='recording'?'listening':voice.phase==='transcribing'?'processing':voice.phase;
 const failPlayback=(failure:PlaybackFailure)=>{
  player.current?.pauseVideo?.();
  failedPlayback.current=true;playbackEpoch.current+=1;begun.current=false;clearReply();voice.cancel();
  setVideoFailure(failure);setReady(false);setError('');setFinished(false);
  activeRef.current=null;setActive(null);setCaption('');setReply('');
 };
 const persist=async()=>{if(saving.current||saveAttempted.current)return;saveAttempted.current=true;saving.current=true;setSaveState('saving');try{await saveWatch(plan.id,answers.current,audio.current);if(mounted.current)setSaveState('saved')}catch{if(mounted.current)setSaveState('error')}finally{saving.current=false}};
 const checkTimeline=useRef<()=>void>(()=>{}),syncing=useRef(false);
 finish.current=async(skip=false)=>{
  const p=activeRef.current;if(!p||state==='processing'||failedPlayback.current)return;
  voice.cancel();clearReply();
  if(skip&&!answers.current.some(a=>a.id===p.id))answers.current.push({id:p.id,question:p.question,userAnswer:'',videoTimestamp:position.current,transcriptSource:'recorded'});
  done.current.add(p.id);activeRef.current=null;setActive(null);setCaption('');setReply('');setError('');
  if(done.current.size===plan.prompts.length){void persist();if(ended.current)setFinished(true);else player.current?.playVideo?.();return;}
  checkTimeline.current();if(!activeRef.current&&!syncing.current&&!ended.current)player.current?.playVideo?.();
 };
 open.current=(p)=>{
  if(activeRef.current||failedPlayback.current)return;player.current?.pauseVideo?.();activeRef.current=p;setActive(p);setError('');setCaption('');setReply('');
  voice.speak(p.question);
 };
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearReply();voice.cancel()}},[voice.cancel]);
 useEffect(()=>{
  if(voice.phase!=='review'||!caption||!voice.preferences.autoListen||!active)return;
  const id=active.id;
  advanceTimer.current=window.setTimeout(()=>{if(!document.hidden&&activeRef.current?.id===id)void finish.current()},4500);
  return()=>clearTimeout(advanceTimer.current);
 },[voice.phase,voice.preferences.autoListen,caption,active?.id]);
 useEffect(()=>{
  let disposed=false,poll:number|undefined;playbackEpoch.current+=1;failedPlayback.current=false;setVideoFailure(null);setReady(false);setPlayback('loading');setError('');begun.current=false;ended.current=false;
  const fail=(failure:PlaybackFailure)=>{if(disposed)return;window.clearTimeout(timeout);window.clearInterval(poll);failPlayback(failure)};
  const timeout=window.setTimeout(()=>fail({message:'영상 연결이 늦어지고 있어요. 다시 연결하거나 다른 영상을 골라 주세요.',retryable:true}),20000);
  let pending:{cue:WatchCue;since:number}|null=null;syncing.current=false;
  const tick=()=>{
   const p=player.current;if(disposed||failedPlayback.current||!p||!begun.current)return;
   const actual=p.getCurrentTime?.()??position.current,playerState=p.getPlayerState?.(),duration=p.getDuration?.()??0;
   if(!Number.isFinite(actual))return;
   if(duration>0&&Number.isFinite(duration)&&duration+.75<requiredWatchEnd(plan)){
    fail({message:'영상 길이가 등록된 시청 구간과 맞지 않아요. 다른 영상을 골라 주세요.',retryable:false});return;
   }
   if(activeRef.current){p.pauseVideo?.();if(Math.abs(actual-position.current)>.75)p.seekTo?.(position.current,true);return;}
   if(pending){
    p.pauseVideo?.();
    if(!cueIsAligned(pending.cue,actual,playerState)){
     if(Date.now()-pending.since>8000)fail({message:'질문 장면으로 이동하지 못했어요. 다시 연결해 주세요.',retryable:true});
     return;
    }
    const cue=pending.cue;pending=null;syncing.current=false;position.current=cue.time;
    ended.current=plan.segment.end!==null?cue.time>=plan.segment.end:playerState===0;
    open.current(cue.prompt);return;
   }
   position.current=actual;
   if(actual<plan.segment.start-.75){ended.current=false;if(playerState===1)p.seekTo?.(plan.segment.start,true);return;}
   ended.current=plan.segment.end!==null?actual>=plan.segment.end:playerState===0&&(duration===0||actual>=duration-.75);
   const cue=nextWatchCue(plan,done.current,actual,ended.current);
   if(cue){
    // Do not ask an earlier question over an unrelated frame after a forward seek.
    pending={cue,since:Date.now()};syncing.current=true;p.pauseVideo?.();
    if(Math.abs(actual-cue.time)>.75)p.seekTo?.(cue.time,true);
    else if(cueIsAligned(cue,actual,playerState)){pending=null;syncing.current=false;position.current=cue.time;open.current(cue.prompt)}
   }else if(ended.current){p.pauseVideo?.();setFinished(true);void persist()}
  };
  checkTimeline.current=tick;
  const cleanup=()=>{disposed=true;checkTimeline.current=()=>{};window.clearTimeout(timeout);window.clearInterval(poll);player.current?.destroy?.();player.current=null;};
  if(plan.localVideo&&host.current){
   const source=plan.localVideo,video=document.createElement('video');
   video.controls=true;video.playsInline=true;video.preload='metadata';video.setAttribute('aria-label',plan.title);
   const listeners:[string,EventListener][]=[];
   const listen=(name:string,handler:()=>void)=>{listeners.push([name,handler]);video.addEventListener(name,handler)};
   const current=()=>!disposed&&!failedPlayback.current;
   listen('loadedmetadata',()=>{
    if(!current())return;
    const requiredEnd=Math.max(plan.segment.start,plan.segment.end??0,...plan.prompts.filter(p=>p.delivery==='at_time').map(p=>p.timestamp));
    if(!Number.isFinite(video.duration)||source.sourceStartSeconds>plan.segment.start||source.sourceStartSeconds+video.duration<requiredEnd){fail({message:'이 영상 파일에는 함께 볼 장면이 모두 들어 있지 않아요. 다른 영상을 골라 주세요.',retryable:false});return;}
    video.currentTime=Math.max(0,position.current-source.sourceStartSeconds);
    window.clearTimeout(timeout);setReady(true);setPlayback('ready');setError('');
   });
   listen('playing',()=>{if(!current())return;begun.current=true;setPlayback('playing');tick()});
   listen('pause',()=>{if(current())setPlayback('paused')});
   listen('waiting',()=>{if(current())setPlayback('buffering')});
   listen('timeupdate',tick);listen('seeked',tick);
   listen('ended',()=>{if(!current()||!begun.current)return;ended.current=true;setPlayback('ended');tick()});
   listen('error',()=>fail({message:video.error?.code===3||video.error?.code===4?'영상 파일을 재생할 수 없어요. 다른 영상을 골라 주세요.':'영상 파일을 불러오지 못했어요. 다시 연결하거나 다른 영상을 골라 주세요.',retryable:video.error?.code!==3&&video.error?.code!==4}));
   player.current={
    getCurrentTime:()=>video.currentTime+source.sourceStartSeconds,
    getDuration:()=>video.duration+source.sourceStartSeconds,
    getPlayerState:()=>video.ended?0:video.paused?2:1,
    playVideo:()=>{void video.play().catch(e=>{if(!current())return;if(e?.name==='NotAllowedError')setError('영상 안의 재생 버튼을 눌러 주세요.');else if(e?.name!=='AbortError')fail({message:'영상 파일을 재생하지 못했어요. 다시 연결하거나 다른 영상을 골라 주세요.',retryable:true})})},
    pauseVideo:()=>video.pause(),
    seekTo:t=>{video.currentTime=Math.max(0,t-source.sourceStartSeconds)},
    destroy:()=>{listeners.forEach(([name,handler])=>video.removeEventListener(name,handler));video.pause();video.removeAttribute('src');video.load();video.remove()},
   };
   host.current.replaceChildren(video);video.src=source.url;video.load();poll=window.setInterval(tick,300);
   return cleanup;
  }
  youtube().then(YT=>{if(disposed||failedPlayback.current||!host.current)return;
   // An explicit iframe keeps its referrer policy and visible controls independent
   // of the API load. It stays inside this site; no automatic external navigation.
   const frame=document.createElement('iframe');frame.title=plan.title;frame.allow='autoplay; encrypted-media; picture-in-picture; fullscreen';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
   const params=new URLSearchParams({enablejsapi:'1',origin:window.location.origin,playsinline:'1',rel:'0',start:String(Math.floor(position.current)),controls:'1'});
   frame.src=`https://www.youtube.com/embed/${plan.youtubeId}?${params}`;host.current.replaceChildren(frame);
   player.current=new YT.Player(frame,{events:{onReady:()=>{if(disposed||failedPlayback.current)return;window.clearTimeout(timeout);setReady(true);setPlayback('ready');setError('');poll=window.setInterval(tick,300)},onStateChange:(e:{data:number})=>{if(disposed||failedPlayback.current)return;if(e.data===1){setPlayback('playing');begun.current=true;tick()}else if(e.data===2)setPlayback('paused');else if(e.data===3)setPlayback('buffering');else if(e.data===5||e.data===-1)setPlayback('ready');if(e.data===0&&begun.current){setPlayback('ended');ended.current=true;tick()}},onError:(e:{data:number})=>{if(!disposed){console.warn('MEMFLIX video player error',e.data);fail(playbackFailure(e.data))}}}});
  }).catch(()=>fail(playbackFailure()));
  return cleanup;
 // Plan is immutable for a session. Callback refs avoid stale recording state.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[plan.id,retry]);
 const leave=async()=>{if(state==='processing'||saving.current)return;voice.cancel();clearReply();if(answers.current.length&&saveState==='idle')await persist();onBack()};
 const jumpToNext=()=>{
  if(!demoMode||!ready||activeRef.current||failedPlayback.current||saving.current||finished)return;
  const p=player.current;if(!p?.seekTo||!p.playVideo)return;
  const target=nextDemoPosition(plan,done.current,p.getCurrentTime?.()??position.current,p.getDuration?.());
  if(target===null){setError('영상 길이를 확인한 뒤 다시 눌러 주세요.');return;}
  setError('');p.seekTo(target,true);p.playVideo();
 };
 const status=videoFailure?'영상을 재생할 수 없어요':finished?'시청을 마쳤어요':state==='listening'?(voice.heard?'말씀을 듣고 있어요':'편하게 말씀해 주세요'):state==='processing'?'말씀을 글로 확인하고 있어요':state==='opening'?'마이크를 연결하고 있어요':state==='review'?'말씀하신 내용을 확인해 주세요':state==='speaking'?'함께 이야기하는 중':playback==='playing'?'함께 보는 중':playback==='buffering'?'영상을 불러오고 있어요':playback==='paused'?'영상을 잠시 멈췄어요':ready?'재생 버튼을 눌러 주세요':'영상을 준비하고 있어요';
 return <div className={`ee-app ee-watch-app${demoMode?' ee-demo-mode':''}`}>
  <header className="ee-header"><Brand/><span className="ee-watch-title">{plan.title}</span><button className="ee-secondary" disabled={state==='processing'||saveState==='saving'} onClick={()=>void leave()}>다른 영상 보기</button></header>
  <main className="ee-watch-main">
   <p className="ee-watch-footnote">함께 볼 구간 {formatVideoTime(plan.segment.start)}–{plan.segment.end===null?'영상 끝':formatVideoTime(plan.segment.end)}{plan.prompts.every(p=>p.delivery==='after_segment')?' · 이 구간을 본 뒤 이야기해요.':' · 질문할 때 영상이 잠시 멈춰요.'}</p>
   {demoMode&&<aside className="ee-demo-notice" aria-label="시연 모드"><strong>시연 모드</strong><span>다음 대화 구간으로 이동해 장면을 짧게 본 뒤 이야기를 나눠요.</span></aside>}
   <div className="ee-watch-stage">
    <div className="ee-player-host ee-live-player" ref={host}/>
    {videoFailure&&<section className="ee-watch-message ee-playback-error" role="alert"><div><h2>다른 영상으로 함께 볼까요?</h2><p>{videoFailure.message}</p></div><div className="ee-playback-actions"><button className="ee-primary" disabled={saveState==='saving'} onClick={()=>void leave()}>다른 영상 고르기</button>{videoFailure.retryable&&<button className="ee-secondary" disabled={saveState==='saving'} onClick={()=>setRetry(r=>r+1)}>다시 연결하기</button>}</div></section>}
    {error&&!videoFailure&&<div className="ee-watch-message" role="status"><p>{error}</p></div>}
    {finished&&!videoFailure&&<div className="ee-watch-finish"><h2>함께 봐서 즐거웠어요.</h2><p>{saveState==='saving'?'오늘의 이야기를 정리하고 있어요.':saveState==='saved'?'오늘의 이야기를 기록해 두었어요.':saveState==='error'?'연결이 끊겨 기록 완료 여부를 확인하지 못했어요. 가족 화면에서 확인해 주세요.':'또 다른 이야기를 만나볼까요?'}</p><button className="ee-primary" disabled={saveState==='saving'} onClick={()=>void leave()}>다른 영상 함께 보기</button></div>}
   </div>
   <div className="ee-watch-controls"><div role="status"><span className="ee-small-dot"/><span>{status}</span></div>{!videoFailure&&!finished&&<div>{demoMode&&<button className="ee-primary" disabled={!ready||Boolean(active)||saveState==='saving'||done.current.size===plan.prompts.length} onClick={jumpToNext}>다음 대화 구간</button>}<button className="ee-secondary" disabled={!ready||Boolean(active)} onClick={()=>player.current?.playVideo?.()}>영상 재생</button><button className={voice.preferences.autoListen?'ee-primary':'ee-secondary'} onClick={()=>voice.setAutoListen(!voice.preferences.autoListen)}>{voice.preferences.autoListen?'자동 마이크 켜짐':'자동 마이크 꺼짐'}</button></div>}</div>
   {active&&!videoFailure&&<section className="ee-spoken-card" aria-label="함께 나누는 이야기"><div className="ee-spoken-avatar"><Duri size={64}/></div><div className="ee-spoken-body"><small>{active.delivery==='at_time'?`${formatVideoTime(active.timestamp)} 장면 이야기`:active.delivery==='after_segment'?'방금 함께 본 구간 이야기':'시청을 마친 뒤 이야기'}</small><p className="ee-spoken-prompt">{active.question}</p>{caption&&<p className="ee-spoken-answer">{caption}</p>}{reply&&<p className="ee-spoken-reply">{reply}</p>}<p role="status">{voice.message || (state==='listening'?`말씀을 마치고 ${voice.preferences.silenceSeconds}초 쉬면 자동으로 마쳐요.`:'')}</p><div className="ee-spoken-actions">
   {state==='listening'?<button className="ee-primary" onClick={()=>void voice.stop()}>말 다했어요</button>:!['processing','opening','speaking'].includes(state)&&<><button className={caption?'ee-secondary':'ee-primary'} onClick={()=>{clearReply();setCaption('');setReply('');void voice.record()}}>{caption?'다시 말하기':'말하기'}</button><button className="ee-secondary" onClick={()=>{clearReply();voice.speak(active.question,!caption)}}>다시 듣기</button></>}
   {caption&&state==='review'?<button className="ee-primary" onClick={()=>void finish.current()}>{ended.current?'다음으로':'영상 이어 보기'}</button>:<button className="ee-text-button" disabled={state==='processing'} onClick={()=>void finish.current(true)}>이 이야기는 넘어갈게요</button>}
   </div></div></section>}
   {!videoFailure&&<WebVoiceSettings preferences={voice.preferences} onAuto={voice.setAutoListen} onSilence={voice.setSilenceSeconds}/>}
   {!videoFailure&&<p className="ee-watch-footnote">말씀하실 때만 목소리를 기록해요. 마이크를 끄고 편하게 시청하셔도 괜찮아요.</p>}
  </main>
 </div>
}
