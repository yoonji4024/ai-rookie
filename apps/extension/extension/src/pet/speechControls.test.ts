import test from 'node:test';
import assert from 'node:assert/strict';
import {speechControl,type SpeechState} from './speechControls.ts';
const ready:SpeechState={phase:'idle',active:true,busy:false,speaking:false,closing:false,session:'watch',welcomeDone:true,heard:false};
test('speech prompt enables explicit microphone action',()=>assert.equal(speechControl(ready).action,'record'));
test('watching without prompt keeps mic visible and explains waiting',()=>{
  const ui=speechControl({...ready,active:false});assert.equal(ui.label,'말하기');assert.equal(ui.enabled,false);assert.ok(ui.hint.includes('두리가 말을 걸면'));
});
test('first greeting shows where speech starts without opening the microphone',()=>{
  const ui=speechControl({...ready,session:null,active:false,welcomeDone:false});assert.ok(ui.hint.includes('인사 나누기'));assert.equal(ui.action,'none');
});
for(const phase of ['opening','transcribing','saving','saved','uncertain'] as const)test('no new recording in '+phase,()=>assert.equal(speechControl({...ready,phase}).enabled,false));
for(const flag of ['busy','speaking','closing'] as const)test('no new recording while '+flag,()=>assert.equal(speechControl({...ready,[flag]:true}).action,'none'));
test('recording always offers a stop action',()=>{const ui=speechControl({...ready,phase:'recording',heard:true});assert.equal(ui.action,'stop');assert.equal(ui.enabled,true);assert.equal(ui.recording,true);});
test('review offers explicit replacement recording',()=>assert.equal(speechControl({...ready,phase:'review'}).label,'다시 말하기'));
