import registry from '../content/local_video_sources.v1.json';
export interface LocalVideoSource {url:string;sourceStartSeconds:number;sha256:string}
export function localVideoSource(contentId:string):LocalVideoSource|undefined {
 const item=(registry.sources as Record<string,LocalVideoSource>)[contentId];
 if(!item)return;
 // Only curated files on this site's media path may replace a content item.
 if(!/^\/videos\/[A-Za-z0-9_/-]+\.(mp4|webm)$/.test(item.url)||item.url.includes('..')||!Number.isFinite(item.sourceStartSeconds)||item.sourceStartSeconds<0||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('영상 준비 정보를 확인하고 있어요. 다른 영상을 골라 주세요.');
 return {...item};
}
