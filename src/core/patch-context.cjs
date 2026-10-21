// 2026-10-21 김기덕: AI가 지목한 파일은 발췌 누락을 해소하도록 우선 확대한다. 카탈로그 밖은 읽지 않는다.
const path=require('node:path');
const {readSource,excerpts,digest}=require('./files.cjs');
async function expandPatchContext(context,index,hints,signal){
 const names=new Set((hints||[]).join('\n').match(/[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:clx|xfdl|js|xjs|java|xml|sql)\b/gi)?.map(s=>s.toLowerCase())||[]);
 if(!names.size)return context;
 const candidates=index.files.filter(f=>names.has(path.basename(f.relative).toLowerCase())).sort((a,b)=>Number(!context.files.some(f=>f.absolute===a.absolute))-Number(!context.files.some(f=>f.absolute===b.absolute))).slice(0,4);
 const expanded=[];
 for(const file of candidates){
  signal?.throwIfAborted();const read=await readSource(file),old=context.files.find(f=>f.absolute===file.absolute);
  if(old&&old.hash!==read.hash)throw Error('추가 검색 중 소스가 변경됐습니다. 다시 분석하세요.');
  const snippet=excerpts(read.text,(hints||[]).join(' ').match(/[A-Za-z_][A-Za-z0-9_]*|[가-힣]{2,}/g)||[],60000);
  expanded.push({...file,...snippet,hash:read.hash,reason:'수정 위치 확인을 위한 확대 소스'});
 }
 if(!expanded.length)return context;
 let remaining=240000;const files=[];
 for(const file of [...expanded,...context.files.filter(f=>!expanded.some(e=>e.absolute===f.absolute))]){if(file.content.length>remaining)continue;files.push(file);remaining-=file.content.length;}
 return {...context,files,search:context.search?{...context.search,selectedFiles:files.length}:undefined,warnings:[...context.warnings,`수정 위치 확인을 위해 ${expanded.length}개 파일의 발췌 범위를 확대했습니다.`],hash:digest(JSON.stringify(files.map(f=>[f.absolute,f.hash,f.content])))};
}
module.exports={expandPatchContext};
