import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Run the exact built content script. The iframe begins at the parent origin,
// as in the user's postMessage error; navigation and readiness are separate.
const dist=resolve(process.env.FRAME_TEST_DIST||'dist-ext');
const manifest=JSON.parse(readFileSync(resolve(dist,'manifest.json'),'utf8'));
const script=readFileSync(resolve(dist,manifest.content_scripts[0].js[0]),'utf8');
function harness(){
  const id='test-extension',origin='chrome-extension://'+id;
  const sent=[],runtime=[],windows=new Map(),timers=[];
  const elements=[];
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.events=new Map();this.styles={};this.style={setProperty:(k,v)=>{this.styles[k]=v;}};this.isConnected=false;this.open=false;elements.push(this);if(tag==='iframe')this.contentWindow={postMessage:(message,target)=>sent.push({message,target})};}
    setAttribute(k,v){this[k]=v;}
    addEventListener(k,fn){this.events.set(k,fn);}
    appendChild(el){this.children.push(el);el.isConnected=true;return el;}
    attachShadow(){this.shadowRoot=new Element('shadow');return this.shadowRoot;}
    querySelector(){return new Element('button');}
    remove(){this.isConnected=false;}
    matches(){return this.open;}
    showPopover(){this.open=true;}
    hidePopover(){this.open=false;}
    fire(type){this.events.get(type)?.({target:this});}
  }
  const body=new Element('body');
  const win={innerWidth:1200,innerHeight:900,addEventListener:(k,fn)=>windows.set(k,fn),setTimeout:fn=>{timers.push(fn);return timers.length;}};
  // Node's URL treats chrome-extension as opaque. Chrome registers this scheme
  // and reports its origin, as confirmed in the user's actual error message.
  class ChromeURL extends URL {get origin(){return this.protocol==='chrome-extension:'?this.protocol+'//'+this.host:super.origin;}}
  const context={window:win,document:{body,documentElement:body,hidden:false,createElement:t=>new Element(t),addEventListener:()=>{}},chrome:{runtime:{id,getURL:path=>origin+'/'+path,onMessage:{addListener:fn=>runtime.push(fn)}},storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener:()=>{}}}},crypto:{randomUUID:()=> 'test-instance'},URL:ChromeURL,console:{log:()=>{}},setTimeout:win.setTimeout,clearTimeout:()=>{}};
  vm.runInNewContext(script,context);
  const open=()=>{let response;runtime.forEach(fn=>fn({v:2,type:'pet/open'},{},r=>{response=r;}));return response;};
  const host=()=>elements.find(el=>el.id==='memflix-pet'&&el.isConnected);
  const frame=()=>host()?.shadowRoot.children.find(el=>el.tag==='iframe');
  const notify=(sender={id,url:frame().src})=>runtime.forEach(fn=>fn({v:1,type:'pet/frame-layout',channel:'test-instance',event:{type:'frame/size',width:360,height:480}},sender,()=>{}));
  return {open,host,frame,notify,sent,origin,timers,windows,win};
}
test('no host messages sent to an iframe before verified readiness',()=>{
  const h=harness();assert.equal(h.open().opened,false);
  h.windows.get('resize')();h.frame().fire('load');
  assert.equal(h.sent.length,0);
});
test('load displays readable frame without marking it ready',()=>{
  const h=harness();h.open();h.frame().fire('load');
  assert.equal(h.frame().styles.visibility,'visible');
  assert.equal(h.open().opened,false);
});
test('only validated frame size starts exact-origin host messages',()=>{
  const h=harness();h.open();h.notify({id:'other',url:h.frame().src});
  assert.equal(h.sent.length,0);
  h.notify();assert.equal(h.open().opened,true);
  assert.deepEqual(h.sent.map(x=>x.message.type),['host/viewport','host/anchor']);
  assert.ok(h.sent.every(x=>x.target===h.origin));
});
test('connection timeout does not tell an authenticated user to log in again',()=>{
  const h=harness();h.open();h.timers.forEach(fn=>fn());
  const notice=h.host().shadowRoot.children.find(el=>el.role==='status');
  assert.ok(notice.textContent.includes('화면 연결'));
  assert.ok(!notice.textContent.includes('먼저 로그인'));
});
test('host viewport dimensions stay independent of the collapsed frame',()=>{
  const h=harness();h.open();h.notify();
  const initial=h.sent.find(x=>x.message.type==='host/viewport').message;
  assert.equal(initial.width,1200);assert.equal(initial.height,900);
  // A later size report updates the frame, not the enclosing viewport.
  h.notify();h.windows.get('resize')();
  const latest=h.sent.filter(x=>x.message.type==='host/viewport').at(-1).message;
  assert.equal(latest.width,1200);assert.equal(latest.height,900);
});

test('browser resize sends growing host dimensions, not the last reported card size',()=>{
  const h=harness();h.open();h.notify();
  for(const [width,height] of [[1440,900],[1920,1080],[2560,1440],[320,500]]){
    h.win.innerWidth=width;h.win.innerHeight=height;
    h.windows.get('resize')();
    const viewport=h.sent.filter(x=>x.message.type==='host/viewport').at(-1).message;
    assert.equal(viewport.width,width);assert.equal(viewport.height,height);
  }
});
