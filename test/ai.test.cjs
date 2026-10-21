const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildRequest,parseReport,analyze,listModels,endpoint}=require('../src/core/ai.cjs');
const request={id:'REQ-ec/Main.xfdl1',title:'test',text:'password=hidden',fingerprint:'r1',images:[{mime:'image/png',data:'aGVsbG8='}]};
const context={target:'ec/Main.xfdl',hash:'c1',warnings:[],files:[{projectName:'P',relative:'Main.xfdl',reason:'요청ID 연결',content:'1: function save() {}',lineNumbers:[1],hash:'filehash'}]};
const fake=data=>async()=>({ok:true,status:200,text:async()=>JSON.stringify(data)});
test('모든 공급자에 본문과 이미지가 함께 전송되며 비밀값은 가린다',()=>{
  for(const provider of ['openai','anthropic','gemini','compatible']){const {url,init}=buildRequest({provider,endpoint:'https://custom.example/v1',model:'chosen-model'},'fake-key',request,context);assert.ok(url.startsWith('https:'));const body=JSON.parse(init.body);assert.ok(init.body.includes('aGVsbG8='));assert.ok(!init.body.includes('password=hidden'));assert.ok(init.body.includes('[REDACTED]'));assert.ok(init.body.includes('1: function save()'));if(provider==='openai')assert.equal(body.store,false);assert.ok(!url.includes('fake-key'));}
});
test('유효하지 않은 endpoint와 미설정 모델은 전송 전에 거절한다',()=>{
  for(const url of ['http://custom.example/v1','https://user:pass@example.com','https://example.com?key=x'])assert.throws(()=>endpoint({provider:'compatible',endpoint:url}));
  assert.throws(()=>buildRequest({provider:'openai',model:''},'key',request,context),/모델/);
});
test('모델 인용을 제공된 소스와 행 번호로 검증한다',()=>{
  const result=parseReport(JSON.stringify({summary:'가설',textFindings:['본문 오류'],imageFindings:['1번 이미지 경고'],causes:[{title:'원인',confidence:'높음',fix:'수정',tests:['검증'],evidence:[{path:'P/Main.xfdl',line:1,detail:'valid'},{path:'P/Main.xfdl',line:999},{path:'invented.java',line:1}]}]}),context);
  assert.deepEqual(result.textFindings,['본문 오류']);assert.deepEqual(result.imageFindings,['1번 이미지 경고']);
  assert.deepEqual(result.causes[0].evidence.map(e=>e.verified),[true,false,false]);assert.ok(parseReport('not JSON',context).formatWarning);
});
test('AI API 응답 저장과 입력 부족 오류를 처리한다',async()=>{
  const raw=JSON.stringify({summary:'분석',causes:[],missing:[]});const result=await analyze({provider:'openai',model:'chosen'},'key',request,context,null,fake({output:[{content:[{type:'output_text',text:raw}]}]}));assert.equal(result.report.summary,'분석');assert.equal(result.requestFingerprint,'r1');
  await assert.rejects(()=>analyze({provider:'openai',model:'chosen'},'key',request,context,null,async()=>({ok:false,status:401})),/API 키/);
  await assert.rejects(()=>analyze({provider:'openai',model:'chosen'},'key',request,context,null,fake({status:'incomplete'})),/출력 한도/);
});
test('모델 목록을 조회하되 자동으로 모델을 바꾸지 않는다',async()=>{
  assert.deepEqual(await listModels({provider:'openai'},'key',fake({data:[{id:'b'},{id:'a'},{id:'b'}]})),['a','b']);
  assert.deepEqual(await listModels({provider:'gemini'},'key',fake({models:[{name:'models/vision',supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}]})),['vision']);
});
test('검색 근거를 프롬프트로 전달하고 해결 절차의 소스 인용도 검증한다',()=>{
  const enriched={...context,search:{indexedFiles:1500,selectedFiles:1,omittedFiles:0,trace:[{from:'요청내용',to:'P/Main.xfdl',terms:['saveBid']} ]}};
  const wire=buildRequest({provider:'openai',model:'chosen'},'key',request,enriched);
  assert.ok(wire.init.body.includes('1500'));assert.ok(wire.init.body.includes('saveBid'));// 2026-10-20 김기덕: 상세 해결 절차 대신 간결한 수정 이유와 방법을 요청한다.
  assert.ok(wire.init.body.includes('수정 이유'));assert.ok(wire.init.body.includes('3문장 이내'));assert.ok(!wire.init.body.includes('resolutionSteps'));
  const report=parseReport(JSON.stringify({summary:'원인',executionFlow:['화면 → 저장 검증'],causes:[],resolutionSteps:[{title:'대상 줄 수정',action:'검증 대상 확인',expected:'삭제 행 제외',evidence:[{path:'P/Main.xfdl',line:1},{path:'P/Unknown.java',line:9}]}]}),enriched);
  assert.equal(report.resolutionSteps[0].action,'검증 대상 확인');assert.deepEqual(report.resolutionSteps[0].evidence.map(e=>e.verified),[true,false]);
});
