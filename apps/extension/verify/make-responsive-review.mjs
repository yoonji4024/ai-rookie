import {cpSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
// Render the exact built pet UI with authored responses. No real API or microphone.
const output='dist-responsive-review';
mkdirSync(output,{recursive:true});
cpSync('dist-ext',output,{recursive:true});
const mock=`
const auth={token:'f'.repeat(43),account:{id:'fixture',username:'fixture',displayName:'가상 사용자',role:'user'}};
const listeners=new Set();
window.chrome={tabs:{getCurrent:async()=>({id:1}),sendMessage:async()=>({})},runtime:{getURL:path=>'/'+path,openOptionsPage:async()=>{},sendMessage:async()=>({}),onMessage:{addListener:fn=>listeners.add(fn)}},storage:{session:{get:async key=>new URL(location.href).searchParams.has('login')?{}:{[key]:auth},set:async()=>{},remove:async()=>{}},local:{get:async key=>({[key]:{autoVoice:false,autoListen:false,autoFinish:true,silenceSeconds:5,volume:1}}),set:async()=>{}},onChanged:{addListener:()=>{},removeListener:()=>{}}}};
window.fetch=async input=>{
  const path=new URL(String(input)).pathname;
  let body;
  if(path.endsWith('/account/me'))body=auth.account;
  else if(path.endsWith('/memory'))body={previous:null,promise:null};
  else if(path.endsWith('/extension/catalog'))body=[];
  else if(path.endsWith('/welcome'))body={state:'needed'};
  else if(path.endsWith('/welcome/start'))body={state:'ready',id:'fixture-welcome',prompts:[{id:'fixture-prompt',question:'저는 오늘 오랜만에 친구를 만나고 싶어요. 오늘은 어떤 하루를 보내고 계세요?'}]};
  else throw new Error('Only authored layout fixtures are available');
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
};
`;
const html=readFileSync('dist-ext/extension/pet.html','utf8').replace('<head>','<head><script>'+mock+'</script>');
writeFileSync(output+'/frame-review.html',html);
writeFileSync(output+'/stage.html',`<!doctype html><html lang="ko"><meta charset="utf-8"><title>브라우저 영역</title><style>body{margin:0;background:#eee9e5;font:20px sans-serif}h1{padding:40px;font-size:24px}iframe{position:fixed;right:8px;bottom:8px;border:0;width:392px;height:720px}</style><h1>영상 영역 · 실제 API와 마이크를 사용하지 않는 화면 검증</h1><iframe title="두리 대화창" id="pet"></iframe><script>
const pet=document.getElementById('pet');let ready=false;
pet.src='/frame-review.html?instance=fixture'+(new URL(location.href).searchParams.has('login')?'&login':'');
const send=()=>pet.contentWindow.postMessage({v:2,source:'memflix-pet',type:'host/viewport',width:innerWidth,height:innerHeight},location.origin);
addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==pet.contentWindow||e.data?.source!=='memflix-pet')return;if(e.data.type==='frame/size'){pet.style.width=e.data.width+'px';pet.style.height=e.data.height+'px';if(!ready){ready=true;send();}}});
addEventListener('resize',send);
</script></html>`);
writeFileSync(output+'/index.html',`<!doctype html><html lang="ko"><meta charset="utf-8"><title>MEMFLIX 반응형 검증</title><style>body{margin:16px;background:#fff;font:16px sans-serif}nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}button{padding:10px}iframe{border:1px solid #ddd;width:1280px;height:800px}</style><h1>MEMFLIX 반응형 검증 · 가상 입력</h1><p>실제 빌드 화면. 외부 API·실제 계정·마이크 사용 없음.</p><nav id="sizes"></nav><iframe title="브라우저 모의 화면" id="stage" src="/stage.html"></iframe><script>
const stage=document.getElementById('stage');
for(const [w,h] of [[320,500],[768,600],[1280,800],[1440,900],[1600,900],[1920,1080],[2560,1440],[1920,500]]){const b=document.createElement('button');b.textContent=w+' × '+h;b.onclick=()=>{stage.style.width=w+'px';stage.style.height=h+'px';};document.getElementById('sizes').append(b);}
const b=document.createElement('button');b.textContent='로그인 화면';b.onclick=()=>stage.src='/stage.html?login';document.getElementById('sizes').append(b);
</script></html>`);
