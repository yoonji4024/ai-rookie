export type Layout = {type:'frame/size';width:number;height:number}|{type:'frame/hide'}|{type:'frame/busy';busy:boolean};
export function frameEnvelope(channel:string,event:Layout){return {v:1,type:'pet/frame-layout',channel,event};}
export function acceptFrameLayout(message:unknown,sender:{id?:string;url?:string},expected:{id:string;url:string;channel:string}):Layout|null {
  if(!expected.channel||sender.id!==expected.id||sender.url!==expected.url||!message||typeof message!=='object')return null;
  const m=message as {v?:unknown;type?:unknown;channel?:unknown;event?:unknown};
  if(m.v!==1||m.type!=='pet/frame-layout'||m.channel!==expected.channel||!m.event||typeof m.event!=='object')return null;
  const e=m.event as Layout;
  if(e.type==='frame/size')return Number.isFinite(e.width)&&Number.isFinite(e.height)&&e.width>0&&e.height>0&&e.width<=4096&&e.height<=10000?e:null;
  if(e.type==='frame/busy')return typeof e.busy==='boolean'?e:null;
  return e.type==='frame/hide'?e:null;
}
