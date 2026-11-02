import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nextDemoPosition} from '../src/lib/demoMode.ts';
import {nextWatchCue} from '../src/lib/watchTimeline.ts';
import type {WatchPlan} from '../src/lib/portalApi';

test('reviewed island clip returns to viewing between the three questions',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../../../configs/content/team_video_questions.v1.json',import.meta.url),'utf8'));
 const video=catalog.videos.find((v:any)=>v.id==='lnvaFy7cRmk');
 const segment=video.segments.find((s:any)=>s.id==='s1');
 const plan:WatchPlan={id:'timing-only',contentId:video.id,title:video.title,youtubeId:video.youtubeId,segment,
  prompts:video.questions.filter((q:any)=>q.segmentId===segment.id).map((q:any)=>({
   id:q.id,question:q.question,timestamp:q.timestamp??segment.end,delivery:q.delivery,maxRecordingMs:60000,
  }))};
 const done=new Set<string>();
 let position=segment.start;
 for(const [index,expected] of [100,150,420].entries()){
  const jump=nextDemoPosition(plan,done,position,3616)!;
  assert.equal(jump,expected-8);
  assert.equal(nextWatchCue(plan,done,jump,false),undefined);
  const cue=nextWatchCue(plan,done,expected,false)!;
  assert.equal(cue.prompt.id,`${video.id}-q${index+1}`);
  done.add(cue.prompt.id);
  assert.equal(nextWatchCue(plan,done,expected,false),undefined,'a second question must not immediately queue');
  position=expected;
 }
 assert.equal(nextDemoPosition(plan,done,position,3616),null);
});
