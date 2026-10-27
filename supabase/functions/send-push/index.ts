import { requireUser } from "../_shared/require-auth.ts";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

interface PushPayload {
  user_id?: string;
  user_ids?: string[];
  category?: string;
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  notification_id?: string;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY =
  "BKRI8h33q05bBu_SsOsooBzxYiEDhm2rrnuz5rj7S1qL2ZsvoF-rwh8mZuYjKOrNRIqP-4keRkYzYZqGTCDTwYg";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:contato@sevendevx.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") return new Response(null, { status: 405, headers: corsHeaders });
  // Browser tests are restricted to the verified user; internal sends require the service key.
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "")
    || req.headers.get("x-internal-secret");
  const allowed = new Set(
    [
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    ].filter(Boolean) as string[],
  );
  let callerId: string | null = null;
  if (!token || !allowed.has(token)) {
    const auth = await requireUser(req, corsHeaders);
    if ("error" in auth) return auth.error;
    callerId = auth.user.id;
  }

  try {
    const payload = (await req.json()) as PushPayload;
    if (callerId) {
      if (payload.user_id && payload.user_id !== callerId || payload.user_ids?.some(id => id !== callerId)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      Object.assign(payload, { user_id: callerId, user_ids: [callerId], title: "Teste de notificação", body: "As notificações do PsicoOne estão funcionando.", url: "/configuracoes/diagnostico-push", tag: "diag-test" });
    }
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    } catch {
      return new Response(JSON.stringify({ ok: false, code: "PUSH_CONFIGURATION_INVALID", error: "As credenciais de push do servidor precisam ser configuradas." }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!payload?.title) {
      return new Response(JSON.stringify({ error: "title is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const userIds = payload.user_ids?.length ? payload.user_ids : payload.user_id ? [payload.user_id] : [];
    // Require an explicit user scope — never broadcast to every subscriber.
    if (!userIds.length) {
      return new Response(JSON.stringify({ error: "user_id or user_ids is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("*")
      .in("user_id", userIds);
    if (error) throw error;


    const notification = {
      title: payload.title,
      body: payload.body || "",
      url: payload.url || "/",
      tag: payload.tag || payload.category || "psicoone",
      category: payload.category,
      notification_id: payload.notification_id,
    };

    const results = await Promise.allSettled(
      (subs || []).map(async (s: any) => {
        try {
          const endpoint = new URL(s.endpoint);
          const approvedHost = endpoint.hostname === "fcm.googleapis.com" || endpoint.hostname === "web.push.apple.com" || endpoint.hostname.endsWith(".push.services.mozilla.com") || endpoint.hostname.endsWith(".notify.windows.com");
          if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password || !approvedHost) return { ok: false };
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(notification)
          );
          return { endpoint: s.endpoint, ok: true };
        } catch (e: any) {
          // Clean up expired/invalid subscriptions
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          }
          return { endpoint: s.endpoint, ok: false, error: String(e?.message || e) };
        }
      })
    );

    const sent = results.filter((r) => r.status === "fulfilled" && (r as any).value.ok).length;
    return new Response(JSON.stringify({ ok: sent > 0, total: subs?.length || 0, sent, error: sent ? undefined : (subs?.length ? "O provedor recusou o envio. Verifique as credenciais de push." : "Nenhum dispositivo registrado nesta conta. Ative as notificações novamente.") }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[send-push] delivery failed");
    return new Response(JSON.stringify({ ok: false, error: "Falha no envio de push" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
