// The approved synthetic rehearsal completed successfully on 2026-10-20.
// Closed intentionally: no credentials, database access or Google calls.
const headers = {
  "Access-Control-Allow-Origin": "https://psicoone.vercel.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
Deno.serve((req) => req.method === "OPTIONS"
  ? new Response(null, { status: 204, headers })
  : new Response(JSON.stringify({ code: "TEST_CLOSED", error: "Teste técnico encerrado." }), { status: 410, headers }));
