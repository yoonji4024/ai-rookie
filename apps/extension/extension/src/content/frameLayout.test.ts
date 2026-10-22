import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptFrameLayout,frameEnvelope} from './frameLayout.ts';
const expected={id:'test-extension',url:'chrome-extension://test-extension/extension/pet.html?instance=own-frame',channel:'own-frame'};
const sender={id:expected.id,url:expected.url};
const size={type:'frame/size' as const,width:360,height:540};
test('authenticated frame can reveal its measured layout',()=>assert.deepEqual(acceptFrameLayout(frameEnvelope(expected.channel,size),sender,expected),size));
for(const bad of [{...sender,id:'another-extension'},{...sender,url:'https://www.youtube.com/'},{...sender,url:expected.url.replace('own-frame','another-frame')},{...sender,url:undefined}]){
  test('another sender cannot resize the frame '+JSON.stringify(bad),()=>assert.equal(acceptFrameLayout(frameEnvelope(expected.channel,size),bad,expected),null));
}
test('stale frame channel cannot affect replacement frame',()=>assert.equal(acceptFrameLayout(frameEnvelope('old',size),sender,expected),null));
for(const [width,height] of [[0,300],[-1,300],[NaN,300],[Infinity,300],[360,0],[360,NaN],[4097,300],[360,10001]]){
  test('invalid dimensions rejected '+width+','+height,()=>assert.equal(acceptFrameLayout(frameEnvelope(expected.channel,{type:'frame/size',width,height}),sender,expected),null));
}
test('busy and hide require the same authenticated channel',()=>{
  for(const event of [{type:'frame/busy',busy:true},{type:'frame/hide'}] as const)assert.deepEqual(acceptFrameLayout(frameEnvelope(expected.channel,event),sender,expected),event);
  assert.equal(acceptFrameLayout({...frameEnvelope(expected.channel,size),event:{type:'frame/busy',busy:'yes'}},sender,expected),null);
});
test('missing frame and unknown envelope are rejected',()=>{
  for(const message of [null,{}, {...frameEnvelope(expected.channel,size),v:2}, {...frameEnvelope(expected.channel,size),event:{type:'unexpected'}}])assert.equal(acceptFrameLayout(message,sender,expected),null);
  assert.equal(acceptFrameLayout(frameEnvelope('',size),sender,{...expected,channel:''}),null);
});
