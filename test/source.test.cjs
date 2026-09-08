const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {requestPath,indexProjects,buildContext,redact,readSource}=require('../src/core/source.cjs');
const {Store,mergeRequests}=require('../src/core/store.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'pms-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('요청ID에서 파일 경로를 추출하고 요청 일련번호는 제외한다',()=>{
  assert.equal(requestPath('REQ-ec/ecg/ECG0502.xfdl36'),'ec/ecg/ECG0502.xfdl');
  assert.equal(requestPath('REQ-ec\\ecc\\ECC0204.xfdl118'),'ec/ecc/ECC0204.xfdl');
  for(const bad of ['REQ-../secret.xfdl1','REQ-/ec/Screen.xfdl','REQ-ec//a.xfdl','REQ-C:/x.xfdl','other'])assert.throws(()=>requestPath(bad));
});
test('요청 화면·본문 팝업·include 파일을 연결하며 행 번호와 해시를 보존한다',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'src/ec/ecg'),{recursive:true});await fs.mkdir(path.join(root,'src/ec/ecc'),{recursive:true});await fs.mkdir(path.join(root,'lib'));
  await fs.writeFile(path.join(root,'src/ec/ecg/ECG0502.xfdl'),'this.open("ECC0209_P03");\ninclude "lib::common.xjs";');
  await fs.writeFile(path.join(root,'src/ec/ecc/ECC0209_P03.xfdl'),'this.ds.addRow();\nthis.save();');await fs.writeFile(path.join(root,'lib/common.xjs'),'function save() {}');
  await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules/ignored.xfdl'),'ignored');
  const index=await indexProjects([{id:'p',name:'Project',path:root}]);assert.equal(index.files.length,3);
  const context=await buildContext({id:'REQ-ec/ecg/ECG0502.xfdl36',text:'ECC0209_P03 팝업에서 행을 삭제 후 저장'},index);
  assert.equal(context.blocked,false);assert.equal(context.files.length,3);assert.ok(context.files[0].content.startsWith('1:'));assert.equal(context.files[0].hash.length,64);
});
test('중복 기준 소스를 임의로 하나 고르지 않고 후보를 함께 검색한다',async t=>{
  const root=await fixture(t);for(const sub of ['a','b']){await fs.mkdir(path.join(root,sub));await fs.writeFile(path.join(root,sub,'Screen.xfdl'),'sample');}
  const index=await indexProjects([{id:'p',name:'Project',path:root}]);const context=await buildContext({id:'REQ-ui/Screen.xfdl12',text:''},index);assert.equal(context.blocked,false);assert.equal(context.candidates.length,2);assert.equal(context.files.length,2);assert.match(context.warnings.join(' '),/후보를 함께/);
});
test('파일명 일치만으로 연결될 때 경고하고 누락된 기준 파일은 분석을 막는다',async t=>{
  const root=await fixture(t);await fs.writeFile(path.join(root,'Screen.xfdl'),'hello');const index=await indexProjects([{id:'p',name:'Project',path:root}]);
  assert.match((await buildContext({id:'REQ-ui/Screen.xfdl1',text:''},index)).warnings.join(' '),/파일명/);
  assert.equal((await buildContext({id:'REQ-ui/Missing.xfdl1',text:''},index)).blocked,true);
});
test('폴더 밖 읽기와 민감 문자열을 차단한다',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'allowed'));await fs.writeFile(path.join(root,'outside.js'),'private');await assert.rejects(()=>readSource({absolute:path.join(root,'outside.js'),root:path.join(root,'allowed')}),/폴더 밖/);
  assert.equal(redact('password="abc"; api_key=sk-thisisalongsecretkey12345'),'password="[REDACTED]"; api_key=[REDACTED]');
});
test('재수집 중복 방지·기존 결과 보존·변경 후 오래된 분석 표시',()=>{
  const original={id:'r',text:'기존 오류',images:[],fingerprint:'v1',analysis:{requestFingerprint:'v1',report:{}},note:'검토 메모',review:'채택'};
  let rows=mergeRequests([original],[{id:'r',text:'기존 오류',images:[],fingerprint:'v1'}]);assert.equal(rows.length,1);assert.equal(rows[0].analysisStale,false);assert.equal(rows[0].note,'검토 메모');
  rows=mergeRequests(rows,[{id:'r',text:'새 오류',images:[],fingerprint:'v2'}]);assert.equal(rows[0].analysisStale,true);
  rows=mergeRequests(rows,[{id:'r',error:'상세 로딩 실패'}]);assert.equal(rows[0].analysisStale,true);assert.ok(rows[0].analysis);
});
test('동시 저장은 순서대로 반영하며 손상된 파일을 무시하지 않는다',async t=>{
  const root=await fixture(t),store=new Store(root);await Promise.all([store.write('test',{version:1}),store.write('test',{version:2})]);assert.equal((await store.read('test')).version,2);
  await fs.writeFile(path.join(root,'test.json'),'{bad');await assert.rejects(()=>store.read('test',{}),/덮어쓰지/);
});
