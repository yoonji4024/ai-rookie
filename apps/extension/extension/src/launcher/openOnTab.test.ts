import test from 'node:test';
import assert from 'node:assert/strict';
import {openOnTab} from './openOnTab.ts';

test('an ordinary page stays in the launcher without opening a settings tab', async()=>{
  assert.equal(await openOnTab({query:async()=>[{id:1}],sendMessage:async()=>{throw new Error('no receiver');}}),false);
});
test('a supported page receives an open command, not a toggle', async()=>{
  const seen:unknown[]=[];
  const result=await openOnTab({query:async info=>{seen.push(info);return[{id:7}];},sendMessage:async(id,message)=>{seen.push({id,message});return{opened:true};}});
  assert.equal(result,true);assert.deepEqual(seen,[{active:true,currentWindow:true},{id:7,message:{v:2,type:'pet/open'}}]);
});
test('no active tab does not send messages',async()=>{
  assert.equal(await openOnTab({query:async()=>[],sendMessage:async()=>{throw new Error('must not send');}}),false);
});
test('restricted tab query keeps the launcher usable',async()=>{
  assert.equal(await openOnTab({query:async()=>{throw new Error('restricted');},sendMessage:async()=>({opened:true})}),false);
});
for(const reply of [undefined,null,{},true,{opened:false},{opened:'true'}]){
  test('only a positive open acknowledgement closes the popup: '+JSON.stringify(reply),async()=>{
    assert.equal(await openOnTab({query:async()=>[{id:1}],sendMessage:async()=>reply}),false);
  });
}
