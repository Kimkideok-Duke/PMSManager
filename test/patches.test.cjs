// 2026-10-21 김기덕: 실제 임시 소스로 수정안 검증·인코딩·백업·변경 충돌·원복을 검증한다.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {applyChanges,validateChanges}=require('../src/core/patches.cjs'),{digest}=require('../src/core/files.cjs'),{parseReport}=require('../src/core/ai.cjs');
const date='2026-10-21';
async function fixture(t,encode=s=>Buffer.from(s)){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pms-patch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original='const size = value;\r\nsave(size);\r\n',bytes=encode(original);await fs.writeFile(path.join(root,'a.js'),bytes);
 const file={projectId:'p',projectName:'P',relative:'a.js',hash:digest(bytes),content:'1: const size = value;\n2: save(size);\n3: ',lineNumbers:[1,2,3]};
 const change={path:'P/a.js',startLine:1,endLine:1,before:'const size = value;',after:'const size = value / 1024;',reason:'B를 KB로 표시'};
 return {root,original,bytes,file,change,args:{changes:[change],context:{files:[file]},projects:[{id:'p',enabled:true,path:root}],backupRoot:path.join(root,'backups'),requestId:'REQ-a.xfdl1',date}};
}
test('수정안 파싱은 정확한 파일·연속 줄·변경 전 코드만 검증한다',async t=>{
 const f=await fixture(t);assert.equal(validateChanges([f.change],f.args.context)[0].verified,true);
 for(const delta of [{path:'P/invented.js'},{startLine:999},{before:'다른 코드'},{after:f.change.before}])assert.equal(validateChanges([{...f.change,...delta}],f.args.context)[0].verified,false);
 const parsed=parseReport(JSON.stringify({summary:'첨부 크기',causes:[],changes:[f.change]}),f.args.context);assert.equal(parsed.changes[0].verified,true);
 const gap={...f.file,lineNumbers:[1,3]};assert.equal(validateChanges([{...f.change,endLine:2,before:'const size = value;\nsave(size);'}],{files:[gap]})[0].verified,false);
});
test('적용 시 CRLF와 UTF-8 BOM을 유지하고 원본과 감사 기록을 백업한다',async t=>{
 const f=await fixture(t,s=>Buffer.concat([Buffer.from([239,187,191]),Buffer.from(s)]));const result=await applyChanges(f.args);
 const bytes=await fs.readFile(path.join(f.root,'a.js'));assert.ok(bytes.subarray(0,3).equals(Buffer.from([239,187,191])));assert.ok(bytes.toString().includes('const size = value / 1024;\r\nsave(size);'));
 assert.ok((await fs.readFile(path.join(result.backupDirectory,'0.original'))).equals(f.bytes));const manifest=JSON.parse(await fs.readFile(path.join(result.backupDirectory,'manifest.json')));assert.equal(manifest.status,'applied');
 await assert.rejects(()=>applyChanges(f.args),/분석 후 소스가 변경/);
});
test('UTF-16 LE 및 BE 파일의 인코딩과 BOM을 유지한다',async t=>{
 for(const be of [false,true]){const f=await fixture(t,s=>{let b=Buffer.from(s,'utf16le');return Buffer.concat([Buffer.from(be?[254,255]:[255,254]),be?b.swap16():b]);});await applyChanges(f.args);let bytes=await fs.readFile(path.join(f.root,'a.js'));assert.deepEqual([...bytes.subarray(0,2)],be?[254,255]:[255,254]);let body=Buffer.from(bytes.subarray(2));assert.match((be?body.swap16():body).toString('utf16le'),/value \/ 1024/);}
});
test('등록 폴더 밖 경로·비활성 프로젝트·변경된 해시·비밀값은 차단한다',async t=>{
 const f=await fixture(t);await assert.rejects(()=>applyChanges({...f.args,projects:[{id:'p',enabled:false,path:f.root}]}),/프로젝트 폴더/);
 const file={...f.file,relative:'../outside.js'};await assert.rejects(()=>applyChanges({...f.args,context:{files:[file]},changes:[{...f.change,path:'P/../outside.js'}]}),/폴더 밖/);
 await fs.writeFile(path.join(f.root,'a.js'),'사용자 편집');await assert.rejects(()=>applyChanges(f.args),/분석 후 소스가 변경/);assert.equal(await fs.readFile(path.join(f.root,'a.js'),'utf8'),'사용자 편집');
 const secret={...f.change,after:'const password="private";'};assert.equal(validateChanges([secret],f.args.context)[0].verified,false);
});
test('겹치는 수정은 적용 전에 거절한다',async t=>{
 const f=await fixture(t);await assert.rejects(()=>applyChanges({...f.args,changes:[f.change,f.change]}),/겹칩니다/);assert.ok((await fs.readFile(path.join(f.root,'a.js'))).equals(f.bytes));
});
test('여러 파일 저장 중 실패하면 이미 변경한 파일을 원복한다',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'b.js'),f.bytes);const b={...f.file,relative:'b.js'};let count=0;
 await assert.rejects(()=>applyChanges({...f.args,context:{files:[f.file,b]},changes:[f.change,{...f.change,path:'P/b.js'}],writeFile:async(...args)=>{if(++count===2)throw Error('디스크 오류');return fs.writeFile(...args);}}),/변경은 원복/);
 assert.ok((await fs.readFile(path.join(f.root,'a.js'))).equals(f.bytes));assert.ok((await fs.readFile(path.join(f.root,'b.js'))).equals(f.bytes));
});
test('저장 도중 사용자가 바꾼 파일을 덮어쓰지 않는다',async t=>{
 const f=await fixture(t);await assert.rejects(()=>applyChanges({...f.args,writeFile:async(...args)=>{await fs.writeFile(path.join(f.root,'a.js'),'동시 사용자 수정');return fs.writeFile(...args);}}),/저장 중 소스/);assert.equal(await fs.readFile(path.join(f.root,'a.js'),'utf8'),'동시 사용자 수정');
});
test('적용 중 취소되면 새 코드가 남지 않는다',async t=>{
 const f=await fixture(t),controller=new AbortController();await assert.rejects(()=>applyChanges({...f.args,signal:controller.signal,writeFile:async(...args)=>{await fs.writeFile(...args);controller.abort(Error('취소'));}}),/취소/);assert.ok((await fs.readFile(path.join(f.root,'a.js'))).equals(f.bytes));
});
test('잘못된 JS 문법은 실행하거나 저장하지 않는다',async t=>{
 const f=await fixture(t);await assert.rejects(()=>applyChanges({...f.args,changes:[{...f.change,after:'const size = ;'}]}),/JavaScript 문법/);assert.ok((await fs.readFile(path.join(f.root,'a.js'))).equals(f.bytes));
});

test('이름·날짜·새 주석 없이 수정하며 적용일이 달라도 허용한다',async t=>{
 const f=await fixture(t);await applyChanges({...f.args,date:'2026-10-22'});
 assert.equal(await fs.readFile(path.join(f.root,'a.js'),'utf8'),'const size = value / 1024;\r\nsave(size);\r\n');
});

test('예전 작성자 주석을 새로 추가하는 저장된 수정안은 재분석을 요구한다',async t=>{
 const f=await fixture(t);
 for(const [prefix,suffix] of [['//',''],['<!--',' -->'],['/*',' */'],['#',''],['--','']]){
  const change={...f.change,after:`${prefix} ${date} 김기덕: KB 환산${suffix}\nconst size = value / 1024;`};
  assert.match(validateChanges([change],f.args.context)[0].problem,/다시 분석/);
  await assert.rejects(()=>applyChanges({...f.args,changes:[change]}),/다시 분석/);
 }
 assert.ok((await fs.readFile(path.join(f.root,'a.js'))).equals(f.bytes));
});

test('수정 범위에 이미 있던 주석은 삭제하거나 거절하지 않는다',async t=>{
 const f=await fixture(t),original=`// ${date} 김기덕: 기존 설명\r\nconst size = value;\r\nsave(size);\r\n`;
 const bytes=Buffer.from(original);await fs.writeFile(path.join(f.root,'a.js'),bytes);
 const file={...f.file,hash:digest(bytes),content:`1: // ${date} 김기덕: 기존 설명\n2: const size = value;\n3: save(size);\n4: `,lineNumbers:[1,2,3,4]};
 const change={...f.change,endLine:2,before:`// ${date} 김기덕: 기존 설명\nconst size = value;`,after:`// ${date} 김기덕: 기존 설명\nconst size = value / 1024;`};
 await applyChanges({...f.args,context:{files:[file]},changes:[change]});
 assert.equal(await fs.readFile(path.join(f.root,'a.js'),'utf8'),original.replace('value;','value / 1024;'));
});
