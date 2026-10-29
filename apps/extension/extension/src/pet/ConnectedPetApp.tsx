import {useEffect,useRef,useState,type CSSProperties} from 'react';
import PetFace from '../../../src/components/PetFace';
import {createExtensionHost} from './extensionHost';
import {frameMessage,isHostToFrame,PROTOCOL_VERSION as V,type FrameToHost,type VideoPulse} from '../../../src/shared/protocol';
import {AUTH_KEY,WEB_URL,PortalClient,readAuth,type Auth,type Account,type CatalogVideo,type Prompt,type Watch,type Welcome,type Answer,type DialogueMemory} from './portalClient';
import {duePrompts,canRecord} from './livePolicy';
import {startPcmAudioCapture,recordingHasVoice,type PcmAudioCapture} from './audioRecorder';
import type {LiveTranscript} from './liveTranscript';
import './connected.css';
import type {Layout} from '../content/frameLayout';
import SpeechControls,{MicIcon,SpeakerIcon} from './SpeechControls.tsx';
import type {Phase} from './speechControls.ts';
import {DEFAULT_PREFERENCES,PREFERENCES_KEY,readPreferences,silenceDecision,automaticTurnAllowed,type SilenceState} from './dialoguePreferences';

type Session={kind:'watch'|'welcome'; id:string; title:string; prompts:Prompt[]; watch?:Watch};
const embedded=window.parent!==window;
const parentOrigin=location.ancestorOrigins?.[0];
const frameChannel=new URL(location.href).searchParams.get('instance');
const ownTab=embedded&&frameChannel?chrome.tabs.getCurrent().then(tab=>tab?.id).catch(()=>undefined):Promise.resolve(undefined);
function sendLayout(message:Layout){
  if(embedded&&parentOrigin)window.parent.postMessage(frameMessage<FrameToHost>(message),parentOrigin);
  if(embedded&&frameChannel)void ownTab.then(id=>typeof id==='number'?chrome.tabs.sendMessage(id,{v:1,type:'pet/frame-layout',channel:frameChannel,event:message}).catch(()=>{}):undefined);
}
function post(type:'frame/size'|'frame/hide',width=0,height=0){
  sendLayout(type==='frame/hide'?{type}:{type,width,height});
}

export default function ConnectedPetApp(){
  const [host]=useState(createExtensionHost),[api]=useState(()=>new PortalClient());
  const [account,setAccount]=useState<Account|null>(null),[ready,setReady]=useState(false),[open,setOpen]=useState(true);
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false);
  const [catalog,setCatalog]=useState<CatalogVideo[]>([]),[videoId,setVideoId]=useState(''),[segmentId,setSegmentId]=useState('');
  const [session,setSession]=useState<Session|null>(null),[active,setActive]=useState<Prompt|null>(null);
  const [phase,setPhase]=useState<Phase>('idle'),[message,setMessage]=useState(''),[heard,setHeard]=useState(false);
  const [memory,setMemory]=useState<DialogueMemory|null>(null),[nextMeeting,setNextMeeting]=useState('');
  const [welcomeDone,setWelcomeDone]=useState(false),[speaking,setSpeaking]=useState(false);
  const [closing,setClosing]=useState(false);
  const [preferences,setPreferences]=useState(DEFAULT_PREFERENCES),[prefsReady,setPrefsReady]=useState(false),[transcript,setTranscript]=useState('');
  const preferencesRef=useRef(preferences);preferencesRef.current=preferences;
  const armed=useRef(false),autoAttempted=useRef(new Set<string>()),speakingRef=useRef(false),silence=useRef<SilenceState>({started:0,lastVoice:null});
  const silenceTimer=useRef<number>(),advanceTimer=useRef<number>();
  const voiceActive=useRef(false);
  const liveTranscript=useRef<LiveTranscript|null>(null);
  const latestRecord=useRef<()=>void>(()=>{}),latestNext=useRef<()=>void>(()=>{});
  const [anchor,setAnchor]=useState({h:'right',v:'bottom'});
  // Use the enclosing viewport, not the iframe that shrinks with the pet.
  const [viewHeight,setViewHeight]=useState(embedded?720:window.innerHeight);
  const [viewWidth,setViewWidth]=useState(embedded?392:window.innerWidth);
  const root=useRef<HTMLDivElement>(null),pulse=useRef<VideoPulse|null>(null),alive=useRef(true),epoch=useRef(0),locked=useRef(false);
  const capture=useRef<PcmAudioCapture|null>(null),stream=useRef<MediaStream|null>(null),timer=useRef<number>(),speech=useRef<HTMLAudioElement|null>(null);
  const inflight=useRef<AbortController|null>(null),answers=useRef<Answer[]>([]),files=useRef<File[]>([]),queue=useRef<string[]>([]),seen=useRef(new Set<string>());
  const sessionRef=useRef(session),activeRef=useRef(active),phaseRef=useRef(phase),videoRef=useRef(videoId);
  sessionRef.current=session;activeRef.current=active;phaseRef.current=phase;videoRef.current=videoId;
  const pauseToken=useRef<string|null>(null),interrupt=useRef(false);
  const halt=()=>{
    epoch.current++;clearTimeout(timer.current);clearInterval(silenceTimer.current);clearTimeout(advanceTimer.current);inflight.current?.abort();inflight.current=null;
    liveTranscript.current?.cancel();liveTranscript.current=null;
    speech.current?.pause();speech.current=null;speakingRef.current=false;setSpeaking(false);
    void capture.current?.cancel();capture.current=null;stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;
  };
  const resume=()=>{if(pauseToken.current)host.sendToContent({v:V,type:'pet/resume',token:pauseToken.current});pauseToken.current=null;};
  const pause=async()=>{
    const before=pulse.current;
    if(before?.adShowing)throw new Error('광고가 끝나면 이어서 이야기해요.');
    if(before?.paused||before?.ended)return;
    if(!before){if(sessionRef.current?.kind==='welcome')return;throw new Error('영상 연결을 확인하고 있어요.');}
    const token=crypto.randomUUID();pauseToken.current=token;
    host.sendToContent({v:V,type:'pet/pause',token});
    await new Promise<void>((resolve,reject)=>{
      const stop=host.subscribe(msg=>{if(msg.type==='video/pulse'&&msg.pulse.paused&&!msg.pulse.adShowing){clearTimeout(timeout);stop();resolve();}});
      const timeout=window.setTimeout(()=>{stop();reject(new Error('영상을 잠시 멈춘 뒤 말씀해 주세요.'));},2500);
    });
  };
  const reset=()=>{armed.current=false;halt();resume();answers.current=[];files.current=[];queue.current=[];seen.current.clear();autoAttempted.current.clear();interrupt.current=false;setSession(null);setActive(null);setPhase('idle');setMessage('');setTranscript('');setClosing(false);};
  useEffect(()=>{if(!open&&(['opening','recording'].includes(phaseRef.current)||speakingRef.current)){armed.current=false;halt();setPhase('idle');phaseRef.current='idle';setMessage('대화를 잠시 멈췄어요. 준비되면 다시 말씀해 주세요.');}},[open]);
  useEffect(()=>{
    void chrome.storage.local.get(PREFERENCES_KEY).then(b=>setPreferences(readPreferences(b[PREFERENCES_KEY]))).catch(()=>setMessage('설정을 불러오지 못해 기본 설정을 사용해요.')).finally(()=>setPrefsReady(true));
    const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area==='local'&&changes[PREFERENCES_KEY]){
      const next=readPreferences(changes[PREFERENCES_KEY].newValue);preferencesRef.current=next;setPreferences(next);
      // A settings change is a fresh boundary; never restart a partly handled turn.
      armed.current=false;halt();if(['opening','recording'].includes(phaseRef.current)){setPhase('idle');phaseRef.current='idle';}else if(phaseRef.current==='transcribing'){setPhase('review');phaseRef.current='review';}
      setMessage('설정을 적용했어요. 현재 이야기는 ‘말하기’로 이어가 주세요.');
    }};
    chrome.storage.onChanged.addListener(changed);
    const hidden=()=>{if(document.hidden){armed.current=false;halt();if(['opening','recording'].includes(phaseRef.current)){setPhase('idle');phaseRef.current='idle';}else if(phaseRef.current==='transcribing'){setPhase('review');phaseRef.current='review';}setMessage('다시 돌아왔어요. ‘말하기’를 누르면 이어갈 수 있어요.');}};
    document.addEventListener('visibilitychange',hidden);
    return()=>{chrome.storage.onChanged.removeListener(changed);document.removeEventListener('visibilitychange',hidden);};
  },[]);
  useEffect(()=>{
    sendLayout({type:'frame/busy',busy:!!session&&phase!=='saved'});
  },[session,phase]);
  const authenticate=async(auth:Auth)=>{
    api.auth=auth;
    const who=await api.request<Account>('/account/me');
    if(who.role!=='user')throw new Error('패밀리 계정은 웹사이트에서 이용해 주세요.');
    setMemory(await api.request<DialogueMemory>('/memory'));
    setAccount(who);setCatalog(await api.request<CatalogVideo[]>('/extension/catalog'));
    const welcome=await api.request<Welcome>('/welcome');
    setWelcomeDone(['complete','partial','skipped'].includes(welcome.state));
  };
  useEffect(()=>{
    alive.current=true;
    void chrome.storage.session.get(AUTH_KEY).then(async bag=>{const auth=readAuth(bag[AUTH_KEY]);if(auth)await authenticate(auth);}).catch(error=>setMessage(errorText(error))).finally(()=>setReady(true));
    const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{
      if(area==='session'&&changes[AUTH_KEY]&&readAuth(changes[AUTH_KEY].newValue)?.token!==api.auth?.token){
        // Reload this extension frame against the new session snapshot. Old-account
        // requests cannot resolve into the next account's UI after this boundary.
        reset();api.auth=null;window.location.reload();
      }
    };
    chrome.storage.onChanged.addListener(changed);
    const unload=()=>{halt();resume();};window.addEventListener('pagehide',unload);
    const leaving=(event:BeforeUnloadEvent)=>{if(sessionRef.current&&phaseRef.current!=='saved'&&files.current.length){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',leaving);
    const stop=host.subscribe(msg=>{
      if(msg.type==='video/attached'){
        if(videoRef.current&&videoRef.current!==msg.content.id&&sessionRef.current){halt();pauseToken.current=null;interrupt.current=true;setActive(null);setPhase('review');setMessage('영상이 바뀌었어요. 지금까지의 이야기를 먼저 남겨 주세요.');}
        videoRef.current=msg.content.id;setVideoId(msg.content.id);pulse.current=null;
      }else if(msg.type==='video/detached'){
        videoRef.current='';setVideoId('');pulse.current=null;
        if(sessionRef.current){halt();pauseToken.current=null;interrupt.current=true;setActive(null);setPhase('review');setMessage('영상이 닫혔어요. 남겨둔 이야기를 저장할 수 있어요.');}
      }else if(msg.type==='video/pulse'){
        const prior=pulse.current;pulse.current=msg.pulse;
        const current=sessionRef.current;
        if((msg.pulse.adShowing||prior?.paused&&!msg.pulse.paused&&!msg.pulse.ended)&&(['opening','recording'].includes(phaseRef.current)||speakingRef.current)){
          armed.current=false;halt();setPhase('idle');phaseRef.current='idle';setMessage('영상이 재생되어 대화를 멈췄어요. 잠시 멈춘 뒤 다시 말씀해 주세요.');
        }
        if(current?.kind==='watch'&&!interrupt.current){
          for(const id of duePrompts(current.prompts,prior,msg.pulse,current.watch!.segment.end))if(!seen.current.has(id)){seen.current.add(id);queue.current.push(id);}
          if(!activeRef.current&&phaseRef.current==='idle'&&queue.current.length){const id=queue.current.shift();setActive(current.prompts.find(p=>p.id===id)??null);setOpen(true);}
        }
      }
    });
    return()=>{alive.current=false;stop();window.removeEventListener('pagehide',unload);window.removeEventListener('beforeunload',leaving);chrome.storage.onChanged.removeListener(changed);halt();resume();};
  },[]);
  useEffect(()=>{
    if(embedded)return;
    const resized=()=>{setViewWidth(window.innerWidth);setViewHeight(window.innerHeight);};
    window.addEventListener('resize',resized);
    return()=>window.removeEventListener('resize',resized);
  },[]);
  useEffect(()=>{
    const observer=new ResizeObserver(()=>{if(root.current){const r=root.current.getBoundingClientRect();post('frame/size',Math.ceil(r.width),Math.ceil(r.height));}});
    if(root.current)observer.observe(root.current);
    const message=(event:MessageEvent)=>{
      if(event.source!==window.parent||event.origin!==parentOrigin||!isHostToFrame(event.data))return;
      if(event.data.type==='host/tap')setOpen(o=>!o);
      if(event.data.type==='host/anchor')setAnchor(event.data.anchor);
      if(event.data.type==='host/viewport'){
        if(Number.isFinite(event.data.height)&&event.data.height>0)setViewHeight(Math.min(10000,event.data.height));
        if(typeof event.data.width==='number'&&Number.isFinite(event.data.width)&&event.data.width>0)setViewWidth(Math.min(10000,event.data.width));
      }
    };
    window.addEventListener('message',message);return()=>{observer.disconnect();window.removeEventListener('message',message);};
  },[]);
  const login=async(e:React.FormEvent)=>{e.preventDefault();if(busy)return;setBusy(true);setMessage('');try{const auth=await api.login(username,password);setPassword('');await authenticate(auth);await chrome.storage.session.set({[AUTH_KEY]:auth});}catch(e){api.auth=null;setAccount(null);setMessage(errorText(e));}finally{setBusy(false);}};
  const logout=async()=>{if(locked.current)return;setBusy(true);halt();try{await api.request('/account/logout',{});reset();api.auth=null;await chrome.storage.session.remove(AUTH_KEY);setAccount(null);setMemory(null);setNextMeeting('');setWelcomeDone(false);setMessage('');}catch(e){setMessage(errorText(e));}finally{setBusy(false);}};
  const beginWelcome=async(skip=false)=>{if(busy)return;setBusy(true);setMessage('');try{
    let plan=await api.request<Welcome>('/welcome');if(plan.state==='needed')plan=await api.request<Welcome>('/welcome/start',{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});
    if(['complete','partial','skipped'].includes(plan.state)){setWelcomeDone(true);return;}
    if(plan.state!=='ready'||!plan.id)throw new Error('이전 인사 기록을 확인하고 있어요. 잠시 후 다시 확인해 주세요.');
    if(skip){await api.save('welcome',plan.id,[],[]);setWelcomeDone(true);return;}
    const prompts=(plan.prompts??[]).map(p=>({...p,timestamp:null,delivery:'after_video' as const,maxRecordingMs:60000}));
    armed.current=true;setTranscript('');setSession({kind:'welcome',id:plan.id,title:'오늘의 인사',prompts});setActive(prompts[0]??null);setPhase('idle');
  }catch(e){setMessage(errorText(e));}finally{setBusy(false);}};
  const beginWatch=async()=>{if(busy||!segmentId)return;setBusy(true);setMessage('');try{
    setClosing(false);setNextMeeting('');const watch=await api.request<Watch>('/watch',{videoId,segmentId});if(videoRef.current!==watch.contentId)throw new Error('영상이 바뀌었어요. 지금 영상을 다시 연결해 주세요.');answers.current=[];files.current=[];queue.current=[];seen.current.clear();interrupt.current=false;
    armed.current=true;setTranscript('');setOpen(false);setSession({kind:'watch',id:watch.id,title:watch.title,prompts:watch.prompts,watch});setActive(null);setPhase('idle');setMessage('편하게 보세요. 이야기 나눌 때 알려드릴게요.');
  }catch(e){setMessage(errorText(e));}finally{setBusy(false);}};
  const put=(answer:Answer)=>{answers.current=[...answers.current.filter(a=>a.id!==answer.id),answer];};
  const stopRecording=async()=>{
    const recorder=capture.current,prompt=activeRef.current;if(!recorder||!prompt)return;capture.current=null;clearTimeout(timer.current);clearInterval(silenceTimer.current);
    const generation=epoch.current;setPhase('transcribing');phaseRef.current='transcribing';
    try{
      const result=await recorder.stop();stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;
      if(generation!==epoch.current||!alive.current)return;
      files.current=files.current.filter(f=>f.name!==prompt.id+'.wav');
      if(!recordingHasVoice(result)){liveTranscript.current?.cancel();liveTranscript.current=null;put({id:prompt.id,userAnswer:'',state:'silent'});setMessage('목소리가 잘 들리지 않았어요. 다시 말씀하거나 넘어가도 괜찮아요.');setPhase('review');return;}
      const file=new File([result.blob],prompt.id+'.wav',{type:'audio/wav'});files.current.push(file);
      const answer:Answer={id:prompt.id,userAnswer:'',state:'untranscribed',videoTimestamp:pulse.current?.seconds??0};put(answer);
      const live=liveTranscript.current;
      try{if(!live)throw new Error('음성 연결이 종료됐어요.');const text=await live.finish();if(generation===epoch.current){put({...answer,userAnswer:text,state:'recorded'});setTranscript(text);setMessage('이렇게 들었어요. 다르면 다시 말씀해 주세요.');
        if(preferencesRef.current.autoListen&&armed.current)advanceTimer.current=window.setTimeout(()=>{if(generation===epoch.current&&!document.hidden&&armed.current&&activeRef.current?.id===prompt.id&&phaseRef.current==='review')latestNext.current();},4500);
      }}
      catch{if(generation===epoch.current)setMessage(`말씀을 글로 확인하지 못했어요. 녹음은 이 창에 임시 보관 중이며, ‘${sessionRef.current?.kind==='welcome'?'인사 저장하고 영상 보기':'이야기 저장'}’를 눌러야 남아요. 다시 말하거나 넘어갈 수 있어요.`);}
      finally{live?.cancel();if(liveTranscript.current===live){liveTranscript.current=null;inflight.current=null;}}
      if(generation===epoch.current&&alive.current)setPhase('review');
    }catch{if(generation===epoch.current){halt();setPhase('idle');setMessage('녹음을 마치지 못했어요. 다시 말씀하거나 넘어가 주세요.');}}
  };
  const record=async()=>{
    if(!activeRef.current||!['idle','review'].includes(phaseRef.current)||locked.current||busy||speakingRef.current||closing||document.hidden)return;
    halt();setMessage('');setTranscript('');setHeard(false);const generation=epoch.current;setPhase('opening');phaseRef.current='opening';
    try{
      await pause();if(generation!==epoch.current)return;
      const opened=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(generation!==epoch.current||!alive.current){opened.getTracks().forEach(t=>t.stop());return;}
      if(!canRecord(pulse.current,sessionRef.current?.kind??'watch')){opened.getTracks().forEach(t=>t.stop());throw new Error('영상을 잠시 멈춘 뒤 다시 말씀해 주세요.');}
      stream.current=opened;
      const controller=new AbortController();inflight.current=controller;
      const live=await api.openLiveTranscript(controller.signal);
      if(generation!==epoch.current||!alive.current){live.cancel();opened.getTracks().forEach(t=>t.stop());return;}
      liveTranscript.current=live;
      silence.current={started:Date.now(),lastVoice:null};voiceActive.current=false;
      const recorder=await startPcmAudioCapture(opened,on=>{voiceActive.current=on;setHeard(on);silence.current.lastVoice=Date.now();},chunk=>live.send(chunk));
      if(generation!==epoch.current||!alive.current){await recorder.cancel();opened.getTracks().forEach(t=>t.stop());return;}
      capture.current=recorder;setPhase('recording');phaseRef.current='recording';timer.current=window.setTimeout(()=>void stopRecording(),60000);
      silenceTimer.current=window.setInterval(()=>{if(voiceActive.current)silence.current.lastVoice=Date.now();if(preferencesRef.current.autoFinish&&silenceDecision(silence.current,Date.now(),preferencesRef.current.silenceSeconds)!=='wait')void stopRecording();},250);
    }catch(e){if(generation===epoch.current){armed.current=false;halt();setPhase('idle');setMessage(e instanceof DOMException?'마이크 사용을 허용해 주세요. 지금은 건너뛰어도 괜찮아요.':errorText(e));}}
  };
  latestRecord.current=()=>void record();
  const next=()=>{
    if(!active||!session)return;halt();if(!answers.current.some(a=>a.id===active.id))put({id:active.id,userAnswer:'',state:'skipped'});
    setMessage('');setTranscript('');setPhase('idle');phaseRef.current='idle';
    if(session.kind==='welcome'){const i=session.prompts.findIndex(p=>p.id===active.id);setActive(session.prompts[i+1]??null);}
    else{const id=queue.current.shift();setActive(session.prompts.find(p=>p.id===id)??null);if(!id){if(pulse.current?.ended){setClosing(true);setOpen(true);}else setOpen(false);}}
    resume();
  };
  latestNext.current=next;
  const save=async()=>{
    if(!session||locked.current)return;locked.current=true;armed.current=false;halt();resume();setClosing(false);setActive(null);setPhase('saving');setMessage('');
    try{await api.save(session.kind,session.id,answers.current,files.current,nextMeeting);files.current=[];setPhase('saved');if(session.kind==='welcome')setWelcomeDone(true);setMessage('이야기를 남겨두었어요. 공유를 허용한 가족이 웹사이트에서 볼 수 있어요.');}
    catch{setPhase('uncertain');setMessage('저장 결과를 아직 확인하지 못했어요. 다시 보내지 않고 상태를 확인할게요.');}
    finally{locked.current=false;}
  };
  const checkSave=async()=>{if(!session||busy)return;setBusy(true);try{
    const result=await api.request<{state:string}>(session.kind==='welcome'?'/welcome':'/extension/watch-state?watchId='+encodeURIComponent(session.id));
    if(['complete','partial','skipped'].includes(result.state)){files.current=[];setPhase('saved');if(session.kind==='welcome')setWelcomeDone(true);setMessage('저장이 확인됐어요.');}
    else setMessage('아직 저장 완료가 확인되지 않았어요. 이 화면을 유지해 주세요.');
  }catch(e){setMessage(errorText(e));}finally{setBusy(false);}};
  const speak=async(automatic=false)=>{if(!activeRef.current||speakingRef.current||!['idle','review'].includes(phaseRef.current)||document.hidden)return;speakingRef.current=true;setSpeaking(true);const generation=epoch.current;const prompt=activeRef.current;try{
    await pause();if(generation!==epoch.current)return;
    const result=await api.request<{audio:string}>('/tts',{text:prompt.question,voice:'3278b908-86ee-5c30-bb55-24b5b1bbc67b',language:'korean',properties:{speed:preferencesRef.current.speed}});
    if(generation!==epoch.current)return;
    const audio=new Audio(result.audio.startsWith('data:')?result.audio:'data:audio/wav;base64,'+result.audio);speech.current=audio;audio.volume=preferencesRef.current.volume;
    audio.onended=()=>{if(generation!==epoch.current)return;speakingRef.current=false;setSpeaking(false);speech.current=null;
      if(automatic&&armed.current&&preferencesRef.current.autoListen&&!document.hidden&&activeRef.current?.id===prompt.id)latestRecord.current();};
    audio.onerror=()=>{if(generation!==epoch.current)return;speakingRef.current=false;setSpeaking(false);setMessage('소리 재생이 멈췄어요. ‘말하기’로 이어갈 수 있어요.');};await audio.play();
  }catch{if(generation!==epoch.current)return;armed.current=false;setMessage('자동 소리를 재생하지 못했어요. ‘두리 목소리 듣기’나 ‘말하기’를 눌러 주세요.');speakingRef.current=false;setSpeaking(false);}};
  useEffect(()=>{
    const key=session&&active?`${session.id}/${active.id}`:'';
    if(!prefsReady||!preferences.autoVoice||preferences.volume===0||!key||autoAttempted.current.has(key)||!automaticTurnAllowed({armed:armed.current,hidden:document.hidden,phase,active:!!active,busy,closing}))return;
    autoAttempted.current.add(key);void speak(true);
  },[session?.id,active?.id,phase,busy,prefsReady,preferences.autoVoice,preferences.volume,closing]);
  const forget=async()=>{if(busy||session)return;setBusy(true);try{await api.request('/memory/clear',{});setMemory(null);setMessage('다음 인사에 쓰는 기억을 지웠어요. 공유한 리포트는 유지돼요.');}catch(e){setMessage(errorText(e));}finally{setBusy(false);}};
  const selected=catalog.find(v=>v.id===videoId);
  useEffect(()=>{setSegmentId(selected?.segments[0]?.id??'');},[videoId,catalog]);
  const responding=['idle','review'].includes(phase)&&!closing;
  return <div ref={root} className="connected-root" style={{'--pet-view-height':`${viewHeight}px`,'--pet-view-width':`${viewWidth}px`} as CSSProperties} data-compact={viewWidth<=370} data-short={viewHeight<=520} data-h={anchor.h} data-v={anchor.v}><button className="pet-toggle" aria-label="두리와 이야기 나누기" onClick={()=>setOpen(o=>!o)}><PetFace petName="두리" size={96} mood={phase==='saved'?'happy':'neutral'}/></button>{open&&<section className="connected-card" aria-label="MEMFLIX 함께 보기">
    <header className="card-header"><strong>MEMFLIX<span>{account?`${account.displayName} 님과 함께`:'함께 보는 일상'}</span></strong><button className="collapse" onClick={()=>void chrome.runtime.openOptionsPage()} aria-label="소리와 마이크 설정">⚙</button><button className="collapse" onClick={()=>setOpen(false)} aria-label="접기">−</button></header>
    <div className="card-body">
    {!ready?<p>연결을 확인하고 있어요.</p>:!account?<form className="stack" onSubmit={login}><div className="intro"><h2>다시 만나서 반가워요</h2><p>웹사이트에서 만든 아이디로 연결해 주세요.</p></div><label>아이디<input autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required/></label><label>비밀번호<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="primary" disabled={busy}>로그인</button><a href={WEB_URL} target="_blank" rel="noreferrer">계정 만들기 · 패밀리 화면</a></form>:
    <>
      {!session?<div className="stack">{(memory?.previous||memory?.promise)&&<details className="memory"><summary>이어갈 이야기</summary>{memory.previous&&<p>지난 이야기: {memory.previous.quote}</p>}{memory.promise&&<p>함께 정한 다음 만남: {memory.promise.text}</p>}<button disabled={busy} onClick={()=>void forget()}>다음 인사에 쓰는 기억 지우기</button></details>}{!welcomeDone?<><div className="intro"><h2>오늘은 어떻게 지내세요?</h2><p>영상을 보기 전에<br/>잠깐 이야기 나눌까요?</p></div><div className="entry-actions"><button className="primary" disabled={busy} onClick={()=>void beginWelcome()}><MicIcon/>인사 나누기</button><button disabled={busy} onClick={()=>void beginWelcome(true)}>영상을 먼저 볼게요</button></div></>:
      selected?<><div className="intro"><span className="eyebrow">함께 볼 영상</span><h2>{selected.title}</h2></div>{selected.segments.length>1&&<label>함께 볼 부분<select value={segmentId} onChange={e=>setSegmentId(e.target.value)}>{selected.segments.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label>}<button className="primary" disabled={busy} onClick={()=>void beginWatch()}>함께 보기</button><p>이야기 나눌 때 두리가 알려드릴게요.</p></>:<><div className="intro"><h2>함께 볼 영상을 골라요</h2><p>준비된 영상에서 이야기를 나눌 수 있어요.</p></div><div className="video-list">{catalog.map(v=><a key={v.id} href={'https://www.youtube.com/watch?v='+v.id} target="_top">{v.title}</a>)}</div></>}</div>:
      <div className="stack"><p className="session-title">{session.title}</p>
       {phase==='saving'?<h2 role="status">이야기를 남기고 있어요</h2>:phase==='saved'?<><h2>{session.kind==='welcome'?'인사를 남겼어요. 이제 같이 볼까요?':'오늘도 함께해서 반가웠어요'}</h2><button className="primary" onClick={reset}>{session.kind==='welcome'?'영상 함께 보기':'다른 영상 보기'}</button></>:phase==='uncertain'?<><h2>저장 상태를 확인할게요</h2><button disabled={busy} onClick={()=>void checkSave()}>저장 상태 확인</button></>:
       closing?<><div className="intro"><h2>오늘 이야기를 남길까요?</h2><p>다음 만남도 함께 정할 수 있어요.</p></div><label>다음에도 함께 볼까요?<select value={nextMeeting} onChange={e=>setNextMeeting(e.target.value)}><option value="">약속 없이 마칠게요</option><option value="tomorrow">내일 다시 볼게요</option><option value="whenever">편할 때 다시 볼게요</option></select></label><div className="entry-actions"><button className="primary" onClick={()=>void save()}>이야기 저장</button><button onClick={()=>setClosing(false)}>계속 보기</button></div></>:
       <>{active?<div className="dialogue"><span className="eyebrow">두리</span><h2>{active.question}</h2></div>:<div className="waiting"><h2>{interrupt.current?'이야기를 잠시 멈췄어요':session.kind==='watch'?'함께 보고 있어요':'인사 나눠서 반가웠어요'}</h2><p>{interrupt.current?'지금까지 남긴 이야기를 저장할 수 있어요.':session.kind==='watch'?'편하게 영상을 보세요.\n이야기 나눌 때 알려드릴게요.':'이제 영상을 함께 볼까요?'}</p></div>}
       {transcript&&<div className="heard-transcript"><span className="eyebrow">이렇게 들었어요</span><p>{transcript}</p>{preferences.autoListen&&armed.current&&phase==='review'&&<button onClick={()=>{clearTimeout(advanceTimer.current);armed.current=false;setMessage('천천히 확인해 주세요. 준비되면 이어갈 수 있어요.');}}>천천히 확인할게요</button>}</div>}
       {active&&responding&&<div className="response-actions"><button disabled={speaking||busy} onClick={()=>void speak()}><SpeakerIcon/>{speaking?'두리가 말하고 있어요':'두리 목소리 듣기'}</button><button className="quiet" disabled={speaking||busy} onClick={next}>{phase==='review'?(session.kind==='welcome'?'다음 이야기':'영상 이어 보기'):'이 이야기는 넘어갈게요'}</button></div>}
       {responding&&<button className="finish" disabled={speaking||busy} onClick={()=>session.kind==='welcome'?void save():setClosing(true)}>{session.kind==='welcome'?'인사 저장하고 영상 보기':'오늘 이야기는 여기까지'}</button>}</>}
      </div>}
    </>}
    {message&&message!=='편하게 보세요. 이야기 나눌 때 알려드릴게요.'&&<p className="notice" role="status">{message}</p>}
    {account&&<details className="account-details"><summary>연결 · 기록 안내</summary><p>{preferences.autoListen?'자동 마이크를 선택했어요. 시작한 대화의 응답 구간에서만 켜져요.':'말하기를 누르면 마이크가 켜져요.'} 저장한 목소리와 기록은 연결을 허용한 가족과 함께 볼 수 있어요.</p><a href={WEB_URL} target="_blank" rel="noreferrer">가족 리포트 · 내 계정</a><div className="entry-actions"><button disabled={busy||!!session&&phase!=='saved'} onClick={()=>void logout()}>로그아웃</button><button disabled={!!session&&phase!=='saved'} onClick={()=>{armed.current=false;halt();resume();post('frame/hide');}}>오늘은 그만 볼래요</button></div></details>}
    </div>
    {ready&&account&&active&&<SpeechControls state={{phase,active:!!active,busy,speaking,closing,session:session?.kind??null,welcomeDone,heard,autoFinish:preferences.autoFinish,silenceSeconds:preferences.silenceSeconds}} onRecord={()=>void record()} onStop={()=>void stopRecording()}/>}
  </section>}</div>;
}
function errorText(error:unknown){return error instanceof Error?error.message:'연결을 확인해 주세요.';}
