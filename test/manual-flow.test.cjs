// 2026-10-20 김기덕: 목록·선택 상세·편집 요청·수동 분석·보완 대화를 실제 IPC 경계에서 검증한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const {Collector}=require('../src/pms/collector.cjs');
test('목록만 읽을 때 상세 선택·이미지 읽기가 없고 선택 상세는 한 요청만 읽는다',async()=>{
 const c=new Collector({}),ids=['REQ-a.xfdl1','REQ-b.xfdl2'];let selected=[],details=[],images=0;
 c.call=async(action,arg)=>{if(action==='select')selected.push(arg);return {expected:2,selectedId:ids[0],scrollTop:0,rows:ids.map((id,rowIndex)=>({id,rowIndex,title:'목록'+rowIndex})),atEnd:true};};
 c.locate=async()=>{};c.detail=async id=>{details.push(id);return {text:'본문',images:[{src:'data:image/png;base64,aA=='}]};};c.loadImage=async()=>{images++;return {data:'aA==',mime:'image/png'};};
 assert.equal((await c.collect(undefined,null,{listOnly:true})).length,2);assert.deepEqual(selected,[]);assert.deepEqual(details,[]);assert.equal(images,0);
 const rows=await c.collect(undefined,null,{onlyId:ids[1]});assert.equal(rows.length,1);assert.equal(rows[0].id,ids[1]);assert.deepEqual(details,[ids[1]]);assert.equal(images,1);
 await assert.rejects(()=>c.collect(undefined,null,{onlyId:'missing'}),/현재 PMS 목록/);
});
async function harness(){
 const directory=path.join(__dirname,'../src'),handlers=new Map(),windows=[],calls={collect:[],analyze:[],search:[],chat:[],apply:[]};let startup;
 const id='REQ-ec/ECC0101.xfdl1',data={settings:{projects:[{enabled:true,path:'fake'}],ai:{provider:'openai',model:'fake',encryptedKey:Buffer.from('key').toString('base64')}},requests:[{id,text:'이전 PMS',images:[],analysisInput:'보관 초안',note:'검토',chatMessages:[{role:'user',content:'이전 대화'}]},{id:'removed',text:'제거 대상',images:[]}]};
 const meta=[{id,title:'요청1',rowIndex:0},{id:'REQ-ec/ECC0102.xfdl2',title:'요청2',rowIndex:1}];
 class Store{async read(name,fallback){return structuredClone(data[name]??fallback);}async write(name,value){data[name]=structuredClone(value);}}
 class Window{constructor(){this.webContents={session:{setPermissionRequestHandler(){}},mainFrame:{url:pathToFileURL(path.join(directory,'ui/index.html')).href},setWindowOpenHandler(){},on(){},send(){}};windows.push(this);}on(){}setMenu(){}async loadFile(){}async loadURL(){}isDestroyed(){return false;}}
 class FakeCollector{async collect(_signal,_callback,options){calls.collect.push(options);if(calls.failDetail&&!options.listOnly)throw Error('편집기 중복');return options.listOnly?meta:[{...meta.find(r=>r.id===options.onlyId),text:'PMS 실제 원문',images:[{data:'aA==',mime:'image/png'}],contentComplete:true}];}}
 const electron={app:{isPackaged:true,getPath:()=>'',whenReady:()=>({then(fn){startup=Promise.resolve().then(fn);return startup;}}),on(){},quit(){}},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showErrorBox:(_title,message)=>{throw Error(message);}},safeStorage:{isEncryptionAvailable:()=>true,decryptString:b=>b.toString()},Menu:{setApplicationMenu(){}}};
 const real=createRequire(path.join(directory,'main.cjs'));
 const context={target:'ECC0101',files:[],warnings:[],hash:'context'};
 const requireStub=name=>name==='electron'?electron:name==='./core/patches.cjs'?{applyChanges:async args=>{calls.apply.push(args);return {files:[{path:'P/a.js'}],backupDirectory:'test-backup'};}}:name==='./core/store.cjs'?{...real(name),Store}:name==='./pms/collector.cjs'?{...real(name),Collector:FakeCollector}:name==='./core/source.cjs'?{indexProjects:async()=>[],buildContext:async row=>{calls.search.push(row);return context;}}:name==='./core/ai.cjs'?{...real(name),analyze:async(...args)=>{calls.analyze.push(args);return {report:{summary:'요청 요약',causes:[{title:'수정 대상',fix:'조건 수정',evidence:[]}]},context,createdAt:new Date().toISOString()};},chat:async(...args)=>{calls.chat.push(args);return {role:'assistant',content:'보완 답변'};}}:real(name);
 vm.runInNewContext(await fs.readFile(path.join(directory,'main.cjs'),'utf8'),{require:requireStub,__dirname:directory,process:{env:{}},Buffer,AbortController,DOMException,structuredClone,console});await startup;
 const contents=windows[0].webContents;
 return {id,data,calls,call:(name,arg)=>handlers.get(name)({sender:contents,senderFrame:contents.mainFrame},arg)};
}
test('목록은 AI를 호출하지 않고 원문과 초안을 분리하며 수동 분석·대화는 수정 요청을 사용한다',async()=>{
 const h=await harness();await h.call('open-pms');assert.equal((await h.call('collect',{ready:true})).ok,true);
 assert.equal(h.data.requests.length,2);assert.equal(h.data.requests[0].analysisInput,'보관 초안');assert.equal(h.calls.analyze.length,0);assert.equal(h.calls.search.length,0);
 assert.equal((await h.call('analyze-request',{id:h.id,text:'수정 요청'})).ok,false);
 assert.equal((await h.call('read-request',h.id)).ok,true);assert.equal(h.calls.collect.at(-1).onlyId,h.id);assert.equal(h.calls.analyze.length,0);
 assert.equal((await h.call('request-edit',{id:h.id,text:'수정 요청'})).ok,true);assert.equal(h.data.requests[0].text,'PMS 실제 원문');
 assert.equal((await h.call('analyze-request',{id:h.id,text:'최종 분석 요청'})).ok,true);
 assert.equal(h.calls.search[0].text,'최종 분석 요청');assert.equal(h.calls.analyze[0][2].text,'최종 분석 요청');assert.equal(h.calls.analyze[0][2].images.length,1);
 assert.equal(h.data.requests[0].text,'PMS 실제 원문');assert.equal(h.data.requests[0].analysisInput,'최종 분석 요청');assert.equal(h.data.requests[0].analysis.requestText,'최종 분석 요청');assert.equal(h.data.requests[0].chatMessages.length,1);
 await h.call('chat',{id:h.id,message:'추가 조건'});assert.equal(h.calls.chat[0][2].text,'최종 분석 요청');assert.equal(h.calls.chat[0][3].hash,'context');
 // 2026-10-20 김기덕: 상세 재조회 실패는 이전 성공 결과와 원문을 보존하면서 실패·이전 자료 상태로 저장한다.
 h.calls.failDetail=true;assert.equal((await h.call('read-request',h.id)).ok,false);
 assert.equal(h.data.requests[0].syncStatus,'상세 읽기 실패');assert.equal(h.data.requests[0].error,'편집기 중복');assert.equal(h.data.requests[0].analysisStale,true);assert.equal(h.data.requests[0].detailPending,true);assert.equal(h.data.requests[0].text,'PMS 실제 원문');
 h.calls.failDetail=false;assert.equal((await h.call('read-request',h.id)).ok,true);assert.equal(h.data.requests[0].error,undefined);assert.equal(h.data.requests[0].syncStatus,'상세 확인 완료');
});

// 2026-10-21 김기덕: 오래된 분석·편집된 요청·중복 적용은 파일 쓰기 함수 호출 전에 거절한다.
test('수정 적용 IPC는 현재 분석과 요청문이 일치할 때 한 번만 실행한다',async()=>{
 const h=await harness();await h.call('open-pms');await h.call('collect',{ready:true});await h.call('read-request',h.id);await h.call('analyze-request',{id:h.id,text:'확인한 요청'});
 const analysis=h.data.requests[0].analysis;
 assert.equal((await h.call('apply-changes',{id:h.id,createdAt:'old',text:'확인한 요청'})).ok,false);
 assert.equal((await h.call('apply-changes',{id:h.id,createdAt:analysis.createdAt,text:'아직 분석 안 한 수정'})).ok,false);assert.equal(h.calls.apply.length,0);
 const payload={id:h.id,createdAt:analysis.createdAt,text:'확인한 요청'};assert.equal((await h.call('apply-changes',payload)).ok,true);assert.equal(h.calls.apply.length,1);assert.equal(h.data.requests[0].analysis.applied.backupDirectory,'test-backup');
 assert.equal((await h.call('apply-changes',payload)).ok,false);assert.equal(h.calls.apply.length,1);
});
