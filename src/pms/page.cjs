// Runs only inside the PMS page. UUIDs vary between logins; use semantic grid attributes.
function pageAction(action, arg) {
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const grids = [...document.querySelectorAll('[role="grid"]')].filter(visible);
  const grid = grids.find(e => [...e.querySelectorAll('[role="row"]')].some(r => {
    const text = r.innerText || r.textContent || '';
    return text.includes('메뉴명') && (text.includes('요청ID') || (text.includes('등록일자') && text.includes('처리상태')));
  }));
  if (!grid) return {error:'바로콘변경요청관리에서 로그인·조건 입력·조회를 완료하세요. 요청내역 그리드를 찾지 못했습니다.'};

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
        if (score >= 20 || hasContent) candidates.push({doc, score, depth});
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        if (!frame.getClientRects().length) continue;
        try { visit(frame.contentDocument, depth + 1, frame); } catch {}
      }
    }
    visit(document, 0, null);
    return candidates.sort((a,b)=>b.score-a.score||b.depth-a.depth).map(c=>c.doc);
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
    const idEl = elements.find(el => el.children.length === 0 && /^REQ-[\w./\\-]+(?:\.[A-Za-z0-9]+)?\w*$/i.test((el.innerText||'').trim()));
    if (idEl) return (idEl.innerText || '').trim();
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
    if (cell !== row) fire(row);
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

  // Fallback: if no iframe editor found or body is empty, search main document near '요청내용'
  if (!text && !images.length) {
    const contentEditable = document.querySelector('[contenteditable="true"]');
    if (contentEditable) {
      text = (contentEditable.innerText || contentEditable.textContent || '').trim();
      images = [...contentEditable.querySelectorAll('img')].map(img=>({
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight
      }));
    } else {
      const reqLabels = [...document.querySelectorAll('.cl-text, .cl-output, label, span, div')].filter(visible);
      const reqContentLabel = reqLabels.find(e => /요청\s*내용/i.test((e.innerText||'').trim()) && e.children.length === 0);
      if (reqContentLabel) {
        const container = reqContentLabel.closest('.cl-layout, [role="form"], div') || reqContentLabel.parentElement;
        if (container) {
          const editArea = container.querySelector('[contenteditable="true"], .se2_inputarea, [class*="editor"], [class*="edit"]');
          const targetArea = editArea || container;
          text = (targetArea.innerText || targetArea.textContent || '').replace(/요청\s*내용/g, '').trim();
          images = [...targetArea.querySelectorAll('img')].filter(img => !img.src.includes('icon') && !img.src.includes('btn')).map(img=>({
            src: img.currentSrc || img.src,
            alt: img.alt || '',
            width: img.naturalWidth,
            height: img.naturalHeight
          }));
        }
      }
    }
  }

  const busy = [...document.querySelectorAll('.cl-text,[role="alert"],[role="status"]')].filter(visible).some(e => /처리\s*중입니다|잠시만\s*기다려\s*주세요/.test(e.textContent||''));
  const editorReady = !!editor || !!text || images.length > 0;

  return {
    rows,
    visibleRows,
    expected: Math.max(0, Number(grid.getAttribute('aria-rowcount')||0)-1),
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
    editorError: ''
  };
}
module.exports = {pageAction};
