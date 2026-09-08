const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {JSDOM}=require('jsdom');
test('앱 화면이 빈 상태에서 시작하고 요청 선택·이미지·분석 결과를 안전하게 표시한다',async()=>{
  const html=await fs.readFile(path.join(__dirname,'../src/ui/index.html'),'utf8');const script=await fs.readFile(path.join(__dirname,'../src/ui/app.js'),'utf8');
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'file:///app/index.html'}),w=dom.window;
  const search={visitedFiles:1600,indexedFiles:1500,selectedFiles:3,omittedFiles:0,roots:[{name:'icms',path:'C:/example/icms'}],skippedFiles:100,excludedDirectories:2,excluded:[{path:'target',reason:'빌드 출력'}],trace:[{from:'화면',to:'icms/server/Example.java',depth:1,reason:'함수 호출'}]};
  const id='REQ-ec/Screen.xfdl1',row={id,title:'<script>injection</script>',text:'오류 설명',images:[],imageCount:0,analysis:{createdAt:new Date().toISOString(),provider:'test',model:'fake',search,report:{summary:'원인 후보',causes:[],executionFlow:['화면 → 서비스'],resolutionSteps:[{title:'검증 수정',action:'삭제 행을 검증에서 제외',expected:'저장 성공',evidence:[]}]}}};
  const settings={projects:[],ai:{provider:'openai',endpoint:'https://api.openai.com/v1',model:'',hasKey:false}};
  w.pms={state:async()=>({settings,requests:[row],dataPath:'local'}),detail:async()=>row,onProgress:()=>{}};
  w.eval(script);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(w.document.getElementById('stat-total').textContent,'1');
  w.document.querySelector('.request-row').click();await new Promise(resolve=>setTimeout(resolve,20));assert.ok(w.document.getElementById('detail').textContent.includes('오류 설명'));assert.ok(w.document.getElementById('detail').textContent.includes('원인 후보'));assert.equal(w.document.getElementById('detail').querySelector('script'),null);
  assert.ok(w.document.getElementById('detail').textContent.includes('1,500개 내용 검색'));assert.ok(w.document.getElementById('detail').textContent.includes('오류 해결 절차'));assert.ok(w.document.getElementById('detail').textContent.includes('삭제 행을 검증에서 제외'));
  w.document.querySelector('.request-row input').click();assert.equal(w.document.getElementById('selection-count').textContent,'1개 선택');
  w.document.querySelector('[data-page="settings"]').click();assert.equal(w.document.getElementById('settings-page').hidden,false);dom.window.close();
});

test('자동 분석 버튼이 수집·비교·분석 IPC를 호출하고 생략 건수를 표시한다',async()=>{
 const html=await fs.readFile(path.join(__dirname,'../src/ui/index.html'),'utf8'),script=await fs.readFile(path.join(__dirname,'../src/ui/app.js'),'utf8');
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'file:///app/index.html'}),w=dom.window;let received;
 const settings={projects:[],ai:{provider:'openai',endpoint:'https://api.openai.com/v1',model:'example',hasKey:true}};
 w.pms={state:async()=>({settings,requests:[],dataPath:'local'}),onProgress:()=>{},sync:async input=>{received=input;return {requests:[],ids:[],collected:3,unchanged:2,done:1,failed:0,blocked:0};}};
 try{w.eval(script);await new Promise(r=>setTimeout(r,20));w.document.getElementById('ready').checked=true;w.document.getElementById('collect').click();await new Promise(r=>setTimeout(r,20));assert.equal(received.ready,true);assert.match(w.document.getElementById('toast').textContent,/동일 내용 생략 2건.*분석 완료 1건/);assert.equal(w.document.getElementById('collect').disabled,false);}finally{w.close();}
});
