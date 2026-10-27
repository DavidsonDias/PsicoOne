const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const entry = process.argv[2] || path.join(__dirname, '../supabase/functions/send-appointment-email/index.ts');
const guard = process.argv[3] || path.join(__dirname, '../supabase/functions/_shared/require-auth.ts');
const clean = file => stripTypeScriptTypes(fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const source = clean(guard) + '\n' + clean(entry);
const owner = '11111111-1111-4111-8111-111111111111';
const appointment = '22222222-2222-4222-8222-222222222222';
const patient = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const token = 'synthetic_portal_token_123';
const secret = 'synthetic-worker-secret-not-a-real-key';
let passed = 0;
async function run(label, options = {}, expected = 200, calls = 0) {
  const fixtures = {
    appointments: [{ id: appointment, patient_id: patient, psychologist_id: owner, deleted_at: null, scheduled_at: '2030-01-02T15:00:00Z', duration_minutes: 50, type: 'presential' }],
    patients: [{ id: patient, psychologist_id: owner, deleted_at: null, email: 'test@example.invalid', full_name: 'Paciente Ficticio' }],
    patient_access_links: [{ id: 'synthetic-link', token, patient_id: patient, appointment_id: appointment, created_by: owner, is_revoked: false, expires_at: '2099-01-01T00:00:00Z' }],
    profiles: [{ id: owner, full_name: 'Profissional Ficticio', clinic_name: 'Teste' }],
  };
  options.edit?.(fixtures);
  const reads = []; let outgoing = 0; let handler; let verified = 0;
  const db = { from(table) {
    const filters = [];
    return {
      select() { return this; },
      eq(k, v) { filters.push(row => row[k] === v); return this; },
      is(k, v) { filters.push(row => row[k] === v); return this; },
      async maybeSingle() {
        reads.push(table);
        if (options.dbError === table) return { data: null, error: { message: 'private database details' } };
        const rows = fixtures[table].filter(row => filters.every(fn => fn(row)));
        return { data: rows[0] || null, error: null };
      },
    };
  } };
  const env = { SUPABASE_URL: 'https://jeguvjpfuyksqiqrrvyz.supabase.co', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', EMAIL_WORKER_SECRET: secret, EMAIL_TEST_RECIPIENT: 'test@example.invalid', ...options.env };
  vm.runInNewContext(source, {
    Request, Response, AbortSignal,
    Deno: { env: { get: name => env[name] }, serve: fn => handler = fn },
    createClient(url, key, config) {
      if (key === env.SUPABASE_ANON_KEY) return { auth: { async getUser() {
        verified++; assert.equal(config.global.headers.Authorization, 'Bearer synthetic-session');
        return { data: { user: options.invalidAuth ? null : { id: owner } }, error: options.invalidAuth ? {} : null };
      } } };
      assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY); return db;
    },
    async fetch(url, init) {
      outgoing++;
      assert.equal(url, env.SUPABASE_URL + '/functions/v1/send-transactional-email');
      assert.equal(init.headers['x-email-worker-secret'], secret);
      assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.apikey, undefined);
      assert(init.signal instanceof AbortSignal);
      const body = JSON.parse(init.body);
      assert.equal(body.recipientEmail, 'test@example.invalid');
      assert.equal(body.templateData.portalUrl, 'https://psicoone.vercel.app/portal/' + token);
      assert.equal(body.templateName, 'appointment-confirmation');
      assert.equal(body.metadata.appointment_id, appointment); assert.equal(body.metadata.patient_id, patient);
      if (options.throwFetch) throw new Error('private network details');
      return new Response(options.rawResponse ?? JSON.stringify(options.response ?? { success: true, queued: true, sent: false, messageId: 'synthetic-message' }), { status: options.upstreamStatus ?? 200 });
    },
  });
  const method = options.method || 'POST';
  const request = new Request('https://example.invalid', { method, headers: options.noAuth ? {} : { Authorization: 'Bearer synthetic-session' }, ...(method === 'POST' ? { body: options.raw ?? JSON.stringify(options.body ?? { appointmentId: appointment, patientId: patient, token }) } : {}) });
  const response = await handler(request);
  assert.equal(response.status, expected, label);
  assert.equal(outgoing, calls, label + ': outbound calls');
  const text = await response.text();
  assert(!text.includes(secret)); assert(!text.includes('synthetic-service')); assert(!text.includes('private '));
  if (expected === 200) {
    const payload = JSON.parse(text);
    assert.equal(payload.sent, options.alreadySent??false); assert.equal(payload.queued, !options.alreadySent); if(options.alreadySent) assert.equal(payload.already_sent,true); else assert.equal(payload.manual_processing, true);
  }
  if (options.noAuth || options.invalidAuth || options.method) assert.equal(reads.length, 0);
  if (options.invalidAuth) assert.equal(verified, 1);
  if (expected === 404 && reads[0] === 'appointments' && reads.length === 1) assert(!reads.includes('patients'));
  passed++;
}
(async () => {
  await run('preflight', { method: 'OPTIONS' }, 204);
  await run('wrong method', { method: 'GET' }, 405);
  await run('missing auth', { noAuth: true }, 401);
  await run('invalid verified session', { invalidAuth: true }, 401);
  await run('wrong project', { env: { SUPABASE_URL: 'https://wrong.invalid' } }, 503);
  await run('missing worker secret', { env: { EMAIL_WORKER_SECRET: undefined } }, 503);
  await run('test recipient no longer required', { env: { EMAIL_TEST_RECIPIENT: undefined } }, 200, 1);
  await run('invalid JSON', { raw: '{' }, 400);
  await run('invalid identifiers', { body: { appointmentId: 'bad', patientId: patient, token } }, 400);
  await run('invalid portal token', { body: { appointmentId: appointment, patientId: patient, token: '<script>' } }, 400);
  for (const [table, field, value, status] of [
    ['appointments', 'psychologist_id', other, 404], ['appointments', 'patient_id', other, 404],
    ['appointments', 'deleted_at', '2030-01-01', 404], ['patients', 'psychologist_id', other, 404],
    ['patients', 'deleted_at', '2030-01-01', 404], ['patients', 'email', '', 400],
    ['patient_access_links', 'appointment_id', other, 400], ['patient_access_links', 'patient_id', other, 400],
    ['patient_access_links', 'created_by', other, 400], ['patient_access_links', 'is_revoked', true, 400],
    ['patient_access_links', 'expires_at', '2000-01-01T00:00:00Z', 400], ['patient_access_links', 'expires_at', null, 400],
    ['appointments', 'scheduled_at', 'invalid', 400],
  ]) await run(table + '.' + field, { edit: f => f[table][0][field] = value }, status);
  for (const table of ['appointments', 'patients', 'patient_access_links', 'profiles']) await run('database error ' + table, { dbError: table }, 503);
  await run('upstream authentication failure', { upstreamStatus: 401 }, 502, 1);
  await run('upstream unavailable', { upstreamStatus: 503 }, 502, 1);
  await run('suppressed is not success', { response: { success: false, reason: 'email_suppressed' } }, 502, 1);
  await run('missing queue acknowledgement', { response: { success: true, messageId: 'id' } }, 502, 1);
  await run('missing message id', { response: { success: true, queued: true } }, 502, 1);
  await run('invalid response JSON', { rawResponse: '<html>' }, 502, 1);
  await run('network failure', { throwFetch: true }, 500, 1);
  await run('valid request queued only', {}, 200, 1);
  await run('already sent', {alreadySent:true,response:{success:true,queued:false,sent:true,already_sent:true,messageId:'id'}},200,1);
  await run('immediate delivery accepted', {alreadySent:true,response:{success:true,queued:false,sent:true,already_sent:true,messageId:'id'}},200,1);
  await run('contradictory response', {response:{success:true,queued:true,sent:true,already_sent:true,messageId:'id'}},502,1);
  console.log(`PASS ${passed} synthetic authorization, linkage, allowlist and queue-contract scenarios. No network or database writes.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

