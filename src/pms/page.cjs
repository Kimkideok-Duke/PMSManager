// Runs only inside the PMS page. UUIDs vary between logins; use semantic grid attributes.
function pageAction(action, arg) {
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const grids = [...document.querySelectorAll('[role="grid"]')].filter(visible);
  const grid = grids.find(e => [...e.querySelectorAll('[role="row"]')].some(r => r.innerText.includes('요청ID') && r.innerText.includes('메뉴명')));
  if (!grid) return {error:'바로콘변경요청관리에서 로그인·조건 입력·조회를 완료하세요. 요청내역 그리드를 찾지 못했습니다.'};
  const allRows = [...grid.querySelectorAll('[role="row"][data-rowindex]')];
  const cellText = c => (c.querySelector?.('input')?.value || c.innerText || c.getAttribute?.('aria-label')?.replace(/^\d+행\s+\d+열\s*/, '') || '').trim();
  const rows = allRows.map(r => {
    const cells = [...r.querySelectorAll('[role="gridcell"]')];
    const idCell = cells.find(c => /^REQ-\S+\.xfdl\S*$/i.test(cellText(c)));
    if (!idCell) return null;
    const get = index => cellText(cells.find(c => c.getAttribute('data-cellindex') === String(index)) || {innerText:''});
    return {id:cellText(idCell),title:get(4),category:get(5),registeredAt:get(6),status:get(9),rowIndex:Number(r.getAttribute('data-rowindex'))};
  }).filter(Boolean);
  const scroller = [...grid.querySelectorAll('[data-role="scroll-container"],div')].filter(e=>e.scrollHeight>e.clientHeight+2 && e.clientHeight>40 && (/auto|scroll/.test(getComputedStyle(e).overflowY) || (e.matches('[data-role="scroll-container"]') && e.closest('.cl-grid-detail')))).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0];
  function getEditors() {
    const result=[];
    function visit(doc,depth) {
      if(!doc||depth>6)return;
      if(/smart_editor2_inputarea\.html/i.test(doc.URL))result.push(doc);
      for(const frame of doc.querySelectorAll('iframe')){if(!frame.getClientRects().length)continue;try{visit(frame.contentDocument,depth+1);}catch{}}
    }
    visit(document,0);return result;
  }
  if (action === 'select') {
    const row = allRows.find(r => [...r.querySelectorAll('[role="gridcell"]')].some(c => cellText(c) === arg));
    if (!row) return {error:'선택할 요청이 현재 목록에 없습니다.'};
    const cell = [...row.querySelectorAll('[role="gridcell"]')].find(c=>cellText(c)===arg);
    const before=getEditors()[0];
    const label=[...document.querySelectorAll('.cl-text')].find(e=>/^REQ_ID\s*:/i.test(e.textContent.trim()));
    globalThis.__pmsCapture?.observer?.disconnect();
    const capture=globalThis.__pmsCapture={id:arg,body:before?.body,html:before?.body.innerHTML,alreadySelected:label?.textContent.match(/REQ_ID\s*:\s*(REQ-\S+)/i)?.[1]===arg,changed:false};
    if(before?.body){capture.observer=new MutationObserver(()=>{capture.changed=true;});capture.observer.observe(before.body,{childList:true,subtree:true,characterData:true});}
    cell.click();
    return {ok:true};
  }
  if (action === 'scroll') {
    if (scroller) {
      scroller.scrollTop = arg === 'next' ? scroller.scrollTop + Math.max(24,scroller.clientHeight * .8) : Number(arg);
      scroller.dispatchEvent(new Event('scroll',{bubbles:true}));
    }
    return {ok:true};
  }
  const detailLabel = [...document.querySelectorAll('.cl-text')].filter(visible).find(e=>/^REQ_ID\s*:\s*REQ-/i.test(e.textContent.trim()));
  const detailId = detailLabel?.textContent.match(/REQ_ID\s*:\s*(REQ-\S+)/i)?.[1] || '';
  const editors = getEditors();
  const editor = editors.length===1 ? editors[0] : null;
  const capture=globalThis.__pmsCapture;
  if(capture && editor && (capture.body!==editor.body||capture.html!==editor.body.innerHTML))capture.changed=true;
  const images = editor ? [...editor.images].map(img=>({src:img.currentSrc||img.src,alt:img.alt||'',width:img.naturalWidth,height:img.naturalHeight})) : [];
  return {
    rows,expected:Math.max(0,Number(grid.getAttribute('aria-rowcount')||0)-1),
    scrollTop:scroller?.scrollTop||0,atEnd:!scroller || scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-2,
    selectedId:rows.find(r=>allRows.some(e=>Number(e.getAttribute('data-rowindex'))===r.rowIndex && e.getAttribute('aria-selected')==='true'))?.id,
    detailId,text:editor?.body.innerText||'',images,editorReady:!!editor,
    editorUpdated:!capture||capture.id!==detailId||capture.alreadySelected||capture.changed,
    editorError:editors.length>1?'요청내용 편집기가 여러 개입니다. 다른 요청 화면을 닫으세요.':''
  };
}
module.exports = {pageAction};
