// 2026-10-21 김기덕: AI 수정안을 소스 발췌·원본 해시로 검증하고 백업 후에만 적용한다.
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),vm=require('node:vm');
const {digest,redact}=require('./files.cjs');
const normal=s=>s.replace(/\r\n/g,'\n');
function validateChanges(changes,context){
 return (Array.isArray(changes)?changes:[]).slice(0,12).map((c,index)=>{
  const value={id:String(index),path:String(c?.path||''),startLine:c?.startLine,endLine:c?.endLine,before:typeof c?.before==='string'?normal(c.before):'',after:typeof c?.after==='string'?normal(c.after):'',reason:typeof c?.reason==='string'?c.reason:''};
  const file=context.files.find(f=>`${f.projectName}/${f.relative}`===value.path),lines=new Map((file?.content||'').split('\n').map(line=>{const m=/^(\d+): (.*)$/.exec(line);return m?[Number(m[1]),m[2]]:[-1,''];}));
  let problem='';
  if(!file)problem='제공된 소스에 없는 파일입니다.';
  else if(!Number.isInteger(value.startLine)||!Number.isInteger(value.endLine)||value.startLine<1||value.endLine<value.startLine||value.endLine-value.startLine>600)problem='수정 줄 범위가 올바르지 않습니다.';
  else if(!value.before||value.before.length>60000||value.after.length>60000||value.before===value.after)problem='변경 전·후 코드가 없거나 동일합니다.';
  else {
   const numbers=Array.from({length:value.endLine-value.startLine+1},(_,i)=>value.startLine+i);
   if(numbers.some(n=>!file.lineNumbers.includes(n)||!lines.has(n)))problem='수정 범위 전체가 소스 발췌에 포함되지 않았습니다.';
   else if(numbers.map(n=>lines.get(n)).join('\n')!==value.before)problem='변경 전 코드가 제공된 소스 줄과 일치하지 않습니다.';
   else if(redact(value.before)!==value.before||redact(value.after)!==value.after||/\[REDACTED\]/.test(value.before+value.after))problem='비밀값이 포함되거나 가려진 코드는 자동 수정할 수 없습니다.';
   else if(value.after.split('\n').some(line=>/^\s*(?:\/\/|\/\*|\*|<!--|#|--).*\d{4}-\d{2}-\d{2}\s+김기덕/.test(line)&&!value.before.split('\n').some(original=>original.trim()===line.trim())))problem='예전 작성자 주석이 포함된 수정안입니다. 다시 분석해 주석 없는 수정안을 생성하세요.';
  }
  return {...value,verified:!problem,problem,sourceHash:file?.hash,projectId:file?.projectId,relative:file?.relative};
 });
}
function decode(bytes){
 if(bytes[0]===255&&bytes[1]===254)return {text:bytes.subarray(2).toString('utf16le'),encoding:'utf16le',bom:bytes.subarray(0,2)};
 if(bytes[0]===254&&bytes[1]===255)return {text:Buffer.from(bytes.subarray(2)).swap16().toString('utf16le'),encoding:'utf16be',bom:bytes.subarray(0,2)};
 const bom=bytes.subarray(0,3).equals(Buffer.from([239,187,191]))?bytes.subarray(0,3):Buffer.alloc(0);
 try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(bom.length)),encoding:'utf8',bom};}catch{throw Error('UTF-8/UTF-16 이외 인코딩은 변환 손실을 막기 위해 자동 적용하지 않습니다.');}
}
function encode(text,format){let bytes=Buffer.from(text,format.encoding==='utf8'?'utf8':'utf16le');if(format.encoding==='utf16be')bytes=bytes.swap16();return Buffer.concat([format.bom,bytes]);}
function inside(root,file){const rel=path.relative(root,file);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}
async function applyChanges({changes,context,projects,backupRoot,requestId,date,signal,writeFile=fs.writeFile}){
 signal?.throwIfAborted();
 const checked=validateChanges(changes,context);if(!checked.length||checked.some(c=>!c.verified))throw Error(checked.find(c=>!c.verified)?.problem||'적용 가능한 코드 수정안이 없습니다.');
 const groups=new Map();for(const c of checked){if(!groups.has(c.path))groups.set(c.path,[]);groups.get(c.path).push(c);}
 const plans=[];
 for(const [label,items] of groups){
  signal?.throwIfAborted();
  const file=context.files.find(f=>`${f.projectName}/${f.relative}`===label),project=projects.find(p=>p.enabled&&p.id===file.projectId);
  if(!project||!file.relative||path.isAbsolute(file.relative))throw Error('분석 당시 등록한 프로젝트 폴더가 없습니다. 다시 분석하세요.');
  const root=await fs.realpath(project.path),target=path.resolve(root,file.relative);
  if(!inside(root,target)||await fs.realpath(target)!==target||(await fs.lstat(target)).isSymbolicLink())throw Error('폴더 밖 경로 또는 링크 파일은 수정하지 않습니다.');
  const stat=await fs.stat(target);if(!stat.isFile()||stat.size>4*1024*1024)throw Error('일반 소스 파일만 수정할 수 있습니다.');
  const bytes=await fs.readFile(target);if(digest(bytes)!==file.hash)throw Error('분석 후 소스가 변경됐습니다. 다시 분석한 뒤 적용하세요.');
  const format=decode(bytes);if(format.text.includes('\0'))throw Error('바이너리 파일은 수정할 수 없습니다.');
  const newline=format.text.includes('\r\n')?'\r\n':'\n',lines=normal(format.text).split('\n');let previous=Infinity;
  for(const c of items.sort((a,b)=>b.startLine-a.startLine)){
   if(c.endLine>=previous)throw Error('수정 범위가 겹칩니다. 수정안을 다시 생성하세요.');previous=c.startLine;
   if(lines.slice(c.startLine-1,c.endLine).join('\n')!==c.before)throw Error('현재 코드와 변경 전 코드가 다릅니다.');
   lines.splice(c.startLine-1,c.endLine-c.startLine+1,...c.after.split('\n'));
  }
  const nextText=lines.join(newline);
  // 2026-10-21 김기덕: 일반 JS 문법은 실행 없이 검사한다. XML·프로젝트 빌드는 별도 검증 대상이다.
  if(/\.(?:js|cjs|xjs)$/i.test(target)&&!/^\s*(?:import|export)\s/m.test(nextText)){try{new vm.Script(nextText,{filename:target});}catch{throw Error('변경 후 JavaScript 문법 오류입니다. 적용하지 않았습니다.');}}
  plans.push({label,target,bytes,after:encode(nextText,format),mode:stat.mode,items});
 }
 const directory=path.join(backupRoot,date+'-'+randomUUID());await fs.mkdir(directory,{recursive:true});
 const manifest={requestId,createdAt:new Date().toISOString(),status:'prepared',files:plans.map((p,i)=>({path:p.target,backup:i+'.original',beforeHash:digest(p.bytes),afterHash:digest(p.after)}))};
 for(const [i,p] of plans.entries())await fs.writeFile(path.join(directory,i+'.original'),p.bytes,{flag:'wx'});
 const manifestPath=path.join(directory,'manifest.json');await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
 const written=[];
 try{
  for(const p of plans){
   signal?.throwIfAborted();
   if(await fs.realpath(p.target)!==p.target||digest(await fs.readFile(p.target))!==digest(p.bytes))throw Error('적용 직전 소스가 변경되어 중단했습니다.');
   const temporary=p.target+'.pms-'+randomUUID()+'.tmp';
   try{await writeFile(temporary,p.after,{flag:'wx',mode:p.mode});signal?.throwIfAborted();if(await fs.realpath(p.target)!==p.target||digest(await fs.readFile(p.target))!==digest(p.bytes))throw Error('저장 중 소스가 변경됐습니다.');await fs.rename(temporary,p.target);written.push(p);}finally{await fs.unlink(temporary).catch(()=>{});}
  }
  signal?.throwIfAborted();
  manifest.status='applied';await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
  return {backupDirectory:directory,appliedAt:new Date().toISOString(),files:plans.map(p=>({path:p.label,lines:p.items.map(c=>[c.startLine,c.endLine]),hash:digest(p.after)}))};
 }catch(error){
  const conflicts=[];for(const p of written.reverse()){try{if(digest(await fs.readFile(p.target))!==digest(p.after))throw Error();await fs.writeFile(p.target,p.bytes);}catch{conflicts.push(p.target);}}
  manifest.status=conflicts.length?'rollback-conflict':'rolled-back';manifest.conflicts=conflicts;await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)).catch(()=>{});
  throw Error(`${error.message} ${conflicts.length?'일부 파일의 추가 변경으로 원복하지 못했습니다.':'이 작업의 변경은 원복했습니다.'} 백업: ${directory}`);
 }
}
module.exports={validateChanges,applyChanges};
