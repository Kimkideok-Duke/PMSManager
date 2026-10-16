// Runs only inside the PMS page. UUIDs vary between logins; use semantic grid attributes.
function pageAction(action, arg) {
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const grids = [...document.querySelectorAll('[role="grid"]')].filter(visible);
  // 2026-10-16 김기덕: 가로 가상화로 메뉴명 열이 사라져도 오른쪽 요청ID 헤더로 동일 그리드를 찾는다.
  const grid = grids.find(e => [...e.querySelectorAll('[role="row"]')].some(r => {
    const text = r.innerText || r.textContent || '';
    const hasDatesAndStatus=text.includes('등록일자')&&text.includes('처리상태');
    return text.includes('메뉴명')&&(text.includes('요청ID')||hasDatesAndStatus)
      ||text.includes('요청ID')&&hasDatesAndStatus;
  }));
  if (!grid) return {error:'바로콘변경요청관리에서 로그인·조건 입력·조회를 완료하세요. 요청내역 그리드를 찾지 못했습니다.'};
  // 2026-10-16 김기덕: 건수 속성 누락을 빈 조회로 오인해 로컬 목록을 삭제하지 않는다.
  const rawCount=grid.getAttribute('aria-rowcount'),rowCount=Number(rawCount);
  if(rawCount===null||!Number.isInteger(rowCount)||rowCount<1)return {error:'PMS 요청 전체 건수를 확인할 수 없습니다. 목록을 유지했습니다. 다시 조회하세요.'};

  const allRows = [...grid.querySelectorAll('[role="row"][data-rowindex]')];
  const cellText = c => (c.querySelector?.('input')?.value || c.innerText || c.textContent || c.getAttribute?.('aria-label')?.replace(/^\d+행\s+\d+열\s*/, '') || '').trim();

  // Dynamically detect column indices from header row if available
  let colIdx = { title: 4, category: 5, registeredAt: 6, status: 9, id: 12 };
  const headerRows = [...grid.querySelectorAll('.cl-grid-header [role="row"], [role="row"]:not([data-rowindex])')];
  for (const hRow of headerRows) {
    const hCells = [...hRow.querySelectorAll('[role="columnheader"], [role="gridcell"], div')];
    for (const c of hCells) {
      const txt = (c.innerText || c.textContent || '').trim();
      const idx = c.getAttribute('data-cellindex');
      if (idx !== null) {
        if (txt.includes('메뉴명')) colIdx.title = Number(idx);
        else if (txt.includes('구분')) colIdx.category = Number(idx);
        else if (txt.includes('등록일자')) colIdx.registeredAt = Number(idx);
        else if (txt.includes('처리상태')) colIdx.status = Number(idx);
        else if (txt.includes('요청ID')) colIdx.id = Number(idx);
      }
    }
  }

  const visibleRows = allRows.map(r => {
    const cells = [...r.querySelectorAll('[role="gridcell"]')];
    const get = index => cellText(cells.find(c => c.getAttribute('data-cellindex') === String(index)) || {innerText:''});
    return {
      title: get(colIdx.title) || get(3) || get(4),
      category: get(colIdx.category) || get(4) || get(5),
      registeredAt: get(colIdx.registeredAt) || get(5) || get(6),
      status: get(colIdx.status) || get(8) || get(9),
      rowIndex: Number(r.getAttribute('data-rowindex')),
      selected: r.getAttribute('aria-selected') === 'true'
    };
  });

  const rows = allRows.map((r,index) => {
    const idCell = [...r.querySelectorAll('[role="gridcell"]')].find(c => /^REQ-[\w./\\-]+(?:\.[A-Za-z0-9]+)?\w*$/i.test(cellText(c)) || /^REQ-\S+$/i.test(cellText(c)));
    return idCell ? {...visibleRows[index], id: cellText(idCell)} : null;
  }).filter(Boolean);

  const scroller = [...grid.querySelectorAll('[data-role="scroll-container"],div')].filter(e=>e.scrollHeight>e.clientHeight+2 && e.clientHeight>40 && (/auto|scroll/.test(getComputedStyle(e).overflowY) || (e.matches('[data-role="scroll-container"]') && e.closest('.cl-grid-detail')))).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0];
  const horizontal = [...grid.querySelectorAll('[data-role="scroll-container"],div')].filter(e=>e.scrollWidth>e.clientWidth+2 && e.clientWidth>100 && (/auto|scroll/.test(getComputedStyle(e).overflowX) || (e.matches('[data-role="scroll-container"]') && e.closest('.cl-grid-detail')))).sort((a,b)=>b.scrollWidth-a.scrollWidth)[0];

  function getEditors() {
    // 2026-10-16 김기덕: 일반 iframe을 요청내용으로 오인하지 않도록 편집기 식별을 필수화한다.
    const candidates = [];
    function visit(doc, depth, hostFrame) {
      if (!doc || depth > 6) return;
      if (doc !== document) {
        const frameName = `${hostFrame?.id||''} ${hostFrame?.name||''} ${hostFrame?.title||''}`;
        const body = doc.body;
        const hasContent = !!body && !!((body.innerText||body.textContent||'').trim() || body.querySelector?.('img'));
        let score = depth + (hasContent ? 10 : 0);
        if (/smart_editor2_inputarea\.html/i.test(doc.URL||'')) score += 100;
        if (/\bse2_iframe\b/i.test(frameName)) score += 90;
        if (body?.isContentEditable || String(doc.designMode).toLowerCase() === 'on') score += 40;
        if (/smart editor|wysiwyg|editor/i.test(`${doc.title||''} ${frameName}`)) score += 20;
        if (score >= 40) candidates.push({doc, score, depth});
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        if (!frame.getClientRects().length) continue;
        try { visit(frame.contentDocument, depth + 1, frame); } catch {}
      }
    }
    visit(document, 0, null);
    const leaves=candidates.filter(candidate=>!candidates.some(other=>other!==candidate&&[...candidate.doc.querySelectorAll('iframe')].some(frame=>{try{return frame.contentDocument===other.doc;}catch{return false;}})));
    return leaves.sort((a,b)=>b.score-a.score||b.depth-a.depth).map(c=>c.doc);
  }

  function findDetailId() {
    // 1. Check detail header in .cl-text, .cl-output, and other visible elements
    const elements = [...document.querySelectorAll('.cl-text, .cl-output, .cl-control, label, span, div, p, b')].filter(visible);
    for (const el of elements) {
      if (el.children.length > 2) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      const m = txt.match(/REQ_ID\s*:\s*(REQ-[\w./\\-]+(?:\.[A-Za-z0-9]+)?\w*)/i);
      if (m) return m[1].trim();
    }
    // 2026-10-16 김기덕: 그리드 ID 셀을 상세 헤더로 간주하지 않는다.
    const mBody = (document.body.innerText || document.body.textContent || '').match(/REQ_ID\s*:\s*(REQ-[\w./\\-]+(?:\.[A-Za-z0-9]+)?\w*)/i);
    return mBody ? mBody[1].trim() : '';
  }

  if (action === 'select') {
    const row = allRows.find(r => [...r.querySelectorAll('[role="gridcell"]')].some(c => cellText(c) === arg)) ||
                allRows.find(r => (r.innerText || '').includes(arg));
    if (!row) return {error:'선택할 요청이 현재 목록에 없습니다.'};
    const cell = [...row.querySelectorAll('[role="gridcell"]')].find(c=>cellText(c)===arg) || row.querySelector('[role="gridcell"]') || row;
    const before = getEditors()[0];
    const currentDetailId = findDetailId();
    globalThis.__pmsCapture?.observer?.disconnect();
    const capture = globalThis.__pmsCapture = {
      id: arg,
      body: before?.body,
      html: before?.body ? before.body.innerHTML : '',
      alreadySelected: currentDetailId === arg,
      changed: false
    };
    if (before?.body) {
      capture.observer = new MutationObserver(() => { capture.changed = true; });
      capture.observer.observe(before.body, { childList: true, subtree: true, characterData: true });
    }
    const fire = el => {
      if (!el) return;
      el.focus?.({preventScroll:true});
      el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,composed:true,button:0,buttons:1}));
      el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,composed:true,button:0}));
      el.click?.();
    };
    fire(cell);
    // 2026-10-16 김기덕: 버블링되는 클릭은 한 번만 발생시켜 중복 상세 조회를 방지한다.
    return {ok:true};
  }

  if (action === 'columns') {
    if (horizontal) {
      horizontal.scrollLeft = arg === 'id' ? horizontal.scrollWidth : Number(arg) || 0;
      horizontal.dispatchEvent(new Event('scroll',{bubbles:true}));
    }
    return {ok:true};
  }

  if (action === 'scroll') {
    if (scroller) {
      scroller.scrollTop = arg === 'next' ? scroller.scrollTop + Math.max(24,scroller.clientHeight * .8) : Number(arg);
      scroller.dispatchEvent(new Event('scroll',{bubbles:true}));
    }
    return {ok:true};
  }

  const detailId = findDetailId();
  const editors = getEditors();
  const editor = editors[0] || null;
  const capture = globalThis.__pmsCapture;
  if (capture && editor && (capture.body !== editor.body || capture.html !== editor.body.innerHTML)) capture.changed = true;

  let text = '';
  let images = [];
  if (editor && editor.body) {
    text = (editor.body.innerText || editor.body.textContent || '').trim();
    images = [...editor.body.querySelectorAll('img')].map(img=>({
      src: img.currentSrc || img.src,
      alt: img.alt || '',
      width: img.naturalWidth,
      height: img.naturalHeight
    }));
  }

  // 2026-10-16 김기덕: 검색조건이나 처리내용을 본문으로 오인하는 광역 fallback을 제거한다.
  if (!text && !images.length) {
    const areas=[...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
    const labelled=areas.filter(e=>e.hasAttribute('data-pms-request-content')||/요청\s*내용/.test(e.getAttribute('aria-label')||''));
    const candidates=labelled.length?labelled:detailId&&!editors.length?areas:[];
    const contentEditable = candidates.length===1?candidates[0]:null;
    if (contentEditable) {
      text = (contentEditable.innerText || contentEditable.textContent || '').trim();
      images = [...contentEditable.querySelectorAll('img')].map(img=>({
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight
      }));
    }
  }

  // 2026-10-16 김기덕: 숨김·투명·클리핑·다른 요소에 가려진 로딩 문구를 처리중으로 오인하지 않는다.
  function painted(element){
    if(!visible(element))return false;
    let area=element.getBoundingClientRect();
    let left=Math.max(0,area.left),top=Math.max(0,area.top),right=Math.min(innerWidth,area.right),bottom=Math.min(innerHeight,area.bottom);
    if(right<=left||bottom<=top)return false;
    for(let node=element;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity!==''&&Number(style.opacity)===0)return false;
      if(node!==element){
        const bounds=node.getBoundingClientRect();
        if(/hidden|clip|scroll|auto/.test(style.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
        if(/hidden|clip|scroll|auto/.test(style.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
        if(right<=left||bottom<=top)return false;
      }
    }
    if(typeof document.elementFromPoint!=='function')return true;
    const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);
    return !!hit&&(element===hit||element.contains(hit)||hit===element.parentElement);
  }
  const busy = [...document.querySelectorAll('.cl-text,[role="alert"],[role="status"]')].some(e => /^(?:처리\s*중입니다\.?|잠시만\s*기다려\s*주세요\.?)$/.test((e.textContent||'').trim())&&painted(e));
  const editorReady = !!editor || !!text || images.length > 0;

  return {
    rows,
    visibleRows,
    expected: rowCount-1,
    scrollTop: scroller?.scrollTop || 0,
    scrollLeft: horizontal?.scrollLeft || 0,
    atEnd: !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
    selectedId: rows.find(r => allRows.some(e => Number(e.getAttribute('data-rowindex')) === r.rowIndex && e.getAttribute('aria-selected') === 'true'))?.id,
    detailId,
    text,
    images,
    editorReady,
    busy,
    editorUpdated: !capture || capture.id !== detailId || capture.alreadySelected || capture.changed,
    editorError: editors.length>1?'요청내용 편집기 후보가 여러 개입니다. 다른 상세 화면을 닫고 다시 조회하세요.':''
  };
}
module.exports = {pageAction};
