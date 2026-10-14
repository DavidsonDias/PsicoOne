const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const ts = require('typescript');
const ui = fs.readFileSync(__dirname + '/../src/components/settings/GoogleCalendarSettings.tsx', 'utf8');
const callback = ui.slice(ui.indexOf('  const handleOAuthCallback ='), ui.indexOf('  const handleDisconnect ='));
const source = ts.transpile(callback + '\nglobalThis.callback = handleOAuthCallback;', {target: ts.ScriptTarget.ES2022});
const state = 'a'.repeat(64), redirect = 'https://psicoonex.vercel.app/configuracoes';
async function scenario(change = {}, options = {}) {
  let pending = options.missing ? null : JSON.stringify({state, redirect, user:'user-1', expires:Date.now()+600000, ...change});
  let calls = 0, successes = 0, errors = 0, statusReads = 0;
  const context = {Date, JSON, Number, window:{location:{origin:'https://psicoonex.vercel.app'}},
    sessionStorage:{getItem:()=>pending, removeItem:()=>{pending=null;}}, setConnecting:()=>{},
    toast:{error:()=>errors++, success:()=>successes++}, loadStatus:async()=>statusReads++,
    supabase:{auth:{getUser:async()=>({data:{user:{id:'user-1'}}, error:options.identityError})},
      functions:{invoke:async(_, request)=>{calls++;assert.equal(request.body.state,state);return {data:{success:true,email:'synthetic@example.test'}};}}}};
  vm.createContext(context); vm.runInContext(source,context);
  await context.callback('synthetic-code',state);
  if(options.replay) await context.callback('synthetic-code',state);
  return {calls,successes,errors,statusReads,pending};
}
(async()=>{
  let r=await scenario();assert.equal(r.calls,1);assert.equal(r.successes,1);assert.equal(r.statusReads,1);assert.equal(r.pending,null);
  for(const change of [{state:'b'.repeat(64)},{user:'other-user'},{redirect:'https://attacker.test'},{expires:Date.now()-1},{expires:'not-a-number'}]) {
    r=await scenario(change);assert.equal(r.calls,0);assert.equal(r.errors,1);
  }
  r=await scenario({}, {missing:true});assert.equal(r.calls,0);
  r=await scenario({}, {identityError:{message:'unauthorized'}});assert.equal(r.calls,0);
  r=await scenario({}, {replay:true});assert.equal(r.calls,1);assert.equal(r.errors,1);
  console.log('9 callback scenarios passed with mocked browser storage and identity; no live OAuth performed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

