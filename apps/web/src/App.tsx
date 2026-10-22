import {useEffect,useState} from 'react';
import MediaLibrary from './components/MediaLibrary';
import PatientInfoGate from './components/PatientInfoGate';
import FamilyDashboard from './components/FamilyDashboard';
import WatchTogether from './components/WatchTogether';
import WelcomeConversation from './components/WelcomeConversation';
import {rememberVideo} from './lib/randomVideo';
import {currentAccount,logout,startWatch,type Account,type WatchPlan} from './lib/portalApi';
import {localVideoSource} from './lib/localVideo';
import './theme.css';
export default function App(){
 const [welcomeDone,setWelcomeDone]=useState(false);
 const [account,setAccount]=useState<Account|null>(null),[loading,setLoading]=useState(true),[plan,setPlan]=useState<WatchPlan|null>(null),[error,setError]=useState(''),[starting,setStarting]=useState(false);
 useEffect(()=>{currentAccount().then(setAccount).catch(()=>setAccount(null)).finally(()=>setLoading(false));},[]);
 const signout=async()=>{try{await logout();setPlan(null);setWelcomeDone(false);setAccount(null);setError('');window.history.replaceState({},'','/')}catch{setError('로그아웃하지 못했어요. 연결을 확인해 주세요.')}};
 const start=async(videoId:string,segmentId:string)=>{if(starting)return;setStarting(true);setError('');try{const localVideo=localVideoSource(videoId);const next=await startWatch(videoId,segmentId);setPlan({...next,localVideo});if(account)rememberVideo(account.id,videoId)}catch(e){setError(e instanceof Error?e.message:'영상을 준비하지 못했어요.')}finally{setStarting(false)}};
 if(loading)return <main className="ee-loading" role="status">MEMFLIX를 준비하고 있어요.</main>;
 if(!account)return <PatientInfoGate onComplete={a=>{setWelcomeDone(false);setAccount(a);window.history.replaceState({},'','/')}}/>;
 if(account.role==='user'&&!welcomeDone)return <WelcomeConversation key={account.id} account={account} onDone={()=>setWelcomeDone(true)} onLogout={()=>void signout()}/>;
 if(plan&&account.role==='user')return <WatchTogether key={plan.id} plan={plan} onBack={()=>setPlan(null)}/>;
 return <>{error&&<div className="ee-app-error" role="alert">{error}</div>}{account.role==='guardian'?<FamilyDashboard account={account} onLogout={()=>void signout()}/>:<MediaLibrary account={account} onLogout={()=>void signout()} onStart={(video,segment)=>void start(video,segment)} starting={starting}/>}</>;
}
