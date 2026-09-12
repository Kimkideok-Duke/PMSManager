const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {pageAction}=require('../src/pms/page.cjs');
const {Collector}=require('../src/pms/collector.cjs');
const id='REQ-ec/Main.xfdl1',second='REQ-ec/Other.xfdl2';
function page(editorPath='/smart_editor2_inputarea.html',editorAttribute=''){
  const dom=new JSDOM(`<div class="cl-text" id="detail">REQ_ID : ${id}</div><div role="grid" aria-rowcount="3"><div role="row">메뉴명 요청ID</div>${[id,second].map((value,i)=>`<div role="row" data-rowindex="${i}" aria-selected="${i===0}"><div role="gridcell" data-cellindex="4">화면${i}</div><div role="gridcell" data-cellindex="5">오류</div><div role="gridcell" data-cellindex="9"><input value="등록"></div><div role="gridcell" data-cellindex="13">${value}</div></div>`).join('')}</div><iframe ${editorAttribute} src="${editorPath}"></iframe>`,{url:'https://ntest.daewooenc.com/expms/index.do',runScripts:'outside-only'});
  const w=dom.window;w.HTMLElement.prototype.getClientRects=function(){return [{}];};
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  const doc=w.document.querySelector('iframe').contentDocument;doc.open();doc.write('<html><body><p>저장 오류</p><img src="data:image/png;base64,aGVsbG8="></body></html>');doc.close();
  Object.defineProperty(doc.body,'innerText',{get(){return this.textContent;}});
  const call=(action,arg)=>w.eval(`(${pageAction.toString()})(${JSON.stringify(action)},${JSON.stringify(arg??null)})`);
  return {dom,w,doc,call};
}
test('실제 PMS와 같은 그리드·편집기 DOM에서 본문·이미지·전체 건수를 읽는다',()=>{
  const {dom,call}=page();const snap=call('snapshot');assert.equal(snap.expected,2);assert.equal(snap.rows.length,2);assert.equal(snap.visibleRows.length,2);assert.equal(snap.rows[0].status,'등록');assert.equal(snap.detailId,id);assert.equal(snap.text,'저장 오류');assert.equal(snap.images.length,1);dom.window.close();
});
test('Smart Editor 주소가 달라도 se2_iframe의 본문과 사진을 찾는다',()=>{
 const {dom,call}=page('/custom-wysiwyg.html','id="se2_iframe"');const snap=call('snapshot');assert.equal(snap.editorReady,true);assert.equal(snap.text,'저장 오류');assert.equal(snap.images.length,1);dom.window.close();
});
test('요청ID 열이 가상화되어도 화면에 보이는 행 정보는 유지한다',()=>{
  const {dom,w,call}=page();w.document.querySelector('[data-rowindex="1"] [data-cellindex="13"]').remove();
  const snap=call('snapshot');assert.equal(snap.rows.length,1);assert.equal(snap.visibleRows.length,2);assert.equal(snap.visibleRows[1].title,'화면1');dom.window.close();
});
test('상세 헤더만 바뀌고 본문이 이전 요청이면 갱신 완료로 간주하지 않는다',()=>{
  const {dom,w,doc,call}=page();call('select',second);w.document.getElementById('detail').textContent='REQ_ID : '+second;
  assert.equal(call('snapshot').editorUpdated,false);doc.body.innerHTML='<p>새 요청 내용</p>';assert.equal(call('snapshot').editorUpdated,true);dom.window.close();
});
test('선택 동작은 요청ID 셀만 누르고 저장 버튼을 누르지 않는다',()=>{
  const {dom,w,call}=page();let clicked=0;w.document.querySelector('[data-rowindex="1"] [data-cellindex="13"]').addEventListener('click',()=>clicked++);assert.equal(call('select',second).ok,true);assert.equal(clicked,1);assert.ok(call('select','missing').error);dom.window.close();
});
test('부분 목록은 전체 수집으로 완료 처리하지 않는다',async()=>{
  const c=new Collector({});c.call=async()=>({expected:9,rows:[{id}],atEnd:true,scrollTop:0});await assert.rejects(()=>c.collect(),/9건 중 1건/);
});
test('전체 건수를 읽으면 잘못된 스크롤 종료값과 관계없이 목록 탐색을 끝낸다',async()=>{
  const c=new Collector({});let snapshots=0;
  c.call=async action=>{
    if(action==='snapshot'){snapshots++;return {expected:1,visibleRows:[{title:'화면',rowIndex:0}],rows:[{id,rowIndex:0}],atEnd:false,scrollTop:0};}
    return {ok:true};
  };
  c.locate=async()=>{};c.detail=async()=>({text:'본문',images:[]});
  const rows=await c.collect();assert.equal(rows.length,1);assert.equal(rows[0].title,'화면');assert.equal(snapshots,3);
});
test('목록 스크롤 위치와 행이 반복되면 무한 탐색하지 않고 중단한다',async()=>{
  const c=new Collector({});let snapshots=0;
  c.call=async action=>{
    if(action==='snapshot'){snapshots++;return {expected:4,rows:[{id,rowIndex:0}],atEnd:false,scrollTop:0};}
    return {ok:true};
  };
  await assert.rejects(()=>c.collect(),/스크롤이 이동하지 않습니다/);assert.ok(snapshots<=5);
});
test('이미지 외부 URL과 잘못된 데이터 형식을 거절한다',async()=>{
  const c=new Collector({});await assert.rejects(()=>c.loadImage({src:'https://other.example/private.png'}),/PMS 외부/);await assert.rejects(()=>c.loadImage({src:'data:text/html;base64,aGVsbG8='}),/지원하지/);const image=await c.loadImage({src:'data:image/png;base64,aGVsbG8=',alt:'sample'});assert.equal(image.mime,'image/png');assert.equal(image.hash.length,64);
});

test('내용이 동일한 다른 행도 실제 편집기 재로딩을 감지한다',async()=>{
 const {dom,w,doc,call}=page();call('select',second);w.document.getElementById('detail').textContent='REQ_ID : '+second;
 const html=doc.body.innerHTML;doc.body.innerHTML=html;await Promise.resolve();assert.equal(call('snapshot').editorUpdated,true);dom.window.close();
});
test('상세 헤더와 안정된 편집기 내용이 맞으면 선택·변경 플래그 없이도 수집한다',async()=>{
 const c=new Collector({});let calls=0;
 c.call=async action=>action==='select'?{ok:true}:(calls++,{detailId:id,selectedId:undefined,editorReady:true,editorUpdated:false,busy:false,text:'정상 본문',images:[]});
 const detail=await c.detail(id);assert.equal(detail.text,'정상 본문');assert.ok(calls>=4);
});
test('PMS 처리 중 표시가 사라진 뒤 안정된 상세만 수집한다',async()=>{
 const c=new Collector({});let calls=0;
 c.call=async action=>action==='select'?{ok:true}:(calls++,{detailId:id,editorReady:true,busy:calls<3,text:calls<3?'이전 본문':'새 본문',images:[]});
 const detail=await c.detail(id);assert.equal(detail.text,'새 본문');assert.ok(calls>=6);
});
test('수집기는 모든 요청ID 셀을 선택하고 그 행의 상세 본문과 이미지를 읽는다',async()=>{
 const {dom,w,doc}=page();const selected=[];
 for(const r of w.document.querySelectorAll('[data-rowindex]'))r.querySelector('[data-cellindex="13"]').addEventListener('click',()=>{
  const current=r.querySelector('[data-cellindex="13"]').textContent;selected.push(current);
  for(const other of w.document.querySelectorAll('[data-rowindex]'))other.setAttribute('aria-selected',String(other===r));
  w.document.getElementById('detail').textContent='REQ_ID : '+current;doc.body.innerHTML='<p>'+current+' 상세</p><img src="data:image/png;base64,aGVsbG8=">';
 });
 const collector=new Collector({isDestroyed:()=>false,getURL:()=>w.location.href,executeJavaScriptInIsolatedWorld:async(_world,scripts)=>w.eval(scripts[0].code)});
 try{const rows=await collector.collect();assert.equal(rows.length,2);for(const r of rows){assert.equal(r.text,r.id+' 상세');assert.equal(r.images.length,1);assert.equal(r.contentComplete,true);assert.ok(selected.includes(r.id));}}finally{dom.window.close();}
});
test('eXbuilder6 cl-output 라벨과 메인 DOM contenteditable 에디터에서도 본문과 사진을 읽는다',()=>{
  const dom=new JSDOM(`<div class="cl-output" id="detail">REQ_ID : REQ-ec/ecj/ECJ0502.xfdl5</div><div role="grid" aria-rowcount="2"><div role="row">메뉴명 요청ID</div><div role="row" data-rowindex="0" aria-selected="true"><div role="gridcell" data-cellindex="4">심의결과</div><div role="gridcell" data-cellindex="5">권한</div><div role="gridcell" data-cellindex="9">등록</div><div role="gridcell" data-cellindex="12">REQ-ec/ecj/ECJ0502.xfdl5</div></div></div><div contenteditable="true"><p>load시 조회 안됨</p><img src="data:image/png;base64,aGVsbG8="></div>`,{url:'https://ntest.daewooenc.com/expms/index.do',runScripts:'outside-only'});
  const w=dom.window;w.HTMLElement.prototype.getClientRects=function(){return [{}];};
  const call=(action,arg)=>w.eval(`(${pageAction.toString()})(${JSON.stringify(action)},${JSON.stringify(arg??null)})`);
  const snap=call('snapshot');
  assert.equal(snap.detailId,'REQ-ec/ecj/ECJ0502.xfdl5');
  assert.equal(snap.text,'load시 조회 안됨');
  assert.equal(snap.images.length,1);
  assert.equal(snap.editorReady,true);
  dom.window.close();
});
