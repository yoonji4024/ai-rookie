import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextWatchCue, cueIsAligned, requiredWatchEnd} from '../src/lib/watchTimeline.ts';
import type {WatchPlan} from '../src/lib/portalApi';

const plan:WatchPlan={id:'test',contentId:'fixture',title:'authored fixture',youtubeId:'fixture',segment:{id:'s1',label:'1',start:60,end:420},prompts:[
 {id:'q2',question:'second scene',timestamp:180,delivery:'at_time',maxRecordingMs:60000},
 {id:'q1',question:'first scene',timestamp:90,delivery:'at_time',maxRecordingMs:60000},
 {id:'q3',question:'segment recall',timestamp:420,delivery:'after_segment',maxRecordingMs:60000},
]};
test('a jump to the full video end selects the first unfinished scene at its own time',()=>{
 assert.equal(nextWatchCue(plan,new Set(),3600,true)?.time,90);
 assert.equal(nextWatchCue(plan,new Set(),3600,true)?.prompt.id,'q1');
});
test('end-of-segment questions wait for the authored boundary, including after an early ended event',()=>{
 const done=new Set(['q1','q2']);
 assert.equal(nextWatchCue(plan,done,419,false),undefined);
 assert.equal(nextWatchCue(plan,done,59,true),undefined);
 assert.equal(nextWatchCue(plan,done,420,false)?.time,420);
});
test('a seek must land and pause before TTS starts',()=>{
 const cue=nextWatchCue(plan,new Set(),3600,true)!;
 assert.equal(cueIsAligned(cue,3600,2),false);
 assert.equal(cueIsAligned(cue,90,3),false);
 assert.equal(cueIsAligned(cue,90,1),false);
 assert.equal(cueIsAligned(cue,90.3,2),true);
});
test('resume does not ask a future question or repeat completed questions on backward seek',()=>{
 const done=new Set(['q1']);
 assert.equal(nextWatchCue(plan,done,90,false),undefined);
 assert.equal(nextWatchCue(plan,done,70,false),undefined);
 assert.equal(nextWatchCue(plan,done,180,false)?.prompt.id,'q2');
});
test('untimed questions retain one shared segment boundary and authored order',()=>{
 const untimed={...plan,prompts:['a','b','c'].map(id=>({...plan.prompts[2],id}))};
 assert.equal(nextWatchCue(untimed,new Set(),419,false),undefined);
 assert.equal(nextWatchCue(untimed,new Set(),3600,true)?.time,420);
 assert.equal(nextWatchCue(untimed,new Set(['a']),420,true)?.prompt.id,'b');
});
test('unbounded news closing waits for natural end and uses actual video time',()=>{
 const news={...plan,segment:{...plan.segment,start:0,end:null},prompts:[{...plan.prompts[2],delivery:'after_video' as const}]};
 assert.equal(nextWatchCue(news,new Set(),120,false),undefined);
 assert.equal(nextWatchCue(news,new Set(),120,true)?.time,120);
});
test('required coverage includes scene questions as well as the segment end',()=>{
 assert.equal(requiredWatchEnd(plan),420);
 assert.equal(requiredWatchEnd({...plan,segment:{...plan.segment,end:120}}),180);
});
