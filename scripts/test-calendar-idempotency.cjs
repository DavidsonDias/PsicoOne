const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require('typescript');
const raw=fs.readFileSync('supabase/functions/google-calendar-sync/index.ts','utf8');
const source=ts.transpile(raw.replace(/^import .*;\r?\n/gm,''),{target:ts.ScriptTarget.ES2022});
async function test(o={}){
 let calls=[],id;
 const context={Deno:{env:{get:()=>o.project||'project'},serve:()=>{}},crypto:crypto.webcrypto,TextEncoder,Uint8Array,AbortSignal,Response,Date,URLSearchParams,console,fetch:async(url,init)=>{
  calls.push({url,init});
  if(init.method==='POST'){id=JSON.parse(init.body).id;return new Response(JSON.stringify({id:o.badId?'bad':id}),{status:o.conflict?409:o.status||200});}
  return new Response(JSON.stringify({id,status:o.cancelled?'cancelled':'confirmed',extendedProperties:{private:{psicooneAppointmentId:o.foreign?'other':'appointment'}}}),{status:o.missing?404:200});
 }};
 vm.runInNewContext(source,context);
 const result=await context.createOrRecoverEvent('https://example.test/events','synthetic',o.owner||'owner','appointment',{summary:'Synthetic'});
 return {result,calls,id};
}
(async()=>{
 const first=await test(),second=await test();assert.equal(first.id,second.id);assert.match(first.id,/^[0-9a-f]{64}$/);
 assert.notEqual(first.id,(await test({owner:'other'})).id);assert.notEqual(first.id,(await test({project:'other'})).id);
 let r=await test({conflict:true});assert.equal(r.result.id,first.id);assert.equal(r.calls.length,2);
 for(const o of [{foreign:true},{cancelled:true},{missing:true}]){r=await test({conflict:true,...o});assert.equal(r.result.id,null);}
 r=await test({badId:true});assert.equal(r.result.status,502);
 r=await test({status:429});assert.equal(r.result.id,null);assert.equal(r.calls.length,1);
 assert.ok(raw.includes('if (migrationPause) return migrationPause;'));
 assert.ok(raw.includes('reason: "already_linked"'));
 console.log('9 deterministic creation/recovery scenarios passed; no network. Pause retained.');
})().catch(e=>{console.error(e);process.exitCode=1;});
