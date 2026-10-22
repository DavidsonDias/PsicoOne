const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript');
const source=ts.transpile(fs.readFileSync(__dirname + '/../supabase/functions/google-calendar-sync/index.ts','utf8').replace(/^import .*;\r?\n/gm,''),{target:ts.ScriptTarget.ES2022});
const id='11111111-1111-4111-8111-111111111111';
async function run(action, owned, options={}){
 let handler,fetches=[],filters=[];
 const chain=result=>new Proxy({}, {get:(_,key)=>key==='then'?(resolve)=>resolve(result):(...args)=>{if(key==='eq')filters.push(args);return chain(result);}});
 const row={id,scheduled_at:'2026-12-01T12:00:00Z',duration_minutes:50,type:'online',status:'scheduled',google_event_id:'owned-event',patients:{full_name:'Synthetic'}};
 const client={auth:{getUser:async()=>({data:{user:{id:'owner'}}})},from:table=>chain(table==='appointments'?{data:owned?{...row,...options.row}:null,error:options.dbError||null}:{data:{sync_enabled:true,auto_update:true,auto_create:true,access_token:'synthetic',token_expires_at:'2099-01-01T00:00:00Z'},error:null})};
 vm.runInNewContext(source,{Deno:{env:{get:()=> 'synthetic'},serve:fn=>handler=fn},createClient:()=>client,unvalidatedIntegrationResponse:()=>options.paused?new Response('{}',{status:503}):null,Response,Date,URLSearchParams,encodeURIComponent,console:{error:()=>{},log:()=>{}},fetch:async(url,init)=>{fetches.push({url,init});return new Response('{}',{status:options.providerStatus||200});}});
 const res=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify({action,appointment:{id:options.badId?'bad':id,google_event_id:'attacker-event',patient_name:'Attacker'}})}));
 return {status:res.status,body:await res.json(),fetches,filters};
}
(async()=>{
 for(const action of ['create','update','cancel','delete']){const r=await run(action,false);assert.equal(r.status,404);assert.equal(r.fetches.length,0);assert.ok(r.filters.some(([k,v])=>k==='psychologist_id'&&v==='owner'));}
 let r=await run('update',true);assert.equal(r.status,200);assert.ok(r.fetches[0].url.endsWith('/owned-event'));assert.ok(!r.fetches[0].init.body.includes('Attacker'));
 r=await run('delete',true,{providerStatus:500});assert.equal(r.status,502);assert.equal(r.body.success,undefined);
 r=await run('update',true,{dbError:{message:'private'}});assert.equal(r.status,503);assert.equal(r.fetches.length,0);
 r=await run('create',true,{row:{status:'cancelled'}});assert.equal(r.status,409);assert.equal(r.fetches.length,0);
 r=await run('create',true,{badId:true});assert.equal(r.status,400);assert.equal(r.fetches.length,0);
 console.log('9 ownership/failure scenarios passed; Google and database mocked.');
})().catch(e=>{console.error(e);process.exitCode=1;});

