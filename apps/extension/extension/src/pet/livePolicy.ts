// Pure scheduling policy; no provider, browser storage or synthetic answers.
export interface Pulse {seconds:number; prevSeconds:number; paused:boolean; ended:boolean; adShowing:boolean; fullscreen:boolean}
export interface LivePrompt {id:string; timestamp:number|null; delivery:string}
export function canRecord(pulse:Pulse|null,kind:'welcome'|'watch'):boolean {
  if(!pulse)return kind==='welcome';
  return !pulse.adShowing&&(pulse.paused||pulse.ended);
}
export function duePrompts(prompts:LivePrompt[],previous:Pulse|null,current:Pulse,segmentEnd:number|null):string[] {
  if(!previous||current.adShowing||previous.adShowing||current.fullscreen)return [];
  const step=current.seconds-previous.seconds;
  if(step<0||step>2.5)return []; // Seeking is not exposure to the intervening scenes.
  return prompts.filter(p=>{
    if(p.delivery==='after_video')return current.ended&&!previous.ended;
    const target=p.timestamp??segmentEnd;
    return target!==null&&previous.seconds<target&&current.seconds>=target;
  }).map(p=>p.id);
}
export function transcriptOutcome(text:unknown):'recorded'|'untranscribed' {
  return typeof text==='string'&&text.trim().length>0?'recorded':'untranscribed';
}
