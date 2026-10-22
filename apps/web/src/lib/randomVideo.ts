import type {Video} from '../content/catalog';

export function chooseVideo(pool:Video[], previous:string|null, random= Math.random){
 const eligible=pool.filter(v=>v.segments.length>0);
 const alternatives=eligible.filter(v=>v.id!==previous);
 const candidates=alternatives.length?alternatives:eligible;
 if(!candidates.length)return null;
 const video=candidates[Math.min(candidates.length-1,Math.floor(random()*candidates.length))];
 const segment=video.segments[Math.min(video.segments.length-1,Math.floor(random()*video.segments.length))];
 return {videoId:video.id,segmentId:segment.id};
}
export function lastVideo(accountId:string){try{return sessionStorage.getItem('earlyear:last-video:'+accountId)}catch{return null}}
export function rememberVideo(accountId:string,videoId:string){try{sessionStorage.setItem('earlyear:last-video:'+accountId,videoId)}catch{/* optional preference */}}
