const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript');
const source=ts.transpile(fs.readFileSync('supabase/functions/google-calendar-auth/index.ts','utf8').replace(/^import .*;\r?\n/gm,''),{target:ts.ScriptTarget.ES2022});
async function run(body,opts={}){
 let handler,fetches=0,writes=0;const chain={update:()=>chain,eq:()=>chain,select:()=>chain,maybeSingle:async()=>({data:opts.missing?null:{user_id:'test'},error:null}),upsert:async()=>{writes++;return {error:null};}};
 const client={auth:{getUser:async()=>({data:{user:{id:'test'}}})},from:()=>chain,rpc:async()=>({data:true,error:null})};
 vm.runInNewContext(source,{Deno:{env:{get:()=> 'synthetic'},serve:fn=>handler=fn},createClient:()=>client,unvalidatedIntegrationResponse:()=>opts.paused?new Response('{}',{status:503}):null,Response,URLSearchParams,Date,TextEncoder,Uint8Array,AbortSignal,crypto:require('node:crypto').webcrypto,console:{error:()=>{}},fetch:async(_,init)=>{assert.ok(init.signal);fetches++;return new Response(JSON.stringify(fetches===1?{access_token:'test',refresh_token:'test',expires_in:3600,scope:opts.scope}:{email:'test@example.test',verified_email:true}));}});
 const res=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify(body)}));return {status:res.status,fetches,writes};
}
(async()=>{
 const req={action:'exchange_code',code:'synthetic',state:'a'.repeat(64),redirect_uri:'https://psicoone.vercel.app/configuracoes'};
 for(const scope of [undefined,'','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/calendar']){const r=await run(req,{scope});assert.equal(r.status,403);assert.equal(r.writes,0);assert.equal(r.fetches,1);}
 let r=await run(req,{scope:'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email'});assert.equal(r.status,200);assert.equal(r.writes,1);
 const prefs={action:'update_preferences',sync_enabled:false,auto_create:false,auto_update:false,sync_new_only:true};
 r=await run(prefs,{missing:true});assert.equal(r.status,409);
 r=await run({...prefs,sync_enabled:'true'});assert.equal(r.status,400);
 r=await run(prefs);assert.equal(r.status,200);

 console.log('8 auth validation scenarios passed with mocked provider/database.');
})().catch(e=>{console.error(e);process.exitCode=1;});

