import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const reply = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
    || req.headers.get('x-cron-secret') || req.headers.get('x-internal-secret');
  const allowed = new Set([
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), Deno.env.get('INTERNAL_FUNCTION_SECRET'),
    Deno.env.get('CRON_SECRET'),
  ].filter(Boolean));
  if (!token || !allowed.has(token)) return reply(403, { error: 'Forbidden' });
  if (req.method !== 'POST') return reply(405, { error: 'POST required' });

  let created = 0, skipped = 0, failed = 0;
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: plans, error } = await supabase.from('patient_billing_plans')
      .select('id').eq('active', true).is('deleted_at', null);
    if (error) return reply(500, { ok: false, code: 'BILLING_READ_FAILED' });
    for (const plan of plans || []) {
      // The database rechecks eligibility under a row lock and commits both writes together.
      const { data, error: generationError } = await supabase.rpc('generate_patient_billing_cycle', { p_plan_id: plan.id });
      if (generationError || typeof data?.created !== 'boolean') { failed++; continue; }
      if (data.created) created++; else skipped++;
    }
    return reply(failed ? 500 : 200, { ok: failed === 0, created, skipped, failed, plans: plans?.length || 0 });
  } catch {
    return reply(500, { ok: false, code: 'BILLING_PROCESSING_FAILED', created, skipped, failed });
  }
});

