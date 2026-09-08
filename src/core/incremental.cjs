const {mergeRequests}=require('./store.cjs');
const {needsAnalysis,recordAnalysis}=require('./content.cjs');

// Dependencies are injected so the complete collection -> comparison -> analysis
// pipeline can be tested without a private PMS session or paid API calls.
async function runIncremental({previous,collect,createIndex,buildContext,analyze,save,onContext=()=>{},progress=()=>{},signal}) {
  signal?.throwIfAborted();
  // Always read every current row's detail before deciding whether it changed.
  const incoming=await collect(signal);
  const rows=mergeRequests(previous,incoming);
  await save(rows);
  const currentIds=new Set(incoming.map(r=>r.id));
  const current=rows.filter(r=>currentIds.has(r.id));
  const pending=current.filter(needsAnalysis);
  const summary={collected:incoming.length,unchanged:current.filter(r=>r.syncStatus==='동일 내용 · 분석 생략').length,blocked:current.filter(r=>!r.contentFingerprint).length,done:0,failed:0,pending:pending.length};
  progress({phase:'내용 비교',activeId:null,items:current.map(r=>({id:r.id,title:r.title,status:needsAnalysis(r)?'분석 대기':r.syncStatus})),message:`동일 ${summary.unchanged}건 생략 · 신규/변경/미분석 ${pending.length}건 · 확인 필요 ${summary.blocked}건`});
  if(!pending.length)return {rows,ids:[],...summary};
  signal?.throwIfAborted();
  const index=await createIndex(signal);
  for(const [i,row] of pending.entries()) {
    signal?.throwIfAborted();
    try {
      progress({phase:'관련 소스 검색',requestId:row.id,title:row.title,status:'소스 검색 중',message:`${i+1}/${pending.length}번째 요청 · ${row.id}`,batchCurrent:i,batchTotal:pending.length});
      const context=await buildContext(row,index,signal);
      onContext(row.id,context);
      if(context.blocked){row.analysisError=context.warnings.join('\n');row.syncStatus='관련 소스 확인 필요';summary.blocked++;}
      else {progress({phase:'AI 응답 대기',requestId:row.id,status:'AI 응답 대기',message:`${row.id} · 소스 ${context.files?.length||0}개 전송 · 응답을 기다립니다.`});recordAnalysis(row,await analyze(row,context,signal));summary.done++;}
    }catch(e){if(signal?.aborted)throw e;row.analysisError=e.message;row.syncStatus='분석 실패';summary.failed++;}
    await save(rows);
    progress({phase:'요청 처리 결과',requestId:row.id,status:row.syncStatus,message:`${row.id} · ${row.syncStatus}`,batchCurrent:i+1,batchTotal:pending.length});
  }
  return {rows,ids:pending.map(r=>r.id),...summary};
}
module.exports={runIncremental};
