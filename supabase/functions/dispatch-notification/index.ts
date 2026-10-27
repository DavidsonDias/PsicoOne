// Central dispatcher: writes a notification row + fires Web Push respecting
// per-user category preferences. Called by DB triggers (via pg_net) and by
// any server-side code that needs to notify a user.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

interface DispatchPayload {
  user_id: string;
  category: string;        // 'agenda' | 'financeiro' | 'prontuario' | 'paciente' | 'sistema'
  type?: string;           // legacy UI type
  title: string;
  message: string;
  action_path?: string | null;
  action_label?: string | null;
  metadata?: Record<string, unknown>;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROJECT_FUNCTIONS = `${SUPABASE_URL}/functions/v1`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Server-to-server only. Accept SERVICE_ROLE_KEY (used by pg_net triggers)
  // or an INTERNAL_FUNCTION_SECRET / CRON_SECRET; reject anon callers.
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "")
    || req.headers.get("x-internal-secret");
  const allowed = new Set(
    [
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    ].filter(Boolean) as string[],
  );
  if (!token || !allowed.has(token)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }


  try {
    const body = (await req.json()) as DispatchPayload;
    if (!body?.user_id || !body?.title || !body?.category) {
      return new Response(JSON.stringify({ error: "user_id, title and category are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Insert notification (in-app inbox)
    const { data: inserted, error: insertErr } = await supabase
      .from("notifications")
      .insert({
        user_id: body.user_id,
        category: body.category,
        type: body.type || body.category,
        title: body.title,
        message: body.message,
        action_path: body.action_path ?? null,
        action_label: body.action_label ?? null,
        metadata: body.metadata ?? {},
      })
      .select("id")
      .single();

    if (insertErr) {
      return new Response(JSON.stringify({ error: "Falha ao registrar notificação" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Read user preference for this category (default: enabled)
    const { data: prefs } = await supabase
      .from("user_preferences")
      .select("settings")
      .eq("user_id", body.user_id)
      .maybeSingle();

    const settings = (prefs?.settings ?? {}) as Record<string, any>;
    const pushPrefs = (settings.push_categories ?? {}) as Record<string, boolean>;
    const pushEnabledGlobal = settings.push_enabled !== false;
    const pushEnabledCategory = pushPrefs[body.category] !== false;

    if (pushEnabledGlobal && pushEnabledCategory) {
      // Fire-and-forget push
      try {
        await fetch(`${PROJECT_FUNCTIONS}/send-push`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
            apikey: SERVICE_KEY,
          },
          body: JSON.stringify({
            user_ids: [body.user_id],
            category: body.category,
            title: body.title,
            body: body.message,
            url: body.action_path || "/notificacoes",
            tag: `${body.category}:${inserted?.id ?? Date.now()}`,
            notification_id: inserted?.id,
          }),
        });
      } catch (e) {
        console.error("[dispatch-notification] push error", e);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, notification_id: inserted?.id ?? null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[dispatch-notification] fatal", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
