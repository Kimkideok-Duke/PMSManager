const {app,BrowserWindow,ipcMain,dialog,safeStorage,Menu,shell}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
const {Store,mergeRequests,reconcileRequests}=require('./core/store.cjs');
const {needsAnalysis,recordAnalysis,upgradeRow,contentFingerprint}=require('./core/content.cjs');
const {runIncremental}=require('./core/incremental.cjs');
const {indexProjects,buildContext}=require('./core/source.cjs');
const ai=require('./core/ai.cjs');
// 2026-10-21 김기덕: 미리 확인한 수정안만 사용자 버튼으로 백업·적용한다.
const {applyChanges}=require('./core/patches.cjs');
const {expandPatchContext}=require('./core/patch-context.cjs');
// 2026-10-16 김기덕: ChatGPT 플랜 로그인은 암호화된 별도 계정 저장소에서 관리한다.
const {ChatGPTAuth}=require('./core/chatgpt-auth.cjs');
const {Collector,PMS_URL}=require('./pms/collector.cjs');
const {ProgressTracker,completionFor}=require('./core/progress.cjs');
const smoke=process.env.PMS_SMOKE_TEST==='1'&&!app.isPackaged;
if(!app.isPackaged) app.setPath('userData',path.join(__dirname,'..',smoke?'.test-data/smoke-profile':'.local-data'));
let window,pmsWindow,store,settings,chatgpt,savedApiConnection,requests=[],job=null,chatJob=null,prepared=null;
// 2026-10-16 김기덕: 동일 프로필의 다중 실행으로 갱신 토큰이 경쟁하는 것을 방지한다.
const ownsProfile=!app.requestSingleInstanceLock||app.requestSingleInstanceLock();
if(!ownsProfile)app.quit();
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){window.show();window.focus();}});
app.on('before-quit',()=>chatgpt?.cancel());
const contexts=new Map();
const uiFile=path.join(__dirname,'ui','index.html');
const uiURL=pathToFileURL(uiFile).href;
const tracker=new ProgressTracker(value=>{if(window&&!window.isDestroyed())window.webContents.send('progress',value);});
const progress=value=>tracker.update(value);
const publicSettings=()=>({...settings,chatgpt:chatgpt?.publicState(),ai:{...settings.ai,key:undefined,encryptedKey:undefined,hasKey:settings.ai.provider==='chatgpt'?!!chatgpt?.publicState().connected:!!settings.ai.encryptedKey}});
function getKey(){if(!settings.ai.encryptedKey)return '';if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 암호화 저장소를 사용할 수 없습니다.');return safeStorage.decryptString(Buffer.from(settings.ai.encryptedKey,'base64'));}
async function aiKey(config=settings.ai){return config.provider==='chatgpt'?chatgpt.credentials():getKey();}
function idle(){if(job||chatJob||chatgpt?.pending||chatgpt?.refreshing)throw new Error('진행 중인 작업 또는 로그인이 있습니다. 완료하거나 중지한 뒤 실행하세요.');}
function summaries(){return requests.map(({images,text,analysisHistory,chatMessages,analysis,...r})=>({...r,analysis:analysis?{createdAt:analysis.createdAt}:undefined,imageCount:images?.length||0,historyCount:analysisHistory?.length||0}));}
function invalidate(){prepared=null;contexts.clear();}
// 2026-10-16 김기덕: 수집·분석 실패 건수를 반영해 종료 상태를 표시한다.
function handle(channel,fn){ipcMain.handle(channel,async(event,arg)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==uiURL)throw new Error('허용되지 않은 호출');let tracked=false;try{if(['collect','sync','prepare','analyze','read-request','analyze-request'].includes(channel)){idle();tracker.begin({collect:'PMS 수집',sync:'자동 분석',prepare:'소스 검색',analyze:'AI 분석','read-request':'선택 요청 상세 읽기','analyze-request':'선택 요청 분석'}[channel]);tracked=true;}const value=await fn(arg);if(tracked){const completion=completionFor(value);tracker.end(completion.status,completion.message);}return {ok:true,value};}catch(e){if(tracked)tracker.end(e.name==='AbortError'?'중지':'실패',e.message);return {ok:false,error:e.name==='AbortError'?'작업을 중지했습니다.':e.message};}});}
async function saveRequests(){await store.write('requests',requests);}
function browserOptions(){return {width:1500,height:980,minWidth:1000,minHeight:700,title:'PMS · 직접 로그인 후 조회',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'pms-manual-session'}};}
async function openPMS(){
  if(pmsWindow&&!pmsWindow.isDestroyed()){pmsWindow.show();pmsWindow.focus();return;}
  pmsWindow=new BrowserWindow(browserOptions());pmsWindow.setMenu(null);
  pmsWindow.webContents.session.setPermissionRequestHandler((_c,_p,callback)=>callback(false));
  pmsWindow.webContents.setWindowOpenHandler(({url})=>{
    if(!url.startsWith('https://'))return {action:'deny'};
    return {action:'allow',overrideBrowserWindowOptions:{webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'pms-manual-session'}}};
  });
  pmsWindow.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('https://'))event.preventDefault();});
  pmsWindow.on('closed',()=>{pmsWindow=null;});
  await pmsWindow.loadURL(PMS_URL);
}
function markdownFor(row){
  // 2026-10-20 김기덕: 보고서도 실제 분석 요청과 핵심 수정안만 내보낸다.
  const a=row.analysis,r=a?.report;
  const lines=[`# ${row.id}`,row.title||'',`검토: ${row.review||'미검토'}`,`메모: ${row.note||''}`,'','## 분석 요청내용',a?.requestText??row.analysisInput??row.text??''];
  if(a){lines.push('','## 분석',`${a.provider} / ${a.model} · ${a.createdAt}`,row.analysisStale?'이 결과는 이전 자료에 기반합니다. 다시 분석하세요.':'',r.summary||r.raw||'');
    for(const c of (r.causes||[]).slice(0,3)){lines.push('',`### ${c.title}`,`수정 방법: ${c.fix}`);for(const e of c.evidence||[])lines.push(`- ${e.path}:${e.line} ${e.verified?'':'[근거 위치 미확인]'} 수정 이유: ${e.detail}`);}
    for(const m of (r.missing||[]).slice(0,2))lines.push(`- 확인 필요: ${m}`);
  }return lines.join('\n');
}

app.whenReady().then(async()=>{
  if(!ownsProfile)return;
  Menu.setApplicationMenu(null);store=new Store(app.getPath('userData'));
  try {
    settings=await store.read('settings',{projects:[],ai:{provider:'openai',endpoint:ai.BASES.openai,model:''}});
    requests=(await store.read('requests',[])).map(upgradeRow);
    savedApiConnection=await store.read('api-connection',null);
    chatgpt=new ChatGPTAuth({store,safeStorage,openExternal:url=>shell.openExternal(url)});
    await chatgpt.load();
  }catch(e){dialog.showErrorBox('저장 데이터 확인 필요',e.message);app.quit();return;}
  window=new BrowserWindow({show:!smoke,width:1420,height:960,minWidth:1120,minHeight:750,title:'PMS Manager',backgroundColor:'#f4f6fa',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.on('close',event=>{if(job||chatJob){event.preventDefault();window.webContents.send('progress', {...tracker.snapshot(),message:'작업이나 대화를 중지한 뒤 창을 닫아주세요.'});}});
  window.on('closed',()=>app.quit());
  handle('state',()=>({settings:publicSettings(),requests:summaries(),dataPath:app.getPath('userData'),progress:tracker.snapshot()}));
  handle('open-pms',()=>openPMS());
  // 2026-10-16 김기덕: 인증은 시스템 브라우저에서 사용자가 직접 진행하고 토큰은 화면에 전달하지 않는다.
  handle('chatgpt-login',async id=>{
    idle();const {completion}=await chatgpt.start(id);
    completion.then(async result=>{
      const previous=settings.ai;
      if(previous.provider!=='chatgpt'){await store.write('api-connection',previous);savedApiConnection=previous;}
      settings.ai={provider:'chatgpt',endpoint:ai.BASES.chatgpt,model:previous.provider==='chatgpt'?previous.model:''};
      try{await store.write('settings',settings);}catch{settings.ai=previous;throw Error('AI 연결 방식 저장에 실패했습니다. 설정에서 ChatGPT 연결을 다시 선택하세요.');}
      invalidate();if(!window.isDestroyed())window.webContents.send('chatgpt-state',{settings:publicSettings(),...result});
    }).catch(error=>{if(!window.isDestroyed())window.webContents.send('chatgpt-state',{settings:publicSettings(),error:error.message});});
    return publicSettings();
  });
  handle('chatgpt-cancel',()=>{chatgpt.cancel();return publicSettings();});
  handle('chatgpt-select',async id=>{idle();await chatgpt.select(id);invalidate();if(settings.ai.provider==='chatgpt'){settings.ai.model='';await store.write('settings',settings);}return publicSettings();});
  handle('chatgpt-logout',async()=>{idle();const result=await chatgpt.signOut();invalidate();return {settings:publicSettings(),...result};});
  handle('chatgpt-usage',()=>shell.openExternal('https://chatgpt.com/settings/usage'));
  handle('project-add',async()=>{
    idle();const result=await dialog.showOpenDialog(window,{title:'분석할 프로젝트 소스 폴더 선택',properties:['openDirectory']});
    if(result.canceled)return publicSettings();
    const actual=await fs.realpath(result.filePaths[0]);
    if(settings.projects.some(p=>p.path.toLowerCase()===actual.toLowerCase()))throw new Error('이미 등록된 폴더입니다.');
    let name=path.basename(actual),number=1;while(settings.projects.some(p=>p.name===name))name=path.basename(actual)+` (${++number})`;
    settings.projects.push({id:randomUUID(),name,path:actual,enabled:true});invalidate();await store.write('settings',settings);return publicSettings();
  });
  handle('project-toggle',async({id,enabled})=>{idle();const p=settings.projects.find(p=>p.id===id);if(!p)throw new Error('등록된 폴더가 없습니다.');p.enabled=!!enabled;invalidate();await store.write('settings',settings);return publicSettings();});
  handle('project-remove',async id=>{idle();settings.projects=settings.projects.filter(p=>p.id!==id);invalidate();await store.write('settings',settings);return publicSettings();});
  handle('ai-save',async input=>{
    idle();const next={provider:input.provider,endpoint:input.endpoint,model:String(input.model||'').trim()};
    next.endpoint=ai.endpoint(next);
    // 2026-10-16 김기덕: 플랜 로그인과 전환해도 기존 API 키는 별도 암호화 설정에 보존한다.
    if(next.provider==='chatgpt'&&settings.ai.provider!=='chatgpt'){await store.write('api-connection',settings.ai);savedApiConnection=settings.ai;}
    if(next.provider!=='chatgpt'&&input.key?.trim()){
      if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 암호화 저장소를 사용할 수 없어 키를 저장하지 않았습니다.');
      next.encryptedKey=safeStorage.encryptString(input.key.trim()).toString('base64');
    }else if(next.provider===settings.ai.provider&&next.endpoint===ai.endpoint(settings.ai))next.encryptedKey=settings.ai.encryptedKey;
    else if(next.provider!=='chatgpt'&&savedApiConnection?.provider===next.provider&&savedApiConnection.endpoint===next.endpoint)next.encryptedKey=savedApiConnection.encryptedKey;
    settings.ai=next;invalidate();await store.write('settings',settings);return publicSettings();
  });
  handle('ai-clear-key',async()=>{
    idle();
    // 2026-10-16 김기덕: 키 제거 후 연결 방식 전환으로 보관 키가 복원되지 않도록 함께 제거한다.
    if(savedApiConnection?.provider===settings.ai.provider&&savedApiConnection.endpoint===settings.ai.endpoint){delete savedApiConnection.encryptedKey;await store.write('api-connection',savedApiConnection);}
    delete settings.ai.encryptedKey;invalidate();await store.write('settings',settings);return publicSettings();
  });
  handle('models',async()=>{
    idle();const config={...settings.ai},accountId=chatgpt.publicState().activeId;
    const result=await ai.listModels(config,await aiKey(config));
    // 2026-10-16 김기덕: 조회 대기 중 계정이나 제공업체가 바뀌면 이전 모델 목록을 표시하지 않는다.
    if(config.provider!==settings.ai.provider||config.endpoint!==settings.ai.endpoint||config.provider==='chatgpt'&&accountId!==chatgpt.publicState().activeId)throw Error('AI 계정이 변경됐습니다. 모델 목록을 다시 조회하세요.');
    return result;
  });
  handle('collect',async({ready})=>{
    idle();if(!ready)throw new Error('PMS 로그인과 조건 입력·조회 완료를 체크하세요.');
    if(!pmsWindow||pmsWindow.isDestroyed())throw new Error('PMS 열기 버튼으로 창을 열고 로그인하세요.');
    job=new AbortController();invalidate();
    // 2026-10-20 김기덕: 완전한 목록만 동기화하고 본문·수정 초안·대화는 보존한다. AI는 호출하지 않는다.
    try{
      const incoming=await new Collector(pmsWindow.webContents,progress).collect(job.signal,null,{listOnly:true});
      job.signal.throwIfAborted();
      requests=incoming.map(meta=>({...requests.find(r=>r.id===meta.id),...meta,detailPending:true}));
      await saveRequests();return {requests:summaries(),ids:[],collected:incoming.length,failed:0};
    }
    finally{job=null;progress({phase:'대기',message:'수집 작업 종료'});}
  });
  // 2026-10-20 김기덕: 선택 요청만 읽고 사용자 분석 요청은 PMS 원문과 분리해 저장한다.
  handle('read-request',async id=>{
    idle();const old=requests.find(r=>r.id===id);if(!old)throw Error('요청을 찾지 못했습니다.');
    if(!pmsWindow||pmsWindow.isDestroyed())throw Error('PMS 창에서 로그인·조회 후 선택하세요.');
    job=new AbortController();
    try{
      const [incoming]=await new Collector(pmsWindow.webContents,progress).collect(job.signal,null,{onlyId:id});
      job.signal.throwIfAborted();
      if(!incoming||incoming.error)throw Error(incoming?.error||'상세 내용을 읽지 못했습니다.');
      const changed=old.contentFingerprint!==contentFingerprint(incoming);
      const row={...old,...incoming,error:undefined,detailPending:false,syncStatus:'상세 확인 완료',contentFingerprint:contentFingerprint(incoming),analysisStale:!!old.analysis&&(changed||!!old.analysisStale)};
      requests=requests.map(r=>r.id===id?row:r);contexts.delete(id);await saveRequests();return row;
    }catch(e){
      // 2026-10-20 김기덕: 상세 실패를 저장하고 이전 분석이 최신인 것처럼 표시되지 않게 한다.
      old.error=e.name==='AbortError'?'상세 읽기를 중지했습니다.':e.message;old.detailPending=true;
      old.analysisStale=!!old.analysis;old.syncStatus='상세 읽기 실패';await saveRequests();throw e;
    }finally{job=null;}
  });
  handle('request-edit',async({id,text})=>{
    idle();const row=requests.find(r=>r.id===id);if(!row)throw Error('요청을 찾지 못했습니다.');
    if(typeof text!=='string'||!text.trim()||text.length>100000)throw Error('분석 요청내용은 1~100,000자로 입력하세요.');
    row.analysisInput=text;row.analysisStale=!!row.analysis&&row.analysis.requestText!==text;contexts.delete(id);await saveRequests();return {saved:true};
  });
  handle('analyze-request',async({id,text})=>{
    idle();const row=requests.find(r=>r.id===id);if(!row||row.detailPending||row.error||row.contentComplete===false)throw Error('PMS 상세 본문과 이미지를 먼저 확인하세요.');
    if(typeof text!=='string'||!text.trim()||text.length>100000)throw Error('분석 요청내용은 1~100,000자로 입력하세요.');
    if(!settings.ai.model)throw Error('AI 모델을 선택하세요.');
    row.analysisInput=text;row.analysisStale=!!row.analysis;delete row.analysisError;
    const snapshot=structuredClone({...row,text});job=new AbortController();
    try{
      await saveRequests();job.signal.throwIfAborted();
      progress({phase:'소스 검색',requestId:id,title:row.title,status:'소스 검색 중',message:'선택 요청의 관련 소스를 찾습니다.'});
      const index=await indexProjects(settings.projects.filter(p=>p.enabled),job.signal,progress,{scoped:true});
      let context=await buildContext(snapshot,index,job.signal,progress);contexts.set(id,context);
      if(context.blocked)throw Error('관련 소스를 찾지 못했습니다. 등록한 프로젝트 폴더를 확인하세요.');
      const key=await aiKey();job.signal.throwIfAborted();
      progress({phase:'AI 응답 대기',requestId:id,status:'AI 응답 대기',message:'수정 위치와 방법을 분석합니다.'});
      let result=await ai.analyze(settings.ai,key,snapshot,context,job.signal);job.signal.throwIfAborted();
      // 2026-10-21 김기덕: 수정 코드가 없으면 AI가 지목한 파일·함수 단서로 한 번만 추가 검색한다.
      if(!result.report?.changes?.some(c=>c.verified)&&result.report?.missing?.length){
        progress({phase:'추가 소스 검색',requestId:id,status:'소스 검색 중',message:'구체적인 수정 위치를 추가로 찾습니다.'});
        const searched=await buildContext({...snapshot,text:snapshot.text+'\n찾을 소스 단서:\n'+result.report.missing.join('\n')},index,job.signal,progress);
        const deeper=await expandPatchContext(searched,index,result.report.missing,job.signal);
        if(deeper.hash!==context.hash){context=deeper;contexts.set(id,context);result=await ai.analyze(settings.ai,key,snapshot,context,job.signal);job.signal.throwIfAborted();}
      }
      if(result.report?.formatWarning||typeof result.report?.summary!=='string'||!Array.isArray(result.report.causes))throw Error('수정 방향의 응답 형식이 올바르지 않습니다. 다시 분석해 주세요.');
      row.analysisHistory=[...(row.analysisHistory||[]),...(row.analysis?[row.analysis]:[])].slice(-5);
      row.analysis={...result,requestText:text,contentFingerprint:contentFingerprint(snapshot)};
      row.analysisStale=false;row.syncStatus='분석 완료';delete row.analysisError;await saveRequests();return {done:1,failed:0};
    }catch(e){row.analysisError=e.name==='AbortError'?'분석을 중지했습니다.':e.message;await saveRequests();throw e;}
    finally{job=null;}
  });
  handle('apply-changes',async({id,createdAt,text})=>{
    idle();const row=requests.find(r=>r.id===id),analysis=row?.analysis;
    if(!analysis||analysis.createdAt!==createdAt||row.analysisStale||analysis.applied)throw Error('분석 결과가 변경됐거나 이미 적용됐습니다. 다시 분석하세요.');
    if(text!==analysis.requestText||analysis.requestText!==(row.analysisInput??row.text))throw Error('분석 요청내용이 변경됐습니다. 다시 분석하세요.');
    job=new AbortController();
    try{
      const application=await applyChanges({changes:analysis.report.changes,context:analysis.context,projects:settings.projects,backupRoot:path.join(app.getPath('userData'),'source-backups'),requestId:id,date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date()),signal:job.signal});
      analysis.applied=application;row.syncStatus='수정 적용 완료';
      const paths=new Set(application.files.map(f=>f.path));
      for(const other of requests)if(other!==row&&other.analysis?.sources?.some(f=>paths.has(f.path)))other.analysisStale=true;
      invalidate();
      try{await saveRequests();}catch{application.warning='소스 수정은 적용됐으나 앱의 결과 기록 저장에 실패했습니다. 백업 폴더의 manifest.json을 확인하세요.';}
      return application;
    }finally{job=null;}
  });
  handle('sync',async({ready})=>{
    idle();if(!ready)throw new Error('PMS 로그인과 조건 입력·조회 완료를 체크하세요.');
    if(!pmsWindow||pmsWindow.isDestroyed())throw new Error('PMS 열기 버튼으로 창을 열고 로그인하세요.');
    job=new AbortController();invalidate();
    try{
      const result=await runIncremental({previous:requests,signal:job.signal,progress,
        collect:(signal,onItem)=>new Collector(pmsWindow.webContents,progress).collect(signal,onItem),
        createIndex:async signal=>{
          if(!settings.ai.model||!await aiKey())throw new Error('요청내용은 저장했습니다. AI 계정 연결과 모델을 설정한 뒤 다시 실행하세요.');
          // 2026-10-16 김기덕: 전체 내용 색인 대신 업무 폴더와 참조 파일만 지연 색인한다.
          return indexProjects(settings.projects.filter(p=>p.enabled),signal,progress,{scoped:true});
        },
        buildContext:(row,index,signal)=>buildContext(row,index,signal,progress),
        analyze:async(row,context,signal)=>ai.analyze(settings.ai,await aiKey(),row,context,signal),
        onContext:(id,context)=>contexts.set(id,context),
        save:async rows=>{requests=rows;await saveRequests();}
      });
      const {rows,...summary}=result;return {...summary,requests:summaries()};
    }finally{job=null;progress({phase:'대기',message:'요청내용 비교·자동 분석 종료'});}
  });
  handle('detail',id=>{const r=requests.find(r=>r.id===id);if(!r)throw new Error('요청을 찾지 못했습니다.');return {...r,context:contexts.get(id)};});
  handle('prepare',async ids=>{
    idle();if(!Array.isArray(ids)||!ids.length)throw new Error('분석할 요청을 선택하세요.');
    const selectedRows=ids.map(id=>requests.find(r=>r.id===id));if(selectedRows.some(r=>!r||r.error))throw new Error('수집 실패 항목은 다시 수집한 뒤 분석하세요.');
    const rows=selectedRows.filter(needsAnalysis);if(!rows.length)throw new Error('새로 분석할 내용이 없습니다. 동일 내용은 생략하며, 수집이 불완전하면 다시 수집하세요.');
    ids=rows.map(r=>r.id);
    job=new AbortController();invalidate();
    try{
      progress({phase:'소스 연결',message:'등록된 프로젝트 폴더를 읽고 있습니다.'});
      progress({phase:'소스 연결',items:rows.map(r=>({id:r.id,title:r.title,status:'검색 대기'})),activeId:null,batchCurrent:0,batchTotal:rows.length,message:'선택 요청의 소스를 준비합니다.'});
      const index=await indexProjects(settings.projects.filter(p=>p.enabled),job.signal,progress,{scoped:true});
      for(const [n,row] of rows.entries()){
        progress({phase:'소스 연결',requestId:row.id,title:row.title,status:'소스 검색 중',message:row.id,batchCurrent:n,batchTotal:rows.length});
        const context=await buildContext(row,index,job.signal,progress);contexts.set(row.id,context);
        if(row.analysis&&row.analysis.contextHash!==context.hash)row.analysisStale=true;
        progress({phase:'소스 연결',requestId:row.id,status:context.blocked?'관련 소스 확인 필요':'소스 준비 완료',message:`${row.id} · 소스 ${context.files.length}개`,batchCurrent:n+1,batchTotal:rows.length});
      }
      await saveRequests();prepared={token:randomUUID(),ids,config:JSON.stringify(settings.ai)};
      return {token:prepared.token,endpoint:ai.endpoint(settings.ai),model:settings.ai.model,items:rows.map(r=>({id:r.id,images:r.images?.length||0,characters:contexts.get(r.id).files.reduce((n,f)=>n+f.content.length,0),target:contexts.get(r.id).target,search:contexts.get(r.id).search,files:contexts.get(r.id).files.map(f=>({path:`${f.projectName}/${f.relative}`,reason:f.reason,truncated:f.truncated})),blocked:contexts.get(r.id).blocked,warnings:contexts.get(r.id).warnings,candidates:contexts.get(r.id).candidates||[]}))};
    }finally{job=null;progress({phase:'대기',message:'소스 연결 작업 종료'});}
  });
  handle('analyze',async({token})=>{
    idle();if(!prepared||token!==prepared.token||prepared.config!==JSON.stringify(settings.ai))throw new Error('분석 자료가 변경되었습니다. 소스 연결을 다시 실행하세요.');
    const key=await aiKey();if(!key)throw new Error('AI 계정을 먼저 연결하세요.');
    if(!settings.ai.model)throw new Error('AI 모델을 선택하세요.');
    const batch=prepared;prepared=null;job=new AbortController();let failed=0,done=0;
    progress({phase:'AI 분석',items:batch.ids.map(id=>({id,title:requests.find(r=>r.id===id)?.title,status:'분석 대기'})),batchCurrent:0,batchTotal:batch.ids.length,message:'선택 요청 분석 시작'});
    try{
      for(const [n,id] of batch.ids.entries()){
        job.signal.throwIfAborted();const row=requests.find(r=>r.id===id),context=contexts.get(id);
        if(!needsAnalysis(row))continue;
        if(context.blocked){failed++;progress({phase:'AI 분석',requestId:id,status:'관련 소스 확인 필요',message:`${id} · 소스 누락으로 보류`,batchCurrent:n+1,batchTotal:batch.ids.length});continue;}
        progress({phase:'AI 응답 대기',requestId:id,status:'AI 응답 대기',message:`${id} · ${settings.ai.model} 응답 대기`,batchCurrent:n,batchTotal:batch.ids.length});
        try{
          const result=await ai.analyze(settings.ai,await aiKey(),row,context,job.signal);
          recordAnalysis(row,result);done++;
        }catch(e){if(job.signal.aborted)throw e;row.analysisError=e.message;failed++;}
        await saveRequests();progress({phase:'결과 저장',requestId:id,status:row.analysisError?'분석 실패':'분석 완료',message:`${id} · ${row.analysisError||'분석 완료'}`,batchCurrent:n+1,batchTotal:batch.ids.length});
      }
      return {requests:summaries(),done,failed};
    }finally{job=null;progress({phase:'대기',message:`분석 종료 · 완료 ${done} / 실패·보류 ${failed}`});}
  });
  handle('cancel',()=>{job?.abort(new DOMException('사용자가 중지했습니다.','AbortError'));});
  handle('chat-cancel',()=>{chatJob?.abort(new DOMException('대화를 중지했습니다.','AbortError'));});
  handle('chat',async({id,message})=>{
    if(chatJob)throw new Error('LLM 답변을 기다리고 있습니다.');
    const row=requests.find(r=>r.id===id);
    if(!row||row.error||row.detailPending)throw new Error('상세 내용을 수집한 요청을 선택하세요.');
    if(typeof message!=='string'||!message.trim()||message.length>10000)throw new Error('메시지는 1~10,000자로 입력하세요.');
    const config={...settings.ai};
    if(!config.model)throw new Error('AI 모델을 먼저 설정하세요.');
    // 2026-10-20 김기덕: 보완 대화도 사용자가 수정한 분석 요청을 기준으로 진행한다.
    const snapshot=structuredClone({...row,text:row.analysisInput??row.text});
    const context=structuredClone(contexts.get(id)||row.analysis?.context||{target:'소스 미연결',files:[],warnings:['소스 발췌가 없습니다. 소스 검색 후 대화하면 근거를 보완할 수 있습니다.'],hash:null});
    const user={role:'user',content:message.trim(),createdAt:new Date().toISOString(),contentFingerprint:row.contentFingerprint};
    const history=(snapshot.chatMessages||[]).slice(-20);
    chatJob=new AbortController();
    try{
      const key=await aiKey(config);if(!key)throw new Error('AI 계정을 먼저 연결하세요.');
      // 2026-10-16 김기덕: 인증 갱신 대기 중 중지된 대화를 외부로 전송하지 않는다.
      chatJob.signal.throwIfAborted();
      const reply=await ai.chat(config,key,snapshot,context,[...history,user],chatJob.signal);
      chatJob.signal.throwIfAborted();
      const current=requests.find(r=>r.id===id);
      const before=current.chatMessages;
      current.chatMessages=[...(before||[]),user,reply].slice(-100);
      try{await saveRequests();}catch(e){current.chatMessages=before;throw e;}
      return {id,messages:current.chatMessages};
    }finally{chatJob=null;}
  });
  handle('review',async({id,note,review})=>{idle();const row=requests.find(r=>r.id===id);if(!row)throw new Error('요청을 찾지 못했습니다.');if(!['미검토','검토 중','채택','보류'].includes(review))throw new Error('검토 상태가 올바르지 않습니다.');row.note=String(note).slice(0,10000);row.review=review;await saveRequests();return summaries();});
  handle('export',async ids=>{
    idle();const rows=requests.filter(r=>ids.includes(r.id));if(!rows.length)throw new Error('내보낼 요청을 선택하세요.');
    const result=await dialog.showSaveDialog(window,{title:'분석 보고서 저장',defaultPath:'PMS-분석보고서.md',filters:[{name:'Markdown',extensions:['md']}]});
    if(result.canceled)return null;await fs.writeFile(result.filePath,rows.map(markdownFor).join('\n\n---\n\n'),'utf8');return result.filePath;
  });
  await window.loadFile(uiFile);
  if(smoke){
    const result=await window.webContents.executeJavaScript('window.pms.state().then(state => ({ipc:!!state.settings, title:document.title, nodeAccess:typeof require, requestCount:state.requests.length}))');
    result.encryption=safeStorage.isEncryptionAvailable()&&safeStorage.decryptString(safeStorage.encryptString('smoke-only'))==='smoke-only';
    await fs.mkdir(path.join(__dirname,'../.test-data'),{recursive:true});
    await fs.writeFile(path.join(__dirname,'../.test-data/electron-smoke.json'),JSON.stringify(result,null,2));
    if(!result.ipc||result.nodeAccess!=='undefined'||!result.encryption)throw new Error('Electron smoke test failed');
    console.log('Electron smoke test passed');app.exit(0);
  }
}).catch(e=>{dialog.showErrorBox('시작 실패',e.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
