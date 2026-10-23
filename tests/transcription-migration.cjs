const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
function compile(path) {
  return ts.transpileModule(fs.readFileSync(path, 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, ''), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
}
async function engineCase(response) {
  const chunks = new Map(); const dropped = []; const output = {}; let calls = 0;
  const noop = async()=>{};
  vm.runInNewContext(compile('src/lib/transcription/engine.ts'), {
    exports:output, console:{debug(){}}, crypto:require('node:crypto').webcrypto,
    setTimeout:fn=>{fn();return 1}, clearTimeout(){}, setInterval(){}, clearInterval(){},
    supabase:{functions:{invoke:async()=>{calls++;return response}}},
    putChunk:async c=>chunks.set(c.id,c), putSegment:noop, patchSession:noop,
    getSessionChunks:async()=>[...chunks.values()], dropChunkAudio:async id=>dropped.push(id),
    dedupeOverlap:(_,s)=>s,
  });
  const e = new output.ClinicalTranscriptionEngine({context:'medical_record'});
  await e.processChunk({id:'test',session_id:e.sessionId,sequence:0,audio:'synthetic',mime_type:'audio/wav',duration_ms:1000});
  await e.confirmPersisted();
  return {chunk:chunks.get('test'),calls,dropped};
}
async function endpointCase(body, options={}) {
  let handler; let fetches=0;
  vm.runInNewContext(compile('supabase/functions/speech-to-text/index.ts'), {
    exports:{}, serve:f=>handler=f, requireUser:async()=>options.unauthorized?{error:new Response('{}',{status:401})}:{user:{id:'test'}},
    Deno:{env:{get:()=>options.missingKey?undefined:'synthetic-key'}},
    Response,FormData,Blob,Uint8Array,atob,AbortSignal,console:{error(){}},
    fetch:async()=>{fetches++;return new Response(JSON.stringify({text:'Teste de transcrição.'}),{status:options.status||200})}
  });
  const res=await handler(new Request('https://example.test',{method:'POST',body:JSON.stringify(body)}));
  return {status:res.status,body:await res.json(),fetches};
}
(async()=>{
  let r=await engineCase({error:{context:{status:503}}});
  assert.equal(r.calls,4); assert.equal(r.chunk.status,'failed_retryable'); assert.equal(r.chunk.audio,'synthetic'); assert.equal(r.dropped.length,0);
  r=await engineCase({error:{context:{status:403}}});
  assert.equal(r.calls,1); assert.equal(r.chunk.status,'failed_permanent'); assert.equal(r.dropped.length,0);
  r=await engineCase({data:{text:''}}); assert.equal(r.chunk.status,'transcribed');assert.equal(r.chunk.audio,null);
  r=await engineCase({data:{text:'Teste.'}});assert.equal(r.chunk.status,'transcribed');
  const audio=Buffer.alloc(3000).toString('base64');
  r=await endpointCase({audio},{unauthorized:true}); assert.equal(r.status,401);assert.equal(r.fetches,0);
  r=await endpointCase({healthCheck:true},{missingKey:true});assert.equal(r.status,503);
  r=await endpointCase({healthCheck:true});assert.equal(r.body.available,true);assert.equal(r.fetches,0);
  r=await endpointCase({audio,model:'other'});assert.equal(r.status,400);assert.equal(r.fetches,0);
  r=await endpointCase({audio});assert.equal(r.body.text,'Teste de transcrição.');
  r=await endpointCase({audio},{status:403});assert.equal(r.status,403);assert.equal(r.body.detail,undefined);
  const diagnostics={};
  const sandbox={exports:diagnostics,window:{isSecureContext:false},navigator:{}};
  vm.runInNewContext(compile('src/lib/audio/capture-diagnostics.ts'),sandbox);
  assert.match(diagnostics.captureSupportError(),/HTTPS/);
  sandbox.window.isSecureContext=true; assert.match(diagnostics.captureSupportError(),/navegador/);
  sandbox.window.AudioContext=function(){};sandbox.navigator.mediaDevices={getUserMedia(){}};
  assert.equal(diagnostics.captureSupportError(),null); // no SpeechRecognition necessary
  assert.match(diagnostics.captureErrorMessage({name:'NotAllowedError'}),/bloqueado/);
  assert.match(diagnostics.captureErrorMessage({name:'NotFoundError'}),/Nenhum microfone/);
  assert.match(diagnostics.captureErrorMessage({name:'NotReadableError'}),/indisponível/);
  console.log('16 transcription regression scenarios passed (synthetic audio, mocked provider).');
})().catch(e=>{console.error(e);process.exitCode=1});
