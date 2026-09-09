const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const uiScript=async()=> (await Promise.all(['activity.js','chat.js','app.js'].map(name=>fs.readFile(path.join(__dirname,'../src/ui',name),'utf8')))).join('\n');
const tick=()=>new Promise(r=>setTimeout(r,25));
test('대화 요청을 전환해도 초안과 응답이 섞이지 않고 실패 후 다시 전송할 수 있다',async()=>{
  const dom=new JSDOM(await fs.readFile(path.join(__dirname,'../src/ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window;
  const rows=[{id:'REQ-a.xfdl1',text:'A',images:[]},{id:'REQ-b.xfdl1',text:'B',images:[]}];let finish,fail=true;
  w.pms={state:async()=>({settings:{projects:[],ai:{provider:'openai',hasKey:true,model:'test'}},requests:rows}),detail:async id=>rows.find(r=>r.id===id),onProgress:()=>{},chat:async({id,message})=>new Promise((resolve,reject)=>{finish=()=>{if(fail){reject(Error('API 실패'));return;}const messages=[{role:'user',content:message,createdAt:new Date().toISOString()},{role:'assistant',content:'<script>unsafe</script> 답변',createdAt:new Date().toISOString()}];rows.find(r=>r.id===id).chatMessages=messages;resolve({id,messages});};})};
  try{
    w.eval(await uiScript());await tick();w.document.querySelectorAll('.request-row')[0].click();await tick();
    const input=w.document.getElementById('chat-input');input.value='A 질문';input.dispatchEvent(new w.Event('input'));
    w.document.getElementById('chat-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();finish();await tick();
    assert.match(w.document.getElementById('chat-status').textContent,/API 실패/);assert.equal(input.value,'A 질문');
    fail=false;w.document.getElementById('chat-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
    w.document.querySelectorAll('.request-row')[1].click();await tick();input.value='B 초안';input.dispatchEvent(new w.Event('input'));finish();await tick();
    assert.equal(input.value,'B 초안');assert.ok(!w.document.getElementById('chat-messages').textContent.includes('unsafe'));
    w.document.querySelectorAll('.request-row')[0].click();await tick();assert.ok(w.document.getElementById('chat-messages').textContent.includes('unsafe'));assert.equal(w.document.getElementById('chat-messages').querySelector('script'),null);assert.equal(input.value,'');
  }finally{w.close();}
});
test('실시간 작업의 현재 요청과 불확정 진행률을 표시하고 로그를 텍스트로 렌더링한다',async()=>{
  const dom=new JSDOM(await fs.readFile(path.join(__dirname,'../src/ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window;let listener;
  w.pms={state:async()=>({settings:{projects:[],ai:{provider:'openai'}},requests:[]}),onProgress:fn=>listener=fn};
  try{w.eval(await uiScript());await tick();listener({running:true,phase:'AI 응답 대기',activeId:'a',batchCurrent:1,batchTotal:3,items:[{id:'a',title:'현재 요청',status:'AI 응답 대기'}],logs:[{time:Date.now(),phase:'AI',message:'<script>bad</script>'}]});assert.match(w.document.getElementById('activity-current').textContent,/현재 요청.*a/);assert.equal(w.document.getElementById('stage-progress').hasAttribute('value'),false);assert.match(w.document.getElementById('batch-label').textContent,/1\/3/);assert.equal(w.document.getElementById('activity-log').querySelector('script'),null);}finally{w.close();}
});
test('앱 화면이 빈 상태에서 시작하고 요청 선택·이미지·분석 결과를 안전하게 표시한다',async()=>{
  const html=await fs.readFile(path.join(__dirname,'../src/ui/index.html'),'utf8');const script=await uiScript();
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'file:///app/index.html'}),w=dom.window;
  const search={visitedFiles:1600,indexedFiles:1500,selectedFiles:3,omittedFiles:0,roots:[{name:'icms',path:'C:/example/icms'}],skippedFiles:100,excludedDirectories:2,excluded:[{path:'target',reason:'빌드 출력'}],trace:[{from:'화면',to:'icms/server/Example.java',depth:1,reason:'함수 호출'}]};
  const id='REQ-ec/Screen.xfdl1',row={id,title:'<script>injection</script>',text:'오류 설명',images:[],imageCount:0,analysis:{createdAt:new Date().toISOString(),provider:'test',model:'fake',search,report:{summary:'원인 후보',textFindings:['본문에서 저장 오류 확인'],imageFindings:['첨부 이미지에서 경고 확인'],causes:[],executionFlow:['화면 → 서비스'],resolutionSteps:[{title:'검증 수정',action:'삭제 행을 검증에서 제외',expected:'저장 성공',evidence:[]}]}}};
  const settings={projects:[],ai:{provider:'openai',endpoint:'https://api.openai.com/v1',model:'',hasKey:false}};
  w.pms={state:async()=>({settings,requests:[row],dataPath:'local'}),detail:async()=>row,onProgress:()=>{}};
  w.eval(script);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(w.document.getElementById('stat-total').textContent,'1');
  w.document.querySelector('.request-row').click();await new Promise(resolve=>setTimeout(resolve,20));assert.ok(w.document.getElementById('detail').textContent.includes('오류 설명'));assert.ok(w.document.getElementById('detail').textContent.includes('원인 후보'));assert.equal(w.document.getElementById('detail').querySelector('script'),null);
  assert.ok(w.document.getElementById('detail').textContent.includes('1,500개 내용 검색'));assert.ok(w.document.getElementById('detail').textContent.includes('오류 해결 절차'));assert.ok(w.document.getElementById('detail').textContent.includes('삭제 행을 검증에서 제외'));
  assert.ok(w.document.getElementById('detail').textContent.includes('요청 본문에서 확인한 내용'));assert.ok(w.document.getElementById('detail').textContent.includes('이미지에서 확인한 내용'));
  w.document.querySelector('.request-row input').click();assert.equal(w.document.getElementById('selection-count').textContent,'1개 선택');
  w.document.querySelector('[data-page="settings"]').click();assert.equal(w.document.getElementById('settings-page').hidden,false);dom.window.close();
});

test('자동 분석 버튼이 수집·비교·분석 IPC를 호출하고 생략 건수를 표시한다',async()=>{
 const html=await fs.readFile(path.join(__dirname,'../src/ui/index.html'),'utf8'),script=await uiScript();
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'file:///app/index.html'}),w=dom.window;let received;
 const settings={projects:[],ai:{provider:'openai',endpoint:'https://api.openai.com/v1',model:'example',hasKey:true}};
 w.pms={state:async()=>({settings,requests:[],dataPath:'local'}),onProgress:()=>{},sync:async input=>{received=input;return {requests:[],ids:[],collected:3,unchanged:2,done:1,failed:0,blocked:0};}};
 try{w.eval(script);await new Promise(r=>setTimeout(r,20));w.document.getElementById('ready').checked=true;w.document.getElementById('collect').click();await new Promise(r=>setTimeout(r,20));assert.equal(received.ready,true);assert.match(w.document.getElementById('toast').textContent,/동일 내용 생략 2건.*분석 완료 1건/);assert.equal(w.document.getElementById('collect').disabled,false);}finally{w.close();}
});
