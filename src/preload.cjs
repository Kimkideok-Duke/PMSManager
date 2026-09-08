const {contextBridge,ipcRenderer}=require('electron');
const channels=['state','open-pms','project-add','project-toggle','project-remove','ai-save','ai-clear-key','models','collect','sync','detail','prepare','analyze','cancel','review','export'];
const api={};
for(const channel of channels)api[channel]=async arg=>{const response=await ipcRenderer.invoke(channel,arg);if(!response.ok)throw new Error(response.error);return response.value;};
api.onProgress=callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('progress',listener);return ()=>ipcRenderer.removeListener('progress',listener);};
contextBridge.exposeInMainWorld('pms',api);
