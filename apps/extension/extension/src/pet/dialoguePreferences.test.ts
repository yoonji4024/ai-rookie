import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPreferences,silenceDecision,automaticTurnAllowed} from './dialoguePreferences.ts';
test('microphone requires opt-in; corrupt settings cannot enable it',()=>{
  for(const raw of [null,{},'yes',{autoListen:'true'},{autoListen:1}])assert.equal(readPreferences(raw).autoListen,false);
  assert.equal(readPreferences({autoListen:true}).autoListen,true);
});
test('bounded audio preferences',()=>{
  const p=readPreferences({volume:8,speed:-2,silenceSeconds:1});assert.equal(p.volume,1);assert.equal(p.speed,.8);assert.equal(p.silenceSeconds,8);
  assert.equal(readPreferences({volume:NaN}).volume,.8);
});
test('initial thinking time is not a post-speech silence',()=>{
  assert.equal(silenceDecision({started:0,lastVoice:null},8000,8),'wait');
  assert.equal(silenceDecision({started:0,lastVoice:null},19999,8),'wait');
  assert.equal(silenceDecision({started:0,lastVoice:null},20000,8),'empty');
});
test('continued speech and a short pause cannot finish a turn',()=>{
  assert.equal(silenceDecision({started:0,lastVoice:20000},22000,8),'wait');
  assert.equal(silenceDecision({started:0,lastVoice:20000},27999,8),'wait');
  assert.equal(silenceDecision({started:0,lastVoice:20000},28000,8),'finish');
  assert.equal(silenceDecision({started:0,lastVoice:20000},25000,5),'finish');
});
const allowed={armed:true,hidden:false,phase:'idle',active:true,busy:false,closing:false};
test('automatic turns require a user-started session',()=>{assert.equal(automaticTurnAllowed(allowed),true);assert.equal(automaticTurnAllowed({...allowed,armed:false}),false);});
test('never auto-record over a response, network wait, save, or hidden tab',()=>{
  for(const phase of ['opening','recording','transcribing','review','saving','saved','uncertain'])assert.equal(automaticTurnAllowed({...allowed,phase}),false);
  for(const override of [{hidden:true},{active:false},{busy:true},{closing:true}])assert.equal(automaticTurnAllowed({...allowed,...override}),false);
});
