const fs=require('fs'), vm=require('vm'), assert=require('node:assert/strict'), ts=require('typescript');
async function run(opts={}) {
 let handler, sends=0;
 const env={SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'service',VAPID_PRIVATE_KEY:'fake',VAPID_SUBJECT:'mailto:test@example.invalid'};
 const chain={select(){return this},in(){return Promise.resolve({data:opts.noSubs?[]:[{endpoint:'https://example.invalid/push',p256dh:'fake',auth:'fake'}]})}};
 const source=fs.readFileSync('supabase/functions/send-push/index.ts','utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
 Deno:{env:{get:k=>env[k]},serve:f=>handler=f},Response,console:{error(){}},corsHeaders:{},
 requireUser:async()=>opts.unauthorized?{error:new Response('{}',{status:401})}:{user:{id:'owner'}},
 createClient:()=>({from:()=>chain}),webpush:{setVapidDetails(){if(opts.badConfig)throw Error('secret')},sendNotification:async()=>{sends++;if(opts.providerFail)throw Error('secret')}}});
 const res=await handler(new Request('https://example.invalid',{method:opts.method||'POST',headers:{Authorization:'Bearer session'},body:opts.method==='OPTIONS'?undefined:JSON.stringify(opts.body||{user_ids:['owner'],title:'test'})}));
 return {status:res.status,body:res.status===200&&opts.method==='OPTIONS'?{}:await res.json(),sends};
}
(async()=>{
 let r=await run({unauthorized:true});assert.equal(r.status,401);assert.equal(r.sends,0);
 r=await run({body:{title:'x',user_ids:['other']}});assert.equal(r.status,403);assert.equal(r.sends,0);
 r=await run({badConfig:true});assert.equal(r.status,503);assert.equal(r.body.code,'PUSH_CONFIGURATION_INVALID');assert.equal(r.sends,0);
 r=await run({noSubs:true});assert.equal(r.body.ok,false);assert.equal(r.sends,0);
 r=await run({providerFail:true});assert.equal(r.body.ok,false);assert.equal(r.body.sent,0);
 r=await run();assert.equal(r.body.ok,true);assert.equal(r.body.sent,1);
 r=await run({method:'OPTIONS',badConfig:true});assert.equal(r.status,200);assert.equal(r.sends,0);
 console.log('7 push authorization and delivery scenarios passed; mocked provider, no messages sent.');
})().catch(e=>{console.error(e);process.exitCode=1});
