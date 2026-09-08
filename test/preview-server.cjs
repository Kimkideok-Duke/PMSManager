// Local visual QA only. No PMS session, private data, filesystem API or AI credentials.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.join(__dirname,'../src/ui');
const stub=`(() => {
 const settings={projects:[{id:'fixture',name:'화면 확인용 프로젝트',path:'C:\\\\example\\\\project',enabled:true}],ai:{provider:'openai',endpoint:'https://api.openai.com/v1',model:'선택할 모델',hasKey:false}};
 const row={id:'REQ-demo/SAMPLE0101.xfdl1',title:'화면 검증용 예제 · 저장 오류',category:'오류',status:'등록',text:'화면 확인용 가상 요청입니다. 행 삭제 후 저장할 때 필수값 검증 메시지가 표시됩니다.',imageCount:0,images:[],review:'미검토',collectedAt:new Date().toISOString(),analysis:{provider:'화면 테스트',model:'API 호출 없음',createdAt:new Date().toISOString(),report:{summary:'검증용 예제입니다. 실제 PMS 데이터나 AI 분석 결과가 아닙니다.',imageFindings:[],causes:[{title:'삭제된 행이 검증 대상에 포함되는지 확인',confidence:'낮음',fix:'저장 전 검증 함수의 대상 행과 삭제 상태 처리 로직을 확인합니다.',evidence:[],tests:['행 추가 → 저장 → 첫 행 삭제 → 저장 순서로 재현','신규 행과 삭제 행이 함께 있을 때 검증 범위 확인']}],missing:['실제 프로젝트 소스 연결 필요']}}};
 window.pms={state:async()=>({settings,requests:location.search.includes('empty')?[]:[row],dataPath:'화면 테스트 · 저장하지 않음'}),detail:async()=>row,onProgress:()=>{},'open-pms':async()=>{},'project-toggle':async()=>settings,'project-remove':async()=>settings,'project-add':async()=>settings,'ai-save':async()=>settings,'ai-clear-key':async()=>settings,models:async()=>['sample-model'],review:async()=>[row],export:async()=>null,prepare:async()=>({token:'fixture',endpoint:settings.ai.endpoint,model:settings.ai.model,items:[{id:row.id,images:0,characters:1200,target:'demo/SAMPLE0101.xfdl',files:[{path:'예제/SAMPLE0101.xfdl',reason:'화면 테스트',truncated:false}],blocked:false,warnings:[],candidates:[]}]}),cancel:async()=>{}};
})();`;
http.createServer(async(req,res)=>{
 try{const route=new URL(req.url,'http://127.0.0.1').pathname;if(route==='/preview-api.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.end(stub);return;}
 const name={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[route];if(!name){res.writeHead(404);res.end();return;}
 let text=await fs.readFile(path.join(root,name),'utf8');if(name==='index.html')text=text.replace('<script src="app.js">','<script src="preview-api.js"></script><script src="app.js">');
 res.setHeader('Content-Type',name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(text);
 }catch{res.writeHead(500);res.end('preview error');}
}).listen(4179,'127.0.0.1',()=>console.log('Visual QA: http://127.0.0.1:4179'));
