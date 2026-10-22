const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript');
const source=ts.transpile(fs.readFileSync(__dirname + '/../supabase/functions/google-calendar-auth/index.ts','utf8').replace(/^import .*;\r?\n/gm,''),{target:ts.ScriptTarget.ES2022});
async function run(body,consumed=true,paused=false){
 let handler,fetches=0,inserted,rpcArgs;
 const client={auth:{getUser:async()=>({data:{user:{id:'synthetic-user'}}})},from:()=>({insert:async row=>(inserted=row,{error:null})}),rpc:async(_,args)=>(rpcArgs=args,{data:consumed,error:null})};
 vm.runInNewContext(source,{Deno:{env:{get:()=> 'synthetic'},serve:fn=>handler=fn},createClient:()=>client,unvalidatedIntegrationResponse:()=>paused?new Response('{}',{status:503}):null,Response,URLSearchParams,Date,AbortSignal,TextEncoder,Uint8Array,crypto:require('node:crypto').webcrypto,console:{error:()=>{}},fetch:async()=>{fetches++;return new Response('{}',{status:400})}});
 const res=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify(body)}));
 return {status:res.status,body:await res.json(),fetches,inserted,rpcArgs};
}
(async()=>{
 const redirect_uri='https://psicoone.vercel.app/configuracoes';
 const a=await run({action:'get_auth_url',redirect_uri});
 assert.equal(a.status,200);assert.match(a.body.state,/^[0-9a-f]{64}$/);assert.notEqual(a.body.state,a.inserted.state_hash);assert.equal(a.inserted.user_id,'synthetic-user');
 assert.notEqual((await run({action:'get_auth_url',redirect_uri})).body.state,a.body.state);
 const request={action:'exchange_code',redirect_uri,state:a.body.state,code:'synthetic-code'};
 let r=await run({...request,state:undefined});assert.equal(r.status,400);assert.equal(r.fetches,0);
 r=await run({...request,redirect_uri:'https://attacker.test'});assert.equal(r.status,400);assert.equal(r.fetches,0);
 r=await run(request,false);assert.equal(r.status,400);assert.equal(r.fetches,0);
 r=await run(request,true);assert.equal(r.fetches,1);assert.equal(r.rpcArgs.p_user_id,'synthetic-user');assert.equal(r.rpcArgs.p_state_hash,a.inserted.state_hash);
 const ui=fs.readFileSync(__dirname + '/../src/components/settings/GoogleCalendarSettings.tsx','utf8');
 const check=ts.transpileModule(ui,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
 assert.equal(check.diagnostics.length,0);
 console.log('6 worker scenarios passed; TSX syntax passed. Google calls mocked; browser flow not yet tested.');
})().catch(e=>{console.error(e);process.exitCode=1});

