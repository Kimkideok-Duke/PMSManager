const {contextBridge,ipcRenderer}=require('electron');
// 2026-10-16 김기덕: ChatGPT 연결은 제한된 IPC만 노출하고 인증 토큰은 메인 프로세스에 둔다.
// 2026-10-20 김기덕: 선택 상세·요청 편집·수동 분석 IPC를 허용한다.
// 2026-10-21 김기덕: 검증된 변경안 적용 채널만 추가하고 임의 파일 쓰기는 노출하지 않는다.
const channels=['state','open-pms','project-add','project-toggle','project-remove','ai-save','ai-clear-key','models','collect','sync','detail','read-request','request-edit','analyze-request','apply-changes','prepare','analyze','cancel','review','export','chat','chat-cancel','chatgpt-login','chatgpt-cancel','chatgpt-select','chatgpt-logout','chatgpt-usage'];
const api={};
for(const channel of channels)api[channel]=async arg=>{const response=await ipcRenderer.invoke(channel,arg);if(!response.ok)throw new Error(response.error);return response.value;};
api.onProgress=callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('progress',listener);return ()=>ipcRenderer.removeListener('progress',listener);};
api.onConnection=callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('chatgpt-state',listener);return ()=>ipcRenderer.removeListener('chatgpt-state',listener);};
contextBridge.exposeInMainWorld('pms',api);
