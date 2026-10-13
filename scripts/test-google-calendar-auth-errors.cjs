const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/../supabase/functions/google-calendar-auth/index.ts', 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/\)!;/g, ');').replace(/\)!\)/g, '))');
async function run(action, result, paused = false) {
  let handler;
  let reads = 0;
  const logs = [];
  const chain = new Proxy({}, { get: (_, key) => key === 'then' ? (resolve) => resolve(result) : () => chain });
  const client = { auth: { getUser: async () => ({ data: { user: { id: 'synthetic-user' } } }) }, from: () => { reads++; return chain; } };
  vm.runInNewContext(source, {
    Deno: { env: { get: () => 'synthetic-config' }, serve: fn => { handler = fn; } },
    createClient: () => client,
    unvalidatedIntegrationResponse: () => paused ? new Response('{}', { status: 503 }) : null,
    Response, URLSearchParams, Date, console: { error: (...args) => logs.push(args) },
    fetch: async () => { throw new Error('synthetic-sensitive-detail'); }
  });
  const response = await handler(new Request('https://example.test', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: JSON.stringify({ action })
  }));
  return { status: response.status, body: await response.json(), reads, logs };
}
(async () => {
  let r = await run('status', { data: null, error: { message: 'private-db-detail' } });
  assert.equal(r.status, 503); assert.equal(r.body.connected, undefined);
  r = await run('status', { data: null, error: null });
  assert.equal(r.status, 200); assert.equal(r.body.connected, false);
  r = await run('status', { data: { sync_enabled: false }, error: null });
  assert.equal(r.body.connected, true);
  r = await run('disconnect', { error: { message: 'private-db-detail' } });
  assert.equal(r.status, 503); assert.equal(r.body.success, undefined);
  r = await run('disconnect', { error: null });
  assert.equal(r.body.success, true);
  r = await run('exchange_code', {});
  assert.equal(r.status, 500); assert.ok(!JSON.stringify(r).includes('synthetic-sensitive-detail'));
  r = await run('disconnect', {}, true);
  assert.equal(r.status, 503); assert.equal(r.reads, 0);
  console.log('7 synthetic scenarios passed; no network, tokens or real records used.');
})().catch(error => { console.error(error); process.exitCode = 1; });