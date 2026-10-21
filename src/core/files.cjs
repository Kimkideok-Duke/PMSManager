const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');

function parseRequestId(id) {
  const raw = String(id).trim();
  const match = /^REQ-([A-Za-z0-9_./\\-]+)\.(xfdl|clx|xml|jsp)([^\s]*)$/i.exec(raw) ||
                /^REQ-([A-Za-z0-9_./\\-]+)$/i.exec(raw);
  if (!match) throw new Error('요청ID에서 REQ- 화면 경로를 찾을 수 없습니다.');
  const relative = slash(match[1]);
  if (relative.startsWith('/') || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('요청ID에 허용되지 않는 경로가 있습니다.');
  }
  const ext = match[2] ? '.' + match[2].toLowerCase() : '.xfdl';
  const screenId = path.posix.basename(relative);
  return { relative, ext, screenId, raw };
}

function requestPath(id) {
  const info = parseRequestId(id);
  return info.relative + info.ext;
}

function redact(text) {
  return text.replace(/\b(sk-[A-Za-z0-9_-]{15,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*["']?)[^\s"'<>;,]+/gi, '$1[REDACTED]');
}

async function readSource(file) {
  const actual = await fs.realpath(file.absolute);
  const rel = path.relative(file.root, actual);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('등록 폴더 밖의 파일은 읽을 수 없습니다.');
  if ((await fs.stat(actual)).size > 4 * 1024 * 1024) throw new Error('4MB 파일 크기 제한으로 제외');
  const bytes = await fs.readFile(actual);
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
  else {
    if (bytes.subarray(0,8192).includes(0)) throw new Error('바이너리 파일 제외');
    try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch { text = new TextDecoder('euc-kr').decode(bytes); }
  }
  return {text, hash:digest(bytes), bytes:bytes.length};
}

function excerpts(text, needles, limit) {
  const lines = redact(text).split(/\r?\n/);
  // 2026-10-21 김기덕: 파일 단위 오류의 핵심인 KB·MB·GB 줄도 소스 발췌에 포함한다.
  const terms = [...new Set(needles.map(t=>String(t).toLowerCase()))].filter(t=>t.length>2||/^(?:kb|mb|gb)$/.test(t));
  const ranked = [];
  for (let i=0;i<lines.length;i++) {
    const lower=lines[i].toLowerCase();
    const score=terms.reduce((n,t)=>n+(lower.includes(t)?1+Math.min(t.length,30)/10:0),0);
    if(score)ranked.push({line:i,score});
  }
  ranked.sort((a,b)=>b.score-a.score||a.line-b.line);
  const selected=new Set();let size=0;
  function take(i) {
    if(i<0||i>=lines.length||selected.has(i))return;
    const length=lines[i].length+String(i+1).length+3;
    if(size+length>limit)return;
    selected.add(i);size+=length;
  }
  if(text.length+lines.length*8<=limit)for(let i=0;i<lines.length;i++)take(i);
  else {
    // Reserve context around the strongest hits first, including late-file functions.
    for(const hit of ranked.slice(0,40)) {
      take(hit.line);
      for(let delta=1;delta<=15;delta++){take(hit.line-delta);take(hit.line+delta);}
    }
    for(let i=0;i<Math.min(35,lines.length);i++)take(i);
  }
  const lineNumbers=[...selected].sort((a,b)=>a-b).map(i=>i+1);
  return {content:lineNumbers.map(n=>`${n}: ${lines[n-1]}`).join('\n'),lineNumbers,totalLines:lines.length,truncated:lineNumbers.length!==lines.length};
}
module.exports={parseRequestId,requestPath,readSource,redact,digest,slash,excerpts};
