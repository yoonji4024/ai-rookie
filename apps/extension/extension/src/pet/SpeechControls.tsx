import {speechControl,type SpeechState} from './speechControls.ts';

export function MicIcon({stop=false}:{stop?:boolean}){
  return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {stop?<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>:<><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>}
  </svg>;
}
export function SpeakerIcon(){return <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg>;}
export default function SpeechControls({state,onRecord,onStop}:{state:SpeechState;onRecord:()=>void;onStop:()=>void}){
  const control=speechControl(state);
  return <section className="speech-controls" aria-label="음성 대화" data-recording={control.recording}>
    <div className="mic-status" role="status"><span className="status-dot"/>{control.status}</div>
    <button className="mic-button" disabled={!control.enabled} aria-describedby="mic-help" onClick={()=>{if(control.action==='stop')onStop();else if(control.action==='record')onRecord();}}><MicIcon stop={control.recording}/>{control.label}</button>
    <p id="mic-help" className="mic-help">{control.hint}</p>
  </section>;
}
