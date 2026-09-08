let activityState={logs:[],items:[]},activityRefreshPending=false;
function drawActivity(value){
  activityState=value;
  $('activity-phase').textContent=value.phase||'작업 대기';
  const active=(value.items||[]).find(r=>r.id===value.activeId);
  $('activity-current').textContent=active?`${active.title||'현재 요청'} · ${active.id} · ${active.status}`:value.message||'분석을 시작하면 진행 상황이 표시됩니다.';
  const stage=$('stage-progress');
  if(value.total>0){stage.max=value.total;stage.value=value.current||0;$('stage-label').textContent=`${value.phase} · ${value.current||0}/${value.total} (${Math.floor((value.current||0)/value.total*100)}%)`;}
  else {stage.max=1;if(value.running)stage.removeAttribute('value');else stage.value=0;$('stage-label').textContent=value.running?`${value.phase} · 처리 중 (진행률 미제공)`:'현재 단계 · 종료 또는 대기';}
  const batch=$('batch-progress');batch.max=value.batchTotal||1;batch.value=value.batchCurrent||0;
  $('batch-label').textContent=value.batchTotal?`분석 대상 · ${value.batchCurrent||0}/${value.batchTotal}건 처리`:'분석 대상 · 내용 비교 후 확정';
  const items=value.items||[],queue=$('activity-queue');queue.replaceChildren();
  const done=items.filter(r=>r.status==='분석 완료').length,skipped=items.filter(r=>r.status==='동일 내용 · 분석 생략').length,attention=items.filter(r=>/실패|확인 필요/.test(r.status||'')).length;
  $('queue-summary').textContent=`이번 작업 요청 · ${items.length}건 · 분석 완료 ${done} · 생략 ${skipped} · 확인 필요 ${attention}`;
  for(const item of items){
    const entry=el('button',undefined,'queue-item'+(value.running&&item.id===value.activeId?' current':''));entry.type='button';
    entry.append(el('span',item.title||item.id),el('code',item.id),el('b',item.status||'대기'));
    entry.onclick=()=>run(async()=>{if(!requests.some(r=>r.id===item.id))await refresh();if(!requests.some(r=>r.id===item.id)){notice('상세 수집이 끝나면 요청을 열 수 있습니다.');return;}activeId=item.id;drawRows();await drawDetail();});queue.append(entry);
  }
  const log=$('activity-log'),top=log.scrollTop;
  log.textContent=(value.logs||[]).map(l=>`[${new Date(l.time).toLocaleTimeString('ko-KR')}] [${l.phase}] ${l.requestId?l.requestId+' · ':''}${l.message}${l.total?` (${l.current||0}/${l.total})`:''}`).join('\n')||'아직 실행된 작업이 없습니다.';
  log.scrollTop=$('log-follow').checked?log.scrollHeight:top;
  $('status').textContent=`${value.phase||'준비됨'} · ${value.message||''}`;
  drawElapsed();
  document.querySelectorAll('.request-row').forEach(row=>row.classList.toggle('processing',!!value.running&&row.dataset.requestId===value.activeId));
}
function drawElapsed(){const value=activityState;const seconds=value.startedAt?Math.floor(((value.running?Date.now():value.endedAt||Date.now())-value.startedAt)/1000):0;$('activity-elapsed').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function initActivity(){
  setInterval(drawElapsed,1000);
  api.onProgress(value=>{
    drawActivity(value);
    // Refresh saved results as each request finishes, without replacing the selected request.
    if(!activityRefreshPending&&['내용 비교','요청 처리 결과','결과 저장'].includes(value.phase)){
      activityRefreshPending=true;run(async()=>{try{await refresh();}finally{activityRefreshPending=false;}});
    }
  });
}
