import {useEffect,useRef,useState} from 'react';
import {type Video,type Segment,type Question,segmentQuestions,questionTime,kindLabels,timeLabel,nextDue} from '../content/catalog';
import {Brand} from './MediaLibrary';

type Player={getCurrentTime:()=>number;getPlayerState:()=>number;playVideo:()=>void;pauseVideo:()=>void;seekTo:(time:number,allow:boolean)=>void;destroy:()=>void};
type YouTube={Player:new(element:HTMLElement,options:object)=>Player};
declare global {interface Window {YT?:YouTube;onYouTubeIframeAPIReady?:()=>void}}
let youtubePromise:Promise<YouTube>|undefined;
function loadYouTube():Promise<YouTube>{
  if(window.YT?.Player)return Promise.resolve(window.YT);
  if(youtubePromise)return youtubePromise;
  youtubePromise=new Promise<YouTube>((resolve,reject)=>{
    const timeout=window.setTimeout(()=>reject(new Error('영상 연결이 늦어지고 있어요. YouTube에서 영상을 보거나 질문을 먼저 살펴볼 수 있어요.')),15000);
    const previous=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{previous?.();window.clearTimeout(timeout);if(window.YT)resolve(window.YT);};
    let script=document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
    if(!script){script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';document.head.appendChild(script);}
    script.addEventListener('error',()=>{window.clearTimeout(timeout);reject(new Error('YouTube에 연결하지 못했어요.'));},{once:true});
  }).catch(error=>{youtubePromise=undefined;throw error;});
  return youtubePromise;
}
export default function MediaSession({video,segment,onBack}:{video:Video;segment:Segment;onBack:()=>void}){
  const questions=segmentQuestions(video,segment);
  const host=useRef<HTMLDivElement>(null),player=useRef<Player|null>(null);
  const [active,setActive]=useState<Question|null>(null),activeRef=useRef<Question|null>(null);
  const [done,setDone]=useState<Set<string>>(new Set()),doneRef=useRef<Set<string>>(new Set());
  const [draft,setDraft]=useState(''),[answers,setAnswers]=useState<Record<string,string>>({});
  const [showAnswer,setShowAnswer]=useState(false),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const [time,setTime]=useState(segment.start),timeRef=useRef(segment.start),ended=useRef(false),started=useRef(false);
  const [complete,setComplete]=useState(false),[manual,setManual]=useState(false);
  const questionTitle=useRef<HTMLHeadingElement>(null);
  const openRef=useRef<(q:Question,manual?:boolean)=>void>(()=>{});
  openRef.current=(q,isManual=false)=>{player.current?.pauseVideo?.();activeRef.current=q;setActive(q);setDraft(answers[q.id]??'');setShowAnswer(false);setManual(isManual);};
  useEffect(()=>{if(active)questionTitle.current?.focus();},[active]);
  useEffect(()=>{
    let disposed=false;let poll:number|undefined;let loadingTimeout:number|undefined;
    const tick=()=>{
      const p=player.current;if(!p||!started.current)return;
      const now=p.getCurrentTime();timeRef.current=now;setTime(now);
      if(p.getPlayerState()===1&&now<segment.start-0.6){p.seekTo(segment.start,true);return;}
      if(segment.end!==null&&now>=segment.end){ended.current=true;p.pauseVideo();}
      // Native controls can resume playback behind a question. Keep it paused.
      if(activeRef.current){if(p.getPlayerState()===1)p.pauseVideo();return;}
      const due=nextDue(questions,doneRef.current,now,segment,ended.current);
      if(due)openRef.current(due);
    };
    loadingTimeout=window.setTimeout(()=>{if(!disposed)setError('영상이 준비되지 않았어요. 원본 링크로 확인하거나 질문을 먼저 살펴보세요.');},20000);
    loadYouTube().then(YT=>{
      if(disposed||!host.current)return;
      const mount=document.createElement('div');host.current.replaceChildren(mount);
      player.current=new YT.Player(mount,{width:'100%',height:'100%',videoId:video.youtubeId,playerVars:{origin:window.location.origin,start:segment.start,...(segment.end!==null?{end:segment.end}:{}),autoplay:0,controls:1,playsinline:1,rel:0},events:{
        onReady:()=>{if(disposed)return;window.clearTimeout(loadingTimeout);setReady(true);setError('');poll=window.setInterval(tick,250);},
        onStateChange:(event:{data:number})=>{if(disposed)return;if(event.data===1){started.current=true;tick();}if(event.data===0&&started.current){ended.current=true;tick();}},
        onError:()=>{if(disposed)return;window.clearTimeout(loadingTimeout);setError('이 영상은 현재 여기서 재생할 수 없어요. YouTube 원본 링크를 이용해 주세요.');},
      }});
    }).catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'영상 연결을 확인해 주세요.');});
    return()=>{disposed=true;window.clearInterval(poll);window.clearTimeout(loadingTimeout);player.current?.destroy?.();player.current=null;};
  // Remount per video+segment; question array contents are immutable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[video.id,segment.id]);
  const finish=(skip=false)=>{
    if(!active)return;
    setAnswers(prev=>({...prev,[active.id]:skip?'':draft.trim()}));
    const next=new Set(doneRef.current).add(active.id);doneRef.current=next;setDone(next);activeRef.current=null;setActive(null);setDraft('');setShowAnswer(false);
    if(next.size===questions.length){setComplete(true);player.current?.pauseVideo?.();return;}
    // Drain a shared timestamp/segment-end queue before resuming the video.
    const due=nextDue(questions,next,timeRef.current,segment,ended.current);
    if(due){openRef.current(due);return;}
    if(manual||ended.current){const remaining=questions.find(q=>!next.has(q.id));if(remaining)openRef.current(remaining,true);return;}
    player.current?.playVideo?.();
  };
  const reset=()=>{doneRef.current=new Set();setDone(new Set());setAnswers({});activeRef.current=null;setActive(null);setDraft('');setShowAnswer(false);setComplete(false);ended.current=false;started.current=false;timeRef.current=segment.start;setTime(segment.start);player.current?.seekTo?.(segment.start,true);player.current?.pauseVideo?.();};
  return <div className="ee-app ee-session-app"><header className="ee-header"><Brand/><span className="ee-session-breadcrumb">함께 보기 <span>/</span> {segment.label}</span><button className="ee-secondary" onClick={onBack}>← 영상 목록</button></header>
    <main className="ee-session-main"><div className="ee-session-title"><div><span className="ee-eyebrow">{video.publisher}</span><h1>{video.title}</h1></div><span className="ee-preview-tag">질문 흐름 미리보기</span></div>
      <div className="ee-session-layout"><section className="ee-watch-column" aria-label="영상 재생"><div className="ee-player-host" ref={host}/>{error&&<div className="ee-player-error" role="status"><p>{error}</p><a href={video.sourceUrl!} target="_blank" rel="noreferrer">YouTube 원본 열기 ↗</a></div>}<div className="ee-player-caption"><span>{segment.end!==null?`${timeLabel(segment.start)} — ${timeLabel(segment.end)} 구간`:'전체 영상'} · {questions.length}개 질문</span><a href={video.sourceUrl!} target="_blank" rel="noreferrer">원본 영상 ↗</a></div><div className="ee-session-guidance"><span aria-hidden>✦</span><p>질문이 나오면 영상이 잠시 멈춰요. 편하게 답을 적거나 다음 질문으로 넘어가세요. 마이크와 AI 분석은 이 미리보기에서 사용하지 않아요.</p></div>
      <div className="ee-timeline"><div className="ee-timeline-heading"><h2>대화할 장면들</h2><span>{done.size} / {questions.length}</span></div>{questions.map(q=><button key={q.id} className={`ee-timeline-item ${active?.id===q.id?'active':''}`} onClick={()=>{setComplete(false);openRef.current(q,true)}}><span className={`ee-question-number ${done.has(q.id)?'done':''}`}>{done.has(q.id)?'✓':q.number}</span><span><strong>{q.question}</strong><small>{questionTime(q,segment)} · {kindLabels[q.kind]}</small></span><span aria-hidden>↗</span></button>)}</div></section>
      <aside className="ee-conversation" aria-label="질문과 답변"><div className="ee-conversation-top"><span className="ee-small-dot"/><span>MEMFLIX와 이야기 나누기</span></div>{complete?<div className="ee-complete"><span className="ee-complete-mark">✓</span><h2>이야기 잘 들었어요.</h2><p>{questions.length}개 질문을 모두 살펴봤어요.</p><div className="ee-complete-stats"><span><b>{Object.values(answers).filter(Boolean).length}</b>적어 둔 답변</span><span><b>{questions.length}</b>살펴본 질문</span></div><p className="ee-muted">답변 수는 정답 수가 아니에요. 작성한 내용은 이 화면을 떠나면 사라져요.</p><button className="ee-primary" onClick={onBack}>다른 영상도 살펴보기</button><button className="ee-text-button" onClick={reset}>이 구간 다시 보기</button></div>:active?<div className="ee-active-question"><div className="ee-rubric-meta">Q{active.number} · {kindLabels[active.kind]}</div><h2 ref={questionTitle} tabIndex={-1}>{active.question}</h2><label htmlFor="preview-answer" className="ee-answer-label">떠오르는 이야기를 적어 보세요</label><textarea id="preview-answer" placeholder="편하게 적어 주세요. 잘 기억나지 않아도 괜찮아요." value={draft} onChange={e=>setDraft(e.target.value)} maxLength={4000}/><div className="ee-response-actions"><button className="ee-primary" onClick={()=>finish()}>답변 완료 →</button><button className="ee-text-button" onClick={()=>finish(true)}>이번 질문 건너뛰기</button></div><button className="ee-reference-toggle" aria-expanded={showAnswer} onClick={()=>setShowAnswer(!showAnswer)}>{showAnswer?'모범답안 닫기':'팀 모범답안 · 채점 기준 보기'} <span>{showAnswer?'−':'+'}</span></button>{showAnswer&&<div className="ee-reference"><p><strong>{active.kind==='conversation'?'정답 없는 대화':'팀 제공 모범답안'}</strong></p><p>{active.answer||(active.kind==='conversation'?'감상과 경험에는 정답이 없어요.':'모범답안이 아직 제공되지 않았어요.')}</p>{active.rubric&&<><strong>채점 기준 초안</strong><p>{active.rubric}</p></>}{active.reviewNotes.map((n,i)=><p key={i} className="ee-review-warning">{n}</p>)}<small>원영상 대조 전이며 자동으로 점수를 매기지 않습니다.</small></div>}</div>:<div className="ee-session-wait"><div className="ee-wait-icon" aria-hidden>☷</div><span className="ee-eyebrow">READY WHEN YOU ARE</span><h2>편하게 보고,<br/>천천히 이야기해요.</h2><p>영상의 재생 버튼을 누르면<br/>지정한 시점에 질문이 나타나요.</p><button className="ee-primary" disabled={!ready||Boolean(error)} onClick={()=>{started.current=true;player.current?.playVideo?.()}}>영상 재생하기 ▶</button><button className="ee-text-button" onClick={()=>openRef.current(questions.find(q=>!done.has(q.id))??questions[0],true)}>질문부터 살펴볼게요 →</button><small>현재 {timeLabel(time)} · 자동 채점 없음</small></div>}</aside></div>
    </main></div>
}
