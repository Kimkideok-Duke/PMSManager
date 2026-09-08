const {digest}=require('./files.cjs');

function normalizeText(value) {
  return String(value||'').normalize('NFC').replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').split('\n').map(line=>line.trimEnd()).join('\n').trim();
}
function completeContent(row) {
  return !row.error && row.contentComplete!==false && typeof row.text==='string' && Array.isArray(row.images)
    && row.images.every(image=>!!image.data || typeof image.hash==='string' && image.hash.length===64)
    && !(row.warnings||[]).some(w=>/이미지.*(?:실패|최대)/.test(w));
}
function contentFingerprint(row) {
  if(!completeContent(row))return null;
  return digest(JSON.stringify(['request-content-v1',normalizeText(row.text),row.images.map(image=>image.data?digest(Buffer.from(image.data,'base64')):image.hash)]));
}
function upgradeRow(row) {
  const current=contentFingerprint(row);
  let analysis=row.analysis;
  // Legacy hashes included grid metadata. Migrate only when the saved analysis
  // explicitly belongs to the exact saved request snapshot.
  if(analysis && !analysis.contentFingerprint && current && analysis.requestFingerprint && analysis.requestFingerprint===row.fingerprint)analysis={...analysis,contentFingerprint:current};
  const analyzed=new Set(row.analyzedContentFingerprints||[]);
  for(const result of [analysis,...(row.analysisHistory||[])])if(result?.contentFingerprint)analyzed.add(result.contentFingerprint);
  return {...row,analysis,contentFingerprint:current,analyzedContentFingerprints:[...analyzed]};
}
function needsAnalysis(row) {
  const current=upgradeRow(row);
  return !!current.contentFingerprint && !current.analyzedContentFingerprints.includes(current.contentFingerprint);
}
function recordAnalysis(row,result) {
  const fingerprint=contentFingerprint(row);
  if(!fingerprint)throw new Error('본문·이미지를 완전히 확인하지 못한 요청은 분석 완료로 기록할 수 없습니다.');
  row.analysisHistory=[...(row.analysisHistory||[]),...(row.analysis?[row.analysis]:[])].slice(-5);
  row.analysis={...result,contentFingerprint:fingerprint};
  row.analyzedContentFingerprints=[...new Set([...(row.analyzedContentFingerprints||[]),fingerprint])];
  row.contentFingerprint=fingerprint;row.analysisStale=false;row.syncStatus='분석 완료';delete row.analysisError;
}
module.exports={normalizeText,completeContent,contentFingerprint,upgradeRow,needsAnalysis,recordAnalysis};
