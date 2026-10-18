const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript');
const ui=fs.readFileSync('src/components/settings/GoogleCalendarSettings.tsx','utf8');
const load=ui.slice(ui.indexOf('  const loadStatus ='),ui.indexOf('  useEffect('));
const update=ui.slice(ui.indexOf('  const handleUpdatePrefs ='),ui.indexOf('  const handleSyncAll ='));
async function run(reply,session=true,throws=false){
 const result={prefs:[],errors:[],loading:[],saving:[],toasts:[]};
 const c={useCallback:f=>f,setPrefs:v=>result.prefs.push(v),setStatusError:v=>result.errors.push(v),setLoading:v=>result.loading.push(v),setUpdatingPrefs:v=>result.saving.push(v),prefs:{connected:true,sync_enabled:false},toast:{error:v=>result.toasts.push(v)},supabase:{auth:{getSession:async()=>({data:{session:session?{}:null}})},functions:{invoke:async()=>{if(throws)throw Error('network');return reply;}}}};
 vm.createContext(c);vm.runInContext(ts.transpile(load+update+'\nglobalThis.load=loadStatus;globalThis.update=handleUpdatePrefs;',{target:ts.ScriptTarget.ES2022}),c);
 await c.load();return {c,result};
}
(async()=>{
 for(const response of [{error:{}},{data:null},{data:{}},{data:{connected:'false'}}]){const {result}=await run(response);assert.equal(result.prefs.length,0);assert.equal(typeof result.errors.at(-1),'string');assert.equal(result.loading.at(-1),false);}
 let r=await run({data:{connected:false}});assert.equal(r.result.prefs[0].connected,false);assert.equal(r.result.errors.at(-1),null);
 r=await run({},false);assert.equal(typeof r.result.errors.at(-1),'string');
 r=await run({},true,true);assert.equal(typeof r.result.errors.at(-1),'string');
 for(const response of [{error:{}},{data:{}},{data:{success:false}}]){r=await run(response);await r.c.update('sync_enabled',true);assert.equal(r.result.prefs.length,0);assert.equal(r.result.toasts.length,1);assert.equal(r.result.saving.at(-1),false);}
 r=await run({data:{success:true}});await r.c.update('sync_enabled',true);assert.equal(r.result.prefs[0].sync_enabled,true);assert.equal(r.result.toasts.length,0);
 const diagnostics=ts.transpileModule(ui,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true}).diagnostics;assert.equal(diagnostics.length,0);
 console.log('11 status/preference scenarios passed; TSX syntax valid. No live changes.');
})().catch(e=>{console.error(e);process.exitCode=1;});

