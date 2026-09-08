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
  progress({phase:'내용 비교',message:`동일 ${summary.unchanged}건 생략 · 신규/변경/미분석 ${pending.length}건 · 확인 필요 ${summary.blocked}건`});
  if(!pending.length)return {rows,ids:[],...summary};
  signal?.throwIfAborted();
  const index=await createIndex(signal);
  for(const [i,row] of pending.entries()) {
    signal?.throwIfAborted();
    try {
      progress({phase:'신규·변경 분석',message:row.id,current:i+1,total:pending.length});
      const context=await buildContext(row,index,signal);
      onContext(row.id,context);
      if(context.blocked){row.analysisError=context.warnings.join('\n');row.syncStatus='관련 소스 확인 필요';summary.blocked++;}
      else {recordAnalysis(row,await analyze(row,context,signal));summary.done++;}
    }catch(e){if(signal?.aborted)throw e;row.analysisError=e.message;row.syncStatus='분석 실패';summary.failed++;}
    await save(rows);
  }
  return {rows,ids:pending.map(r=>r.id),...summary};
}
module.exports={runIncremental};
