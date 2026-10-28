/** One authenticated live stream per recording; never resend a failed waveform. */
export interface LiveTranscript {
  send(chunk:ArrayBuffer):void;
  finish():Promise<string>;
  cancel():void;
}
export function startLiveTranscript(apiRoot:string,token:string,signal:AbortSignal):Promise<LiveTranscript>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('대화를 중단했어요.'));return;}
    const url=new URL(apiRoot+'/stt/live');url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(url.href);
    let ready=false,ending=false,settled=false,failed:Error|null=null;
    let resolveFinal!:(value:string)=>void,rejectFinal!:(error:Error)=>void;
    const final=new Promise<string>((ok,no)=>{resolveFinal=ok;rejectFinal=no;});
    // Failure may arrive during recording, before finish() consumes this promise.
    void final.catch(()=>{});
    let finishTimer:ReturnType<typeof setTimeout>|undefined;
    const connectTimer=setTimeout(()=>fail('음성 연결이 늦어지고 있어요. 다시 말하기를 눌러 주세요.'),12000);
    const lifetime=setTimeout(()=>fail('대화 연결 시간이 끝났어요.'),95000);
    const cleanup=()=>{clearTimeout(connectTimer);clearTimeout(finishTimer);clearTimeout(lifetime);signal.removeEventListener('abort',abort);};
    const fail=(message:string)=>{
      if(settled)return;settled=true;failed=new Error(message);cleanup();
      if(!ready)reject(failed);rejectFinal(failed);socket.close();
    };
    const abort=()=>fail('대화를 중단했어요.');signal.addEventListener('abort',abort,{once:true});
    socket.onopen=()=>{if(!settled)socket.send(JSON.stringify({type:'start',token}));};
    socket.onmessage=event=>{
      if(settled)return;
      let message:{type?:string;text?:unknown};
      try{message=JSON.parse(String(event.data));}catch{fail('음성 응답을 확인하지 못했어요.');return;}
      if(message.type==='ready'&&!ready){
        ready=true;clearTimeout(connectTimer);
        resolve({
          send(chunk){
            if(settled||ending)return;
            if(socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>128000){fail('음성 연결이 끊겼어요.');return;}
            socket.send(chunk);
          },
          finish(){
            if(failed)return Promise.reject(failed);
            if(!ending&&!settled){ending=true;socket.send('{"type":"stop"}');finishTimer=setTimeout(()=>fail('전사 결과가 늦어지고 있어요. 자동으로 다시 보내지는 않아요.'),18000);}
            return final;
          },
          cancel:abort,
        });
      }else if(message.type==='done'&&ending&&typeof message.text==='string'&&message.text.trim()){
        settled=true;cleanup();resolveFinal(message.text.trim());socket.close();
      }else if(message.type!=='transcript')fail('음성 연결을 마무리하지 못했어요.');
    };
    socket.onerror=()=>fail('음성 서버에 연결하지 못했어요.');
    socket.onclose=()=>{if(!settled)fail('음성 연결이 종료됐어요.');};
  });
}
