import type {ReportResponse,AnswerInput} from './scoreApi';
import type {LocalVideoSource} from './localVideo';
export interface Account{id:string;username:string;displayName:string;role:'user'|'guardian'}
export interface FamilyMember{id:string;displayName:string}
export interface WatchPlan{id:string;contentId:string;title:string;youtubeId:string;localVideo?:LocalVideoSource;segment:{id:string;label:string;start:number;end:number|null};prompts:{id:string;question:string;timestamp:number;delivery:'at_time'|'after_video'|'after_segment';maxRecordingMs:number}[]}
export interface FamilyReport{id:string;createdAt:number;contentId:string;title:string;selectedIds:string[];report:ReportResponse}
const ROOT='/api/score';
export async function request<T>(path:string,method='GET',body?:unknown):Promise<T>{
 const response=await fetch(ROOT+path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
 if(!response.ok){if(response.status===404&&(path==='/account/register-family'||path==='/family/connect-identified'))throw new Error('지금은 가족 연결을 완료할 수 없어요. 잠시 후 다시 시도해 주세요.');const error=await response.json().catch(()=>({}));throw new Error(typeof error.detail==='string'?error.detail:response.status===422?'입력한 내용을 확인해 주세요.':'연결을 확인한 뒤 다시 시도해 주세요.')}
 return response.json() as Promise<T>;
}
export const currentAccount=()=>request<Account>('/account/me');
export const logout=()=>request('/account/logout','POST');
export const members=()=>request<FamilyMember[]>('/family/members');
export const reports=(id:string)=>request<FamilyReport[]>('/family/reports/'+encodeURIComponent(id));
export const startWatch=(videoId:string,segmentId:string)=>request<WatchPlan>('/watch','POST',{videoId,segmentId});
export interface WelcomePlan {id?:string;state:'needed'|'ready'|'processing'|'failed'|'complete'|'partial'|'skipped';prompts?:{id:string;question:string}[]}
export interface WelcomeAnswer {id:string;userAnswer:string;state:'recorded'|'untranscribed'|'silent'|'skipped'}
export interface WelcomeRecord {id:string;createdAt:number;status:string;reference:{timezone:string;date:string;source:string};notice:string;validated:false;observations:{questions:{id:string;score:number|null}[]};items:(WelcomeAnswer&{question:string;recordingUrl:string|null})[]}
export const welcomeState=()=>request<WelcomePlan>('/welcome');
export const startWelcome=(timezone:string)=>request<WelcomePlan>('/welcome/start','POST',{timezone});
export const welcomeRecords=(owner:string)=>request<WelcomeRecord[]>('/family/welcomes/'+encodeURIComponent(owner));
export async function finishWelcome(id:string,answers:WelcomeAnswer[],audio:File[]){
 const fd=new FormData();fd.append('welcomeId',id);fd.append('answers',JSON.stringify(answers));audio.forEach(file=>fd.append('audio',file,file.name));
 const response=await fetch(ROOT+'/welcome/finish',{method:'POST',body:fd,signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error('기록 저장을 확인하지 못했어요. 다시 확인하거나 영상을 먼저 보셔도 괜찮아요.');
 return response.json() as Promise<{state:string}>;
}
export async function saveWatch(watchId:string,answers:AnswerInput[],audio:File[]):Promise<ReportResponse>{
 const fd=new FormData();fd.append('watchId',watchId);fd.append('answers',JSON.stringify(answers));audio.forEach(file=>fd.append('audio',file,file.name));
 const response=await fetch(ROOT+'/report',{method:'POST',body:fd});
 if(!response.ok)throw new Error('기록 정리를 완료하지 못했어요. 연결을 확인해 주세요.');return response.json();
}
