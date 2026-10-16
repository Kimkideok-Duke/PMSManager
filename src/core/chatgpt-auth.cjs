// 2026-10-16 김기덕: 공식 ChatGPT 플랜 OAuth 연결, 검증 및 암호화된 계정별 세션을 관리한다.
const http=require('node:http');
const {randomBytes,randomUUID,createHash,createPublicKey,verify,timingSafeEqual}=require('node:crypto');
const ISSUER='https://auth.openai.com',RESOURCE='https://api.openai.com/v1';
const SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TOKEN=ISSUER+'/api/accounts/oauth/token';
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function scopes(value){return typeof value==='string'?value.split(/\s+/).filter(Boolean):[];}
function permitted(value){const s=new Set(value);return s.has('chatgpt.tokens.use.direct')&&s.has('resource.invoke');}
function trusted(url){const u=new URL(url);if(u.origin!==ISSUER||u.username||u.password||u.hash)throw Error('인증 서버 주소 검증에 실패했습니다.');return u.href;}
async function readJson(response){const reader=response.body?.getReader();if(!reader)throw Error('인증 응답을 읽지 못했습니다.');let text='',size=0;const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024)throw Error('인증 응답 크기가 너무 큽니다.');text+=decoder.decode(value,{stream:true});}try{return JSON.parse(text+decoder.decode());}catch{throw Error('인증 서버 응답 형식이 올바르지 않습니다.');}}finally{await reader.cancel().catch(()=>{});}}
async function validateIdToken(token,{clientId,nonce,subject,fetcher=fetch,now=Date.now()}){
  if(typeof token!=='string'||token.length>65536)throw Error('로그인 신원 정보가 없습니다.');
  const parts=token.split('.');if(parts.length!==3)throw Error('로그인 신원 형식이 올바르지 않습니다.');
  let header,claims;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw Error('로그인 신원 형식이 올바르지 않습니다.');}
  if(header.alg!=='RS256'||typeof header.kid!=='string'||header.crit)throw Error('지원하지 않는 로그인 서명입니다.');
  const response=await fetcher(ISSUER+'/.well-known/jwks.json',{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('로그인 서명 검증 키를 받지 못했습니다.');
  const jwks=await readJson(response),keys=(jwks.keys||[]).filter(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));
  if(keys.length!==1||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:keys[0],format:'jwk'}),Buffer.from(parts[2],'base64url')))throw Error('로그인 신원 서명이 올바르지 않습니다.');
  const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(claims.iss!==ISSUER||!aud.includes(clientId)||(aud.length>1&&claims.azp!==clientId)||!Number.isFinite(claims.exp)||claims.exp<=now/1000||claims.nbf>now/1000+60||typeof claims.sub!=='string'||!claims.sub)throw Error('로그인 신원 또는 유효기간 검증에 실패했습니다.');
  if(nonce!==undefined&&!equal(claims.nonce,nonce))throw Error('로그인 요청 검증에 실패했습니다.');
  if(subject!==undefined&&claims.sub!==subject)throw Error('선택한 계정과 로그인한 계정이 다릅니다. 새 계정 추가를 사용하세요.');
  return claims;
}
class ChatGPTAuth{
  constructor({store,safeStorage,openExternal,fetcher=fetch,timeoutMs=300000}){Object.assign(this,{store,safeStorage,openExternal,fetcher,timeoutMs});this.data={accounts:[],activeId:null};this.pending=null;this.refreshing=null;}
  async load(){this.data=await this.store.read('chatgpt-auth',{accounts:[],activeId:null});if(!Array.isArray(this.data.accounts))throw Error('ChatGPT 계정 저장 자료를 확인하세요.');}
  async persist(){await this.store.write('chatgpt-auth',this.data);}
  active(){return this.data.accounts.find(a=>a.id===this.data.activeId);}
  publicState(){return {pending:!!this.pending,activeId:this.data.activeId,accounts:this.data.accounts.map(a=>({id:a.id,label:a.label,email:a.email,connected:!!a.encryptedCredentials,planEnabled:!!a.planEnabled})),connected:!!this.active()?.encryptedCredentials&&!!this.active()?.planEnabled};}
  encrypt(value){if(!this.safeStorage.isEncryptionAvailable())throw Error('Windows 암호화 저장소를 사용할 수 없어 연결을 저장하지 않았습니다.');return this.safeStorage.encryptString(JSON.stringify(value)).toString('base64');}
  decrypt(account){if(!account?.encryptedCredentials)throw Error('ChatGPT로 로그인해 주세요.');try{return JSON.parse(this.safeStorage.decryptString(Buffer.from(account.encryptedCredentials,'base64')));}catch{throw Error('ChatGPT 연결을 읽지 못했습니다. 다시 로그인하세요.');}}
  async token(form){const response=await this.fetcher(TOKEN,{method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,resource:RESOURCE}),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`ChatGPT 인증에 실패했습니다(HTTP ${response.status}). 다시 로그인하세요.`);return readJson(response);}
  tokenSet(response,previous={}){
    if(typeof response.access_token!=='string'||!response.access_token||response.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(response.expires_in)||response.expires_in<=0)throw Error('ChatGPT 인증 응답이 올바르지 않습니다.');
    const granted=response.scope===undefined?previous.scopes:scopes(response.scope);
    if(!Array.isArray(granted))throw Error('ChatGPT 사용 권한을 확인하지 못했습니다.');
    if(response.refresh_token!==undefined&&(typeof response.refresh_token!=='string'||!response.refresh_token))throw Error('갱신 인증 정보가 올바르지 않습니다.');
    return {access_token:response.access_token,refresh_token:response.refresh_token||previous.refresh_token,id_token:response.id_token||previous.id_token,scopes:granted,expires_at:Date.now()+response.expires_in*1000};
  }
  async start(accountId){
    if(this.pending||this.refreshing)throw Error('진행 중인 ChatGPT 로그인 또는 갱신을 완료하거나 취소하세요.');
    const account=accountId?this.data.accounts.find(a=>a.id===accountId):null;
    if(accountId&&!account)throw Error('등록된 ChatGPT 계정이 없습니다.');
    const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    let resolve,reject;const completion=new Promise((yes,no)=>{resolve=yes;reject=no;});
    // The UI attaches completion handlers immediately; also prevent an early unhandled rejection.
    completion.catch(()=>{});
    const pending={state,nonce,verifier,account,resolve,reject,completion,consumed:false};this.pending=pending;
    const server=http.createServer((req,res)=>this.callback(req,res,pending).catch(()=>{if(!res.writableEnded){res.writeHead(500);res.end('Sign-in failed. Return to PMS Manager.');}}));pending.server=server;
    try{
      if(!this.data.hostId){this.data.hostId='urn:uuid:'+randomUUID();await this.persist();}
      if(this.pending!==pending)throw Error('종료된 로그인 요청입니다.');
      await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',no);yes();});});
      if(this.pending!==pending){server.close();throw Error('종료된 로그인 요청입니다.');}
      pending.redirectUri=`http://127.0.0.1:${server.address().port}/auth/callback`;
      pending.timer=setTimeout(()=>this.finish(pending,Error('ChatGPT 로그인 시간이 초과됐습니다. 다시 시도하세요.')),this.timeoutMs);
      const url=new URL(ISSUER+'/api/accounts/authorize');
      const params={client_id:account?.clientId||'dynamic_agent_client',ext_agent_host_id:this.data.hostId,response_type:'code',redirect_uri:pending.redirectUri,scope:SCOPES,resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
      if(!account)params.agent_name_hint='PMS Manager';
      else if(account.encryptedCredentials){const old=this.decrypt(account);if(old.id_token)params.id_token_hint=old.id_token;}
      if(account&&!account.planEnabled)params.prompt='consent';
      for(const [key,value]of Object.entries(params))url.searchParams.set(key,value);
      await this.openExternal(url.href);
      return {completion};
    }catch(error){this.finish(pending,Error('ChatGPT 로그인 창을 열지 못했습니다. 다시 시도하세요.'));throw Error('ChatGPT 로그인 창을 열지 못했습니다. 다시 시도하세요.');}
  }
  finish(pending,error,value){if(this.pending!==pending)return;this.pending=null;clearTimeout(pending.timer);pending.server.close(()=>{});pending.server.closeIdleConnections?.();if(error)pending.reject(error);else pending.resolve(value);}
  async callback(req,res,pending){
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method!=='GET'||url.pathname!=='/auth/callback'){res.writeHead(404);res.end();return;}
    if(this.pending!==pending||pending.consumed||!equal(url.searchParams.get('state'),pending.state)){res.writeHead(400);res.end('Invalid sign-in request.');return;}
    pending.consumed=true;
    try{
      if(url.searchParams.has('error'))throw Error('ChatGPT 연결 승인이 취소됐습니다.');
      const clientId=url.searchParams.get('client_id')||pending.account?.clientId;
      if(typeof clientId!=='string'||!clientId||clientId==='dynamic_agent_client'||clientId.length>512||pending.account&&clientId!==pending.account.clientId)throw Error('ChatGPT 앱 등록을 확인하지 못했습니다.');
      const code=url.searchParams.get('code');if(!code||code.length>8192)throw Error('로그인 인증 코드가 없습니다.');
      const response=await this.token({grant_type:'authorization_code',client_id:clientId,code,code_verifier:pending.verifier,redirect_uri:pending.redirectUri});
      const identity=await validateIdToken(response.id_token,{clientId,nonce:pending.nonce,subject:pending.account?.subject,fetcher:this.fetcher});
      const credentials=this.tokenSet(response);
      if(this.pending!==pending)throw Error('종료된 로그인 요청입니다.');
      const existing=pending.account||this.data.accounts.find(a=>a.clientId===clientId&&a.subject===identity.sub);
      const id=existing?.id||randomUUID(),firstUse=permitted(credentials.scopes)&&!existing?.welcomed;
      const next={id,clientId,subject:identity.sub,issuer:identity.iss,email:typeof identity.email==='string'?identity.email.slice(0,320):'',label:existing?.label||`계정 ${this.data.accounts.length+1}`,planEnabled:permitted(credentials.scopes),welcomed:existing?.welcomed||firstUse,encryptedCredentials:this.encrypt(credentials)};
      const before=this.data;this.data={...before,accounts:[...before.accounts.filter(a=>a.id!==id),next],activeId:id};
      try{await this.persist();}catch{this.data=before;throw Error('ChatGPT 연결을 저장하지 못했습니다. 다시 시도하세요.');}
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('ChatGPT 연결이 완료됐습니다. PMS Manager로 돌아가세요.');
      this.finish(pending,null,{firstUse,planEnabled:next.planEnabled});
    }catch(error){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end('로그인을 완료하지 못했습니다. PMS Manager의 안내를 확인하세요.');this.finish(pending,error);}
  }
  cancel(){if(this.pending)this.finish(this.pending,Error('ChatGPT 로그인을 취소했습니다.'));}
  async select(id){if(this.pending||this.refreshing)throw Error('로그인 또는 연결 갱신 후 계정을 변경하세요.');if(!this.data.accounts.some(a=>a.id===id))throw Error('등록된 계정이 없습니다.');const before=this.data;this.data={...before,activeId:id};try{await this.persist();}catch(error){this.data=before;throw error;}}
  async credentials(){
    if(this.pending)throw Error('ChatGPT 로그인 완료 후 실행하세요.');
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.renew();try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  async renew(){
    const account=this.active(),old=this.decrypt(account);
    if(!permitted(old.scopes))throw Error('ChatGPT 플랜 사용 권한이 없습니다. 로그인 연결에서 사용을 승인하세요.');
    if(old.expires_at>Date.now()+60000)return old.access_token;
    if(!old.refresh_token)throw Error('ChatGPT 연결이 만료됐습니다. 다시 로그인하세요.');
    const response=await this.token({grant_type:'refresh_token',client_id:account.clientId,refresh_token:old.refresh_token});
    if(response.id_token)await validateIdToken(response.id_token,{clientId:account.clientId,subject:account.subject,fetcher:this.fetcher});
    const next=this.tokenSet(response,old);if(!permitted(next.scopes))throw Error('ChatGPT 플랜 사용 권한이 해제됐습니다. 다시 연결하세요.');
    const previous=account.encryptedCredentials;account.encryptedCredentials=this.encrypt(next);try{await this.persist();}catch(error){account.encryptedCredentials=previous;throw error;}
    return next.access_token;
  }
  async signOut(){
    if(this.pending||this.refreshing)throw Error('로그인 또는 연결 갱신을 마친 뒤 연결을 해제하세요.');
    const account=this.active();if(!account)return {remoteRevoked:true};
    let remoteRevoked=false;
    if(account.encryptedCredentials){const credentials=this.decrypt(account);if(credentials.refresh_token){try{const discovery=await this.fetcher(ISSUER+'/.well-known/openid-configuration',{redirect:'error',signal:AbortSignal.timeout(15000)});if(!discovery.ok)throw Error();const metadata=await readJson(discovery);if(metadata.issuer!==ISSUER)throw Error();const response=await this.fetcher(trusted(metadata.revocation_endpoint),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:credentials.refresh_token,token_type_hint:'refresh_token',client_id:account.clientId})});remoteRevoked=response.status===200;}catch{}}}
    const previous=account.encryptedCredentials;delete account.encryptedCredentials;try{await this.persist();}catch(error){account.encryptedCredentials=previous;throw error;}return {remoteRevoked};
  }
}
module.exports={ChatGPTAuth,validateIdToken,RESOURCE};
