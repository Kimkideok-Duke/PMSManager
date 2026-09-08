const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {indexProjects,buildContext,excerpts}=require('../src/core/source.cjs');

async function project(t,content){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'icms-search-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [file,text] of Object.entries(content)){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),text);}
  return {root,config:[{id:'icms',name:'icms',path:root}]};
}
test('icms 최상위 선택 후 깊은 화면 → 다른 이름 컨트롤러 → 함수 → 매퍼 → SQL을 내용으로 추적한다',async t=>{
  const data={
    'client/projects/bid/forms/ec/ecg/ECG0502.xfdl':`this.transaction("commitBid", "svc::/procurement/commit", "dsBid=dsBid:U", "");`,
    'server/src/main/java/web/ProcurementEndpoint.java':`@RequestMapping("/procurement")\npublic class ProcurementEndpoint {\n@PostMapping("/commit")\npublic void receive() { bidFacade.storeBids(); }\n}`,
    'server/src/main/java/business/DecisionCoordinator.java':`public class DecisionCoordinator { public void storeBids() { rules.validateAllocations(); persistence.flushDrafts(); } }`,
    'server/src/main/java/rules/AllocationChecks.java':`public class AllocationChecks { public void validateAllocations() { throw new Error("납품 계획수량 합계가 올바르지 않습니다"); } }`,
    'server/src/main/java/persistence/Writes.java':`public class Writes { public void flushDrafts() { dao.update("BudgetMapper.applyAmounts", params); } }`,
    'server/src/main/resources/mappers/DifferentFileName.xml':`<mapper namespace="BudgetMapper"><update id="applyAmounts">UPDATE PROCUREMENT_PLAN SET PLAN_QTY = #{planQty}</update></mapper>`,
    'database/deep/migrations/20260123.sql':`CREATE TABLE PROCUREMENT_PLAN (PLAN_QTY DECIMAL(10,2));`,
    'unrelated/Nothing.java':`public class Nothing { public void save() { return; } }`
  };
  const {config}=await project(t,data),events=[];
  const index=await indexProjects(config,null,event=>events.push(event));
  const context=await buildContext({id:'REQ-ec/ecg/ECG0502.xfdl36',title:'입찰상세',text:'행을 삭제한 후 저장되지 않습니다.'},index);
  const found=context.files.map(f=>f.relative);
  for(const file of Object.keys(data).filter(f=>!f.startsWith('unrelated')))assert.ok(found.includes(file),`Missing ${file}: ${JSON.stringify(context.search.trace)}`);
  assert.ok(!found.includes('unrelated/Nothing.java'));
  assert.equal(context.search.indexedFiles,8);assert.ok(events.length);assert.ok(context.search.trace.some(t=>t.depth>=2));
  assert.ok(context.search.trace.some(t=>t.terms.includes('budgetmapper.applyamounts')));
});
test('XFDL이 없더라도 요청에 있는 오류 문자열을 모든 하위 파일 내용에서 검색한다',async t=>{
  const {config}=await project(t,{'backend/nested/validators/OrdinaryName.py':'def validate_quantity():\n    raise ValueError("납품수량검증실패")','other/random.ts':'const unrelated = 42;'});
  const index=await indexProjects(config);const context=await buildContext({id:'REQ-ui/NotHere.xfdl1',text:'납품수량검증실패 메시지가 발생합니다.'},index);
  assert.equal(context.blocked,false);assert.ok(context.files.some(f=>f.relative.endsWith('OrdinaryName.py')));assert.match(context.warnings.join(' '),/파일을 찾지 못해/);
});
test('프런트엔드 프로젝트 밖의 형제 서버 폴더도 명시적으로 함께 선택했을 때 검색한다',async t=>{
  const {root}=await project(t,{'frontend/deep/Main.xfdl':'this.submitTicket();','backend/java/Handler.java':'public void submitTicket() { System.out.println("x"); }'});
  const configs=[{id:'front',name:'front',path:path.join(root,'frontend')},{id:'back',name:'back',path:path.join(root,'backend')}];
  const one=await buildContext({id:'REQ-deep/Main.xfdl1',text:''},await indexProjects(configs.slice(0,1)));
  assert.equal(one.files.length,1);
  const both=await buildContext({id:'REQ-deep/Main.xfdl1',text:''},await indexProjects(configs));assert.equal(both.files.length,2);
});
test('검색 과정에서 코드 실행 없이 텍스트만 읽고 바이너리·제외 폴더를 공개한다',async t=>{
  const {root,config}=await project(t,{'src/a.ts':'throw new Error("distinctFailure");','node_modules/skip.ts':'distinctFailure','assets/binary.dat':Buffer.from([0,1,2]),'src/binary.txt':Buffer.from([0,1,2]),'src/PasswordValidator.java':'class PasswordValidator { void distinctFailure() {} }','.support/nested/readme.md':'distinctFailure'});
  const index=await indexProjects([...config,{id:'nested',name:'overlap',path:path.join(root,'src')}]);
  assert.equal(index.stats.indexedFiles,3);assert.equal(index.stats.excludedDirectories,1);assert.ok(index.stats.skippedFiles>=2);
  assert.ok(index.files.some(f=>f.relative==='src/PasswordValidator.java'&&f.indexed));
  assert.ok(index.excluded.some(e=>e.path.includes('binary.txt')));
});
test('긴 소스 후반부의 관련 함수와 오류 줄을 발췌 우선순위로 보존한다',()=>{
  const text=Array.from({length:1500},(_,i)=>i===1400?'function validateRemainingQuantity() { throw new Error("distinctFailure"); }':`// boilerplate line ${i}`).join('\n');
  const result=excerpts(text,['validateRemainingQuantity','distinctFailure'],2500);assert.ok(result.lineNumbers.includes(1401));assert.ok(result.content.includes('distinctFailure'));assert.equal(result.truncated,true);
});
test('소스가 색인 이후 변경되면 오래된 검색 결과를 새 내용으로 바꿔 보내지 않는다',async t=>{
  const {root,config}=await project(t,{'ui/Screen.xfdl':'original'});const index=await indexProjects(config);await fs.writeFile(path.join(root,'ui/Screen.xfdl'),'changed');
  const context=await buildContext({id:'REQ-ui/Screen.xfdl1',text:''},index);assert.equal(context.blocked,true);assert.match(context.warnings.join(' '),/색인 이후 변경/);
});
test('내용 색인과 검색은 중지 신호에 응답한다',async t=>{
  const {config}=await project(t,{'Screen.xfdl':'test'});const controller=new AbortController();controller.abort();await assert.rejects(()=>indexProjects(config,controller.signal),{name:'AbortError'});
});
