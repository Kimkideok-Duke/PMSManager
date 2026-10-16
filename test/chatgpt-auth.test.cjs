// 2026-10-16 김기덕: 실제 계정 없이 OAuth 검증·계정 분리·갱신·취소를 검증한다.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync,sign}=require('node:crypto');
const {ChatGPTAuth,validateIdToken}=require('../src/core/chatgpt-auth.cjs');
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
function jwt(claims){const body=[{alg:'RS256',kid:'test'},claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return body+'.'+sign('RSA-SHA256',Buffer.from(body),pair.privateKey).toString('base64url');}
function identity(extra={}){return {iss:'https://auth.openai.com',sub:'user-a',aud:'issued-client',exp:Date.now()/1000+3600,nonce:'expected',email:'user@example.invalid',...extra};}
const jwksFetch=async()=>new Response(JSON.stringify({keys:[jwk]}));
test('신원 토큰은 서명·issuer·audience·nonce·만료·기존 계정을 검증한다',async()=>{
 const options={clientId:'issued-client',nonce:'expected',fetcher:jwksFetch};
 assert.equal((await validateIdToken(jwt(identity()),options)).sub,'user-a');
 for(const override of [{iss:'https://attacker.invalid'},{aud:'other'},{nonce:'wrong'},{exp:0},{sub:'user-b'}]){
  await assert.rejects(()=>validateIdToken(jwt(identity(override)),{...options,subject:'user-a'}));
 }
 const invalid=jwt(identity()).split('.');invalid[2]=Buffer.alloc(256).toString('base64url');await assert.rejects(()=>validateIdToken(invalid.join('.'),options),/서명/);
});
async function harness({grant='openid resource.invoke chatgpt.tokens.use.direct offline_access',subject='user-a',tokenHook}={}){
 const files=new Map();let authorization,refreshCalls=0,auth;
 const fetcher=async(url,init)=>{
  if(url.endsWith('jwks.json'))return jwksFetch();
  if(url.endsWith('openid-configuration'))return new Response(JSON.stringify({issuer:'https://auth.openai.com',revocation_endpoint:'https://auth.openai.com/api/accounts/oauth/revoke'}));
  if(url.endsWith('/revoke'))return new Response(null,{status:200});
  if(url.endsWith('/token')){
   const form=new URLSearchParams(init.body);assert.equal(form.get('client_id'),'issued-client');assert.equal(form.get('resource'),'https://api.openai.com/v1');
   if(form.get('grant_type')==='refresh_token'){refreshCalls++;return new Response(JSON.stringify({access_token:'renewed',refresh_token:'rotated',token_type:'Bearer',expires_in:3600,scope:grant}));}
   assert.equal(form.get('redirect_uri'),authorization.searchParams.get('redirect_uri'));
   await tokenHook?.(auth);
   return new Response(JSON.stringify({access_token:'access-secret',refresh_token:'refresh-secret',token_type:'Bearer',expires_in:3600,scope:grant,id_token:jwt(identity({sub:subject,nonce:authorization.searchParams.get('nonce')}))}));
  }
  throw Error('Unexpected URL');
 };
 auth=new ChatGPTAuth({store:{read:async(_name,fallback)=>fallback,write:async(name,value)=>files.set(name,structuredClone(value))},safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from('encrypted:'+v),decryptString:v=>v.toString().slice(10)},openExternal:async url=>{authorization=new URL(url);},fetcher});await auth.load();
 return {auth,files,get url(){return authorization;},get refreshCalls(){return refreshCalls;},callback:async extra=>{const url=new URL(authorization.searchParams.get('redirect_uri'));url.search=new URLSearchParams({state:authorization.searchParams.get('state'),code:'test-code',client_id:'issued-client',...extra});return fetch(url);}};
}
test('로그인은 loopback·PKCE·state로 보호되고 토큰은 공개 상태에서 제외된다',async()=>{
 const h=await harness();const {completion}=await h.auth.start();
 try{
 assert.equal(h.url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(h.url.searchParams.get('agent_name_hint'),'PMS Manager');assert.match(h.url.searchParams.get('ext_agent_host_id'),/^urn:uuid:/);assert.equal(h.url.searchParams.get('code_challenge_method'),'S256');
 assert.equal((await h.callback({state:'wrong'})).status,400);assert.equal(h.auth.publicState().connected,false);
 assert.equal((await h.callback()).status,200);assert.equal((await completion).firstUse,true);
 assert.equal(await h.auth.credentials(),'access-secret');
 assert.doesNotMatch(JSON.stringify(h.auth.publicState()),/secret|encryptedCredentials|id_token/);
 const saved=h.files.get('chatgpt-auth');assert.ok(saved.accounts[0].encryptedCredentials);assert.equal(saved.hostId,h.url.searchParams.get('ext_agent_host_id'));
 const {completion:again}=await h.auth.start(saved.activeId);assert.equal(h.url.searchParams.get('client_id'),'issued-client');assert.equal(h.url.searchParams.has('agent_name_hint'),false);assert.ok(h.url.searchParams.get('id_token_hint'));await h.callback();assert.equal((await again).firstUse,false);
 }finally{h.auth.cancel();}
});
test('권한 미승인 로그인은 보존하지만 분석은 차단하며 취소는 기존 계정을 유지한다',async()=>{
 const h=await harness({grant:'openid profile email'});let {completion}=await h.auth.start();await h.callback();assert.equal((await completion).planEnabled,false);await assert.rejects(()=>h.auth.credentials(),/사용 권한/);
 const previous=h.auth.data.activeId;({completion}=await h.auth.start());h.auth.cancel();await assert.rejects(completion,/취소/);assert.equal(h.auth.data.activeId,previous);
});
test('만료 토큰 갱신은 직렬화하고 회전 refresh token을 함께 저장한다',async()=>{
 const h=await harness();const {completion}=await h.auth.start();await h.callback();await completion;
 const account=h.auth.active(),old=h.auth.decrypt(account);old.expires_at=0;account.encryptedCredentials=h.auth.encrypt(old);
 assert.deepEqual(await Promise.all([h.auth.credentials(),h.auth.credentials()]),['renewed','renewed']);assert.equal(h.refreshCalls,1);assert.equal(h.auth.decrypt(account).refresh_token,'rotated');
 assert.equal((await h.auth.signOut()).remoteRevoked,true);assert.equal(h.auth.publicState().connected,false);assert.equal(h.auth.active().clientId,'issued-client');
});
test('토큰 교환 중 취소된 로그인은 계정이나 인증정보를 저장하지 않는다',async()=>{
 const h=await harness({tokenHook:async auth=>auth.cancel()});const {completion}=await h.auth.start();const pending=assert.rejects(completion,/취소/);await h.callback();await pending;assert.equal(h.auth.data.accounts.length,0);
});
