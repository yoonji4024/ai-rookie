export const PREFERENCES_KEY='memflix.dialogue.preferences.v1';
export interface DialoguePreferences {autoVoice:boolean;autoListen:boolean;autoFinish:boolean;silenceSeconds:5|8;volume:number;speed:number}
export const DEFAULT_PREFERENCES:DialoguePreferences={autoVoice:true,autoListen:false,autoFinish:true,silenceSeconds:8,volume:.8,speed:.92};
export function readPreferences(raw:unknown):DialoguePreferences {
  const r=(raw&&typeof raw==='object'?raw:{}) as Partial<DialoguePreferences>;
  const number=(v:unknown,min:number,max:number,fallback:number)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(min,v)):fallback;
  return {autoVoice:typeof r.autoVoice==='boolean'?r.autoVoice:true,autoListen:r.autoListen===true,autoFinish:typeof r.autoFinish==='boolean'?r.autoFinish:true,silenceSeconds:r.silenceSeconds===5?5:8,volume:number(r.volume,0,1,.8),speed:number(r.speed,.8,1.2,.92)};
}
export interface SilenceState {started:number;lastVoice:number|null}
// Thinking before the first word is distinct from a pause after speaking.
export function silenceDecision(state:SilenceState,now:number,seconds:number):'wait'|'empty'|'finish' {
  if(state.lastVoice===null)return now-state.started>=20000?'empty':'wait';
  return now-state.lastVoice>=seconds*1000?'finish':'wait';
}
export function automaticTurnAllowed(input:{armed:boolean;hidden:boolean;phase:string;active:boolean;busy:boolean;closing:boolean}):boolean {
  return input.armed&&!input.hidden&&input.phase==='idle'&&input.active&&!input.busy&&!input.closing;
}
