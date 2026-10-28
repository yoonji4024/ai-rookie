import {useEffect, useState} from 'react';
import PetFace from '../../../src/components/PetFace';
import {AUTH_KEY, PortalClient, WEB_URL, readAuth, type Auth} from '../pet/portalClient';
import './launcher.css';
import DialogueSettings from '../pet/DialogueSettings';

export default function Launcher({settings=false}: {settings?: boolean}) {
  const [auth,setAuth]=useState<Auth|null>(null),[ready,setReady]=useState(false);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [loginOpen,setLoginOpen]=useState(false),[username,setUsername]=useState(''),[password,setPassword]=useState('');
  useEffect(()=>{
    let active=true;
    const load=()=>chrome.storage.session.get(AUTH_KEY).then(bag=>{if(active)setAuth(readAuth(bag[AUTH_KEY]));})
      .catch(()=>{if(active)setMessage('연결 상태를 확인하지 못했어요.');}).finally(()=>{if(active)setReady(true);});
    const changed=(_changes:unknown,area:string)=>{if(area==='session')void load();};
    void load();chrome.storage.onChanged.addListener(changed);
    return()=>{active=false;chrome.storage.onChanged.removeListener(changed);};
  },[]);
  async function logout(){
    if(busy||!auth)return;setBusy(true);setMessage('');
    try{await new PortalClient(auth).request('/account/logout',{});await chrome.storage.session.remove(AUTH_KEY);setAuth(null);setMessage('로그아웃했어요.');}
    catch{setMessage('연결을 확인한 뒤 다시 시도해 주세요.');}finally{setBusy(false);}
  }
  async function login(event:React.FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setMessage('');
    try{
      const result=await new PortalClient().login(username.trim(),password),next=readAuth(result);
      if(!next)throw new Error('일반 사용자 계정으로 로그인해 주세요. 패밀리 계정은 가족 리포트에서 이용할 수 있어요.');
      await chrome.storage.session.set({[AUTH_KEY]:next});setAuth(next);setPassword('');setLoginOpen(false);
      setMessage('로그인했어요. YouTube에서 두리와 인사를 시작해 주세요.');
    }catch(error){setMessage(error instanceof Error?error.message:'로그인하지 못했어요. 연결을 확인해 주세요.');}
    finally{setBusy(false);}
  }
  return <main className={'launcher '+(settings?'settings':'compact')+(loginOpen&&!auth?' signing-in':'')}>
    <header><a className="brand" href={WEB_URL} target="_blank" rel="noreferrer">MEMFLIX</a><span className="status">{ready?(auth?'로그인됨':'로그인 전'):'확인 중'}</span></header>
    {loginOpen&&!auth?<form className="launcher-login" onSubmit={login}>
      <h1>두리와 인사해요</h1><p>MEMFLIX에서 만든 일반 사용자 계정으로 로그인해 주세요.</p>
      <label htmlFor="launcher-username">아이디</label><input id="launcher-username" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required disabled={busy}/>
      <label htmlFor="launcher-password">비밀번호</label><input id="launcher-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required disabled={busy}/>
      <button className="primary" disabled={busy}>{busy?'로그인 중…':'로그인'}</button>
      <a href={WEB_URL} target="_blank" rel="noreferrer">계정 만들기 · 가족 리포트</a>
      <button type="button" className="text-action" disabled={busy} onClick={()=>{setPassword('');setMessage('');setLoginOpen(false);}}>돌아가기</button>
    </form>:<>
    {settings?<><h1>MEMFLIX 환경설정</h1><DialogueSettings/></>:<>
    <div className="pet-portrait"><PetFace petName="두리" size={92}/><span className="pet-dot" aria-hidden="true"/></div>
    <h1><em className="hl">영상 볼 때,</em> 같이 있어요.</h1>
    <p className="intro">YouTube에 들어가면<br/>두리가 영상 옆으로 찾아갈게요.</p></>}
    <div className="launcher-actions">
      {ready&&!auth&&<button className="primary" onClick={()=>{setLoginOpen(true);setMessage('');}}>로그인하고 함께 보기</button>}
      <a className={auth?'primary':'secondary'} href="https://www.youtube.com/" target="_blank" rel="noreferrer">YouTube로 가기 <span aria-hidden="true">↗</span></a>
      <a className="secondary" href={WEB_URL} target="_blank" rel="noreferrer">가족 리포트 · 계정</a>
    </div>
    <p className="microphone-note">소리와 마이크는 설정에서 조절할 수 있어요.</p>
    {settings?<section className="settings-detail"><h2>내 연결</h2><p>{auth?`${auth.account.displayName} 님으로 연결되어 있어요.`:'위의 로그인 버튼으로 계정을 연결해 주세요.'}</p>
      {auth&&<button className="text-action" disabled={busy} onClick={()=>void logout()}>{busy?'로그아웃 중…':'확장 프로그램 로그아웃'}</button>}
      <h2>두리가 보이지 않나요?</h2><p>YouTube 탭을 새로고침하고 툴바의 두리 아이콘을 눌러 주세요. ‘오늘은 혼자 볼게요’를 선택했어도 다시 열 수 있어요.</p>
      <p className="small-note">준비된 영상에서 대화를 나눌 수 있어요. 음성은 분석 서버에 전달되며, 허용한 가족이 저장된 기록을 볼 수 있어요.</p>
    </section>:<footer><span>{auth?`${auth.account.displayName} 님과 함께`:'일반 사용자 계정으로 함께 봐요'}</span><button className="text-action" onClick={()=>void chrome.runtime.openOptionsPage()}>설정</button></footer>}
    </>}
    {message&&<p className="feedback" role="status">{message}</p>}
  </main>;
}
