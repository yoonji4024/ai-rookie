import source from './team_video_questions.v1.json';
export type Kind = 'recall' | 'conversation' | 'mixed' | 'context' | 'calculation' | 'sequence';
export interface Question { id:string; number:number; segmentId:string; timestamp:number|null; delivery:'at_time'|'after_segment'|'after_video'; kind:Kind; question:string; answer:string; rubric:string; reviewNotes:string[]; referenceStatus:string; automaticScoring:false }
export interface Segment { id:string; label:string; start:number; end:number|null }
export interface Video { id:string; youtubeId:string|null; title:string; category:'news'|'entertainment'; publisher:string; sourceUrl:string|null; notes:string[]; segments:Segment[]; questions:Question[] }
export const catalog = source as unknown as {version:string; videos:Video[]; templates:{id:string;question:string}[]};
// The team explicitly excluded the unlinked TBC item on 2026-10-06.
export const videos = catalog.videos.filter(video => video.youtubeId !== null);
export const questionCount = videos.reduce((n,v) => n+v.questions.length,0);
export const kindLabels:Record<Kind,string> = {recall:'내용 회상',conversation:'감상 · 경험',mixed:'감상 + 회상',context:'방송 맥락',calculation:'수리 이해',sequence:'순서 회상'};
export function timeLabel(t:number):string { return `${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`; }
export function segmentQuestions(video:Video,segment:Segment):Question[] { return video.questions.filter(q=>q.segmentId===segment.id); }
export function questionTime(q:Question,segment:Segment):string { return q.delivery==='after_segment' ? '구간 종료 후' : q.delivery==='after_video' ? '영상 종료 후' : timeLabel(q.timestamp ?? segment.start); }
// Repeated timestamps retain original question order. Approximate end labels do
// not become evidence timestamps: end-of-video questions wait for actual END.
export function nextDue(questions:Question[],done:ReadonlySet<string>,time:number,segment:Segment,ended=false):Question|undefined {
  return [...questions].sort((a,b)=>(a.timestamp??segment.end??Infinity)-(b.timestamp??segment.end??Infinity)||a.number-b.number)
    .find(q=>!done.has(q.id)&&(q.delivery==='after_video' ? ended : q.delivery==='after_segment' ? ended||(segment.end!==null&&time>=segment.end) : time>=(q.timestamp??Infinity)));
}
