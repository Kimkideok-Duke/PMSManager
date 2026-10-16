const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const {mergeRequests}=require('../src/core/store.cjs');
const {contentFingerprint}=require('../src/core/content.cjs');
async function harness(chat){
  const directory=path.join(__dirname,'../src'),handlers=new Map(),windows=[];let startup;
  const row={id:'REQ-a.xfdl1',text:'요청',images:[],chatMessages:[],analysis:{report:{summary:'기존 분석'},context:{target:'a.xfdl',files:[{content:'1: save();'}],warnings:[],hash:'saved'}}};row.contentFingerprint=contentFingerprint(row);
  const data={requests:[row],settings:{projects:[],ai:{provider:'openai',model:'fake',encryptedKey:Buffer.from('fake-key').toString('base64')}}};
  // 2026-10-16 김기덕: ChatGPT 인증 저장소의 기본값도 실제 Store와 같이 제공한다.
  class Store{async read(name,fallback){return structuredClone(data[name]===undefined?fallback:data[name]);}async write(name,value){data[name]=structuredClone(value);}}
  class Window{constructor(){this.webContents={mainFrame:{url:pathToFileURL(path.join(directory,'ui/index.html')).href},setWindowOpenHandler(){},on(){},send(){}};windows.push(this);}on(){}async loadFile(){}isDestroyed(){return false;}}
  const electron={app:{isPackaged:true,getPath:()=>'',whenReady:()=>({then(fn){startup=Promise.resolve().then(fn);return startup;}}),on(){},quit(){}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showErrorBox:(_title,message)=>{throw Error(message);}},safeStorage:{isEncryptionAvailable:()=>true,decryptString:b=>b.toString()},Menu:{setApplicationMenu(){}}};
  const realRequire=createRequire(path.join(directory,'main.cjs'));
  const api={...realRequire('./core/ai.cjs'),chat};
  const requireStub=name=>name==='electron'?electron:name==='./core/store.cjs'?{Store,mergeRequests}:name==='./core/ai.cjs'?api:realRequire(name);
  vm.runInNewContext(await fs.readFile(path.join(directory,'main.cjs'),'utf8'),{require:requireStub,__dirname:directory,process:{env:{}},Buffer,AbortController,DOMException,structuredClone,console});await startup;
  const contents=windows[0].webContents;
  return {data,call:(name,arg)=>handlers.get(name)({sender:contents,senderFrame:contents.mainFrame},arg)};
}
test('대화 IPC는 저장된 소스 문맥을 전달하고 요청별 대화를 저장하며 중복 전송을 막는다',async()=>{
  let complete,received;
  const h=await harness(async(...args)=>{received=args;return new Promise(resolve=>complete=()=>resolve({role:'assistant',content:'보완 답변',createdAt:new Date().toISOString()}));});
  assert.equal((await h.call('chat',{id:'missing',message:'질문'})).ok,false);
  assert.equal((await h.call('chat',{id:'REQ-a.xfdl1',message:''})).ok,false);
  const pending=h.call('chat',{id:'REQ-a.xfdl1',message:'추가 조건'});
  assert.equal((await h.call('chat',{id:'REQ-a.xfdl1',message:'중복'})).ok,false);
  assert.equal((await h.call('ai-clear-key')).ok,false);
  assert.equal(received[3].hash,'saved');assert.equal(received[4].at(-1).content,'추가 조건');complete();
  assert.equal((await pending).ok,true);assert.equal(h.data.requests[0].chatMessages.length,2);
  assert.equal((await h.call('detail','REQ-a.xfdl1')).value.chatMessages[1].content,'보완 답변');
  assert.equal((await h.call('state')).value.requests[0].chatMessages,undefined);
});
test('대화 취소는 미완성 대화를 저장하지 않고 다음 전송을 허용한다',async()=>{
  const h=await harness(async(_config,_key,_row,_context,_messages,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  const pending=h.call('chat',{id:'REQ-a.xfdl1',message:'질문'});await h.call('chat-cancel');
  assert.equal((await pending).ok,false);assert.equal(h.data.requests[0].chatMessages.length,0);
  assert.equal((await h.call('ai-clear-key')).ok,true);
});
