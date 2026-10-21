import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const headers = {
  'Access-Control-Allow-Origin': 'https://psicoone.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};


Deno.serve(async (req: Request) => {
  const allowedOrigins = new Set([
    'https://psicoone.vercel.app',
    'https://psicoonex-git-codex-admin-account-emails-davidson-dias-projects.vercel.app',
  ]);
  const origin = req.headers.get('Origin') || '';
  const responseHeaders = {...headers, 'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://psicoone.vercel.app', Vary: 'Origin'};
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: responseHeaders});
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: responseHeaders});
  if (req.method !== 'POST') return reply(405, {error: 'POST required'});
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return reply(401, {error: 'Authentication required'});
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (url !== 'https://jeguvjpfuyksqiqrrvyz.supabase.co' || !key) return reply(503, {error: 'Invalid staging configuration'});
  try {
    const admin = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
    const {data: auth, error: authError} = await admin.auth.getUser(token);
    if (authError || !auth?.user) return reply(401, {error: 'Invalid authentication'});
    // Authorization comes only from server-managed roles, never user_metadata.
    const {data: role, error: roleError} = await admin.from('user_roles').select('role')
      .eq('user_id', auth.user.id).eq('role', 'super_admin').maybeSingle();
    if (roleError) return reply(503, {error: 'Unable to verify permission'});
    if (!role) return reply(403, {error: 'Super administrator required'});
    let body;
    try { body = await req.json(); } catch { return reply(400, {error: 'Invalid JSON'}); }
    const ids = body?.userIds;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      return reply(400, {error: 'Expected at most 100 user IDs'});
    }
    const users: {id: string; email: string | null}[] = [];
    for (const id of new Set<string>(ids)) {
      const {data, error} = await admin.auth.admin.getUserById(id);
      if (error) return reply(503, {error: 'Unable to retrieve account emails'});
      users.push({id, email: data?.user?.email ?? null});
    }
    return reply(200, {users});
  } catch {
    return reply(503, {error: 'Unable to retrieve account emails'});
  }
});