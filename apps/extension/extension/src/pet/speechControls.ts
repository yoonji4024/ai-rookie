export type Phase='idle'|'opening'|'recording'|'transcribing'|'review'|'saving'|'saved'|'uncertain';
export interface SpeechState {phase:Phase;active:boolean;busy:boolean;speaking:boolean;closing:boolean;session:'welcome'|'watch'|null;welcomeDone:boolean;heard:boolean;autoFinish?:boolean;silenceSeconds?:number}
export function speechControl(state:SpeechState){
  if(state.phase==='recording')return {label:'말 다 했어요',status:state.heard?'네, 듣고 있어요':'마이크 켜짐',hint:state.autoFinish?`천천히 말씀하세요. 말씀 후 ${state.silenceSeconds??8}초 쉬면 자동으로 마쳐요.`:'다 말씀하셨으면 아래 버튼을 눌러 주세요.',action:'stop' as const,enabled:true,recording:true};
  if(state.phase==='opening')return {label:'마이크 준비 중',status:'마이크 연결 중',hint:'잠깐만 기다려 주세요.',action:'none' as const,enabled:false,recording:false};
  if(state.phase==='transcribing')return {label:'말씀 정리 중',status:'마이크 꺼짐',hint:'녹음을 마쳤어요. 말씀을 정리하고 있어요.',action:'none' as const,enabled:false,recording:false};
  const enabled=state.active&&['idle','review'].includes(state.phase)&&!state.busy&&!state.speaking&&!state.closing;
  const hint=state.closing?'이야기를 저장하거나, 계속 보기를 선택해 주세요.':state.phase==='saving'?'이야기를 안전하게 남기고 있어요.':state.phase==='uncertain'?'저장 상태를 먼저 확인해 주세요.':state.phase==='saved'?'이야기를 남겼어요. 이어서 볼 수 있어요.':state.speaking?'두리의 말을 들은 뒤 말씀해 주세요.':enabled?'누르면 영상이 잠시 멈추고 마이크가 켜져요.':!state.session&&!state.welcomeDone?'위의 ‘인사 나누기’를 누르면 이야기할 수 있어요.':state.session==='welcome'?'인사를 마쳤어요. 이제 영상을 보러 갈까요?':state.session==='watch'?'함께 보는 중이에요. 두리가 말을 걸면 눌러 주세요.':'함께 보기를 시작하면 이야기할 수 있어요.';
  return {label:state.phase==='review'&&state.active?'다시 말하기':'말하기',status:'마이크 꺼짐',hint,action:enabled?'record' as const:'none' as const,enabled,recording:false};
}
