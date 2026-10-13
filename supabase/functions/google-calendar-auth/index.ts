import { unvalidatedIntegrationResponse } from "../_shared/staging-isolation.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  const migrationPause = unvalidatedIntegrationResponse(req);
  if (migrationPause) return migrationPause;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    const body = await req.json();
    const { action, code, redirect_uri, sync_enabled, auto_create, auto_update, sync_new_only } = body;

    // Generate OAuth URL
    if (action === "get_auth_url") {
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email",
        access_type: "offline",
        prompt: "consent",
        state: userId,
      });
      return new Response(JSON.stringify({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Exchange code for tokens
    if (action === "exchange_code") {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
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

      // Get user email
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userInfo = await userInfoRes.json();

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

      return new Response(JSON.stringify({ connected: !!data, ...(data || {}) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update preferences
    if (action === "update_preferences") {
      const { error } = await supabase
        .from("google_calendar_tokens")
        .update({ sync_enabled, auto_create, auto_update, sync_new_only, updated_at: new Date().toISOString() })
        .eq("user_id", userId);

      if (error) {
        return new Response(JSON.stringify({ error: "Erro ao atualizar preferências" }), { status: 500, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("Google Calendar request failed");
    return new Response(JSON.stringify({ error: "Erro interno na integração com Google Agenda" }), { status: 500, headers: corsHeaders });
  }
});
