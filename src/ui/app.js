const $=id=>document.getElementById(id);
const api=window.pms;
let settings,requests=[],selected=new Set(),activeId=null,busy=false,preview=null,toastTimer;
const BASES={chatgpt:'https://api.openai.com/v1',openai:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta',compatible:''};
// 2026-10-16 김기덕: 선택된 연결 방식과 승인 상태를 표시하고 비밀 토큰은 화면에 보관하지 않는다.
function modelLabel(){return settings.ai.model?`${settings.ai.provider==='chatgpt'?'ChatGPT 플랜':settings.ai.provider} · ${settings.ai.model}`:'AI 연결 전';}
function drawConnectionFields(){
 const plan=$('provider').value==='chatgpt',state=settings.chatgpt||{accounts:[]};
 $('chatgpt-connection').hidden=!plan;$('api-fields').hidden=plan;$('endpoint').required=!plan;$('clear-key').hidden=plan;
 const picker=$('chatgpt-account');picker.replaceChildren();
 for(const account of state.accounts){const option=el('option',`${account.label}${account.email?' · '+account.email:''}${account.connected?'':' · 연결 필요'}`);option.value=account.id;picker.append(option);}
 if(!state.accounts.length){const option=el('option','등록된 계정 없음');option.value='';picker.append(option);}
 picker.value=state.activeId||'';picker.disabled=!!state.pending||!state.accounts.length;
 $('chatgpt-state').textContent=state.pending?'브라우저에서 로그인과 사용 권한 승인을 완료하세요.':state.connected?'ChatGPT 플랜 연결됨 · 모델 목록을 조회해 선택하세요.':'ChatGPT 로그인 또는 플랜 사용 권한 승인이 필요합니다.';
 $('chatgpt-login').disabled=!!state.pending;$('chatgpt-add').disabled=!!state.pending;$('chatgpt-logout').disabled=!!state.pending||!state.activeId;
 $('chatgpt-cancel').hidden=!state.pending;
}
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function button(text,fn,cls='button'){const b=el('button',text,cls);b.type='button';b.addEventListener('click',()=>run(fn));return b;}
function notice(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,8500);}
async function run(fn){try{await fn();}catch(e){notice(e.message||String(e));}}
function setBusy(value){busy=value;document.querySelectorAll('button').forEach(b=>{if(!b.closest('.chat-panel')&&!b.closest('#activity-queue')&&!['cancel','close-image'].includes(b.id))b.disabled=value;});$('cancel').hidden=!value;updateChatControls();}
async function work(fn){setBusy(true);try{return await fn();}finally{setBusy(false);await refresh();}}
function stateOf(r){if(r.error||r.analysisError||r.analysisStale||r.contentComplete===false)return ['다시 확인','warn','attention'];if(r.analysis)return ['분석 완료','good','done'];return ['분석 전','','pending'];}
function filtered(){const q=$('search').value.toLowerCase().trim();return requests.filter(r=>(r.id+' '+r.title).toLowerCase().includes(q)&&($('filter').value==='all'||stateOf(r)[2]===$('filter').value));}
function drawRows(){
  const root=$('rows');root.replaceChildren();
  const rows=filtered();
  if(!rows.length)root.append(el('div',requests.length?'조건에 맞는 요청이 없습니다.':'아직 읽어온 요청이 없습니다.\nPMS에서 조회한 뒤 목록을 읽어주세요.','list-empty'));
  for(const r of rows){
    const row=el('div',undefined,'request-row'+(r.id===activeId?' selected':''));
    row.dataset.requestId=r.id;row.classList.toggle('processing',!!activityState.running&&activityState.activeId===r.id);
    row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`${r.title} ${r.id}`);
    const check=el('input');check.type='checkbox';check.checked=selected.has(r.id);check.setAttribute('aria-label',r.id+' 분석 선택');
    check.addEventListener('click',e=>e.stopPropagation());check.addEventListener('change',()=>{check.checked?selected.add(r.id):selected.delete(r.id);drawSelection();});
    const content=el('div',undefined,'row-content'),top=el('div',undefined,'row-top'),state=stateOf(r);
    top.append(el('b',r.title||'제목 없음'),el('span',state[0],'pill '+state[1]));
    content.append(top,el('code',r.id,'row-id'));
    const meta=el('div',undefined,'row-meta');meta.append(el('span',`${r.category||'-'} · PMS ${r.status||'-'}`),el('span',`${r.imageCount}개 이미지 · ${r.review||'미검토'}`));if(r.syncStatus)meta.append(el('span',r.syncStatus));content.append(meta);row.append(check,content);
    const activate=()=>run(async()=>{activeId=r.id;drawRows();await drawDetail();});row.addEventListener('click',activate);row.addEventListener('keydown',e=>{if(e.target===row&&e.key==='Enter')activate();});root.append(row);
  }
  $('stat-total').textContent=requests.length;$('stat-done').textContent=requests.filter(r=>r.analysis&&!r.analysisStale&&!r.analysisError).length;
  $('stat-review').textContent=requests.filter(r=>r.analysis&&!['채택','보류'].includes(r.review)).length;$('stat-error').textContent=requests.filter(r=>stateOf(r)[2]==='attention').length;$('nav-count').textContent=requests.length;drawSelection();
}
function drawSelection(){const rows=filtered();$('selection-count').textContent=`${selected.size}개 선택`;$('select-all').checked=rows.length>0&&rows.every(r=>selected.has(r.id));$('select-all').indeterminate=rows.some(r=>selected.has(r.id))&&!$('select-all').checked;}
function section(title){const s=el('section',undefined,'section');s.append(el('h3',title));return s;}
function list(values){const ul=el('ul');for(const v of values)ul.append(el('li',v));return ul;}
function searchNode(search){
  const root=el('div',undefined,'search-summary');
  root.append(el('p',`하위 파일 ${search.visitedFiles.toLocaleString()}개 확인 → ${search.indexedFiles.toLocaleString()}개 내용 검색 → ${search.selectedFiles}개 소스 분석`));
  if(search.omittedFiles)root.append(el('div',`관련 후보 중 ${search.omittedFiles}개는 분석 자료 제한으로 제외됐습니다.`,'warning'));
  // 2026-10-16 김기덕: 전체 경로 수와 실제 내용 검색 범위를 구분해 표시한다.
  if(search.scope){root.append(el('p',`업무 검색 범위: ${search.scope.folder||'경로 확인 필요'} · 전체 경로 ${search.catalogFiles}개 중 내용 검색 ${search.indexedFiles}개`));root.append(list(search.scope.stages.map(s=>`${s.stage}: ${s.scope} · ${s.files}개`)));}
  const ranges=el('details');ranges.append(el('summary','검색 폴더와 제외 내역'),list(search.roots.map(r=>`${r.name}: ${r.path}`)),el('p',`제외 파일 ${search.skippedFiles}개 · 제외 폴더 ${search.excludedDirectories}개`));
  if(search.excluded.length)ranges.append(list(search.excluded.map(e=>`${e.path} · ${e.reason}`)));root.append(ranges);
  const trace=el('details');trace.append(el('summary',`관련 소스를 찾은 경로 · ${search.trace.length}개`));
  for(const step of search.trace){const row=el('div',undefined,'evidence');row.append(el('code',`${step.from} → ${step.to}`),el('div',`${step.depth}단계 · ${step.reason}`));trace.append(row);}root.append(trace);
  return root;
}
function reportNode(analysis){
  const s=el('div'),r=analysis.report;
  s.append(el('small',`${analysis.provider} / ${analysis.model} · ${new Date(analysis.createdAt).toLocaleString()}`,'hint'));
  if(r.formatWarning)s.append(el('div',r.formatWarning,'warning'));
  if(r.raw){s.append(el('pre',r.raw));return s;}
  s.append(el('div',r.summary,'report-summary'));
  if(analysis.search)s.append(searchNode(analysis.search));
  if(r.textFindings?.length){const text=section('요청 본문에서 확인한 내용');text.append(list(r.textFindings));s.append(text);}
  if(r.executionFlow?.length){const flow=section('관련 코드의 처리 흐름');flow.append(list(r.executionFlow));s.append(flow);}
  if(r.imageFindings?.length){const image=section('이미지에서 확인한 내용');image.append(list(r.imageFindings));s.append(image);}
  for(const c of r.causes||[]){const cause=el('div',undefined,'cause');cause.append(el('h3',`${c.title} · 가설 신뢰도 ${c.confidence}`),el('p',c.fix));for(const e of c.evidence||[]){const evidence=el('div',undefined,'evidence');evidence.append(el('code',`${e.path}:${e.line} · ${e.verified?'제공된 줄 확인':'근거 위치 미확인'}`),el('div',e.detail));cause.append(evidence);}if(c.tests?.length){cause.append(el('h3','검증 절차'),list(c.tests));}s.append(cause);}
  if(r.resolutionSteps?.length){const steps=section('오류 해결 절차');for(const [i,step] of r.resolutionSteps.entries()){const row=el('div',undefined,'cause');row.append(el('h3',`${i+1}. ${step.title}`),el('p',step.action),el('p',`기대 결과: ${step.expected}`));for(const e of step.evidence||[])row.append(el('div',`${e.path}:${e.line} · ${e.verified?'제공된 줄 확인':'근거 위치 미확인'} · ${e.detail}`,'evidence'));steps.append(row);}s.append(steps);}
  if(r.missing?.length){const missing=section('추가 확인');missing.append(list(r.missing));s.append(missing);}
  if(analysis.warnings?.length)s.append(el('div',analysis.warnings.join('\n'),'warning'));
  return s;
}
async function drawDetail(){
  if(!activeId)return;const id=activeId;const r=await api.detail(id);if(id!==activeId)return;
  drawChat(r);
  const root=$('detail');root.replaceChildren();
  const heading=el('div',undefined,'detail-heading');heading.append(el('h2',r.title||'요청 상세'),el('span',r.review||'미검토','pill'));root.append(heading,el('code',r.id,'detail-id'));
  if(r.error)root.append(el('div','수집 실패: '+r.error,'warning'));
  if(r.warnings?.length)root.append(el('div',r.warnings.join('\n'),'warning'));
  const original=section('요청내용');original.append(el('div',r.text||'읽어온 본문이 없습니다.','request-text'));
  const images=el('div',undefined,'images');for(const [n,image] of (r.images||[]).entries()){const b=button('',()=>{$('large-image').src=`data:${image.mime};base64,${image.data}`;$('image-view').showModal();},'image-button');b.setAttribute('aria-label',`첨부 이미지 ${n+1} 확대`);const img=el('img');img.src=`data:${image.mime};base64,${image.data}`;img.alt=image.alt||`요청 이미지 ${n+1}`;b.append(img);images.append(b);}original.append(images);root.append(original);
  if(r.context){const context=section(`찾은 소스 · ${r.context.files.length}개`);context.append(el('code',r.context.target));if(r.context.search)context.append(searchNode(r.context.search));for(const w of r.context.warnings||[])context.append(el('div',w,'warning'));if(r.context.candidates?.length)context.append(list(r.context.candidates));for(const f of r.context.files){const d=el('details');d.append(el('summary',`${f.projectName}/${f.relative} · ${f.reason}${f.truncated?' · 일부 발췌':''}`),el('pre',f.content));context.append(d);}root.append(context);}
  const analysis=section('원인과 수정 방향');
  if(r.analysisError)analysis.append(el('div','분석 실패: '+r.analysisError,'warning'));
  if(r.analysisStale)analysis.append(el('div','요청 또는 연결 소스가 변경됐거나 재수집에 실패했습니다. 아래 결과는 이전 자료에 기반합니다.','warning'));
  if(r.analysis)analysis.append(reportNode(r.analysis));else analysis.append(el('p','목록에서 요청을 체크하고 소스 연결 후 분석을 실행하세요.'));
  for(const old of [...(r.analysisHistory||[])].reverse()){const d=el('details');d.append(el('summary',`이전 분석 · ${new Date(old.createdAt).toLocaleString()} · ${old.model}`),reportNode(old));analysis.append(d);}root.append(analysis);
  const review=section('검토 기록'),controls=el('div',undefined,'review-controls'),select=el('select');select.setAttribute('aria-label','검토 상태');for(const value of ['미검토','검토 중','채택','보류']){const o=el('option',value);o.value=value;select.append(o);}select.value=r.review||'미검토';const note=el('textarea');note.value=r.note||'';note.placeholder='검토 의견과 후속 작업을 기록하세요';note.setAttribute('aria-label','검토 메모');controls.append(select,button('검토 저장',async()=>{await api.review({id:r.id,review:select.value,note:note.value});notice('검토 기록을 저장했습니다.');await refresh();}));review.append(note,controls);root.append(review);
}
function drawSettings(){
  $('model-badge').textContent=modelLabel();
  const projects=$('projects');projects.replaceChildren();if(!settings.projects.length)projects.append(el('div','분석할 소스 폴더를 등록하세요.','list-empty'));
  for(const p of settings.projects){const row=el('div',undefined,'project'),check=el('input');check.type='checkbox';check.checked=p.enabled;check.setAttribute('aria-label',p.name+' 분석 사용');check.onchange=()=>run(async()=>{settings=await api['project-toggle']({id:p.id,enabled:check.checked});drawSettings();});const text=el('div');text.append(el('b',p.name),el('code',p.path));row.append(check,text,button('등록 해제',async()=>{settings=await api['project-remove'](p.id);drawSettings();},'text-button'));projects.append(row);}
  $('provider').value=settings.ai.provider;$('endpoint').value=settings.ai.endpoint;$('endpoint').readOnly=settings.ai.provider!=='compatible';$('model').value=settings.ai.model||'';$('api-key').value='';$('key-state').textContent=settings.ai.hasKey?'API 키 저장됨 · 새 키를 입력하지 않으면 기존 키를 유지합니다.':'API 키가 아직 없습니다.';
  drawConnectionFields();
}
// 2026-10-16 김기덕: PMS에서 제거된 요청의 선택·상세 화면을 함께 해제한다.
async function refresh(){const state=await api.state();settings=state.settings;requests=state.requests;selected=new Set([...selected].filter(id=>requests.some(r=>r.id===id)));if(activeId&&!requests.some(r=>r.id===activeId)){activeId=null;chatRow=null;$('chat-messages').replaceChildren();$('chat-request').textContent='요청을 선택하세요';$('chat-context').textContent='';$('chat-input').value='';$('detail').replaceChildren(el('p','현재 PMS 목록에서 제외된 요청입니다. 다른 요청을 선택하세요.'));}$('data-path').textContent=state.dataPath;drawRows();if(state.progress)drawActivity(state.progress);$('model-badge').textContent=modelLabel();if(activeId)await drawDetail();updateChatControls();}
function drawPreview(value){preview=value;$('destination').textContent=`${value.endpoint} · 모델: ${value.model||'설정 필요'}`;const root=$('preview-items');root.replaceChildren();for(const item of value.items){const s=el('section',undefined,'preview-item');s.append(el('code',item.id),el('p',`${item.files.length}개 소스 · 이미지 ${item.images}개 · 소스 ${item.characters.toLocaleString()}자`));if(item.search)s.append(searchNode(item.search));s.append(list(item.files.map(f=>`${f.path} — ${f.reason}${f.truncated?' (발췌)':''}`)));if(item.warnings.length)s.append(el('div',item.warnings.join('\n'),'warning'));if(item.candidates.length)s.append(list(item.candidates));if(item.blocked)s.append(el('b','관련 소스를 찾지 못해 이 요청은 분석에서 제외됩니다.'));root.append(s);} $('analyze').disabled=value.items.every(i=>i.blocked)||!settings.ai.hasKey||!settings.ai.model;$('preview').showModal();}
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n===b));$('requests-page').hidden=b.dataset.page!=='requests';$('settings-page').hidden=b.dataset.page!=='settings';$('page-title').textContent=b.dataset.page==='requests'?'요청 분석':'프로젝트 · AI 설정';if(b.dataset.page==='settings')drawSettings();});
$('open-pms').onclick=()=>run(()=>api['open-pms']());
$('collect').onclick=()=>run(()=>work(async()=>{const result=await api.sync({ready:$('ready').checked});requests=result.requests;selected=new Set(result.ids);notice(`상세 확인 ${result.collected}건 · 동일 내용 생략 ${result.unchanged}건 · 분석 완료 ${result.done}건 · 실패 ${result.failed}건 · 확인 필요 ${result.blocked}건`);}));
$('search').oninput=drawRows;$('filter').onchange=drawRows;$('select-all').onchange=()=>{for(const r of filtered())$('select-all').checked?selected.add(r.id):selected.delete(r.id);drawRows();};
$('prepare').onclick=()=>run(async()=>{const value=await work(()=>api.prepare([...selected]));drawPreview(value);});
$('close-preview').onclick=()=>$('preview').close();$('close-image').onclick=()=>$('image-view').close();
$('analyze').onclick=()=>run(async()=>{$('preview').close();await work(async()=>{const result=await api.analyze({token:preview.token});notice(`분석 완료 ${result.done}건 · 실패·보류 ${result.failed}건`);});});
$('cancel').onclick=()=>run(()=>api.cancel());
$('export').onclick=()=>run(async()=>{const output=await api.export([...selected]);if(output)notice('보고서를 저장했습니다.\n'+output);});
$('add-project').onclick=()=>run(async()=>{settings=await api['project-add']();drawSettings();});
$('provider').onchange=()=>{$('endpoint').value=BASES[$('provider').value];$('endpoint').readOnly=$('provider').value!=='compatible';$('model').value='';$('api-key').value='';$('models').replaceChildren();$('key-state').textContent='제공업체를 바꾸면 해당 계정의 API 키를 입력하고 저장하세요.';drawConnectionFields();};
$('ai-form').onsubmit=e=>{e.preventDefault();run(async()=>{settings=await api['ai-save']({provider:$('provider').value,endpoint:$('endpoint').value,key:$('api-key').value,model:$('model').value});drawSettings();notice('AI 연결 설정을 저장했습니다. 모델 목록 조회로 키와 연결을 확인할 수 있습니다.');});};
$('load-models').onclick=()=>run(async()=>{if($('provider').value!==settings.ai.provider)throw Error('연결 설정을 먼저 저장하세요.');const models=await api.models();$('models').replaceChildren(...models.map(m=>{const o=el('option',typeof m==='string'?m:m.name);o.value=typeof m==='string'?m:m.id;return o;}));notice(`${models.length}개 모델을 읽었습니다. 사용할 모델을 선택하고 저장하세요.`);$('model').focus();});
$('clear-key').onclick=()=>run(async()=>{settings=await api['ai-clear-key']();drawSettings();notice('저장한 API 키를 제거했습니다.');});
// 2026-10-16 김기덕: 시스템 브라우저에서 로그인하며 승인 결과만 수신한다.
$('chatgpt-login').onclick=()=>run(async()=>{settings=await api['chatgpt-login'](settings.chatgpt?.activeId||null);drawSettings();$('provider').value='chatgpt';drawConnectionFields();});
$('chatgpt-add').onclick=()=>run(async()=>{settings=await api['chatgpt-login'](null);drawSettings();$('provider').value='chatgpt';drawConnectionFields();});
$('chatgpt-cancel').onclick=()=>run(async()=>{settings=await api['chatgpt-cancel']();drawSettings();});
$('chatgpt-account').onchange=()=>run(async()=>{settings=await api['chatgpt-select']($('chatgpt-account').value);$('models').replaceChildren();drawSettings();});
$('chatgpt-usage').onclick=()=>run(()=>api['chatgpt-usage']());
$('chatgpt-logout').onclick=()=>run(async()=>{const result=await api['chatgpt-logout']();settings=result.settings;drawSettings();notice(result.remoteRevoked?'ChatGPT 연결을 해제했습니다.':'이 PC 연결을 해제했습니다. 서버 연결 해제는 확인되지 않았으므로 ChatGPT 사용량 관리에서도 확인하세요.');});
$('chatgpt-welcome-close').onclick=()=>$('chatgpt-welcome').close();
api.onConnection?.(value=>run(async()=>{settings=value.settings;drawSettings();$('models').replaceChildren();if(value.error)notice(value.error);else if(value.firstUse)$('chatgpt-welcome').showModal();else notice(value.planEnabled?'ChatGPT 연결을 완료했습니다. 모델을 선택하세요.':'로그인은 완료됐지만 ChatGPT 플랜 사용 권한이 없습니다. 다시 연결해 권한을 승인하세요.');updateChatControls();}));
initActivity();initChat();
run(async()=>{await refresh();drawSettings();});
