const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const root=__dirname+'/../supabase/functions/';
function load(name,db){let handler;const code=stripTypeScriptTypes(fs.readFileSync(root+name+'/index.ts','utf8').replace(/^import .*;\r?\n/gm,''));
vm.runInNewContext(code,{Request,Response,Date,console:{log(){},error(){}},Deno:{env:{get:k=>k==='INTERNAL_FUNCTION_SECRET'?'synthetic-secret':'value'},serve:h=>handler=h},serve:h=>handler=h,createClient:()=>db});return handler;}
const request=body=>new Request('https://example.invalid',{method:'POST',headers:{'x-internal-secret':'synthetic-secret'},body:JSON.stringify(body)});
(async()=>{
 let reads=0,audits=0;
 for(const scenario of ['unchanged','extended','activated','already_expired']){
 const row={id:'synthetic',user_id:'synthetic-user',status:'trial',trial_end_date:'2000-01-01'};
 let writes=0;
 const db={from(table){if(table==='audit_logs')return{async insert(){audits++;return {error:null}}};
 let update=false;const filters=[];return{
 select(){return this},update(){update=true;return this},eq(k,v){filters.push([k,v]);return this},lt(){return this},
 then(resolve){if(!update){reads++;resolve({data:[{...row}],error:null});return;}
 if(scenario==='extended')row.trial_end_date='2099-01-01';
 if(scenario==='activated')row.status='active';
 if(scenario==='already_expired')row.status='expired';
 const matches=filters.every(([k,v])=>row[k]===v);
 if(matches)writes++;
 resolve({data:matches?[{id:row.id}]:[],error:null});
 }};}};
 const before=audits;const response=await load('expire-trials',db)(request({}));const data=await response.json();
 assert.equal(response.status,200);assert.equal(data.count,scenario==='unchanged'?1:0);
 assert.equal(writes,scenario==='unchanged'?1:0);assert.equal(audits-before,writes);
 }
 const db={from(){throw Error('Unexpected database access')}};
 const r=await load('send-notification',db)(request({to:'synthetic@example.invalid',subject:'test',message:'test'}));
 assert.equal(r.status,501);const body=await r.json();assert.equal(body.success,false);assert.equal(body.sent,false);
 for(const name of ['send-notification','expire-trials']){const denied=await load(name,db)(new Request('https://example.invalid',{method:'POST',body:'{}'}));assert.equal(denied.status,403);}
 console.log('7 internal automation regressions passed');
})().catch(e=>{console.error(e);process.exitCode=1});

