import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSilenceClock,readVoicePreferences} from '../src/lib/voiceTurnPolicy.ts';
test('continuous speech lasting 40 seconds never triggers the silence timer',()=>{
 const clock=new VoiceSilenceClock(0);clock.update(true,100);
 for(let t=100;t<=40000;t+=250)assert.equal(clock.decision(t,5),'wait');
 clock.update(false,40100);assert.equal(clock.decision(45099,5),'wait');assert.equal(clock.decision(45100,5),'finish');
});
test('a pause shorter than five seconds and resumed speech continue the same recording',()=>{
 const c=new VoiceSilenceClock(0);c.update(true,100);c.update(false,1000);assert.equal(c.decision(5500,5),'wait');
 c.update(true,5800);assert.equal(c.decision(15000,5),'wait');c.update(false,15100);assert.equal(c.decision(20099,5),'wait');assert.equal(c.decision(20100,5),'finish');
});
test('thinking before the first word gets 20 seconds; a false VAD does not shorten it',()=>{
 const c=new VoiceSilenceClock(0);c.update(false,500);assert.equal(c.decision(19999,5),'wait');assert.equal(c.decision(20000,5),'empty');
});
test('eight-second preference applies and recording remains bounded to one minute',()=>{
 const c=new VoiceSilenceClock(0);c.update(true,100);c.update(false,1000);assert.equal(c.decision(8999,8),'wait');assert.equal(c.decision(9000,8),'finish');c.update(true,59000);assert.equal(c.decision(60000,8),'limit');
});
test('automatic microphone defaults on but respects explicit opt-out',()=>{
 assert.deepEqual(readVoicePreferences(null),{autoListen:true,silenceSeconds:5});assert.deepEqual(readVoicePreferences({autoListen:false,silenceSeconds:8}),{autoListen:false,silenceSeconds:8});
});
