import { unvalidatedIntegrationResponse } from "../_shared/staging-isolation.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const allowedReturns = new Set(['https://psicoonex.vercel.app/configuracoes', 'https://psicoone.vercel.app/configuracoes']);
const stateHash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const fail = (status: number) => new Response(JSON.stringify({ error: 'Conexão inválida ou expirada. Inicie novamente.' }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") return fail(405);
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }
    const userId = user.id;
    // Time-limited, reviewed connection test. Event synchronization remains paused.
    if (SUPABASE_URL !== "https://jeguvjpfuyksqiqrrvyz.supabase.co" ||
        Date.now() >= Date.parse("2026-10-20T09:30:00Z") ||
        await stateHash(userId) !== "22ed549770256ec3622d65f18479d82a0e09b4349879f7f661473453fed8b250") {
      return unvalidatedIntegrationResponse(req)!;
    }

    const body = await req.json();
    const { action, code, state, redirect_uri, sync_enabled, auto_create, auto_update, sync_new_only } = body;

    if (!["status", "get_auth_url", "exchange_code", "disconnect"].includes(action)) return unvalidatedIntegrationResponse(req)!;
    if (action === 'get_auth_url' || action === 'exchange_code') {
      if (typeof redirect_uri !== 'string' || redirect_uri !== 'https://psicoonex.vercel.app/configuracoes') return fail(400);
    }
    // Generate OAuth URL
    if (action === "get_auth_url") {
      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const attempts = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { error: attemptError } = await attempts.from('google_calendar_oauth_attempts').insert({ state_hash: await stateHash(oauthState), user_id: userId, redirect_uri });
      if (attemptError) return fail(503);
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email",
        access_type: "offline",
        prompt: "consent",
        state: oauthState,
      });
      return new Response(JSON.stringify({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state: oauthState, user_id: userId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Exchange code for tokens
    if (action === "exchange_code") {
      if (typeof state !== 'string' || !/^[0-9a-f]{64}$/.test(state) || typeof code !== 'string' || !code.trim() || code.length > 4096) return fail(400);
      const attempts = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: consumed, error: consumeError } = await attempts.rpc('consume_google_calendar_oauth_attempt', { p_state_hash: await stateHash(state), p_user_id: userId, p_redirect_uri: redirect_uri });
      if (consumeError) return fail(503);
      if (consumed !== true) return fail(400);
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        console.error("Google token exchange failed");
        return new Response(JSON.stringify({ error: "Falha na autenticação com Google" }), { status: 400, headers: corsHeaders });
      }

      if (typeof tokenData.access_token !== 'string' || !tokenData.access_token || typeof tokenData.refresh_token !== 'string' || !tokenData.refresh_token || !Number.isFinite(tokenData.expires_in) || tokenData.expires_in <= 0 || tokenData.expires_in > 86400) return fail(502);
      const grantedScopes = new Set(typeof tokenData.scope === "string" ? tokenData.scope.split(/\s+/) : []);
      if (!grantedScopes.has("https://www.googleapis.com/auth/calendar") || !grantedScopes.has("https://www.googleapis.com/auth/userinfo.email")) return fail(403);
      // Get user email
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userInfo = await userInfoRes.json();

      if (!userInfoRes.ok || typeof userInfo.email !== 'string' || !userInfo.email.includes('@') || userInfo.verified_email !== true) return fail(502);
      if (await stateHash(userInfo.email.trim().toLowerCase()) !== "970d02b0923c8fcb887a0fb2247927a6d75c53bff35f28246969034795429f49") return fail(403);
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      const serviceClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

      const { error: upsertError } = await serviceClient
        .from("google_calendar_tokens")
        .upsert({
          user_id: userId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          token_expires_at: expiresAt,
          google_email: userInfo.email,
          sync_enabled: false,
          auto_create: false,
          auto_update: false,
          sync_new_only: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

      if (upsertError) {
        console.error("Google Calendar token storage failed");
        return new Response(JSON.stringify({ error: "Erro ao salvar tokens" }), { status: 500, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, email: userInfo.email }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Disconnect
    if (action === "disconnect") {
      const serviceClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error: deleteError } = await serviceClient.from("google_calendar_tokens").delete().eq("user_id", userId);
      if (deleteError) return new Response(JSON.stringify({ error: "Não foi possível desconectar o Google Agenda" }), { status: 503, headers: corsHeaders });
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Status
    if (action === "status") {
      const { data, error: statusError } = await supabase
        .from("google_calendar_tokens")
        .select("google_email, sync_enabled, auto_create, auto_update, sync_new_only")
        .eq("user_id", userId)
        .maybeSingle();
      if (statusError) return new Response(JSON.stringify({ error: "Não foi possível consultar a conexão com Google Agenda" }), { status: 503, headers: corsHeaders });

      return new Response(JSON.stringify({ connected: !!data, ...(data || {}), migration_test: true, sync_enabled: false, auto_create: false, auto_update: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update preferences
    if (action === "update_preferences") {
      if ([sync_enabled, auto_create, auto_update, sync_new_only].some(value => typeof value !== "boolean")) return fail(400);
      const { data: updated, error } = await supabase
        .from("google_calendar_tokens")
        .update({ sync_enabled, auto_create, auto_update, sync_new_only, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .select("user_id")
        .maybeSingle();

      if (error) {
        return new Response(JSON.stringify({ error: "Erro ao atualizar preferências" }), { status: 500, headers: corsHeaders });
      }
      if (!updated) return new Response(JSON.stringify({ error: "Conecte sua conta Google antes de alterar as preferências" }), { status: 409, headers: corsHeaders });
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("Google Calendar request failed");
    return new Response(JSON.stringify({ error: "Erro interno na integração com Google Agenda" }), { status: 500, headers: corsHeaders });
  }
});




