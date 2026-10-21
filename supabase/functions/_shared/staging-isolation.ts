// PsicoOneX migration boundary. Reopening an integration requires a reviewed code change.
// Do not add an environment-variable bypass: restored credentials may still be valid.
export function unvalidatedIntegrationResponse(req: Request): Response | null {
  const headers = {
    'Access-Control-Allow-Origin': 'https://psicoone.vercel.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret, x-cron-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({
    code: 'STAGING_INTEGRATION_PAUSED',
    error: 'Esta integração está pausada no ambiente de testes enquanto a migração é validada.',
  }), { status: 503, headers });
}
