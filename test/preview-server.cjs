// Local visual QA only. No PMS session, private data, filesystem API or AI credentials.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.join(__dirname,'../src/ui');
const stub=`(() => {
 const settings={projects:[{id:'fixture',name:'화면 확인용 프로젝트',path:'C:\\\\example\\\\project',enabled:true}],ai:{provider:'openai',endpoint:'https://api.openai.com/v1',model:'선택할 모델',hasKey:false}};
 const row={id:'REQ-demo/SAMPLE0101.xfdl1',title:'화면 검증용 예제 · 저장 오류',category:'오류',status:'등록',text:'화면 확인용 가상 요청입니다. 행 삭제 후 저장할 때 필수값 검증 메시지가 표시됩니다.',imageCount:0,images:[],review:'미검토',collectedAt:new Date().toISOString(),analysis:{provider:'화면 테스트',model:'API 호출 없음',createdAt:new Date().toISOString(),report:{summary:'검증용 예제입니다. 실제 PMS 데이터나 AI 분석 결과가 아닙니다.',imageFindings:[],causes:[{title:'삭제된 행이 검증 대상에 포함되는지 확인',confidence:'낮음',fix:'저장 전 검증 함수의 대상 행과 삭제 상태 처리 로직을 확인합니다.',evidence:[],tests:['행 추가 → 저장 → 첫 행 삭제 → 저장 순서로 재현','신규 행과 삭제 행이 함께 있을 때 검증 범위 확인']}],missing:['실제 프로젝트 소스 연결 필요']}}};
 window.pms={state:async()=>({settings,requests:location.search.includes('empty')?[]:[row],dataPath:'화면 테스트 · 저장하지 않음'}),detail:async()=>row,onProgress:()=>{},'open-pms':async()=>{},'project-toggle':async()=>settings,'project-remove':async()=>settings,'project-add':async()=>settings,'ai-save':async()=>settings,'ai-clear-key':async()=>settings,models:async()=>['sample-model'],review:async()=>[row],export:async()=>null,prepare:async()=>({token:'fixture',endpoint:settings.ai.endpoint,model:settings.ai.model,items:[{id:row.id,images:0,characters:1200,target:'demo/SAMPLE0101.xfdl',files:[{path:'예제/SAMPLE0101.xfdl',reason:'화면 테스트',truncated:false}],blocked:false,warnings:[],candidates:[]}]}),cancel:async()=>{}};
 let listener=()=>{},cancelled=false;
 const activity={runId:'preview',running:false,phase:'화면 검증',message:'가상 진행 상황입니다. 실제 API를 호출하지 않습니다.',startedAt:Date.now()-65000,endedAt:Date.now(),batchCurrent:1,batchTotal:3,activeId:null,items:[{id:row.id,title:row.title,status:'분석 완료'},{id:'REQ-demo/SAMPLE0201.xfdl2',title:'조회 조건에 따른 합계 확인',status:'분석 대기'},{id:'REQ-demo/SAMPLE0301.xfdl3',title:'저장 후 목록 갱신 확인',status:'분석 대기'}],logs:[{time:Date.now()-50000,phase:'상세 수집',message:'조회 목록 3건 수집 완료'},{time:Date.now()-30000,phase:'하위 소스 검색',message:'파일 내용 색인 · 1,500개',current:1500,total:1500},{time:Date.now(),phase:'결과 저장',requestId:row.id,message:'가상 분석 결과 저장'}]};
 const originalState=window.pms.state;window.pms.state=async()=>({...await originalState(),progress:activity});
 window.pms.onProgress=fn=>{listener=fn;};
 window.pms.sync=async()=>{cancelled=false;activity.running=true;activity.startedAt=Date.now();for(const phase of ['상세 수집','관련 소스 검색','AI 응답 대기','결과 저장']){if(cancelled)break;activity.phase=phase;activity.activeId=row.id;activity.items[0].status=phase;activity.logs.push({time:Date.now(),phase,message:'가상 작업 진행'});listener(structuredClone(activity));await new Promise(r=>setTimeout(r,900));}activity.running=false;activity.activeId=null;activity.endedAt=Date.now();activity.phase=cancelled?'중지':'완료';activity.items[0].status=cancelled?'중지':'분석 완료';listener(structuredClone(activity));return {requests:[row],ids:[row.id],collected:3,unchanged:2,done:1,failed:0,blocked:0};};
 window.pms.cancel=async()=>{cancelled=true;};
 settings.ai.hasKey=true;settings.ai.model='화면 테스트 · API 호출 없음';
 row.chatMessages=[{role:'user',content:'삭제된 행에서만 오류가 발생합니다. 어떤 조건을 먼저 확인해야 하나요?',createdAt:new Date().toISOString()},{role:'assistant',model:'화면 테스트',content:'저장 전 검증에서 삭제 상태의 행을 제외하는지 확인하세요.\\n\\n1. 삭제 직후 행 상태를 확인합니다.\\n2. 필수값 검증 함수의 반복 범위를 대조합니다.\\n3. 삭제 행과 신규 행이 함께 있을 때 저장을 검증합니다.\\n\\n이 내용은 화면 확인용 예시입니다.',createdAt:new Date().toISOString()}];
 window.pms.chat=async({message})=>{await new Promise(r=>setTimeout(r,1000));row.chatMessages.push({role:'user',content:message,createdAt:new Date().toISOString()},{role:'assistant',content:'화면 검증용 답변입니다. 추가 설명을 반영한 대화가 여기에 표시됩니다.',model:'화면 테스트',createdAt:new Date().toISOString()});return {id:row.id,messages:row.chatMessages};};
 window.pms['chat-cancel']=async()=>{};
})();`;
http.createServer(async(req,res)=>{
 try{const route=new URL(req.url,'http://127.0.0.1').pathname;if(route==='/preview-api.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.end(stub);return;}
 const name={'/':'index.html','/app.js':'app.js','/activity.js':'activity.js','/chat.js':'chat.js','/style.css':'style.css'}[route];if(!name){res.writeHead(404);res.end();return;}
 let text=await fs.readFile(path.join(root,name),'utf8');if(name==='index.html')text=text.replace('<script src="app.js">','<script src="preview-api.js"></script><script src="app.js">');
 res.setHeader('Content-Type',name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(text);
 }catch{res.writeHead(500);res.end('preview error');}
}).listen(4179,'127.0.0.1',()=>console.log('Visual QA: http://127.0.0.1:4179'));
