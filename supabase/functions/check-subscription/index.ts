// Staging only. Authenticate, then let the UI read its local subscription.
const STAGING_URL = 'https://jeguvjpfuyksqiqrrvyz.supabase.co';
const headers = {
  'Access-Control-Allow-Origin': 'https://psicoone.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const reply = (status, body) => new Response(JSON.stringify(body), {status, headers});
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, {headers});
  if (req.method !== 'POST') return reply(405, {error: 'POST required'});
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (url !== STAGING_URL || !key) return reply(503, {error: 'Invalid staging configuration'});
  const auth = req.headers.get('Authorization');
  if (!auth?.match(/^Bearer\s+\S+$/i)) return reply(401, {error: 'Unauthorized'});
  try {
    const result = await fetch(`${url}/auth/v1/user`, {
      headers: {Authorization: auth, apikey: key}, signal: AbortSignal.timeout(10000),
    });
    if (result.status === 401 || result.status === 403) return reply(401, {error: 'Unauthorized'});
    if (!result.ok) return reply(503, {error: 'Authentication unavailable'});
    const user = await result.json();
    if (!user?.id) return reply(401, {error: 'Unauthorized'});
    // subscribed means an external Stripe subscription in existing callers.
    return reply(200, {subscribed: false, source: 'local', external_sync: false});
  } catch {
    return reply(503, {error: 'Authentication unavailable'});
  }
});
