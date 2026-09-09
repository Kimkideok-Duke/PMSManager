const {pageAction} = require('./page.cjs');
const {digest} = require('../core/source.cjs');
const {contentFingerprint}=require('../core/content.cjs');
const PMS_URL = 'https://ntest.daewooenc.com/expms/index.do';
const PMS_ORIGIN = new URL(PMS_URL).origin;
const sleep = (ms,signal) => new Promise((resolve,reject)=>{
  signal?.throwIfAborted();
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true});
});

class Collector {
  constructor(contents, progress=()=>{}) {this.contents=contents;this.progress=progress;}
  async call(action,arg) {
    if (this.contents.isDestroyed() || new URL(this.contents.getURL()).origin !== PMS_ORIGIN) throw new Error('PMS 창을 열고 로그인과 조회를 완료하세요.');
    const result = await this.contents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${pageAction.toString()})(${JSON.stringify(action)},${JSON.stringify(arg??null)})`}]);
    if (result.error) throw new Error(result.error);
    return result;
  }
  async locate(id,signal) {
    await this.call('scroll',0);
    let previous='',stalled=0;
    for(let page=0;page<500;page++) {
      await sleep(160,signal);
      const snap=await this.call('snapshot');
      if(snap.rows.some(r=>r.id===id)) return;
      if(snap.atEnd) break;
      const position=`${snap.scrollTop}|${snap.rows.map(r=>r.id).join('|')}`;
      stalled=position===previous?stalled+1:0;previous=position;
      if(stalled>=2) throw new Error('요청 목록 스크롤이 이동하지 않습니다. PMS 그리드를 다시 조회한 뒤 실행하세요.');
      await this.call('scroll','next');
    }
    throw new Error('목록이 변경되어 요청을 찾지 못했습니다. 다시 수집하세요.');
  }
  async detail(id,signal) {
    await this.call('select',id);
    // The PMS accessibility selection flag and editor mutation events are not
    // reliable. Trust the exact detail header after the loading overlay clears,
    // then require a stable editor body before collecting it.
    const start=Date.now();let last='',stable=0,lastSnap={};
    while(Date.now()-start<18000) {
      await sleep(350,signal);
      const snap=await this.call('snapshot');
      lastSnap=snap;
      if(snap.editorError) throw new Error(snap.editorError);
      if(snap.detailId!==id || !snap.editorReady || snap.busy) {stable=0;last='';continue;}
      const key=digest(JSON.stringify([snap.text,snap.images]));
      stable=key===last?stable+1:0;last=key;
      if(stable>=3 && Date.now()-start>=1500) return snap;
    }
    throw new Error(`상세 읽기 대기시간을 초과했습니다. 상세ID=${lastSnap.detailId||'없음'}, 편집기=${lastSnap.editorReady?'확인':'없음'}, PMS처리중=${lastSnap.busy?'예':'아니오'}`);
  }
  async collect(signal) {
    const original=await this.call('snapshot');
    const discovered=new Map(),results=[];
    if(!original.expected && !original.rows.length) return [];
    if(original.expected>500) throw new Error('한 번에 최대 500건을 수집합니다. PMS 검색조건을 좁혀 다시 조회하세요.');
    try {
      const metadata=new Map();
      await this.call('columns','start');
      await this.call('scroll',0);
      let previous='',stalled=0;
      for(let page=0;page<500;page++) {
        await sleep(180,signal);
        const snap=await this.call('snapshot');
        if(original.expected!==snap.expected) throw new Error('수집 중 목록 건수가 바뀌었습니다. 다시 조회하고 실행하세요.');
        for(const row of snap.visibleRows||snap.rows) metadata.set(row.rowIndex,row);
        this.progress({phase:'목록 탐색',message:`조회 목록 정보 ${metadata.size}/${original.expected}건 확인`,current:metadata.size,total:original.expected});
        // Some PMS grids report a non-final scrollbar position even when every
        // logical row is already rendered. The exact row count is authoritative.
        if(metadata.size===original.expected) break;
        if(snap.atEnd) break;
        const position=`${snap.scrollTop}|${(snap.visibleRows||snap.rows).map(r=>r.rowIndex).join('|')}`;
        stalled=position===previous?stalled+1:0;previous=position;
        if(stalled>=2) throw new Error(`요청 목록 세로 스크롤이 이동하지 않습니다. ${metadata.size}/${original.expected}건에서 멈췄습니다. PMS에서 다시 조회하세요.`);
        await this.call('scroll','next');
      }
      await this.call('columns','id');
      await this.call('scroll',0);previous='';stalled=0;
      for(let page=0;page<500;page++) {
        await sleep(180,signal);
        const snap=await this.call('snapshot');
        if(original.expected!==snap.expected) throw new Error('수집 중 목록 건수가 바뀌었습니다. 다시 조회하고 실행하세요.');
        for(const row of snap.rows) discovered.set(row.id,{...(metadata.get(row.rowIndex)||{}),...row});
        this.progress({phase:'목록 탐색',message:`요청ID ${discovered.size}/${original.expected}건 확인`,current:discovered.size,total:original.expected});
        if(discovered.size===original.expected) break;
        if(snap.atEnd) break;
        const position=`${snap.scrollTop}|${snap.rows.map(r=>r.id).join('|')}`;
        stalled=position===previous?stalled+1:0;previous=position;
        if(stalled>=2) throw new Error(`요청ID 열을 읽는 중 세로 스크롤이 이동하지 않습니다. ${discovered.size}/${original.expected}건에서 멈췄습니다.`);
        await this.call('scroll','next');
      }
      if(discovered.size!==original.expected) throw new Error(`목록 ${original.expected}건 중 ${discovered.size}건만 읽었습니다. 그리드 스크롤·페이지 상태를 확인하세요. 부분 목록을 전체로 처리하지 않습니다.`);
      this.progress({phase:'상세 수집',items:[...discovered.values()].map(r=>({id:r.id,title:r.title,status:'수집 대기'})),current:0,total:discovered.size,message:'요청별 본문과 이미지 수집 시작'});
      for(const row of [...discovered.values()].sort((a,b)=>a.rowIndex-b.rowIndex)) {
        signal?.throwIfAborted();
        this.progress({phase:'상세 수집',requestId:row.id,title:row.title,status:'상세 수집 중',message:row.id,current:results.length,total:discovered.size});
        try {
          await this.locate(row.id,signal);
          const detail=await this.detail(row.id,signal);
          const images=[],warnings=[];
          if(detail.images.length>12) warnings.push(`이미지 ${detail.images.length}개 중 최대 12개만 수집합니다.`);
          for(const image of detail.images.slice(0,12)) {
            this.progress({phase:'이미지 수집',requestId:row.id,status:'이미지 수집 중',message:`${row.id} · 이미지 ${images.length+1}/${Math.min(detail.images.length,12)}`,current:images.length,total:Math.min(detail.images.length,12)});
            signal?.throwIfAborted();
            try {
              images.push(await this.loadImage(image,signal));
            } catch(e) {if(signal?.aborted) throw e;warnings.push(`이미지 읽기 실패: ${e.message}`);}
          }
          if(!detail.text.trim() && !images.length) throw new Error('요청내용과 이미지가 비어 있습니다.');
          if(detail.text.length>100000) throw new Error('요청내용이 100,000자를 넘습니다. 요청을 나누어 주세요.');
          const snapshot={...row,text:detail.text,images,warnings,contentComplete:images.length===detail.images.length,collectedAt:new Date().toISOString()};
          snapshot.fingerprint=contentFingerprint(snapshot);
          results.push(snapshot);
        } catch(e) {if(signal?.aborted) throw e;results.push({...row,error:e.message,collectedAt:new Date().toISOString()});}
        const result=results[results.length-1];
        this.progress({phase:'상세 수집',requestId:row.id,status:result.error?'상세 읽기 실패':result.contentComplete?'수집 완료':'이미지·본문 확인 필요',message:`${row.id} · ${result.error?'상세 읽기 실패':result.contentComplete?'수집 완료':'이미지 확인 필요'}`,current:results.length,total:discovered.size});
      }
      return results;
    } finally {
      try {
        if(original.selectedId) {await this.locate(original.selectedId);await this.call('select',original.selectedId);}
        await this.call('columns',original.scrollLeft||0);
        await this.call('scroll',original.scrollTop);
      } catch {this.progress({phase:'수집',message:'원래 선택 행 복원에 실패했습니다. PMS 화면을 확인하세요.'});}
    }
  }
  async loadImage(image,signal) {
    let bytes,mime;
    if(image.src.startsWith('data:')) {
      const m=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(image.src);
      if(!m) throw new Error('지원하지 않는 이미지 데이터');
      mime=m[1];bytes=Buffer.from(m[2],'base64');
    } else {
      const url=new URL(image.src);
      if(url.origin!==PMS_ORIGIN) throw new Error('PMS 외부의 이미지 주소입니다.');
      const response=await this.contents.session.fetch(url.href,{signal,redirect:'error'});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      mime=response.headers.get('content-type')?.split(';')[0];
      if(!/^image\/(png|jpeg|webp|gif)$/.test(mime||'')) throw new Error('이미지 형식이 아닙니다.');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024)throw new Error('이미지가 8MB를 넘습니다.');chunks.push(Buffer.from(value));}}
      finally {await reader.cancel();}
      bytes=Buffer.concat(chunks);
    }
    if(bytes.length>8*1024*1024) throw new Error('이미지가 8MB를 넘습니다.');
    return {mime,data:bytes.toString('base64'),alt:image.alt,hash:digest(bytes),bytes:bytes.length};
  }
}
module.exports={Collector,PMS_URL,PMS_ORIGIN};
