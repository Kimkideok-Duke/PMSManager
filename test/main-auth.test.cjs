// 2026-10-16 김기덕: ChatGPT IPC 연결과 API 키 복원·비밀정보 비노출을 검증한다.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
async function harness(){
 const directory=path.join(__dirname,'../src'),handlers=new Map(),events=[];let startup,complete,tokenCalls=0;
 const data={settings:{projects:[],ai:{provider:'openai',endpoint:'https://api.openai.com/v1',model:'old-model',encryptedKey:Buffer.from('saved-api-key').toString('base64')}},requests:[]};
 class Store{async read(name,fallback){return structuredClone(data[name]??fallback);}async write(name,value){data[name]=structuredClone(value);}}
 class Auth{publicState(){return {accounts:[],connected:true};}async load(){}async credentials(){tokenCalls++;return 'oauth-secret';}async start(){return {completion:new Promise(resolve=>{complete=resolve;})};}cancel(){}async select(){}async signOut(){return {remoteRevoked:true};}}
 const contents={mainFrame:{url:pathToFileURL(path.join(directory,'ui/index.html')).href},on(){},setWindowOpenHandler(){},send:(...args)=>events.push(args)};
 class Window{constructor(){this.webContents=contents;}on(){}async loadFile(){}isDestroyed(){return false;}}
 const electron={app:{isPackaged:true,getPath:()=>'',whenReady:()=>({then(fn){startup=Promise.resolve().then(fn);return startup;}}),on(){},quit(){}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showErrorBox:(_title,message)=>{throw Error(message);}},safeStorage:{isEncryptionAvailable:()=>true,decryptString:b=>b.toString()},Menu:{setApplicationMenu(){}},shell:{openExternal:async()=>{}}};
 const realRequire=createRequire(path.join(directory,'main.cjs'));
 const requireStub=name=>name==='electron'?electron:name==='./core/store.cjs'?{...realRequire(name),Store}:name==='./core/chatgpt-auth.cjs'?{ChatGPTAuth:Auth}:name==='./core/ai.cjs'?{...realRequire(name),listModels:async(_config,key)=>[key==='oauth-secret'?'plan-model':'api-model']}:realRequire(name);
 vm.runInNewContext(await fs.readFile(path.join(directory,'main.cjs'),'utf8'),{require:requireStub,__dirname:directory,process:{env:{}},Buffer,AbortController,DOMException,structuredClone,console});await startup;
 return {data,events,call:(name,arg)=>handlers.get(name)({sender:contents,senderFrame:contents.mainFrame},arg),complete:async()=>{complete({firstUse:true,planEnabled:true});await new Promise(resolve=>setImmediate(resolve));},get tokenCalls(){return tokenCalls;}};
}
test('OAuth 로그인 이후 모델 조회는 구독 토큰만 쓰며 API 키 연결은 복원할 수 있다',async()=>{
 const h=await harness();assert.equal((await h.call('chatgpt-login',null)).ok,true);await h.complete();
 assert.equal(h.data.settings.ai.provider,'chatgpt');assert.equal(h.data['api-connection'].encryptedKey,Buffer.from('saved-api-key').toString('base64'));
 const state=await h.call('state');assert.doesNotMatch(JSON.stringify(state),/oauth-secret|saved-api-key|c2F2ZWQtYXBpLWtleQ==/);
 assert.deepEqual((await h.call('models')).value,['plan-model']);assert.equal(h.tokenCalls,1);
 await h.call('ai-save',{provider:'openai',endpoint:'https://api.openai.com/v1',model:'old-model',key:''});assert.equal(h.data.settings.ai.encryptedKey,Buffer.from('saved-api-key').toString('base64'));
 assert.deepEqual((await h.call('models')).value,['api-model']);assert.ok(h.events.some(([name])=>name==='chatgpt-state'));
 await h.call('ai-clear-key');assert.equal(h.data['api-connection'].encryptedKey,undefined);
});
