import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireUser } from "../_shared/require-auth.ts";

const site = "https://psicoone.vercel.app";
const headers = {
  "Access-Control-Allow-Origin": site,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "POST required" });
  try {
    const auth = await requireUser(req, headers);
    if ("error" in auth) return auth.error;
    const url = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const secret = Deno.env.get("EMAIL_WORKER_SECRET");
    if (url !== "https://jeguvjpfuyksqiqrrvyz.supabase.co" || !key || !secret || secret.length < 32) {
      return reply(503, { error: "Invalid staging configuration" });
    }
    let body;
    try { body = await req.json(); } catch { return reply(400, { error: "Invalid JSON" }); }
    const patientId = body?.patient_id;
    if (typeof patientId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patientId)) {
      return reply(400, { error: "Paciente inválido" });
    }
    const db = createClient(url, key);
    const { data: patient, error: patientError } = await db.from("patients")
      .select("id, full_name, email, psychologist_id, user_id")
      .eq("id", patientId).eq("psychologist_id", auth.user.id).is("deleted_at", null).maybeSingle();
    if (patientError) return reply(503, { error: "Falha ao consultar paciente" });
    if (!patient || patient.psychologist_id !== auth.user.id) return reply(404, { error: "Paciente não encontrado" });
    if (patient.user_id) return reply(409, { error: "Paciente já tem acesso ativo ao portal" });
    const recipient = typeof patient.email === "string" ? patient.email.trim().toLowerCase() : "";
    if (!/^[^\s<>;,]+@[^\s<>;,]+\.[^\s<>;,]+$/.test(recipient)) {
      return reply(400, { error: "Cadastre um e-mail válido para o paciente.", code: "PATIENT_EMAIL_MISSING" });
    }
    const { data: profile, error: profileError } = await db.from("profiles")
      .select("full_name").eq("id", auth.user.id).maybeSingle();
    if (profileError) return reply(503, { error: "Falha ao consultar profissional" });
    const { data: pending, error: pendingError } = await db.from("patient_invites")
      .select("id, token, expires_at, email").eq("patient_id", patientId)
      .eq("psychologist_id", auth.user.id).eq("email", recipient)
      .eq("is_revoked", false).is("accepted_at", null)
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (pendingError) return reply(503, { error: "Falha ao consultar convite" });
    let invite = pending;
    if (!invite) {
      const { data, error } = await db.from("patient_invites")
        .insert({ patient_id: patientId, psychologist_id: auth.user.id, email: recipient })
        .select("id, token, expires_at, email").single();
      if (error || !data) return reply(503, { error: "Falha ao criar convite" });
      invite = data;
    }
    // Existing valid invites survive queue failures. No automatic revocation or delivery.
    if (typeof invite.token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(invite.token) ||
        !Number.isFinite(Date.parse(invite.expires_at)) || Date.parse(invite.expires_at) <= Date.now()) {
      return reply(503, { error: "Convite inválido" });
    }
    const inviteUrl = site + "/portal/aceitar-convite/" + invite.token;
    let queued = false;
    let alreadySent = false;
    try {
      const response = await fetch(url + "/functions/v1/send-transactional-email", {
        method: "POST", headers: { "Content-Type": "application/json", "x-email-worker-secret": secret },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          delivery: "immediate", templateName: "patient-portal-invite", recipientEmail: recipient,
          idempotencyKey: "patient-invite-" + invite.id,
          templateData: {
            patientName: patient.full_name, psychologistName: profile?.full_name || "Seu profissional",
            inviteUrl, expiresInDays: Math.max(1, Math.ceil((Date.parse(invite.expires_at) - Date.now()) / 86400000)),
          },
          metadata: { patient_id: patientId },
        }),
      });
      const result = await response.json().catch(() => null);
      alreadySent = response.ok && result?.success === true && result?.queued === false &&
        result?.sent === true &&
        typeof result?.messageId === "string" && result.messageId.length > 0;
      queued = response.ok && result?.success === true && result?.queued === true && result?.sent === false &&
        typeof result?.messageId === "string" && result.messageId.length > 0;
    } catch { /* Keep the invitation available for a manual retry. */ }
    return reply(200, {
      success: true, invite_url: inviteUrl, expires_at: invite.expires_at,
      email_sent: alreadySent,  email_queued: queued, manual_processing: queued,
      email_error: queued || alreadySent ? null : "Não foi possível confirmar o envio do e-mail",
    });
  } catch {
    return reply(500, { error: "Erro interno ao criar convite" });
  }
});
