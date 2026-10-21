import { unvalidatedIntegrationResponse } from "../_shared/staging-isolation.ts";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

type ChannelResult = {
  status: "ok" | "warn" | "fail";
  label: string;
  detail: string;
  meta?: Record<string, unknown>;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const migrationPause = unvalidatedIntegrationResponse(req);
  if (migrationPause) return migrationPause;

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const user = userData.user;
    const origin = req.headers.get("origin") || "https://psicoone.vercel.app";
    const runId = crypto.randomUUID();

    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, notification_emails")
      .eq("id", user.id)
      .maybeSingle();

    const configuredEmails = Array.isArray((profile as any)?.notification_emails)
      ? (profile as any).notification_emails
      : [];
    const candidates = Array.from(new Set([...configuredEmails, user.email].filter(Boolean))) as string[];
    const { data: suppressedRows } = candidates.length
      ? await supabase.from("suppressed_emails").select("email").in("email", candidates.map((e) => e.toLowerCase()))
      : { data: [] as any[] };
    const suppressed = new Set((suppressedRows || []).map((r: any) => String(r.email).toLowerCase()));
    const recipientEmail = candidates.find((email) => !suppressed.has(email.toLowerCase()));

    const internalPromise = (async (): Promise<ChannelResult> => {
      const { data, error } = await supabase
        .from("notifications")
        .insert({
          user_id: user.id,
          category: "system",
          type: "diagnostic",
          title: "Teste completo de notificações",
          message: "Notificação interna registrada com sucesso.",
          action_path: "/configuracoes/diagnostico-notificacoes",
          action_label: "Abrir diagnóstico",
          metadata: { run_id: runId, channel: "internal" },
        })
        .select("id")
        .single();
      if (error) return { status: "fail", label: "Notificação interna", detail: error.message };
      return { status: "ok", label: "Notificação interna", detail: "Registrada no sino e na central.", meta: { notification_id: data.id } };
    })();

    const pushPromise = (async (): Promise<ChannelResult> => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
        body: JSON.stringify({
          user_ids: [user.id],
          category: "system",
          title: "Teste completo de push",
          body: "Canal push validado pelo diagnóstico PsicoOne.",
          url: "/configuracoes/diagnostico-notificacoes",
          tag: `full-test-${runId}`,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok === false) return { status: "fail", label: "Push", detail: payload?.error || `HTTP ${res.status}` };
      if ((payload?.total ?? 0) === 0) return { status: "warn", label: "Push", detail: "Nenhum dispositivo inscrito para este usuário.", meta: payload };
      return { status: payload.sent > 0 ? "ok" : "warn", label: "Push", detail: `${payload.sent}/${payload.total} dispositivo(s) receberam.`, meta: payload };
    })();

    const emailPromise = (async (): Promise<ChannelResult> => {
      if (!recipientEmail) {
        const reason = candidates.length ? "Todos os e-mails estão bloqueados por descadastro." : "Nenhum e-mail disponível no perfil.";
        return { status: "warn", label: "E-mail", detail: reason, meta: { candidates, suppressed: [...suppressed] } };
      }

      const idempotencyKey = `full-test-${runId}`;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
        body: JSON.stringify({
          templateName: "psychologist-patient-action",
          recipientEmail,
          idempotencyKey,
          templateData: {
            psychologistName: (profile as any)?.full_name,
            patientName: "Diagnóstico PsicoOne",
            actionType: "diagnostic",
            message: "Este e-mail confirma que o pipeline transacional está ativo.",
            agendaUrl: `${origin}/configuracoes/diagnostico-notificacoes`,
          },
          metadata: { run_id: runId, channel: "email", idempotency_key: idempotencyKey },
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) return { status: "fail", label: "E-mail", detail: payload?.error || `HTTP ${res.status}` };

      const messageId = payload?.messageId;
      const { data: latest } = messageId
        ? await supabase
            .from("email_send_log")
            .select("status, error_message, created_at")
            .eq("message_id", messageId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : { data: null as any };
      const status = latest?.status || (payload?.queued ? "pending" : "unknown");
      if (status === "sent") return { status: "ok", label: "E-mail", detail: `Enviado para ${recipientEmail}.`, meta: { message_id: messageId } };
      if (status === "suppressed") return { status: "warn", label: "E-mail", detail: `${recipientEmail} está bloqueado por descadastro.`, meta: { message_id: messageId } };
      if (status === "failed" || status === "dlq") return { status: "fail", label: "E-mail", detail: latest?.error_message || "Falha no envio.", meta: { message_id: messageId } };
      return { status: "warn", label: "E-mail", detail: `E-mail enfileirado para ${recipientEmail}; processamento pendente.`, meta: { message_id: messageId, status } };
    })();

    const [internal, push, email] = await Promise.all([internalPromise, pushPromise, emailPromise]);
    const results = { internal, push, email };

    await supabase.from("audit_logs").insert({
      user_id: user.id,
      action_type: "notification_full_test",
      entity_type: "notification_pipeline",
      new_data: { run_id: runId, results },
    } as any);

    return json({ ok: true, run_id: runId, results });
  } catch (error) {
    console.error("[notification-full-test]", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});