import {useState,type FormEvent} from 'react';
import {request,type Account} from '../lib/portalApi';
import Duri from './Duri';
export type UserRole='guardian'|'user';
export interface LoginInfo {role:UserRole;username:string;password?:string}
export default function PatientInfoGate({onComplete}:{onComplete:(account:Account)=>void}){
 const [register,setRegister]=useState(false),[role,setRole]=useState<UserRole>('user');
 const [username,setUsername]=useState(''),[name,setName]=useState(''),[password,setPassword]=useState('');
 const [memberIdentity,setMemberIdentity]=useState(''),[code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const family=register&&role==='guardian';
 const submit=async(e:FormEvent)=>{
  e.preventDefault();if(busy)return;setBusy(true);setError('');
  try{
   const path=family?'/account/register-family':register?'/account/register':'/account/login';
   const body={username:username.trim(),password,...(family?{memberIdentity:memberIdentity.trim(),code:code.replace(/[\s-]/g,'')}:register?{role,displayName:name.trim()}: {})};
   const account=await request<Account>(path,'POST',body);setPassword('');setCode('');onComplete(account);
  }catch(e){setError(e instanceof Error?e.message:'연결을 확인해 주세요.')}finally{setBusy(false)}
 };
 return <main className="ee-login">
  <section className="ee-login-story"><a className="ee-brand" href="/">MEMFLIX</a><span className="ee-eyebrow">함께 보는 일상</span><h1>좋아하는 영상을,<br/>다정한 대화와 함께.</h1><p>편안하게 보고 이야기해요.<br/>가족과는 일상의 기록을 나눌 수 있어요.</p><div className="ee-login-art"><Duri size={176}/><span className="ee-login-art-quote"><span>“오늘은 어떤</span><span>이야기를 볼까요?”</span></span></div></section>
  <section className="ee-login-form"><form onSubmit={e=>void submit(e)}>
   <span className="ee-eyebrow">WELCOME TO MEMFLIX</span><h2>{family?'가족의 일상을 함께 살펴봐요':register?'처음 만나서 반가워요':'다시 만나서 반가워요'}</h2><p>{family?'내 계정을 만들고, 기록을 함께 볼 가족을 연결해요.':register?'사용할 계정을 만들어 주세요.':'로그인하고 편안한 시간을 시작해요.'}</p>
   {register&&<fieldset><legend>이용 방식</legend><div className="ee-role-options">{[['user','일반 사용자','영상과 대화를 즐겨요'],['guardian','패밀리 사용자','연결된 가족의 기록을 봐요']].map(([id,label,desc])=><label key={id} className={role===id?'active':''}><input type="radio" name="role" value={id} checked={role===id} disabled={busy} onChange={()=>{setRole(id as UserRole);setError('')}}/><strong>{label}</strong><small>{desc}</small></label>)}</div></fieldset>}
   <label htmlFor="account-id">{family?'내 로그인 아이디':'아이디'}</label><input id="account-id" required minLength={2} maxLength={50} autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder={family?'패밀리 계정에서 사용할 아이디':'사용할 아이디'} disabled={busy}/>
   {register&&!family&&<><label htmlFor="display-name">부를 이름</label><input id="display-name" required maxLength={40} autoComplete="name" value={name} onChange={e=>setName(e.target.value)} placeholder="화면에 표시할 이름" disabled={busy}/></>}
   <label htmlFor="account-password">{family?'내 비밀번호':'비밀번호'}</label><input id="account-password" type="password" required minLength={register?8:1} maxLength={128} autoComplete={register?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder={register?'8자 이상 입력해 주세요':'비밀번호를 입력해 주세요'} disabled={busy}/>
   {family&&<fieldset className="ee-family-signup"><legend>연결할 가족</legend><label htmlFor="member-identity">연결할 사용자의 아이디 또는 이름</label><input id="member-identity" required maxLength={50} autoComplete="off" value={memberIdentity} onChange={e=>setMemberIdentity(e.target.value)} placeholder="영상을 시청하는 분의 아이디 또는 이름" aria-describedby="family-signup-help" disabled={busy}/><label htmlFor="member-code">사용자가 공유한 연결 코드</label><input id="member-code" required minLength={12} maxLength={24} autoComplete="off" value={code} onChange={e=>setCode(e.target.value)} placeholder="12자리 연결 코드" disabled={busy}/><p id="family-signup-help">연결할 사용자의 ‘가족 연결’ 화면에서 받은 코드를 입력해 주세요. 공유를 허용한 가족의 기록만 볼 수 있어요.</p></fieldset>}
   {error&&<p className="ee-form-error" role="alert">{error}</p>}<button className="ee-primary" disabled={busy}>{busy?'연결하고 있어요…':family?'가입하고 가족 연결하기':register?'계정 만들기':'로그인'}</button><button className="ee-text-button" type="button" disabled={busy} onClick={()=>{setRegister(!register);setError('');setPassword('');setCode('')}}>{register?'이미 계정이 있어요 · 로그인':'처음 오셨나요? 계정 만들기'}</button>
  </form></section>
 </main>
}
