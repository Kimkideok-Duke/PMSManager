const {mergeRequests}=require('./store.cjs');
const {needsAnalysis,recordAnalysis}=require('./content.cjs');

// Dependencies are injected so the complete collection -> comparison -> analysis
// pipeline can be tested without a private PMS session or paid API calls.
async function runIncremental({previous,collect,createIndex,buildContext,analyze,save,onContext=()=>{},progress=()=>{},signal}) {
  signal?.throwIfAborted();
  // Finish one request at a time: select/read -> persist -> compare -> source
  // search -> AI analysis -> persist, then move to the next PMS row.
  let rows=previous, index;
  const seen=new Set(),ids=[];
  const summary={collected:0,unchanged:0,blocked:0,done:0,failed:0,pending:0};
  const process=async(incoming,current,total)=>{
    signal?.throwIfAborted();
    if(seen.has(incoming.id))return;seen.add(incoming.id);
    rows=mergeRequests(rows,[incoming]);summary.collected++;
    await save(rows);
    const row=rows.find(r=>r.id===incoming.id);
    if(!row.contentFingerprint){summary.blocked++;progress({phase:'요청 처리 결과',requestId:row.id,title:row.title,status:'상세 읽기 실패',message:`${row.id} · ${row.error||row.syncStatus}`,batchCurrent:current,batchTotal:total});return;}
    if(!needsAnalysis(row)){summary.unchanged++;progress({phase:'요청 처리 결과',requestId:row.id,title:row.title,status:'동일 내용 · 분석 생략',message:`${row.id} · 동일 내용 생략`,batchCurrent:current,batchTotal:total});return;}
    summary.pending++;ids.push(row.id);
    try {
      if(!index){progress({phase:'소스 경로 확인',requestId:row.id,title:row.title,status:'프로젝트 경로 확인 중',message:'파일 경로를 파악한 뒤 요청 업무 폴더의 내용을 검색합니다.',batchCurrent:current-1,batchTotal:total});index=await createIndex(signal);}
      progress({phase:'관련 소스 검색',requestId:row.id,title:row.title,status:'소스 검색 중',message:`${current}/${total}번째 요청 · ${row.id}`,batchCurrent:current-1,batchTotal:total});
      const context=await buildContext(row,index,signal);
      onContext(row.id,context);
      if(context.blocked){row.analysisError=context.warnings.join('\n');row.syncStatus='관련 소스 확인 필요';summary.blocked++;}
      else {progress({phase:'AI 응답 대기',requestId:row.id,status:'AI 응답 대기',message:`${row.id} · 소스 ${context.files?.length||0}개 전송 · 응답을 기다립니다.`});recordAnalysis(row,await analyze(row,context,signal));summary.done++;}
    }catch(e){if(signal?.aborted)throw e;row.analysisError=e.message;row.syncStatus='분석 실패';summary.failed++;}
    await save(rows);
    progress({phase:'요청 처리 결과',requestId:row.id,status:row.syncStatus,message:`${row.id} · ${row.syncStatus}`,batchCurrent:current,batchTotal:total});
  };
  // Collector calls process after every selected row. Simple integrations that
  // return an array are supported as a fallback for tests and manual collection.
  const incoming=await collect(signal,process);
  for(const [i,item] of incoming.entries())if(!seen.has(item.id))await process(item,i+1,incoming.length);
  // 2026-10-16 김기덕: 수집이 정상 종료된 경우만 현재 PMS 목록에 없는 요청을 제거한다.
  signal?.throwIfAborted();
  const currentIds=new Set(incoming.map(row=>row.id));
  summary.removed=rows.filter(row=>!currentIds.has(row.id)).length;
  // 2026-10-16 김기덕: 이미 처리한 결과를 재병합하지 않아 실패 상태와 완료 상태를 보존한다.
  rows=rows.filter(row=>currentIds.has(row.id));
  await save(rows);
  // 2026-10-16 김기덕: API 실패 건수도 종료 로그에 표시한다.
  progress({phase:'자동 분석 완료',activeId:null,message:`상세 ${summary.collected}건 · 분석 ${summary.done}건 · 동일 ${summary.unchanged}건 · 실패 ${summary.failed}건 · 확인 필요 ${summary.blocked}건`});
  return {rows,ids,...summary};
}
module.exports={runIncremental};
