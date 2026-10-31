import {useEffect,useRef,useState} from 'react';
import Duri from "./Duri";
import {Brand} from './MediaLibrary';
import {saveWatch,type WatchPlan} from '../lib/portalApi';
import {fetchEmpatheticReply,fetchTranscript,type AnswerInput} from '../lib/scoreApi';
import {startPcmAudioCapture,recordingHasVoice,type PcmAudioCapture} from '../lib/audioRecorder';
import {playVarcoTts} from '../lib/varcoTts';

type Prompt=WatchPlan['prompts'][number];
type Player={getCurrentTime?:()=>number;getPlayerState?:()=>number;playVideo?:()=>void;pauseVideo?:()=>void;seekTo?:(time:number,allow:boolean)=>void;destroy?:()=>void};
type YTApi={Player:new(element:HTMLElement,options?:object)=>Player};
type PlaybackFailure={message:string;retryable:boolean};
function playbackFailure(code?:number):PlaybackFailure{
 if(code===101||code===150)return {message:'이 영상은 YouTube에서 다른 사이트의 재생을 허용하지 않아요. 다른 영상을 골라 함께 볼까요?',retryable:false};
 if(code===100)return {message:'이 영상은 삭제되었거나 비공개로 바뀌어 볼 수 없어요. 다른 영상을 골라 주세요.',retryable:false};
 if(code===153)return {message:'YouTube가 이 화면의 연결 정보를 확인하지 못했어요. Chrome에서 MEMFLIX를 열어 다시 시도해 주세요.',retryable:true};
 return {message:'지금 영상에 연결하지 못했어요. 다시 연결하거나 다른 영상을 골라 주세요.',retryable:true};
}
const VOICE='3278b908-86ee-5c30-bb55-24b5b1bbc67b';
let loadingYT:Promise<YTApi>|undefined;
function youtube():Promise<YTApi>{
 const w=window as unknown as {YT?:YTApi;onYouTubeIframeAPIReady?:()=>void};
 if(w.YT?.Player)return Promise.resolve(w.YT);if(loadingYT)return loadingYT;
 loadingYT=new Promise<YTApi>((resolve,reject)=>{const timer=window.setTimeout(()=>reject(new Error('영상 연결이 늦어지고 있어요.')),15000);const before=w.onYouTubeIframeAPIReady;w.onYouTubeIframeAPIReady=()=>{before?.();window.clearTimeout(timer);if(w.YT)resolve(w.YT)};let script=document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');if(!script){script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';document.head.appendChild(script)}script.addEventListener('error',()=>{window.clearTimeout(timer);reject(new Error('영상에 연결하지 못했어요.'));},{once:true})}).catch(e=>{loadingYT=undefined;throw e});return loadingYT;
}
export default function WatchTogether({plan,onBack}:{plan:WatchPlan;onBack:()=>void}){
 const host=useRef<HTMLDivElement>(null),player=useRef<Player|null>(null),stream=useRef<MediaStream|null>(null),capture=useRef<PcmAudioCapture|null>(null),voiceStop=useRef<(()=>void)|null>(null);
 const [active,setActive]=useState<Prompt|null>(null),activeRef=useRef<Prompt|null>(null),done=useRef(new Set<string>()),answers=useRef<AnswerInput[]>([]),audio=useRef<File[]>([]);
 const [ready,setReady]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0),[mic,setMic]=useState(false),[state,setState]=useState<'watching'|'speaking'|'listening'|'processing'>('watching'),[heard,setHeard]=useState(false),[reply,setReply]=useState(''),[caption,setCaption]=useState(''),[saveState,setSaveState]=useState<'idle'|'saving'|'saved'|'error'>('idle'),[finished,setFinished]=useState(false);
 const [videoFailure,setVideoFailure]=useState<PlaybackFailure|null>(null),[playback,setPlayback]=useState<'loading'|'ready'|'playing'|'paused'|'buffering'|'ended'>('loading');
 const failedPlayback=useRef(false),playbackEpoch=useRef(0);
 const begun=useRef(false),ended=useRef(false),position=useRef(plan.segment.start),busy=useRef(false),mounted=useRef(true),saving=useRef(false),saveAttempted=useRef(false),timer=useRef<number>(),recordStarted=useRef(0),lastVoice=useRef(0),hasVoice=useRef(false);
 const open=useRef<(p:Prompt)=>void>(()=>{}),record=useRef<()=>Promise<void>>(async()=>{}),stop=useRef<()=>Promise<void>>(async()=>{}),finish=useRef<(skip?:boolean)=>Promise<void>>(async()=>{});
 const closeTracks=()=>{stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;setMic(false)};
 const failPlayback=(failure:PlaybackFailure)=>{
  failedPlayback.current=true;playbackEpoch.current+=1;begun.current=false;busy.current=false;
  setVideoFailure(failure);setReady(false);setError('');setFinished(false);setState('watching');setHeard(false);
  voiceStop.current?.();voiceStop.current=null;window.clearInterval(timer.current);
  void capture.current?.cancel();capture.current=null;closeTracks();
  activeRef.current=null;setActive(null);setCaption('');setReply('');
 };
 const persist=async()=>{if(saving.current||saveAttempted.current)return;saveAttempted.current=true;saving.current=true;setSaveState('saving');try{await saveWatch(plan.id,answers.current,audio.current);if(mounted.current)setSaveState('saved')}catch{if(mounted.current)setSaveState('error')}finally{saving.current=false}};
 const due=()=>plan.prompts.find(p=>!done.current.has(p.id)&&(p.delivery==='after_video'?ended.current:p.delivery==='after_segment'?ended.current||(plan.segment.end!==null&&position.current>=plan.segment.end):position.current>=p.timestamp));
 finish.current=async(skip=false)=>{
  const p=activeRef.current;if(!p||busy.current||failedPlayback.current)return;const epoch=playbackEpoch.current;
  voiceStop.current?.();voiceStop.current=null;window.clearInterval(timer.current);await capture.current?.cancel();capture.current=null;
  if(!mounted.current||failedPlayback.current||epoch!==playbackEpoch.current)return;
  if(skip&&!answers.current.some(a=>a.id===p.id))answers.current.push({id:p.id,question:p.question,userAnswer:'',videoTimestamp:position.current,transcriptSource:'recorded'});
  done.current.add(p.id);activeRef.current=null;setActive(null);setCaption('');setReply('');setState('watching');setError('');
  if(done.current.size===plan.prompts.length){void persist();if(ended.current)setFinished(true);else player.current?.playVideo?.();return;}
  const next=due();if(next){open.current(next);return;}if(!ended.current)player.current?.playVideo?.();
 };
 stop.current=async()=>{
  const p=activeRef.current,c=capture.current;if(!p||!c||busy.current||failedPlayback.current)return;const epoch=playbackEpoch.current;const current=()=>mounted.current&&!failedPlayback.current&&epoch===playbackEpoch.current;capture.current=null;window.clearInterval(timer.current);busy.current=true;setState('processing');
  try{
   const result=await c.stop();if(!current())return;setHeard(false);
   if(!recordingHasVoice(result)){setError('편하실 때 말씀해 주세요. 그냥 이어서 보셔도 괜찮아요.');setState('watching');return;}
   const file=new File([result.blob],`${p.id}.wav`,{type:'audio/wav'});audio.current=[...audio.current.filter(f=>f.name!==file.name),file];
   const item:AnswerInput={id:p.id,question:p.question,userAnswer:'',audioFilename:file.name,videoTimestamp:position.current,transcriptSource:'recorded',answerKeywords:[]};answers.current=[...answers.current.filter(a=>a.id!==p.id),item];
   try{item.userAnswer=await fetchTranscript(file,[]);if(!item.userAnswer.trim())throw new Error('인식된 말씀이 없어요. 다시 말씀해 주세요.')}catch(error){if(current()){setError(error instanceof Error&&error.name!=='AbortError'?error.message:'말씀을 글로 바꾸는 데 시간이 오래 걸려 중단했어요. 다시 말씀해 주세요.');setState('watching')}return;}
   if(!current())return;setCaption(item.userAnswer??'');
   let response='이야기해 주셔서 고마워요. 우리 이어서 볼까요?';
   const controller=new AbortController(),timeout=window.setTimeout(()=>controller.abort(),10000);
   try{response=await fetchEmpatheticReply({questionId:p.id,question:p.question,userAnswer:item.userAnswer??'',correctAnswer:'',answerKeywords:[],signal:controller.signal})}catch{/* one request only; do not retry uncertain completions */}finally{window.clearTimeout(timeout)}
   if(!current())return;setReply(response);setState('speaking');voiceStop.current=playVarcoTts(response,VOICE,()=>{if(current()){busy.current=false;void finish.current()}},{speed:.92,pitch:.98},undefined,error=>{if(current()){busy.current=false;setState('watching');setError(error.message)}});
  }catch{if(current()){setError('목소리를 저장하지 못했어요. 다시 말씀해 주시겠어요?');setState('watching')}}finally{if(current())busy.current=false}
 };
 record.current=async()=>{
  if(!activeRef.current||capture.current||busy.current||failedPlayback.current)return;const epoch=playbackEpoch.current;const current=()=>mounted.current&&!failedPlayback.current&&epoch===playbackEpoch.current;voiceStop.current?.();voiceStop.current=null;setError('');
  try{if(!stream.current?.active){const opened=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});if(!current()){opened.getTracks().forEach(t=>t.stop());return;}stream.current=opened;setMic(true)}hasVoice.current=false;recordStarted.current=Date.now();lastVoice.current=Date.now();const recording=await startPcmAudioCapture(stream.current,on=>{if(!current())return;setHeard(on);if(on){hasVoice.current=true;lastVoice.current=Date.now()}});if(!current()){await recording.cancel();return;}capture.current=recording;setState('listening');timer.current=window.setInterval(()=>{const now=Date.now();if(now-recordStarted.current>=60000||(hasVoice.current&&now-lastVoice.current>3000)||(!hasVoice.current&&now-recordStarted.current>18000))void stop.current()},250)}catch{if(current()){setError('마이크 권한을 확인해 주세요. 영상은 계속 볼 수 있어요.');setState('watching');setMic(false)}}
 };
 open.current=(p)=>{
  if(activeRef.current||failedPlayback.current)return;const epoch=playbackEpoch.current;player.current?.pauseVideo?.();activeRef.current=p;setActive(p);setError('');setCaption('');setReply('');setState('speaking');
  voiceStop.current=playVarcoTts(p.question,VOICE,()=>{if(!mounted.current||failedPlayback.current||epoch!==playbackEpoch.current)return;if(stream.current?.active)void record.current();else setState('watching')},{speed:.92,pitch:.98},undefined,error=>{if(mounted.current&&!failedPlayback.current&&epoch===playbackEpoch.current){setState('watching');setError(error.message)}});
 };
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;window.clearInterval(timer.current);voiceStop.current?.();void capture.current?.cancel();stream.current?.getTracks().forEach(t=>t.stop())}},[]);
 useEffect(()=>{if(finished)closeTracks()},[finished]);
 useEffect(()=>{
  let disposed=false,poll:number|undefined;playbackEpoch.current+=1;failedPlayback.current=false;setVideoFailure(null);setReady(false);setPlayback('loading');setError('');begun.current=false;ended.current=false;
  const fail=(failure:PlaybackFailure)=>{if(disposed)return;window.clearTimeout(timeout);window.clearInterval(poll);failPlayback(failure)};
  const timeout=window.setTimeout(()=>fail({message:'영상 연결이 늦어지고 있어요. 다시 연결하거나 다른 영상을 골라 주세요.',retryable:true}),20000);
  const tick=()=>{const p=player.current;if(disposed||failedPlayback.current||!p||!begun.current)return;position.current=p.getCurrentTime?.()??position.current;if(activeRef.current){p.pauseVideo?.();return;}if(plan.segment.end!==null&&position.current>=plan.segment.end){ended.current=true;p.pauseVideo?.();}if(position.current<plan.segment.start-1&&p.getPlayerState?.()===1){p.seekTo?.(plan.segment.start,true);return;}const next=due();if(next)open.current(next);else if(ended.current){setFinished(true);void persist()}};
  const cleanup=()=>{disposed=true;window.clearTimeout(timeout);window.clearInterval(poll);player.current?.destroy?.();player.current=null;};
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
    getPlayerState:()=>video.ended?0:video.paused?2:1,
    playVideo:()=>{void video.play().catch(e=>{if(!current())return;if(e?.name==='NotAllowedError')setError('영상 안의 재생 버튼을 눌러 주세요.');else if(e?.name!=='AbortError')fail({message:'영상 파일을 재생하지 못했어요. 다시 연결하거나 다른 영상을 골라 주세요.',retryable:true})})},
    pauseVideo:()=>video.pause(),
    seekTo:t=>{video.currentTime=Math.max(0,t-source.sourceStartSeconds)},
    destroy:()=>{listeners.forEach(([name,handler])=>video.removeEventListener(name,handler));video.pause();video.removeAttribute('src');video.load();video.remove()},
   };
   host.current.replaceChildren(video);video.src=source.url;video.load();
   return cleanup;
  }
  youtube().then(YT=>{if(disposed||failedPlayback.current||!host.current)return;
   // An explicit iframe keeps its referrer policy and visible controls independent
   // of the API load. It stays inside this site; no automatic external navigation.
   const frame=document.createElement('iframe');frame.title=plan.title;frame.allow='autoplay; encrypted-media; picture-in-picture; fullscreen';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
   const params=new URLSearchParams({enablejsapi:'1',origin:window.location.origin,playsinline:'1',rel:'0',start:String(Math.floor(position.current)),controls:'1'});if(plan.segment.end!==null)params.set('end',String(plan.segment.end));
   frame.src=`https://www.youtube.com/embed/${plan.youtubeId}?${params}`;host.current.replaceChildren(frame);
   player.current=new YT.Player(frame,{events:{onReady:()=>{if(disposed||failedPlayback.current)return;window.clearTimeout(timeout);setReady(true);setPlayback('ready');setError('');poll=window.setInterval(tick,300)},onStateChange:(e:{data:number})=>{if(disposed||failedPlayback.current)return;if(e.data===1){setPlayback('playing');begun.current=true;tick()}else if(e.data===2)setPlayback('paused');else if(e.data===3)setPlayback('buffering');else if(e.data===5||e.data===-1)setPlayback('ready');if(e.data===0&&begun.current){setPlayback('ended');ended.current=true;tick()}},onError:(e:{data:number})=>{if(!disposed){console.warn('MEMFLIX video player error',e.data);fail(playbackFailure(e.data))}}}});
  }).catch(()=>fail(playbackFailure()));
  return cleanup;
 // Plan is immutable for a session. Callback refs avoid stale recording state.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[plan.id,retry]);
 const enableMic=async()=>{if(!ready||failedPlayback.current||finished)return;const epoch=playbackEpoch.current;try{if(mic){voiceStop.current?.();window.clearInterval(timer.current);await capture.current?.cancel();capture.current=null;closeTracks();setState('watching');return;}const opened=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});if(!mounted.current||failedPlayback.current||epoch!==playbackEpoch.current){opened.getTracks().forEach(t=>t.stop());return;}stream.current=opened;setMic(true);setError('')}catch{if(mounted.current&&!failedPlayback.current&&epoch===playbackEpoch.current)setError('마이크 사용을 허용하면 목소리로 함께 이야기할 수 있어요.')}};
 const leave=async()=>{if(busy.current||saving.current)return;voiceStop.current?.();window.clearInterval(timer.current);await capture.current?.cancel();capture.current=null;if(answers.current.length&&saveState==='idle')await persist();onBack()};
 const status=videoFailure?'영상을 재생할 수 없어요':finished?'시청을 마쳤어요':state==='listening'?(heard?'말씀을 듣고 있어요':'편하게 말씀해 주세요'):state==='processing'?'이야기를 듣고 있어요':state==='speaking'?'함께 이야기하는 중':playback==='playing'?'함께 보는 중':playback==='buffering'?'영상을 불러오고 있어요':playback==='paused'?'영상을 잠시 멈췄어요':ready?'재생 버튼을 눌러 주세요':'영상을 준비하고 있어요';
 return <div className="ee-app ee-watch-app">
  <header className="ee-header"><Brand/><span className="ee-watch-title">{plan.title}</span><button className="ee-secondary" disabled={state==='processing'||saveState==='saving'} onClick={()=>void leave()}>다른 영상 보기</button></header>
  <main className="ee-watch-main">
   <div className="ee-watch-stage">
    <div className="ee-player-host ee-live-player" ref={host}/>
    {videoFailure&&<section className="ee-watch-message ee-playback-error" role="alert"><div><h2>다른 영상으로 함께 볼까요?</h2><p>{videoFailure.message}</p></div><div className="ee-playback-actions"><button className="ee-primary" disabled={saveState==='saving'} onClick={()=>void leave()}>다른 영상 고르기</button>{videoFailure.retryable&&<button className="ee-secondary" disabled={saveState==='saving'} onClick={()=>setRetry(r=>r+1)}>다시 연결하기</button>}</div></section>}
    {error&&!videoFailure&&<div className="ee-watch-message" role="status"><p>{error}</p></div>}
    {finished&&!videoFailure&&<div className="ee-watch-finish"><h2>함께 봐서 즐거웠어요.</h2><p>{saveState==='saving'?'오늘의 이야기를 정리하고 있어요.':saveState==='saved'?'오늘의 이야기를 기록해 두었어요.':saveState==='error'?'연결이 끊겨 기록 완료 여부를 확인하지 못했어요. 가족 화면에서 확인해 주세요.':'또 다른 이야기를 만나볼까요?'}</p><button className="ee-primary" disabled={saveState==='saving'} onClick={()=>void leave()}>다른 영상 함께 보기</button></div>}
   </div>
   <div className="ee-watch-controls"><div role="status"><span className="ee-small-dot"/><span>{status}</span></div>{!videoFailure&&!finished&&<div><button className="ee-secondary" disabled={!ready||Boolean(active)} onClick={()=>player.current?.playVideo?.()}>영상 재생</button><button className={mic?'ee-primary':'ee-secondary'} disabled={!ready||state==='processing'} onClick={()=>void enableMic()}>{mic?'마이크 끄기':'마이크 켜기'}</button></div>}</div>
   {active&&!videoFailure&&<section className="ee-spoken-card" aria-label="함께 나누는 이야기"><div className="ee-spoken-avatar"><Duri size={64}/></div><div className="ee-spoken-body"><p className="ee-spoken-prompt">{active.question}</p>{caption&&<p className="ee-spoken-answer">{caption}</p>}{reply&&<p className="ee-spoken-reply">{reply}</p>}<div className="ee-spoken-actions">{state==='listening'?<button className="ee-primary" onClick={()=>void stop.current()}>말 다했어요</button>:state!=='processing'&&<button className="ee-primary" onClick={()=>void record.current()}>말하기</button>}<button className="ee-text-button" disabled={state==='processing'} onClick={()=>void finish.current(true)}>그냥 이어서 볼게요</button></div></div></section>}
   {!videoFailure&&<p className="ee-watch-footnote">말씀하실 때만 목소리를 기록해요. 마이크를 끄고 편하게 시청하셔도 괜찮아요.</p>}
  </main>
 </div>
}
