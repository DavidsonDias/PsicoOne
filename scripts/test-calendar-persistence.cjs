const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript');
const source=ts.transpile(fs.readFileSync('supabase/functions/google-calendar-sync/index.ts','utf8').replace(/^import .*;\r?\n/gm,''),{target:ts.ScriptTarget.ES2022});
async function run(o={}){
 let handler,calls=[];
 const row={id:'11111111-1111-4111-8111-111111111111',scheduled_at:'2026-12-01T12:00:00Z',patients:{full_name:'Synthetic'}};
 const client={auth:{getUser:async()=>({data:{user:{id:'owner'}}})},from(table){
  let write=false;const chain=new Proxy({}, {get:(_,k)=>k==='then'?resolve=>resolve(write?{data:o.saveMissing?null:{id:row.id,user_id:'owner'},error:o.saveError?{message:'private'}:null}:{data:table==='appointments'?(o.all?[row]:row):{sync_enabled:true,auto_create:true,auto_update:true,access_token:'synthetic',refresh_token:'synthetic',token_expires_at:o.refresh?'2000-01-01':'2099-01-01'}}):()=>{if(k==='update')write=true;return chain;}});return chain;
 }};
 vm.runInNewContext(source,{Deno:{env:{get:()=> 'synthetic'},serve:fn=>handler=fn},createClient:()=>client,unvalidatedIntegrationResponse:()=>o.paused?new Response('{}',{status:503}):null,Response,Date,URLSearchParams,AbortSignal,encodeURIComponent,console:{error:()=>{},log:()=>{}},fetch:async(url)=>{calls.push(url);return new Response(JSON.stringify(url.includes('oauth2')?(o.invalidToken?{}:{access_token:'renewed',expires_in:3600}):(o.invalidEvent?{}:{id:'synthetic-event'})));}});
 const res=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify({action:o.all?'sync_all':'create',appointment:{id:row.id}})}));return {status:res.status,body:await res.json(),calls};
}
(async()=>{
 let r=await run();assert.equal(r.body.success,true);
 for(const o of [{saveError:true},{saveMissing:true}]){r=await run(o);assert.equal(r.status,503);assert.equal(r.body.reconciliation_required,true);}
 r=await run({invalidEvent:true});assert.equal(r.status,502);
 for(const o of [{saveError:true},{saveMissing:true},{invalidToken:true}]){r=await run({refresh:true,...o});assert.equal(r.status,401);assert.equal(r.calls.length,1);}
 r=await run({refresh:true});assert.equal(r.body.success,true);assert.equal(r.calls.length,2);
 r=await run({all:true,saveMissing:true});assert.equal(r.body.success,false);assert.equal(r.body.failed,1);assert.equal(r.body.created,0);
 r=await run({paused:true});assert.equal(r.status,503);assert.equal(r.calls.length,0);
 console.log('10 persistence scenarios passed; no real data or provider calls.');
})().catch(e=>{console.error(e);process.exitCode=1;});

