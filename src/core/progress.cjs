const {randomUUID}=require('node:crypto');
class ProgressTracker {
  constructor(send=()=>{}){this.send=send;this.state={running:false,logs:[],items:[]};}
  snapshot(){return this.state;}
  begin(label){this.state={runId:randomUUID(),running:true,startedAt:Date.now(),phase:label,message:'작업 시작',logs:[],items:[],activeId:null};this.update({phase:label,message:'작업 시작'});}
  update(event){
    const {items,...value}=event;
    if(items)this.state.items=items.map(item=>({...item}));
    if(value.requestId){
      let item=this.state.items.find(r=>r.id===value.requestId);
      if(!item){item={id:value.requestId,title:value.title||''};this.state.items.push(item);}
      item.status=value.status||value.phase;item.phase=value.phase;
      if(value.title)item.title=value.title;
      this.state.activeId=value.requestId;
    }
    if(value.phase!==this.state.phase){delete this.state.current;delete this.state.total;}
    Object.assign(this.state,value);
    this.state.logs.push({time:Date.now(),phase:value.phase,message:value.message||'',requestId:value.requestId||this.state.activeId,current:value.current,total:value.total});
    this.state.logs=this.state.logs.slice(-500);
    this.send(this.state);
  }
  end(status,message){
    this.state.running=false;this.state.endedAt=Date.now();this.state.activeId=null;
    for(const item of this.state.items)if(!['분석 완료','수집 완료','동일 내용 · 분석 생략','상세 읽기 실패','이미지·본문 확인 필요','관련 소스 확인 필요','분석 실패','소스 준비 완료'].includes(item.status))item.status=status==='완료'?'완료':status;
    this.update({phase:status,message:message||(status==='완료'?'작업이 종료되었습니다. 요청별 결과를 확인하세요.':`작업 ${status}`),current:undefined,total:undefined});
  }
}
// 2026-10-16 김기덕: 요청 실패·보류가 있는 배치를 전체 성공으로 표시하지 않는다.
function completionFor(result){
  const issues=(result?.failed||0)+(result?.blocked||0);
  return issues?{status:'확인 필요',message:`작업 종료 · 분석 완료 ${result.done||0}건 · 실패/확인 필요 ${issues}건. 요청별 결과를 확인하세요.`}:{status:'완료'};
}
module.exports={ProgressTracker,completionFor};
