/** Presentation controls change navigation and playback only. */
export function isDemoPath(pathname:string):boolean {
 return pathname==='/demo'||pathname==='/demo/';
}

interface DemoPrompt {id:string;timestamp:number;delivery:'at_time'|'after_video'|'after_segment'}
interface DemoPlan {segment:{start:number;end:number|null};prompts:DemoPrompt[]}

/** Keep each selected question in order and show eight seconds of its scene. */
export function nextDemoPosition(plan:DemoPlan,done:ReadonlySet<string>,current:number,duration:number|undefined):number|null {
 const next=plan.prompts.find(prompt=>!done.has(prompt.id));
 if(!next)return null;
 const end=plan.segment.end??duration;
 const questionTime=next.delivery==='at_time'?next.timestamp:end;
 if(questionTime===undefined||!Number.isFinite(questionTime))return null;
 const currentTime=Number.isFinite(current)?current:plan.segment.start;
 return Math.max(plan.segment.start,currentTime,questionTime-8);
}
