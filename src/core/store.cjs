const fs=require('node:fs/promises');
const path=require('node:path');
const {upgradeRow,contentFingerprint}=require('./content.cjs');
class Store {
  constructor(directory){this.directory=directory;this.queue=Promise.resolve();}
  async read(name,fallback){try{return JSON.parse(await fs.readFile(path.join(this.directory,name+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error(`${name} 저장 파일을 읽지 못했습니다. 파일을 덮어쓰지 않았습니다.`);}}
  write(name,value){const json=JSON.stringify(value);const operation=this.queue.then(async()=>{await fs.mkdir(this.directory,{recursive:true});const target=path.join(this.directory,name+'.json');await fs.writeFile(target+'.tmp',json,'utf8');await fs.rename(target+'.tmp',target);});this.queue=operation.catch(()=>{});return operation;}
}
function mergeRequests(previous,incoming){
  const map=new Map(previous.map(r=>[r.id,upgradeRow(r)]));
  for(const row of incoming){
    const old=map.get(row.id);
    if(row.error){map.set(row.id,{...old,...row,contentFingerprint:null,syncStatus:'상세 읽기 실패',analysisStale:!!old?.analysis});continue;}
    const fingerprint=contentFingerprint(row);
    const analyzed=old?.analyzedContentFingerprints||[];
    const unchanged=!!fingerprint&&analyzed.includes(fingerprint);
    const matching=unchanged?[old?.analysis,...(old?.analysisHistory||[])].find(a=>a?.contentFingerprint===fingerprint):null;
    const analysis=matching||old?.analysis;
    const history=matching&&matching!==old?.analysis?[...(old?.analysisHistory||[]).filter(a=>a!==matching),...(old?.analysis?[old.analysis]:[])].slice(-5):old?.analysisHistory||[];
    map.set(row.id,{...row,contentFingerprint:fingerprint,analyzedContentFingerprints:analyzed,note:old?.note||'',review:old?.review||'미검토',analysis,analysisHistory:history,
      syncStatus:!fingerprint?'이미지·본문 확인 필요':unchanged?'동일 내용 · 분석 생략':!old?'신규 요청':old.contentFingerprint!==fingerprint?'요청내용 변경':'아직 분석 안 됨',
      analysisStale:!!analysis&&(analysis.contentFingerprint!==fingerprint || !!old?.analysisStale&&analysis===old?.analysis),analysisError:unchanged?undefined:old?.analysisError});
  }
  return [...map.values()];
}
module.exports={Store,mergeRequests};
