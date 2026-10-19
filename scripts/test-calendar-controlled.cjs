const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require('typescript');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const raw=fs.readFileSync('supabase/functions/google-calendar-auth/index.ts','utf8');
const source=ts.transpile(raw.replace(/^import .*;\r?\n/gm,'').replace('22ed549770256ec3622d65f18479d82a0e09b4349879f7f661473453fed8b250',hash('synthetic-owner')).replace('970d02b0923c8fcb887a0fb2247927a6d75c53bff35f28246969034795429f49',hash('owner@example.test')),{target:ts.ScriptTarget.ES2022});
async function run(action,opts={}){
 let handler,reads=0,fetches=0,saved;class TestDate extends Date{static now(){return Date.parse(opts.expired?'2026-10-21T00:00Z':'2026-10-19T10:00Z')}}
 const chain={select:()=>chain,eq:()=>chain,maybeSingle:async()=>({data:null}),upsert:async r=>{saved=r;return {}},insert:async()=>({})};
 const client={auth:{getUser:async()=>({data:{user:opts.unauthorized?null:{id:opts.other?'other':'synthetic-owner'}}})},from:()=>{reads++;return chain;},rpc:async()=>({data:true})};
 vm.runInNewContext(source,{Deno:{env:{get:k=>k==='SUPABASE_URL'?(opts.wrongProject?'https://other.supabase.co':'https://jeguvjpfuyksqiqrrvyz.supabase.co'):'test'},serve:fn=>handler=fn},createClient:()=>client,unvalidatedIntegrationResponse:()=>new Response('{}',{status:503}),Response,URLSearchParams,Date:TestDate,TextEncoder,Uint8Array,AbortSignal,crypto:crypto.webcrypto,console:{error:()=>{}},fetch:async()=>{fetches++;return new Response(JSON.stringify(fetches===1?{access_token:'synthetic',refresh_token:'synthetic',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email'}:{email:opts.wrongGoogle?'other@example.test':'owner@example.test',verified_email:true}));}});
 const res=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({action,state:'a'.repeat(64),code:'test',redirect_uri:'https://psicoonex.vercel.app/configuracoes'})}));return {status:res.status,body:await res.json(),reads,fetches,saved};
}
(async()=>{
 for(const opts of [{other:true},{expired:true},{wrongProject:true}]){const r=await run('get_auth_url',opts);assert.equal(r.status,503);assert.equal(r.reads,0);assert.equal(r.fetches,0);}
 let r=await run('status');assert.equal(r.status,200);assert.equal(r.body.migration_test,true);assert.equal(r.body.sync_enabled,false);
 r=await run('update_preferences');assert.equal(r.status,503);assert.equal(r.reads,0);
 r=await run('get_auth_url');assert.equal(r.status,200);assert.match(r.body.state,/^[a-f0-9]{64}$/);
 r=await run('exchange_code',{wrongGoogle:true});assert.equal(r.status,403);assert.equal(r.saved,undefined);
 r=await run('exchange_code');assert.equal(r.status,200);assert.equal(r.saved.sync_enabled,false);assert.equal(r.saved.auto_create,false);assert.equal(r.saved.auto_update,false);
 r=await run('status',{unauthorized:true});assert.equal(r.status,401);assert.equal(r.reads,0);
 const ui=fs.readFileSync('src/components/settings/GoogleCalendarSettings.tsx','utf8');assert.equal(ts.transpileModule(ui,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true}).diagnostics.length,0);
 console.log('9 controlled connection scenarios passed; UI syntax valid. No live provider calls.');
})().catch(e=>{console.error(e);process.exitCode=1;});

