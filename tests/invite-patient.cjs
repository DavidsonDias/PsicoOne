const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const clean=p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,''));
const root=__dirname+'/../supabase/functions/';
const source=clean(root+'_shared/require-auth.ts')+'\n'+clean(root+'invite-patient/index.ts');
const owner='11111111-1111-4111-8111-111111111111',pid='22222222-2222-4222-8222-222222222222';
let passed=0;
async function test(label,o={},status=200){
 let handler,writes=0,outgoing=0;
 const env={SUPABASE_URL:'https://jeguvjpfuyksqiqrrvyz.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',EMAIL_WORKER_SECRET:'synthetic-secret-long-enough-for-testing',EMAIL_TEST_RECIPIENT:'test@example.invalid',...o.env};
 const invite={id:'synthetic-invite',token:'synthetic_invite_token_123',expires_at:'2099-01-01T00:00:00Z',email:'test@example.invalid',...o.invite};
 const db={from(table){let inserted=false;return {
 select(){return this},eq(){return this},is(){return this},gt(){return this},order(){return this},limit(){return this},
 insert(values){assert.equal(table,'patient_invites');assert.equal(values.email,env.EMAIL_TEST_RECIPIENT);inserted=true;writes++;return this},
 async maybeSingle(){return this.single()},async single(){
 if(o.dbError===table)return {data:null,error:{message:'private database failure'}};
 return {error:null,data:table==='patients'?{id:pid,psychologist_id:owner,full_name:'Ficticio',email:'test@example.invalid',user_id:null,...o.patient}:table==='profiles'?{full_name:'Profissional'}:o.noPending&&!inserted?null:invite};
 }}}};
 vm.runInNewContext(source,{Request,Response,AbortSignal,Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},createClient(url,key){return key==='anon'?{auth:{async getUser(){return {data:{user:o.badAuth?null:{id:owner}},error:null}}}}:db},async fetch(url,init){
 outgoing++;assert.equal(init.headers['x-email-worker-secret'],env.EMAIL_WORKER_SECRET);assert.equal(init.headers.Authorization,undefined);
 const body=JSON.parse(init.body);assert.equal(body.recipientEmail,'test@example.invalid');assert.equal(body.metadata.invite_token,undefined);assert.equal(body.templateData.inviteUrl,'https://psicoone.vercel.app/portal/aceitar-convite/'+invite.token);
 if(o.networkError)throw Error('private network failure');
 return new Response(o.rawResponse??JSON.stringify(o.response??{success:true,queued:true,sent:false,messageId:'synthetic-message'}),{status:o.upstreamStatus??200});
 }});
 const method=o.method||'POST';
 const r=await handler(new Request('https://example.invalid',{method,headers:o.noAuth?{}:{Authorization:'Bearer test'},...(method==='POST'?{body:o.raw??JSON.stringify(o.body??{patient_id:pid})}:{})}));
 const text=await r.text();assert.equal(r.status,status,label);assert(!text.includes('private '));if(env.EMAIL_WORKER_SECRET)assert(!text.includes(env.EMAIL_WORKER_SECRET));
 if(status!==200){assert.equal(outgoing,0);assert.equal(writes,0)}else{
 const data=JSON.parse(text);assert.equal(data.email_sent,o.alreadySent??false);assert.equal(data.email_queued,o.expectQueued??true);if(o.alreadySent){assert.equal(data.email_error,null)}assert.equal(data.manual_processing,o.expectQueued??true);assert.equal(writes,o.noPending?1:0);assert.equal(outgoing,1);
 }
 passed++;
}
(async()=>{
 await test('OPTIONS',{method:'OPTIONS'},204);await test('GET',{method:'GET'},405);
 await test('no auth',{noAuth:true},401);await test('bad auth',{badAuth:true},401);
 await test('wrong project',{env:{SUPABASE_URL:'https://wrong.invalid'}},503);
 await test('no secret',{env:{EMAIL_WORKER_SECRET:''}},503);
 await test('bad JSON',{raw:'{'},400);await test('bad id',{body:{patient_id:'bad'}},400);
 await test('other owner',{patient:{psychologist_id:'other'}},404);
 await test('missing recipient',{patient:{email:''},noPending:true},400);
 await test('active portal',{patient:{user_id:'active'}},409);
 for(const table of ['patients','profiles','patient_invites'])await test('read failure '+table,{dbError:table},503);
 await test('reuse existing');await test('create new',{noPending:true});
 await test('expired invite',{invite:{expires_at:'2000-01-01'}},503);
 await test('invalid token',{invite:{token:'<script>'}},503);
 for(const response of [{success:true},{success:true,queued:true},{success:false,queued:true,messageId:'x'}])await test('incomplete acknowledgment',{response,expectQueued:false});
 await test('upstream rejected',{upstreamStatus:401,expectQueued:false});
 await test('invalid response',{rawResponse:'not json',expectQueued:false});
 await test('timeout preserves invite',{networkError:true,expectQueued:false});
 await test('already sent',{alreadySent:true,expectQueued:false,response:{success:true,queued:false,sent:true,already_sent:true,messageId:'id'}});
 await test('immediate sent',{alreadySent:true,expectQueued:false,response:{success:true,queued:false,sent:true,messageId:'id'}});
 await test('contradictory response',{expectQueued:false,response:{success:true,queued:true,sent:true,already_sent:true,messageId:'id'}});
 console.log(passed+' invite-patient tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});

