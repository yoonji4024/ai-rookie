import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLiveTranscript} from './liveTranscript.ts';

class Socket {
  static OPEN=1;static last:Socket;
  readyState=1;bufferedAmount=0;sent:unknown[]=[];closed=false;url:string;
  onopen:(()=>void)|null=null;onmessage:((e:{data:string})=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;
  constructor(url:string){this.url=url;Socket.last=this;}
  send(value:unknown){this.sent.push(value);}
  close(){this.closed=true;}
  emit(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
}
Object.assign(globalThis,{WebSocket:Socket});
const root='http://127.0.0.1:5173/api/score';
async function open(){
  const abort=new AbortController();const pending=startLiveTranscript(root,'secret-session',abort.signal);
  const socket=Socket.last;socket.onopen?.();socket.emit({type:'ready'});
  return {session:await pending,socket,abort};
}
test('session token stays in first message, never URL; PCM precedes stop',async()=>{
  const {session,socket}=await open();
  assert.equal(socket.url,'ws://127.0.0.1:5173/api/score/stt/live');
  assert.deepEqual(JSON.parse(socket.sent[0] as string),{type:'start',token:'secret-session'});
  session.send(new ArrayBuffer(3200));const result=session.finish();session.finish();
  assert.equal(socket.sent.length,3);socket.emit({type:'done',text:'작성 문장'});
  assert.equal(await result,'작성 문장');assert.equal(socket.closed,true);
});
test('recording cancellation closes once and never retransmits',async()=>{
  const {session,socket,abort}=await open();session.send(new ArrayBuffer(3200));abort.abort();
  session.send(new ArrayBuffer(3200));await assert.rejects(session.finish());
  assert.equal(socket.sent.length,2);assert.equal(socket.closed,true);
});
test('network failure during recording is retained until finish without unhandled rejection',async()=>{
  const {session,socket}=await open();socket.onerror?.();await new Promise(r=>setTimeout(r,0));
  await assert.rejects(session.finish());assert.equal(socket.sent.length,1);
});
test('partial result alone cannot finish',async()=>{
  const {session,socket}=await open();session.send(new ArrayBuffer(3200));const result=session.finish();
  socket.emit({type:'transcript',text:'partial',final:false});socket.onclose?.();
  await assert.rejects(result);assert.equal(socket.closed,true);
});
test('provider done before recording stop is rejected',async()=>{
  const {session,socket}=await open();socket.emit({type:'done',text:'early'});
  await assert.rejects(session.finish());
});
test('backpressure does not queue unlimited microphone audio',async()=>{
  const {session,socket}=await open();socket.bufferedAmount=128001;session.send(new ArrayBuffer(3200));
  await assert.rejects(session.finish());assert.equal(socket.sent.length,1);
});
test('cancel during connect rejects and closes without sending audio',async()=>{
  const abort=new AbortController();const pending=startLiveTranscript(root,'token',abort.signal);const socket=Socket.last;
  abort.abort();await assert.rejects(pending);assert.equal(socket.closed,true);assert.equal(socket.sent.length,0);
});
