// 2026-10-16 김기덕: ChatGPT 플랜 요청 형식과 스트림 종료·실패를 검증한다.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const ai=require('../src/core/ai.cjs');
const config={provider:'chatgpt',model:'account-model'};
const request={id:'REQ-ec/ECC0101.xfdl1',text:'요청 본문',images:[{mime:'image/png',data:'aW1hZ2U='}]};
const context={target:'ec/ECC0101',files:[{projectName:'icms',relative:'a.js',content:'1: test',lineNumbers:[1]}],warnings:[],hash:'hash'};
function event(value){return 'data: '+JSON.stringify(value)+'\r\n\r\n';}
function stream(text){const bytes=new TextEncoder().encode(text);let i=0;return new Response(new ReadableStream({pull(controller){if(i>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(i,i+=7));}}),{headers:{'content-type':'text/event-stream'}});}
test('플랜은 공식 주소, stream=true와 store=false를 사용하며 미지원 필드는 제외한다',()=>{
 const call=ai.buildRequest(config,'oauth-token',request,context,[{role:'user',content:'추가 질문'}]);const body=JSON.parse(call.init.body);
 assert.equal(call.url,'https://api.openai.com/v1/responses');assert.equal(body.stream,true);assert.equal(body.store,false);assert.ok(Array.isArray(body.input));assert.equal(body.max_output_tokens,undefined);assert.equal(body.input[0].content[1].type,'input_image');assert.equal(body.input.at(-1).content,'추가 질문');
});
test('ChatGPT 모델 목록의 표시명과 서버 순서를 유지한다',async()=>{
 const models=await ai.listModels(config,'token',async()=>new Response(JSON.stringify({models:[{slug:'b',display_name:'모델 B',visibility:'list'},{slug:'hidden',visibility:'hidden'},{slug:'a',display_name:'모델 A',visibility:'list'}]})));
 assert.deepEqual(models,[{id:'b',name:'모델 B'},{id:'a',name:'모델 A'}]);
});
test('완료 이벤트가 있는 스트림만 분석 성공으로 반환하고 UTF-8 분할을 처리한다',async()=>{
 const raw=JSON.stringify({summary:'요청 분석',causes:[]});
 const data=event({type:'response.output_text.delta',delta:raw})+event({type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text:raw}]}]}});
 const result=await ai.analyze(config,'token',request,context,null,async()=>stream(data));assert.equal(result.report.summary,'요청 분석');
});
test('스트림 도중 사용량 오류·불완전·연결 중단은 성공으로 저장하지 않는다',async()=>{
 const failures=[event({type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}),event({type:'response.incomplete'}),event({type:'response.output_text.delta',delta:'일부 응답'})];
 for(const failure of failures)await assert.rejects(()=>ai.analyze(config,'token',request,context,null,async()=>stream(failure)));
});
// 2026-10-16 김기덕: 실제 플랜 API의 빈 completed.output과 별도 텍스트 이벤트를 재현한다.
test('완료 output이 비어도 item.done 또는 텍스트 이벤트를 순서대로 복원하고 중복하지 않는다',async()=>{
 const raw=JSON.stringify({summary:'실제 스트림 복원',causes:[]});
 const delta=event({type:'response.output_text.delta',output_index:0,content_index:0,delta:raw.slice(0,10)})+event({type:'response.output_text.delta',output_index:0,content_index:0,delta:raw.slice(10)});
 const textDone=event({type:'response.output_text.done',output_index:0,content_index:0,text:raw});
 const itemDone=event({type:'response.output_item.done',output_index:0,item:{type:'message',role:'assistant',content:[{type:'output_text',text:raw}]}});
 const completed=event({type:'response.completed',response:{status:'completed',output:[]}});
 for(const value of [delta+completed,delta+textDone+completed,delta+textDone+itemDone+completed,itemDone+completed]){
  const result=await ai.analyze(config,'token',request,context,null,async()=>stream(value));assert.equal(result.report.summary,'실제 스트림 복원');assert.equal(result.report.formatWarning,undefined);
 }
 await assert.rejects(()=>ai.analyze(config,'token',request,context,null,async()=>stream(delta+textDone+itemDone)),/완료 응답 전/);
});
test('HTTP 429 크레딧 소진과 플랜 제한을 구분하고 서버 원문을 노출하지 않는다',async()=>{
 for(const [code,message]of [['credit_balance_exhausted','크레딧이 소진'],['subscription_sharing_usage_limit_exceeded','플랜 또는 이 앱']])await assert.rejects(()=>ai.analyze(config,'token',request,context,null,async()=>new Response(JSON.stringify({error:{code,message:'secret-echo'}}),{status:429})),error=>error.message.includes(message)&&!error.message.includes('secret-echo'));
});
