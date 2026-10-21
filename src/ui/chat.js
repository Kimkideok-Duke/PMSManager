let chatRow=null,chatPending=null,chatStartedAt=0;
const chatDrafts=new Map(),chatErrors=new Map();
function drawChat(row){
  const switched=chatRow?.id!==row.id;
  if(switched){if(chatRow)chatDrafts.set(chatRow.id,$('chat-input').value);$('chat-input').value=chatDrafts.get(row.id)||'';}
  chatRow=row;
  $('chat-request').textContent=row.id;
  const context=row.context||row.analysis?.context;
  // 2026-10-21 김기덕: 적용 후 대화에 남은 소스는 수정 전 자료임을 표시한다.
  $('chat-context').textContent=`${context?.files?.length?`연결 소스 ${context.files.length}개`:'소스 미연결'} · ${row.analysis?'기존 분석 포함':'분석 전'}${row.analysisStale?' · 이전 자료 기반 분석':''}${row.analysis?.applied?' · 수정 적용됨 · 재분석 전 소스':''} · ${settings.ai.model||'AI 설정 필요'}`;
  const root=$('chat-messages'),nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<60,top=root.scrollTop;root.replaceChildren();
  for(const m of row.chatMessages||[]){const bubble=el('article',undefined,'chat-message '+m.role);bubble.append(el('small',`${m.role==='user'?'나':m.model||'LLM'} · ${new Date(m.createdAt).toLocaleTimeString('ko-KR')}`),el('div',m.content));if(m.contentFingerprint&&m.contentFingerprint!==row.contentFingerprint)bubble.append(el('small','이전 요청내용에 대한 대화'));root.append(bubble);}
  if(!(row.chatMessages||[]).length)root.append(el('p','추가 재현 조건이나 확인한 내용을 알려주면 수정 방향을 함께 보완할 수 있습니다.','chat-empty'));
  if(chatPending===row.id)root.append(el('div','LLM이 답변을 작성하고 있습니다…','chat-waiting'));
  root.scrollTop=switched||nearBottom?root.scrollHeight:top;
  updateChatControls();
}
function updateChatControls(){
  // 2026-10-20 김기덕: 목록만 읽은 요청은 상세를 확인한 후 보완 대화를 허용한다.
  $('chat-input').disabled=!chatRow||!!chatRow.error||!!chatRow.detailPending;
  $('chat-send').disabled=!chatRow||!!chatRow.error||!!chatRow.detailPending||!!chatPending||!settings?.ai?.hasKey||!settings?.ai?.model||!$('chat-input').value.trim();
  $('chat-stop').hidden=!chatPending;$('chat-stop').disabled=false;
  // 2026-10-16 김기덕: ChatGPT 로그인 사용자에게 API 키 등록을 요구하지 않는다.
  $('chat-status').textContent=chatPending?`${chatPending===chatRow?.id?'답변 대기':'다른 요청 답변 대기'} · ${Math.floor((Date.now()-chatStartedAt)/1000)}초`:chatErrors.get(chatRow?.id)||(!settings?.ai?.hasKey?'프로젝트 · AI 설정에서 계정을 연결하고 모델을 선택하세요.':'');
}
async function sendChat(){
  if(!chatRow||chatPending)return;
  const id=chatRow.id,message=$('chat-input').value.trim();if(!message)return;
  chatDrafts.set(id,$('chat-input').value);chatErrors.delete(id);chatPending=id;chatStartedAt=Date.now();drawChat(chatRow);
  try{
    const result=await api.chat({id,message});
    if(chatDrafts.get(id)?.trim()===message)chatDrafts.delete(id);
    if(chatRow?.id===id){chatRow.chatMessages=result.messages;if($('chat-input').value.trim()===message)$('chat-input').value='';}
  }catch(e){chatErrors.set(id,e.message||'대화 요청에 실패했습니다. 다시 전송할 수 있습니다.');}
  finally{chatPending=null;if(chatRow)drawChat(chatRow);}
}
function initChat(){
  $('chat-form').onsubmit=e=>{e.preventDefault();run(sendChat);};
  $('chat-input').oninput=()=>{if(chatRow)chatDrafts.set(chatRow.id,$('chat-input').value);updateChatControls();};
  $('chat-input').onkeydown=e=>{if(e.ctrlKey&&e.key==='Enter'&&!e.isComposing){e.preventDefault();if(!$('chat-send').disabled)run(sendChat);}};
  $('chat-stop').onclick=()=>run(()=>api['chat-cancel']());
  setInterval(()=>{if(chatPending)updateChatControls();},1000);
}
