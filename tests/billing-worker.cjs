const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
function load(db){let handler;const code=stripTypeScriptTypes(fs.readFileSync(__dirname+'/../supabase/functions/generate-billing-cycle/index.ts','utf8').replace(/^import .*;\r?\n/gm,''));
vm.runInNewContext(code,{Response,Set,corsHeaders:{},Deno:{env:{get:k=>k==='INTERNAL_FUNCTION_SECRET'?'test-secret':'placeholder'},serve:h=>handler=h},createClient:()=>db});return handler;}
const request=(auth=true,method='POST')=>new Request('https://example.invalid',{method,headers:auth?{'x-internal-secret':'test-secret'}:{}});
(async()=>{
 const never={from(){throw Error('Unexpected DB access')}};
 assert.equal((await load(never)(request(false))).status,403);
 assert.equal((await load(never)(request(true,'GET'))).status,405);
 for(const scenario of ['success','partial','malformed','read_error','transport_error']){
 let calls=0;
 const db={from(){return{select(){return this},eq(){return this},is(){return Promise.resolve({data:[{id:'a'},{id:'b'}],error:scenario==='read_error'?{}:null})}}},async rpc(name,args){
 assert.equal(name,'generate_patient_billing_cycle');assert.ok(['a','b'].includes(args.p_plan_id));calls++;
 if(scenario==='transport_error')throw Error('Sensitive details must not leak');
 if(scenario==='partial'&&calls===2)return{error:{message:'private'}};
 if(scenario==='malformed')return{data:{}};
 return{data:{created:calls===1},error:null};}};
 const r=await load(db)(request());const body=await r.json();
 assert.equal(r.status,scenario==='success'?200:500);assert.equal(body.ok,scenario==='success');
 assert.equal(JSON.stringify(body).includes('private'),false);
 assert.equal(JSON.stringify(body).includes('Sensitive'),false);
 if(scenario==='success')assert.deepEqual(body,{ok:true,created:1,skipped:1,failed:0,plans:2});
 if(scenario==='partial')assert.equal(body.failed,1);
 if(scenario==='read_error')assert.equal(calls,0);
 }
 console.log('7 billing worker checks passed (mocks, no remote writes)');
})().catch(e=>{console.error(e);process.exitCode=1});

