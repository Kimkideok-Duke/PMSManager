const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runIncremental}=require('../src/core/incremental.cjs');
const {contentFingerprint,needsAnalysis,recordAnalysis,upgradeRow}=require('../src/core/content.cjs');
const row=(text='오류',id='REQ-ec/Main.xfdl1')=>({id,text,images:[],warnings:[]});
// 2026-10-16 김기덕: 현재 PMS 목록 동기화와 실패 시 삭제 방지를 검증한다.
test('정상 전체 조회 후 사라진 요청은 제거하고 현재 요청의 분석·메모는 보존한다',async()=>{
 const first=await batch([],[row(),row('조치됨','REQ-ec/Closed.xfdl1')]);first.rows[0].note='검토 메모';
 const next=await batch(first.rows,[row()]);
 assert.equal(next.removed,1);assert.equal(next.rows.length,1);assert.equal(next.rows[0].note,'검토 메모');assert.ok(next.rows[0].analysis);assert.equal(next.unchanged,1);
 const empty=await batch(next.rows,[]);assert.equal(empty.rows.length,0);assert.equal(empty.removed,1);
});
test('목록 수집 실패에서는 과거 요청을 삭제하지 않는다',async()=>{
 const previous=[row('보존')];let saved;
 await assert.rejects(()=>batch(previous,[],{collect:async()=>{throw Error('부분 목록');},save:async rows=>{saved=rows;}}),/부분 목록/);
 assert.equal(saved,undefined);assert.equal(previous.length,1);
});
async function batch(previous,incoming,extra={}){
 const calls={read:0,index:0,ai:[],saved:[]};
 const result=await runIncremental({previous,collect:async()=>{calls.read++;return incoming;},createIndex:async()=>{calls.index++;return {};},buildContext:async()=>({blocked:false}),analyze:async r=>{calls.ai.push(r.id);return {report:{summary:r.text}};},save:async rows=>calls.saved.push(JSON.parse(JSON.stringify(rows))),...extra});
 return {...result,calls};
}
test('매번 상세 수집 후 비교하며 동일 본문은 정렬·상태·제목 변경에도 API와 소스 검색을 생략한다',async()=>{
 let first=await batch([],[row()]);assert.equal(first.done,1);
 const again=await batch(JSON.parse(JSON.stringify(first.rows)),[{...row(),title:'바뀐 제목',status:'조치중',rowIndex:12}]);
 assert.equal(again.calls.read,1);assert.equal(again.unchanged,1);assert.equal(again.calls.index,0);assert.deepEqual(again.calls.ai,[]);
});
test('신규 ID·변경 본문·이미지 바이트 변경만 분석하고 동일 URL 이미지를 비교한다',async()=>{
 const image=data=>({...row(),images:[{src:'https://same/image.png',data:Buffer.from(data).toString('base64')}]});
 let result=await batch([],[image('a'),row('다른 내용','REQ-ec/Other.xfdl1')]);
 result=await batch(result.rows,[image('b'),row('변경','REQ-ec/Other.xfdl1'),row('오류','REQ-ec/New.xfdl2')]);assert.equal(result.done,3);
 const repeat=await batch(result.rows,[image('b'),row('변경','REQ-ec/Other.xfdl1')]);assert.equal(repeat.unchanged,2);
});
test('A→B→A로 복원된 내용은 재호출하지 않고 해당 과거 결과를 표시한다',async()=>{
 let result=await batch([],[row('A')]);result=await batch(result.rows,[row('B')]);result=await batch(result.rows,[row('A')]);
 assert.equal(result.done,0);assert.equal(result.unchanged,1);assert.equal(result.rows[0].analysis.report.summary,'A');assert.equal(result.rows[0].analysisStale,false);
});
test('API 실패·소스 누락·이미지 실패는 분석 완료로 기록하지 않으며 다음 실행에 재시도한다',async()=>{
 let result=await batch([],[row()],{analyze:async()=>{throw Error('API 실패');}});assert.equal(result.failed,1);assert.equal(needsAnalysis(result.rows[0]),true);
 result=await batch(result.rows,[row()],{buildContext:async()=>({blocked:true,warnings:['소스 없음']})});assert.equal(result.blocked,1);assert.equal(needsAnalysis(result.rows[0]),true);
 result=await batch(result.rows,[{...row(),contentComplete:false,warnings:['이미지 읽기 실패']}]);assert.equal(result.blocked,1);assert.equal(result.calls.index,0);
 result=await batch(result.rows,[row()]);assert.equal(result.done,1);
 const failedRead=await batch(result.rows,[{id:row().id,error:'상세 실패'}]);assert.equal(failedRead.unchanged,0);assert.equal(failedRead.blocked,1);
});
// 2026-10-16 김기덕: 실제 API 429 테스트에서 발견한 종료 후 실패 상태 덮어쓰기를 방지한다.
test('전체 수집 종료 후에도 API 실패와 관련 소스 확인 상태를 보존하고 실패 건수를 알린다',async()=>{
 const events=[];
 const result=await batch([],[row(),row('다른 요청','REQ-ec/Other.xfdl1')],{
  buildContext:async r=>r.id===row().id?{blocked:false}:{blocked:true,warnings:['소스 확인 필요']},
  analyze:async()=>{throw Error('AI API HTTP 429');},progress:event=>events.push(event)
 });
 assert.equal(result.rows[0].syncStatus,'분석 실패');
 assert.equal(result.rows[0].analysisError,'AI API HTTP 429');
 assert.equal(result.rows[1].syncStatus,'관련 소스 확인 필요');
 assert.match(events.at(-1).message,/실패 1건 · 확인 필요 1건/);
 assert.deepEqual(result.calls.saved.at(-1),JSON.parse(JSON.stringify(result.rows)));
});
test('구버전의 정확히 대응하는 성공 결과만 이전하고 근거 없는 결과는 다시 분석한다',()=>{
 const legacy={...row(),fingerprint:'old',analysis:{requestFingerprint:'old',report:{}}};assert.equal(needsAnalysis(legacy),false);
 assert.equal(needsAnalysis({...row(),analysis:{report:{}}}),true);
 assert.equal(needsAnalysis({...legacy,analysis:{requestFingerprint:'other'}}),true);
 assert.equal(upgradeRow(legacy).analysis.contentFingerprint,contentFingerprint(row()));
});
test('부분 이미지와 식별 불가능한 이미지는 완료 해시를 만들지 않는다',()=>{
 for(const r of [{...row(),images:[{}]},{...row(),contentComplete:false}]){assert.equal(contentFingerprint(r),null);assert.throws(()=>recordAnalysis(r,{}));}
});
test('취소 시 완료 결과를 보존하고 다음 요청은 호출하지 않는다',async()=>{
 const controller=new AbortController();let saved=[],count=0;
 await assert.rejects(()=>batch([],[row(),row('둘','REQ-ec/Two.xfdl1')],{signal:controller.signal,save:async rows=>{saved=structuredClone(rows);if(rows[0].analysis)controller.abort();},analyze:async()=>{count++;return {report:{}};}}),{name:'AbortError'});
 assert.equal(count,1);assert.ok(saved[0].analysis);assert.equal(saved.find(r=>r.id==='REQ-ec/Two.xfdl1'),undefined);
});
test('각 PMS 행은 상세 저장과 분석을 완료한 뒤 다음 행으로 넘어간다',async()=>{
 const events=[],incoming=[row('첫 요청'),row('둘째 요청','REQ-ec/Two.xfdl1')];let saved=[];
 const result=await runIncremental({previous:[],collect:async(_signal,onItem)=>{
  for(const [i,item] of incoming.entries()){
   events.push('선택 '+item.id);await onItem(item,i+1,incoming.length);
   assert.ok(saved.find(r=>r.id===item.id)?.analysis);events.push('완료 '+item.id);
  }
  return incoming;
 },createIndex:async()=>({}),buildContext:async()=>({blocked:false,files:[]}),analyze:async item=>{events.push('분석 '+item.id);return {report:{summary:item.text}};},save:async rows=>{saved=structuredClone(rows);}});
 assert.equal(result.done,2);assert.deepEqual(events,[`선택 ${incoming[0].id}`,`분석 ${incoming[0].id}`,`완료 ${incoming[0].id}`,`선택 ${incoming[1].id}`,`분석 ${incoming[1].id}`,`완료 ${incoming[1].id}`]);
});
