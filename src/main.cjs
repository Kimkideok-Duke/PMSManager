const {app,BrowserWindow,ipcMain,dialog,safeStorage,Menu}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
const {Store,mergeRequests}=require('./core/store.cjs');
const {needsAnalysis,recordAnalysis,upgradeRow}=require('./core/content.cjs');
const {runIncremental}=require('./core/incremental.cjs');
const {indexProjects,buildContext}=require('./core/source.cjs');
const ai=require('./core/ai.cjs');
const {Collector,PMS_URL}=require('./pms/collector.cjs');
const smoke=process.env.PMS_SMOKE_TEST==='1'&&!app.isPackaged;
if(!app.isPackaged) app.setPath('userData',path.join(__dirname,'..',smoke?'.test-data/smoke-profile':'.local-data'));
let window,pmsWindow,store,settings,requests=[],job=null,prepared=null;
const contexts=new Map();
const uiFile=path.join(__dirname,'ui','index.html');
const uiURL=pathToFileURL(uiFile).href;
const progress=value=>{if(window&&!window.isDestroyed())window.webContents.send('progress',value);};
const publicSettings=()=>({...settings,ai:{...settings.ai,key:undefined,encryptedKey:undefined,hasKey:!!settings.ai.encryptedKey}});
function getKey(){if(!settings.ai.encryptedKey)return '';if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 암호화 저장소를 사용할 수 없습니다.');return safeStorage.decryptString(Buffer.from(settings.ai.encryptedKey,'base64'));}
function idle(){if(job)throw new Error('진행 중인 작업이 있습니다. 완료하거나 중지한 뒤 실행하세요.');}
function summaries(){return requests.map(({images,text,analysisHistory,...r})=>({...r,imageCount:images?.length||0,historyCount:analysisHistory?.length||0}));}
function invalidate(){prepared=null;contexts.clear();}
function handle(channel,fn){ipcMain.handle(channel,async(event,arg)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==uiURL)throw new Error('허용되지 않은 호출');try{return {ok:true,value:await fn(arg)};}catch(e){return {ok:false,error:e.name==='AbortError'?'작업을 중지했습니다.':e.message};}});}
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
  const a=row.analysis,r=a?.report;
  const lines=[`# ${row.id}`,row.title||'',`수집: ${row.collectedAt||'-'}`,`검토: ${row.review||'미검토'}`,`메모: ${row.note||''}`,'','## 요청내용',row.text||''];
  if(a){lines.push('','## 분석',`${a.provider} / ${a.model} · ${a.createdAt}`,row.analysisStale?'이 결과는 이전 자료에 기반합니다. 다시 분석하세요.':'',r.summary||r.raw||'');
    for(const finding of r.imageFindings||[])lines.push(`- 이미지 관찰: ${finding}`);
    if(a.search)lines.push('',`검색 범위: 하위 파일 ${a.search.indexedFiles}개 내용 색인 / ${a.search.selectedFiles}개 소스 발췌`);
    if(r.executionFlow?.length)lines.push('','### 코드 처리 흐름',...r.executionFlow.map(s=>`- ${s}`));
    for(const c of r.causes||[]){lines.push('',`### ${c.title} (가설 신뢰도: ${c.confidence})`,c.fix);for(const e of c.evidence||[])lines.push(`- ${e.path}:${e.line} ${e.verified?'[제공된 줄 확인]':'[근거 위치 미확인]'} ${e.detail}`);for(const t of c.tests||[])lines.push(`- 검증: ${t}`);}
    for(const [i,step] of (r.resolutionSteps||[]).entries()){lines.push('',`### 해결 ${i+1}. ${step.title}`,step.action,`기대 결과: ${step.expected}`);for(const e of step.evidence||[])lines.push(`- ${e.path}:${e.line} ${e.verified?'[제공된 줄 확인]':'[근거 위치 미확인]'} ${e.detail}`);}
    for(const m of [...(r.missing||[]),...(a.warnings||[])])lines.push(`- 확인 필요: ${m}`);
  }return lines.join('\n');
}

app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);store=new Store(app.getPath('userData'));
  try {
    settings=await store.read('settings',{projects:[],ai:{provider:'openai',endpoint:ai.BASES.openai,model:''}});
    requests=(await store.read('requests',[])).map(upgradeRow);
  }catch(e){dialog.showErrorBox('저장 데이터 확인 필요',e.message);app.quit();return;}
  window=new BrowserWindow({show:!smoke,width:1420,height:960,minWidth:1120,minHeight:750,title:'PMS Manager',backgroundColor:'#f4f6fa',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.on('close',event=>{if(job){event.preventDefault();progress({phase:'안내',message:'작업을 중지한 뒤 창을 닫아주세요.'});}});
  window.on('closed',()=>app.quit());
  handle('state',()=>({settings:publicSettings(),requests:summaries(),dataPath:app.getPath('userData')}));
  handle('open-pms',()=>openPMS());
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
    if(input.key?.trim()){
      if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 암호화 저장소를 사용할 수 없어 키를 저장하지 않았습니다.');
      next.encryptedKey=safeStorage.encryptString(input.key.trim()).toString('base64');
    }else if(next.provider===settings.ai.provider&&next.endpoint===ai.endpoint(settings.ai))next.encryptedKey=settings.ai.encryptedKey;
    settings.ai=next;invalidate();await store.write('settings',settings);return publicSettings();
  });
  handle('ai-clear-key',async()=>{idle();delete settings.ai.encryptedKey;invalidate();await store.write('settings',settings);return publicSettings();});
  handle('models',()=>{idle();return ai.listModels(settings.ai,getKey());});
  handle('collect',async({ready})=>{
    idle();if(!ready)throw new Error('PMS 로그인과 조건 입력·조회 완료를 체크하세요.');
    if(!pmsWindow||pmsWindow.isDestroyed())throw new Error('PMS 열기 버튼으로 창을 열고 로그인하세요.');
    job=new AbortController();invalidate();
    try{const incoming=await new Collector(pmsWindow.webContents,progress).collect(job.signal);requests=mergeRequests(requests,incoming);await saveRequests();return {requests:summaries(),ids:incoming.filter(r=>!r.error).map(r=>r.id),collected:incoming.length,failed:incoming.filter(r=>r.error).length};}
    finally{job=null;progress({phase:'대기',message:'수집 작업 종료'});}
  });
  handle('sync',async({ready})=>{
    idle();if(!ready)throw new Error('PMS 로그인과 조건 입력·조회 완료를 체크하세요.');
    if(!pmsWindow||pmsWindow.isDestroyed())throw new Error('PMS 열기 버튼으로 창을 열고 로그인하세요.');
    job=new AbortController();invalidate();
    try{
      const result=await runIncremental({previous:requests,signal:job.signal,progress,
        collect:signal=>new Collector(pmsWindow.webContents,progress).collect(signal),
        createIndex:signal=>{
          if(!getKey()||!settings.ai.model)throw new Error('요청내용은 저장했습니다. AI API 키와 모델을 설정한 뒤 다시 실행하세요.');
          return indexProjects(settings.projects.filter(p=>p.enabled),signal,progress);
        },
        buildContext:(row,index,signal)=>buildContext(row,index,signal,progress),
        analyze:(row,context,signal)=>ai.analyze(settings.ai,getKey(),row,context,signal),
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
      const index=await indexProjects(settings.projects.filter(p=>p.enabled),job.signal,progress);
      for(const [n,row] of rows.entries()){
        progress({phase:'소스 연결',message:row.id,current:n+1,total:rows.length});
        const context=await buildContext(row,index,job.signal,progress);contexts.set(row.id,context);
        if(row.analysis&&row.analysis.contextHash!==context.hash)row.analysisStale=true;
      }
      await saveRequests();prepared={token:randomUUID(),ids,config:JSON.stringify(settings.ai)};
      return {token:prepared.token,endpoint:ai.endpoint(settings.ai),model:settings.ai.model,items:rows.map(r=>({id:r.id,images:r.images?.length||0,characters:contexts.get(r.id).files.reduce((n,f)=>n+f.content.length,0),target:contexts.get(r.id).target,search:contexts.get(r.id).search,files:contexts.get(r.id).files.map(f=>({path:`${f.projectName}/${f.relative}`,reason:f.reason,truncated:f.truncated})),blocked:contexts.get(r.id).blocked,warnings:contexts.get(r.id).warnings,candidates:contexts.get(r.id).candidates||[]}))};
    }finally{job=null;progress({phase:'대기',message:'소스 연결 작업 종료'});}
  });
  handle('analyze',async({token})=>{
    idle();if(!prepared||token!==prepared.token||prepared.config!==JSON.stringify(settings.ai))throw new Error('분석 자료가 변경되었습니다. 소스 연결을 다시 실행하세요.');
    const key=getKey();if(!key)throw new Error('AI API 키를 먼저 등록하세요.');
    if(!settings.ai.model)throw new Error('AI 모델을 선택하세요.');
    const batch=prepared;prepared=null;job=new AbortController();let failed=0,done=0;
    try{
      for(const [n,id] of batch.ids.entries()){
        job.signal.throwIfAborted();const row=requests.find(r=>r.id===id),context=contexts.get(id);
        if(!needsAnalysis(row))continue;
        if(context.blocked){failed++;continue;}
        progress({phase:'AI 분석',message:`${id} · ${settings.ai.model}`,current:n+1,total:batch.ids.length});
        try{
          const result=await ai.analyze(settings.ai,key,row,context,job.signal);
          recordAnalysis(row,result);done++;
        }catch(e){if(job.signal.aborted)throw e;row.analysisError=e.message;failed++;}
        await saveRequests();progress({phase:'결과 저장',message:id,current:n+1,total:batch.ids.length});
      }
      return {requests:summaries(),done,failed};
    }finally{job=null;progress({phase:'대기',message:`분석 종료 · 완료 ${done} / 실패·보류 ${failed}`});}
  });
  handle('cancel',()=>{job?.abort(new DOMException('사용자가 중지했습니다.','AbortError'));});
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
