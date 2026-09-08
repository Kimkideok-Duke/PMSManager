const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chat,buildRequest}=require('../src/core/ai.cjs');
const {mergeRequests}=require('../src/core/store.cjs');
const {recordAnalysis}=require('../src/core/content.cjs');
const request={id:'REQ-demo.xfdl1',text:'저장 오류',images:[{mime:'image/png',data:'aGVsbG8='}],analysis:{report:{summary:'기존 원인 후보'}},note:'보충 메모'};
const context={target:'demo.xfdl',hash:'ctx',warnings:[],files:[{projectName:'P',relative:'demo.xfdl',content:'1: save();',lineNumbers:[1]}]};
const messages=[{role:'user',content:'password=hidden 첫 질문'},{role:'assistant',content:'첫 답변'},{role:'user',content:'추가 재현 조건'}];
test('네 공급자의 대화에 요청·이미지·소스·기존 분석과 이전 대화 역할을 전달한다',()=>{
  for(const provider of ['openai','anthropic','gemini','compatible']){
    const wire=buildRequest({provider,model:'test',endpoint:'https://test.example/v1'},'key',request,context,messages);
    const data=JSON.parse(wire.init.body);
    for(const text of ['저장 오류','aGVsbG8=','save();','기존 원인 후보','첫 답변','추가 재현 조건'])assert.ok(wire.init.body.includes(text));
    assert.ok(!wire.init.body.includes('password=hidden'));
    if(provider==='gemini'){assert.deepEqual(data.contents.map(m=>m.role),['user','model','user']);assert.equal(data.generationConfig.responseMimeType,undefined);}
    if(provider==='anthropic')assert.deepEqual(data.messages.map(m=>m.role),['user','assistant','user']);
    if(provider==='openai'){assert.equal(data.store,false);assert.equal(data.input.at(-2).role,'assistant');}
    if(provider==='compatible')assert.equal(data.messages.at(-2).role,'assistant');
  }
});
test('대화 답변은 일반 텍스트로 반환하고 공급자 오류·취소를 전달한다',async()=>{
  const config={provider:'openai',model:'test'};
  const reply=await chat(config,'key',request,context,messages,null,async()=>({ok:true,text:async()=>JSON.stringify({output:[{content:[{type:'output_text',text:'보완한 답변'}]}]})}));
  assert.equal(reply.content,'보완한 답변');assert.equal(reply.contextHash,'ctx');assert.equal(reply.role,'assistant');
  await assert.rejects(()=>chat(config,'key',request,context,messages,null,async()=>({ok:false,status:429})),/사용 한도/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(()=>chat(config,'key',request,context,messages,abort.signal,async(_url,init)=>{init.signal.throwIfAborted();}),{name:'AbortError'});
});
test('요청 내용 변경·재수집·분석 결과 저장 이후에도 요청별 대화를 유지한다',()=>{
  const original={...request,chatMessages:messages};
  const [merged]=mergeRequests([original],[{...request,text:'변경된 본문'}]);assert.deepEqual(merged.chatMessages,messages);
  recordAnalysis(merged,{report:{summary:'새 분석'}});assert.deepEqual(merged.chatMessages,messages);
  const restored=JSON.parse(JSON.stringify(merged));assert.deepEqual(restored.chatMessages,messages);
  assert.deepEqual(mergeRequests([restored],[{id:restored.id,error:'수집 실패'}])[0].chatMessages,messages);
});
