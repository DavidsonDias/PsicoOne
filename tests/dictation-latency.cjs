const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/audio/dictation-window.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:api});
const flush=api.shouldFlushDictation;
// Continuous speech is sent at 8 seconds, not the former 24 seconds.
assert.equal(flush(7999,7999,0),false);
assert.equal(flush(8000,8000,0),true);
// A natural pause submits the first phrase in 2s; brief hesitation does not split it.
assert.equal(flush(2000,1000,1000),true);
assert.equal(flush(2000,1500,500),false);
assert.equal(flush(1600,600,1000),false);
// Below the limit noise cannot close early; at the limit reclaim buffers (recorder discards noise).
assert.equal(flush(2000,0,2000),false);
assert.equal(flush(8000,150,7850),true);
assert.equal(flush(8000,600,7400),true);
console.log('8 dictation latency and silence scenarios passed.');
