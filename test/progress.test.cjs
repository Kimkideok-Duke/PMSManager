const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ProgressTracker}=require('../src/core/progress.cjs');
const {runIncremental}=require('../src/core/incremental.cjs');
test('실제 처리 결과를 요청별로 기록하며 단계 변경 시 이전 진행률을 지운다',async()=>{
  const tracker=new ProgressTracker();tracker.begin('자동 분석');
  await runIncremental({previous:[],collect:async()=>[{id:'REQ-a.xfdl1',text:'a',images:[]},{id:'REQ-b.xfdl1',text:'b',images:[]}],createIndex:async()=>({}),buildContext:async()=>({files:[],blocked:false}),analyze:async r=>{if(r.id.includes('b.'))throw Error('API 실패');return {report:{summary:'완료'}};},save:async()=>{},progress:e=>tracker.update(e)});
  assert.deepEqual(tracker.snapshot().items.map(r=>r.status),['분석 완료','분석 실패']);
  assert.equal(tracker.snapshot().batchCurrent,2);assert.equal(tracker.snapshot().batchTotal,2);
  tracker.update({phase:'색인',current:30,total:100});tracker.update({phase:'AI 응답 대기',message:'대기'});
  assert.equal(tracker.snapshot().total,undefined);
  tracker.end('완료');assert.equal(tracker.snapshot().running,false);assert.equal(tracker.snapshot().activeId,null);
});
test('중지 시 완료 결과는 유지하고 나머지를 중지로 표시하며 로그는 500개로 제한한다',()=>{
  const tracker=new ProgressTracker();tracker.begin('분석');tracker.update({phase:'분석',items:[{id:'a',status:'분석 완료'},{id:'b',status:'AI 응답 대기'},{id:'c',status:'분석 대기'}]});
  for(let i=0;i<600;i++)tracker.update({phase:'분석',message:String(i)});
  tracker.end('중지');assert.equal(tracker.snapshot().logs.length,500);assert.deepEqual(tracker.snapshot().items.map(r=>r.status),['분석 완료','중지','중지']);
  tracker.begin('다음 작업');assert.equal(tracker.snapshot().items.length,0);assert.equal(tracker.snapshot().logs.length,1);
});
