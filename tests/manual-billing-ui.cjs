const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(process.argv[2]||__dirname+'/../src/components/financial/BillingPlansPanel.tsx','utf8');
const start=source.indexOf('  const generateNow = async (plan: Plan) => {');
const end=source.indexOf('\n  return (',start);
assert.ok(start>=0&&end>start);
const code=stripTypeScriptTypes(source.slice(start,end))+'\nglobalThis.invoke=generateNow;';
async function scenario(kind){let calls=0,loads=0,changed=0;const messages=[];let release;
const pending=new Promise(r=>release=r);
const ctx={generatingRef:{current:false},setGeneratingId(){},nextDueDate:()=>new Date('2026-10-20T00:00:00Z'),format:()=> '2026-10-20',load:async()=>{loads++},onChanged:()=>changed++,toast:{info:m=>messages.push('info'),success:m=>messages.push('success'),error:m=>messages.push('error')},supabase:{rpc:async(name,args)=>{calls++;assert.equal(name,'generate_manual_billing_cycle');assert.equal(args.p_plan_id,'synthetic');assert.equal(args.p_expected_last_generated_at,null);if(kind==='double')await pending;if(kind==='transport')throw Error('transport');if(kind==='error')return{error:{message:'private'}};return{data:kind==='stale'?{created:false,reason:'stale_plan'}:kind==='malformed'?{}:{created:true,transaction_id:'synthetic-tx'}}}}};
vm.createContext(ctx);vm.runInContext(code,ctx);
const first=ctx.invoke({id:'synthetic',last_generated_at:null});
if(kind==='double'){await ctx.invoke({id:'synthetic',last_generated_at:null});release();}
await first;assert.equal(calls,1);assert.equal(ctx.generatingRef.current,false);
const ok=['success','stale','double'].includes(kind);assert.equal(loads,ok?1:0);assert.equal(changed,ok?1:0);
assert.deepEqual(messages,[kind==='stale'?'info':ok?'success':'error']);}
(async()=>{for(const k of ['success','stale','double','error','transport','malformed'])await scenario(k);console.log('6 manual billing UI handler checks passed; browser rendering not tested');})().catch(e=>{console.error(e);process.exitCode=1});

