import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isDemoPath, nextDemoPosition} from '../src/lib/demoMode.ts';
import {nextWatchCue} from '../src/lib/watchTimeline.ts';
import type {WatchPlan} from '../src/lib/portalApi';

const plan:WatchPlan={id:'fixture',contentId:'fixture',title:'Authored demo fixture',youtubeId:'fixture',
 segment:{id:'s1',label:'First segment',start:60,end:420},prompts:[
  {id:'q1',question:'Authored segment question',timestamp:420,delivery:'after_segment',maxRecordingMs:60000},
  {id:'q2',question:'Authored follow-up question',timestamp:420,delivery:'after_segment',maxRecordingMs:60000},
 ]};

test('only /demo and /demo/ enable presentation controls',()=>{
 assert.equal(isDemoPath('/demo'),true);assert.equal(isDemoPath('/demo/'),true);
 for(const path of ['/','/demonstration','/demo/report'])assert.equal(isDemoPath(path),false);
});
test('seven-minute segment jumps to 6:52 and waits for its real question boundary',()=>{
 const done=new Set<string>();const target=nextDemoPosition(plan,done,60,3617);
 assert.equal(target,412);assert.equal(nextWatchCue(plan,done,target!,false),undefined);
 assert.equal(nextWatchCue(plan,done,420,false)?.prompt.id,'q1');
});
test('finishing one segment question keeps the next at the same paused boundary',()=>{
 const done=new Set(['q1']);assert.equal(nextDemoPosition(plan,done,420,3617),420);
 assert.equal(nextWatchCue(plan,done,420,true)?.prompt.id,'q2');
 assert.equal(nextDemoPosition(plan,new Set(['q1','q2']),420,3617),null);
});
test('short previews do not seek before the selected segment or rewind ongoing playback',()=>{
 const scene={...plan,prompts:[{...plan.prompts[0],delivery:'at_time' as const,timestamp:65}]};
 assert.equal(nextDemoPosition(scene,new Set(),0,3617),60);
 assert.equal(nextDemoPosition(plan,new Set(),416,3617),416);
});
test('whole-video closing uses the actual duration and waits until metadata is known',()=>{
 const news={...plan,segment:{...plan.segment,start:0,end:null},prompts:[{...plan.prompts[0],delivery:'after_video' as const}]};
 assert.equal(nextDemoPosition(news,new Set(),0,undefined),null);
 assert.equal(nextDemoPosition(news,new Set(),0,120),112);
 assert.equal(nextWatchCue(news,new Set(),112,false),undefined);
 assert.equal(nextWatchCue(news,new Set(),120,true)?.time,120);
});
