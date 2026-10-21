const fs = require('node:fs/promises');
const path = require('node:path');
const {parseRequestId,requestPath,readSource,redact,digest,slash,excerpts} = require('./files.cjs');

const EXTENSIONS = new Set(('.clx .xfdl .xjs .js .mjs .cjs .ts .tsx .jsx .java .kt .kts .xml .sql .ddl .jsp .jspx .properties .vue .svelte .html .htm .css .scss .less .cs .cshtml .vb .py .go .rs .c .h .cpp .hpp .php .rb .json .yaml .yml .toml .ini .config .conf .txt .md .gradle .prisma .graphql .gql').split(' '));
// 2026-10-16 김기덕: icms 원본과 중복되는 eXbuilder 생성물·배포본·작업 폴더의 재색인을 방지한다.
const EXCLUDED = new Set(['.git','.svn','node_modules','target','build','dist','clx-build','webapps','outputs','work','jsdocs','.idea','.metadata','.gradle','coverage','bin','obj','.next','.nuxt','.venv','venv','__pycache__']);
const STOP = new Set(('this form self public private protected static final return class interface extends implements new function const let var if else null true false undefined string number boolean object void int long double float import from package export default include select update insert delete into where join table values set get save load open close error message data value name type text id row col div span input button script style xmlns http https www com org java util system console log promise async await function onload onclick transaction addrow application encoding version utf-8 json xml xfdl java sql js ts').split(' '));
const LIMITS = {files:75000,postings:3000000,termsPerFile:30000,contextFiles:40,contextChars:240000,depth:5};
const normalized = value => value.replaceAll('\\','/').replaceAll('::','/').replace(/^\/+|\/+$/g,'').toLowerCase();
const label = f => `${f.projectName}/${f.relative}`;
// 2026-10-21 김기덕: KB·MB 같은 짧은 파일 용량 단위도 소스 검색 단서로 사용한다.
const useful = term => (term.length>=3||/^(?:kb|mb|gb)$/i.test(term)) && term.length<=180 && !STOP.has(term) && !/^\d+$/.test(term);

function words(text) {
  const result=new Set();
  for(const m of text.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*(?:[./:#-][\p{L}\p{N}_$]+)*/gu)) {
    const full=normalized(m[0]);
    if(useful(full))result.add(full);
    const parts=full.split(/[./:#-]/);
    for(const part of parts)if(useful(part))result.add(part);
    if(parts.length>1){const tail=parts.slice(-2).join('.');if(useful(tail))result.add(tail);}
  }
  return result;
}

function symbols(text) {
  const definitions=new Set(),references=new Map();
  const ref=(value,kind,weight)=>{const term=normalized(value);if(useful(term)&&(!references.has(term)||references.get(term).weight<weight))references.set(term,{term,kind,weight});};
  const def=value=>{if(useful(normalized(value)))definitions.add(normalized(value));};
  for(const m of text.matchAll(/\b(?:class|interface|function|def|struct|enum)\s+([\w$]+)/g))def(m[1]);
  for(const m of text.matchAll(/\b(?:public|private|protected)\s+(?:(?:static|final|async|override)\s+)*[\w<>?,.\[\] ]+\s+([\w$]+)\s*\(/g))def(m[1]);
  for(const m of text.matchAll(/\b(?:this\.)?([\w$]+)\s*[:=]\s*(?:async\s+)?function\b/g))def(m[1]);
  for(const m of text.matchAll(/\b([A-Z][a-zA-Z0-9_$]*(?:Service|Controller|Repository|Mapper|Dao|DAO|Manager|Client|Validator|Helper|Util|Exception))\b/g))ref(m[1],'클래스·컴포넌트',10);
  for(const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const last=m[1].split('.').pop();ref(last,'함수 호출·정의',6);
  }
  for(const m of text.matchAll(/["']([^"'\r\n]{3,180})["']/g)) {
    const value=m[1];
    if(/^[\w./:\\-]+\.(?:clx|xfdl|xjs|js|ts|java|xml|sql|py|cs|vue|jsp)$/i.test(value)) {
      ref(value,'파일 참조',16);ref(path.posix.basename(value.replaceAll('::','/')),'파일 참조',16);
    }else if(/^[\w./:\\-]+$/.test(value)&&/[./:]/.test(value)) {
      ref(value,'API·매퍼 식별자',12);
      for(const token of words(value))ref(token,'경로·식별자 구성요소',4);
    }else if(/[가-힣]/.test(value))for(const token of words(value))ref(token,'오류 메시지·업무 용어',3);
  }
  for(const m of text.matchAll(/\b(?:from|join|update|into)\s+([\w$.]+)/gi))ref(m[1],'SQL 테이블',10);
  for(const m of text.matchAll(/\bimport\s+(?:static\s+)?([\w.]+)/g))ref(m[1].split('.').pop(),'import 참조',10);
  for(const m of text.matchAll(/<cl:submission\b[^>]*\baction\s*=\s*["']([^"']+)["']/gi)) {
    ref(m[1],'Submission URL·API',15);
    for(const token of words(m[1]))ref(token,'API 경로 구성요소',6);
  }
  for(const m of text.matchAll(/<cl:listener\b[^>]*\bhandler\s*=\s*["']([^"']+)["']/gi)) {
    ref(m[1],'화면 이벤트 핸들러',12);
  }
  for(const m of text.matchAll(/<cl:(?:dataset|datamap)\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)) {
    def(m[1]);ref(m[1],'eXbuilder 데이터셋',8);
  }
  const namespace=text.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/i)?.[1];
  if(namespace){def(namespace);ref(namespace.split('.').pop(),'매퍼 인터페이스',12);}
  for(const m of text.matchAll(/<(?:select|insert|update|delete|sql|resultMap)\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)) {
    def(m[1]);if(namespace)def(`${namespace}.${m[1]}`);
  }
  // Join simple Spring class and method route annotations without executing project code.
  const classAt=text.search(/\bclass\s/);
  const prefix=classAt>=0?text.slice(0,classAt).match(/@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/)?.[1]:'';
  for(const m of text.matchAll(/@(?:Request|Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/g)) {
    def(m[1]);if(prefix&&m.index>classAt)def(prefix.replace(/\/$/,'')+'/'+m[1].replace(/^\//,''));
  }
  for(const term of definitions)ref(term,'선언·역참조',7);
  return {definitions,references:[...references.values()]};
}

async function indexProjects(projects,signal,onProgress=()=>{},options={}) {
  if(!projects.length&&!options.catalog)throw new Error('프로젝트 최상위 폴더를 먼저 등록하세요.');
  const files=options.catalog?options.catalog.map(f=>({...f})):[],warnings=[],excluded=[],postings=new Map(),seen=new Set();
  const stats={roots:options.roots||[],visitedFiles:options.catalog?.length||0,indexedFiles:0,skippedFiles:0,excludedDirectories:0,bytesRead:0};
  const note=(relative,reason)=>{stats.skippedFiles++;if(excluded.length<300)excluded.push({path:relative,reason});};
  for(const project of projects) {
    signal?.throwIfAborted();
    const root=await fs.realpath(project.path);stats.roots.push({name:project.name,path:root});
    onProgress({phase:'폴더 탐색',message:`${project.name} · 하위 폴더 탐색 시작`});
    if(!(await fs.stat(root)).isDirectory())throw new Error('소스 경로가 폴더가 아닙니다.');
    async function walk(dir) {
      signal?.throwIfAborted();
      let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{warnings.push(`${project.name}/${slash(path.relative(root,dir))}: 폴더 읽기 실패`);return;}
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      for(const entry of entries) {
        signal?.throwIfAborted();
        const absolute=path.join(dir,entry.name),relative=slash(path.relative(root,absolute));
        if(entry.isSymbolicLink()){note(relative,'심볼릭 링크 제외');continue;}
        if(entry.isDirectory()) {
          if(EXCLUDED.has(entry.name.toLowerCase())){stats.excludedDirectories++;if(excluded.length<300)excluded.push({path:relative,reason:'의존성·빌드·도구 폴더'});}
          else await walk(absolute);
        }else if(entry.isFile()) {
          stats.visitedFiles++;
          if(stats.visitedFiles%500===0){onProgress({phase:'폴더 탐색',message:`${project.name} · 파일 ${stats.visitedFiles.toLocaleString()}개 확인`});await new Promise(resolve=>setImmediate(resolve));}
          const ext=path.extname(entry.name).toLowerCase();
          if((ext&&!EXTENSIONS.has(ext))||/^\.env(?:\.|$)|^(?:credentials?|secrets?)(?:\.|$)|(?:package-lock|pnpm-lock|yarn\.lock)/i.test(entry.name)){note(relative,'바이너리·잠금·비밀설정 또는 미지원 형식');continue;}
          const identity=process.platform==='win32'?absolute.toLowerCase():absolute;
          if(seen.has(identity))continue;seen.add(identity);
          if(files.length>=LIMITS.files)throw new Error('검색 가능한 소스가 75,000개를 넘었습니다. 분석 폴더 범위를 줄여주세요.');
          files.push({absolute,root,relative,projectId:project.id,projectName:project.name});
        }
      }
    }
    await walk(root);
  }
  // 2026-10-16 김기덕: 전체 트리는 경로만 수집하고 내용 읽기는 요청별 업무 폴더로 지연한다.
  if(options.scoped)return {files,warnings,excluded,stats,scoped:true,scopeCache:new Map()};
  let postingCount=0;
  for(const [i,file] of files.entries()) {
    signal?.throwIfAborted();
    try {
      const read=await readSource(file);const clean=redact(read.text);
      const semantic=symbols(clean);file.definitions=semantic.definitions;file.references=semantic.references;
      const terms=words(clean);for(const term of words(file.relative))terms.add(term);for(const term of semantic.definitions)terms.add(term);for(const ref of semantic.references)terms.add(ref.term);
      if(terms.size>LIMITS.termsPerFile)throw new Error('파일 검색어가 30,000개를 넘음');
      if(postingCount+terms.size>LIMITS.postings)throw new Error('INDEX_LIMIT');
      for(const term of terms){if(!postings.has(term))postings.set(term,[]);postings.get(term).push(i);}
      postingCount+=terms.size;file.indexHash=read.hash;file.indexed=true;stats.indexedFiles++;stats.bytesRead+=read.bytes;
    }catch(e){if(e.message==='INDEX_LIMIT')throw new Error('소스 내용 색인이 메모리 제한에 도달했습니다. 검색 범위를 줄여주세요.');note(label(file),e.message);}
    if(i%50===0||i===files.length-1){onProgress({phase:'하위 소스 검색',message:`파일 내용 색인 · ${stats.indexedFiles.toLocaleString()}개`,current:i+1,total:files.length});await new Promise(resolve=>setImmediate(resolve));}
  }
  if(stats.skippedFiles)warnings.push(`파일 ${stats.skippedFiles}개를 제외했습니다. 검색 범위의 제외 내역을 확인하세요.`);
  return {files,postings,warnings,excluded,stats};
}

function rankedMatches(index,signals,omit=new Set()) {
  const result=new Map(),frequencyLimit=Math.max(25,Math.ceil(index.stats.indexedFiles*.05));
  for(const signal of signals) {
    const matches=index.postings.get(signal.term)||[];
    if(matches.length>frequencyLimit)continue;
    const rarity=1+Math.log(1+index.stats.indexedFiles/(1+matches.length));
    for(const id of matches) {
      if(omit.has(id))continue;
      const file=index.files[id];
      const declaration=file.definitions.has(signal.term);
      const basename=normalized(path.basename(file.relative));
      const exactName=basename===signal.term||basename.replace(/\.[^.]+$/,'')===signal.term;
      const score=signal.weight*rarity*(exactName?2.5:declaration?1.7:1);
      if(!result.has(id))result.set(id,{id,score:0,hits:[]});
      const row=result.get(id);row.score+=score;row.hits.push({term:signal.term,kind:signal.kind,score});
    }
  }
  return [...result.values()].sort((a,b)=>b.score-a.score||label(index.files[a.id]).localeCompare(label(index.files[b.id])));
}

async function buildContext(request,index,signal,onProgress=()=>{}) {
  // 2026-10-16 김기덕: 화면 코드에 해당하는 업무 폴더와 명시적 참조만 색인한다.
  if(index.scoped)return buildScopedContext(request,index,signal,onProgress);
  const warnings=[...index.warnings],trace=[],chosen=new Map(),expanded=new Set(),candidates=[];
  let target='요청내용 기반 검색', reqInfo=null;
  try{
    reqInfo=parseRequestId(request.id);
    target=requestPath(request.id);
  }catch(e){warnings.push(e.message+' 요청내용으로 하위 소스를 검색합니다.');}
  const screenId=reqInfo?.screenId?.toLowerCase()||'';
  const relBase=reqInfo?.relative?.toLowerCase()||'';
  const query=[...words(`${request.title||''}\n${request.text||''}\n${target}\n${reqInfo?.screenId||''}`)].map(term=>({term,kind:'요청내용 검색',weight:/\d|[./_]/.test(term)?12:5}));
  const exact=index.files.map((f,id)=>({f,id})).filter(({f})=>f.indexed&&(normalized(f.relative)===normalized(target)||normalized(f.relative).endsWith('/'+normalized(target))||(relBase&&(normalized(f.relative)===relBase+'.clx'||normalized(f.relative).endsWith('/'+relBase+'.clx')))));
  const primary=exact.length?exact:index.files.map((f,id)=>({f,id})).filter(({f})=>f.indexed&&(normalized(path.basename(f.relative))===normalized(path.basename(target))||(screenId&&(normalized(path.basename(f.relative))===screenId+'.clx'||normalized(path.basename(f.relative))===screenId+'.xfdl'))));
  if(primary.length>1){warnings.push('기준 파일 후보가 여러 개여서 후보를 함께 분석합니다. 실제 배포 경로와 호출 관계를 확인해야 합니다.');candidates.push(...primary.map(({f})=>label(f)));}
  if(!exact.length&&primary.length)warnings.push('전체 경로가 일치하지 않아 파일명 후보를 포함했습니다.');
  if(!primary.length)warnings.push('요청ID 파일을 찾지 못해 하위 소스 내용의 일치 항목으로 분석을 시작합니다.');
  function select(id,reason,depth,hits,from) {
    if(chosen.has(id))return;
    chosen.set(id,{id,reason,depth,hits});
    trace.push({from:from||'요청내용 / 요청ID',to:label(index.files[id]),depth,terms:hits.map(h=>h.term).slice(0,8),reason});
  }
  for(const {id} of primary.slice(0,8))select(id,'요청ID 경로·파일명 후보',0,[{term:normalized(path.basename(target))}]);
  if(primary.length>8)warnings.push(`기준 후보 ${primary.length}개 중 8개만 탐색을 시작합니다. 폴더 범위를 좁혀주세요.`);
  if(screenId){
    const screenRelated=index.files.map((f,id)=>({f,id})).filter(({f})=>{
      if(!f.indexed)return false;
      const ext=path.extname(f.relative).toLowerCase();
      if(!['.clx','.js','.ts','.java','.sql','.xml'].includes(ext))return false;
      const b=normalized(path.basename(f.relative)).replace(/\.[^.]+$/,'');
      return b===screenId||b.startsWith(screenId+'_')||b.startsWith(screenId+'controller')||b.startsWith(screenId+'service')||b.startsWith(screenId+'mapper')||b.startsWith(screenId+'dao');
    });
    for(const {id,f} of screenRelated.slice(0,8)){
      const ext=path.extname(f.relative).toLowerCase();
      const reason=ext==='.clx'?'화면 정의 (.clx)':ext==='.js'||ext==='.ts'?'화면 스크립트 (.js)':ext==='.java'?'백엔드 (.java)':ext==='.sql'||ext==='.xml'?'매퍼·SQL (.xml/.sql)':'화면 관련 소스';
      select(id,reason,0,[{term:screenId}]);
    }
  }
  const seeds=rankedMatches(index,query,new Set(chosen.keys()));
  for(const hit of seeds.slice(0,8))select(hit.id,`하위 파일 내용 일치: ${hit.hits.sort((a,b)=>b.score-a.score).slice(0,3).map(h=>h.term).join(', ')}`,0,hit.hits);
  let depth=0,omitted=0;
  for(depth=0;depth<LIMITS.depth;depth++) {
    const frontier=[...chosen.values()].filter(c=>c.depth===depth&&!expanded.has(c.id));if(!frontier.length)break;
    const next=new Map();
    for(const parent of frontier) {
      signal?.throwIfAborted();expanded.add(parent.id);
      const file=index.files[parent.id];
      for(const hit of rankedMatches(index,file.references,new Set(chosen.keys())).slice(0,12)) {
        if(!next.has(hit.id)||next.get(hit.id).score<hit.score)next.set(hit.id,{...hit,from:label(file)});
      }
    }
    const ordered=[...next.values()].sort((a,b)=>b.score-a.score||a.id-b.id);
    for(const hit of ordered) {
      if(chosen.size>=LIMITS.contextFiles){omitted++;continue;}
      const top=hit.hits.sort((a,b)=>b.score-a.score).slice(0,5);
      select(hit.id,`${top[0].kind}: ${top.map(h=>h.term).join(', ')}`,depth+1,top,hit.from);
    }
    onProgress({phase:'관련 코드 추적',message:`${depth+1}단계 · 관련 파일 ${chosen.size}개`});
    await new Promise(resolve=>setImmediate(resolve));
    if(chosen.size>=LIMITS.contextFiles)break;
  }
  if([...chosen.values()].some(c=>c.depth===LIMITS.depth))warnings.push(`참조 탐색을 최대 ${LIMITS.depth}단계에서 종료했습니다. 더 깊은 연결은 검토가 필요합니다.`);
  if(chosen.size>=LIMITS.contextFiles)warnings.push(`관련 소스 ${LIMITS.contextFiles}개에 도달해 추가 참조 탐색을 종료했습니다.`);
  if(omitted)warnings.push(`관련 후보 ${omitted}개가 ${LIMITS.contextFiles}개 파일 제한으로 제외되었습니다.`);
  const files=[];let remaining=LIMITS.contextChars;
  for(const choice of chosen.values()) {
    signal?.throwIfAborted();
    if(remaining<500){omitted++;continue;}
    const file=index.files[choice.id];
    try {
      const read=await readSource(file);
      if(read.hash!==file.indexHash)throw new Error('내용 색인 이후 변경됨: 다시 소스 검색을 실행하세요.');
      const budget=Math.min(22000,Math.max(3500,Math.floor(remaining/(chosen.size-files.length))),remaining);
      const needles=[...choice.hits.map(h=>h.term),...query.map(q=>q.term),...file.references.filter(r=>r.weight>=10).map(r=>r.term)];
      const snippet=excerpts(read.text,needles,budget);remaining-=snippet.content.length;
      if(!snippet.content)throw new Error('전송 가능한 소스 발췌가 없음');
      files.push({absolute:file.absolute,root:file.root,relative:file.relative,projectId:file.projectId,projectName:file.projectName,...snippet,reason:choice.reason,depth:choice.depth,hash:read.hash});
    }catch(e){warnings.push(`${label(file)}: ${e.message}`);}
  }
  const fileNames=new Set(files.map(label));
  const search={...index.stats,relatedFiles:chosen.size,selectedFiles:files.length,omittedFiles:Math.max(omitted,chosen.size-files.length),maxDepth:LIMITS.depth,terms:query.map(q=>q.term).slice(0,100),excluded:index.excluded,trace:trace.filter(t=>fileNames.has(t.to))};
  if(!files.length)warnings.push('요청과 연결되는 소스 내용을 찾지 못했습니다. 프로젝트 폴더와 요청 설명을 확인하세요.');
  return {target,files,warnings,candidates,search,blocked:!files.length,hash:digest(JSON.stringify(['recursive-content-v2',files.map(f=>[f.absolute,f.hash,f.content])]))};
}
// 2026-10-16 김기덕: ECC0101 → EC/ECC 경로를 계산하고 검색 범위 확대 이유를 기록한다.
function scopeFor(request){
  let target='';try{target=normalized(requestPath(request.id));}catch{}
  const code=path.posix.basename(target).match(/^([a-z]{2,})\d/i)?.[1]||'';
  const folder=target.split('/').slice(0,-1).join('/')||(code?`${code.slice(0,2)}/${code}`:'');
  return {target,code,business:code.slice(0,2),folder};
}
async function buildScopedContext(request,catalog,signal,onProgress){
  const scope=scopeFor(request),selected=new Map(),stages=[];
  const add=file=>selected.set(file.absolute,file);
  const inFolder=(file,folder)=>!!folder&&`/${normalized(slash(path.join(file.root,file.relative)))}/`.includes(`/${folder}/`);
  for(const file of catalog.files)if(inFolder(file,scope.folder)||scope.code&&inFolder(file,`${scope.business}/${scope.code}`))add(file);
  stages.push({stage:'업무 폴더',scope:scope.folder||scope.code||'경로 미확인',files:selected.size});
  // 2026-10-21 김기덕: 첨부 크기·표시 요청은 업무 밖의 공통 파일 UDC·유틸리티도 제한적으로 검색한다.
  if(/첨부|파일|용량|크기|사이즈|\b(?:kb|mb|gb|bytes?)\b|file\s*size|upload|download/i.test(request.text||'')){
    const shared=catalog.files.filter(f=>/\/(?:udc|module|common|shared)\//i.test('/'+slash(f.relative))&&/file|attach|atch|upload|download/i.test(path.basename(f.relative))).slice(0,100);
    for(const file of shared)add(file);
    if(shared.length)stages.push({stage:'첨부 공통 소스',scope:'파일 관련 공통 UDC·모듈',files:selected.size});
  }
  const names=words(`${scope.target}\n${request.text||''}`);
  for(const file of catalog.files){const base=normalized(path.basename(file.relative));if(names.has(base)||names.has(base.replace(/\.[^.]+$/,'')))add(file);}
  if(!selected.size&&scope.business){
    for(const file of catalog.files)if(inFolder(file,scope.business))add(file);
    stages.push({stage:'상위 업무 폴더로 확대',scope:scope.business,files:selected.size});
  }
  if(!selected.size){
    for(const file of catalog.files)add(file);
    stages.push({stage:'업무 경로 미발견으로 전체 범위 사용',scope:'등록 폴더',files:selected.size});
  }
  let subset;
  for(let depth=0;depth<=LIMITS.depth;depth++){
    signal?.throwIfAborted();
    const key=[...selected.keys()].sort().join('\n');
    subset=catalog.scopeCache.get(key);
    if(!subset){
      onProgress({phase:'업무 소스 색인',message:`${scope.folder||scope.code||'후보 경로'} · 내용 확인 ${selected.size}개 / 전체 경로 ${catalog.files.length}개`});
      subset=await indexProjects([],signal,onProgress,{catalog:[...selected.values()],roots:catalog.stats.roots});
      catalog.scopeCache.set(key,subset);
    }
    if(depth===LIMITS.depth)break;
    // 2026-10-16 김기덕: 업무 폴더 전체의 참조가 아니라 요청 관련 파일에서만 범위를 확장한다.
    const currentContext=await buildContext(request,subset,signal,onProgress);
    const related=new Set(currentContext.files.map(file=>file.absolute));
    const references=new Set(subset.files.filter(file=>related.has(file.absolute)).flatMap(file=>(file.references||[]).filter(r=>r.weight>=10).map(r=>r.term)));
    const referenceNames=new Set([...references].map(ref=>path.posix.basename(ref)));
    const before=selected.size;
    for(const file of catalog.files){
      const base=normalized(path.basename(file.relative)),stem=base.replace(/\.[^.]+$/,'');
      if(referenceNames.has(base)||referenceNames.has(stem)||references.has(normalized(file.relative)))add(file);
    }
    if(selected.size===before)break;
    stages.push({stage:'명시적 파일·클래스 참조 추가',scope:`${depth+1}단계`,files:selected.size});
  }
  const result=await buildContext(request,subset,signal,onProgress);
  result.search.catalogFiles=catalog.files.length;
  result.search.scope={folder:scope.folder,code:scope.code,stages};
  result.warnings.push(...catalog.warnings);
  result.warnings.push('업무 범위와 명시적 파일·클래스 참조만 검색했습니다. 범위 밖의 동적 API·함수·SQL 연결은 추가 확인이 필요합니다.');
  if(stages.some(s=>s.stage.includes('전체 범위')))result.warnings.push('요청 업무 폴더를 찾지 못해 전체 소스 내용 검색으로 확대했습니다.');
  return result;
}
module.exports={indexProjects,buildContext,words,symbols,LIMITS,scopeFor};
