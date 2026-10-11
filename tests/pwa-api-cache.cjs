const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../vite.config.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const sandbox={exports:{},__dirname:path.join(__dirname,'..'),require:(name)=>{
 if(name==='vite')return {defineConfig:x=>x};
 if(name==='@vitejs/plugin-react-swc')return ()=>({});
 if(name==='lovable-tagger')return {componentTagger:()=>({})};
 if(name==='vite-plugin-pwa')return {VitePWA:x=>({pwa:x})};
 if(name==='path')return path;
 throw new Error('Unexpected import '+name);
}};
vm.runInNewContext(compiled,sandbox);
const config=sandbox.exports.default({mode:'production'});
const wb=config.plugins.find(x=>x.pwa).pwa.workbox;
test('Supabase responses never use offline cache, including signed image URLs',()=>{
 for(const suffix of ['/rest/v1/patients','/auth/v1/user','/storage/v1/object/sign/private/report.png?token=synthetic']){
  const url=new URL('https://example.supabase.co'+suffix);
  const route=wb.runtimeCaching.find(r=>typeof r.urlPattern==='function'?r.urlPattern({url,sameOrigin:false}):r.urlPattern.test(url.href));
  assert.equal(route.handler,'NetworkOnly');
  assert.equal(route.options.fetchOptions.cache,'no-store');
 }
});
test('image caching is restricted to same-origin assets',()=>{
 const route=wb.runtimeCaching.find(r=>r.options?.cacheName==='image-cache');
 assert.equal(route.urlPattern({url:new URL('https://app.example/icon.png'),sameOrigin:true}),true);
 assert.equal(route.urlPattern({url:new URL('https://private.example/report.png'),sameOrigin:false}),false);
});
test('worker activation removes only the retired cache and awaits completion',async()=>{
 assert.ok(wb.importScripts.includes('retire-api-cache.js'));
 let activate; const deleted=[]; let pending;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/retire-api-cache.js'),'utf8'),{
 self:{addEventListener:(event,callback)=>{assert.equal(event,'activate');activate=callback}},
 caches:{delete:async name=>{deleted.push(name);return true}}
 });
 activate({waitUntil:p=>{pending=p}});
 assert.ok(pending); await pending;
 assert.deepEqual(deleted,['supabase-api-cache']);
});

