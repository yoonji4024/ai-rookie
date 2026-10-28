import connection from '../../connection.json';
import {responseError,transportError} from './portalErrors';
import {startLiveTranscript} from './liveTranscript';

export interface Account {id:string; username:string; displayName:string; role:'user'|'guardian'}
export interface Auth {token:string; account:Account}
export interface Segment {id:string; label:string; start:number; end:number|null}
export interface CatalogVideo {id:string; title:string; segments:Segment[]}
export interface Prompt {id:string; question:string; timestamp:number|null; delivery:'at_time'|'after_video'|'after_segment'; maxRecordingMs:number}
export interface Watch {id:string; contentId:string; title:string; segment:Segment; prompts:Prompt[]}
export interface Welcome {id?:string; state:string; prompts?:{id:string; question:string}[]}
export interface Answer {id:string; userAnswer:string; state:'recorded'|'untranscribed'|'silent'|'skipped'; videoTimestamp?:number}
export interface DialogueMemory {previous:{quote:string;title:string}|null;promise:{text:string}|null}
export const AUTH_KEY='memflix.connected.auth.v1';
export const WEB_URL='http://127.0.0.1:5173/';
export function readAuth(value:unknown):Auth|null {
  if(!value||typeof value!=='object')return null;
  const candidate=value as Partial<Auth>;
  return typeof candidate.token==='string'&&/^[A-Za-z0-9_-]{40,128}$/.test(candidate.token)
    &&typeof candidate.account?.id==='string'&&typeof candidate.account.displayName==='string'
    &&candidate.account.role==='user'?candidate as Auth:null;
}

export class PortalClient {
  constructor(public auth:Auth|null=null) {}
  openLiveTranscript(signal:AbortSignal){
    if(!this.auth)throw new Error('다시 로그인해 주세요.');
    return startLiveTranscript(connection.apiRoot,this.auth.token,signal);
  }
  async request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
    const multipart=body instanceof FormData;
    const headers:Record<string,string>={'X-Memflix-Extension':connection.id};
    if(this.auth)headers.Authorization='Bearer '+this.auth.token;
    if(body!==undefined&&!multipart)headers['Content-Type']='application/json';
    const response=await fetch(connection.apiRoot+path,{method:body===undefined?'GET':'POST',
      headers,credentials:'omit',redirect:'error',body:body===undefined?undefined:multipart?body:JSON.stringify(body),
      signal:signal??AbortSignal.timeout(90000)}).catch(error=>{throw transportError(error);});
    if(!response.ok){
      const error=await response.json().catch(()=>({}));
      throw responseError(response.status,error.detail);
    }
    return response.json() as Promise<T>;
  }
  async login(username:string,password:string) {
    const auth=await this.request<Auth>('/extension/login',{username,password});
    this.auth=auth; return auth;
  }
  async transcribe(file:File,signal:AbortSignal) {
    const body=new FormData();body.append('audio',file,file.name);body.append('answerKeywords','[]');
    const result=await this.request<{text?:string}>('/transcribe',body,signal);
    if(typeof result.text!=='string'||!result.text.trim())throw new Error('목소리를 글로 확인하지 못했어요.');
    return result.text.trim();
  }
  save(kind:'watch'|'welcome',id:string,answers:Answer[],files:File[],nextMeeting='') {
    const body=new FormData();body.append(kind==='watch'?'watchId':'welcomeId',id);
    body.append('answers',JSON.stringify(answers));files.forEach(file=>body.append('audio',file,file.name));
    if(kind==='watch')body.append('nextMeeting',nextMeeting);
    return this.request(kind==='watch'?'/report':'/welcome/finish',body,AbortSignal.timeout(180000));
  }
}
