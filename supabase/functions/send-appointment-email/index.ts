import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireUser } from "../_shared/require-auth.ts";

const site = "https://psicoone.vercel.app";
const corsHeaders = {
  "Access-Control-Allow-Origin": site,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "POST required" });
  try {
    const auth = await requireUser(req, corsHeaders);
    if ("error" in auth) return auth.error;
    const url = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const secret = Deno.env.get("EMAIL_WORKER_SECRET");
    if (url !== "https://jeguvjpfuyksqiqrrvyz.supabase.co" || !key || !secret || secret.length < 32) {
      return reply(503, { error: "Invalid staging configuration" });
    }
    let body;
    try { body = await req.json(); } catch { return reply(400, { error: "Invalid JSON" }); }
    const { appointmentId, patientId, token } = body ?? {};
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof appointmentId !== "string" || !uuid.test(appointmentId) || typeof patientId !== "string" || !uuid.test(patientId) ||
        typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      return reply(400, { error: "Dados da consulta ou token inválidos" });
    }
    const db = createClient(url, key);
    // Scope every privileged lookup to the verified caller and linked records.
    const { data: apt, error: aptError } = await db.from("appointments")
      .select("scheduled_at, duration_minutes, type, psychologist_id, patient_id")
      .eq("id", appointmentId).eq("psychologist_id", auth.user.id)
      .eq("patient_id", patientId).is("deleted_at", null).maybeSingle();
    if (aptError) return reply(503, { error: "Falha ao consultar agendamento" });
    if (!apt || apt.psychologist_id !== auth.user.id || apt.patient_id !== patientId) return reply(404, { error: "Agendamento não encontrado" });
    const { data: patient, error: patientError } = await db.from("patients")
      .select("full_name, email, psychologist_id")
      .eq("id", patientId).eq("psychologist_id", auth.user.id).is("deleted_at", null).maybeSingle();
    if (patientError) return reply(503, { error: "Falha ao consultar paciente" });
    if (!patient || patient.psychologist_id !== auth.user.id) return reply(404, { error: "Paciente não encontrado" });
    const recipient = typeof patient.email === "string" ? patient.email.trim().toLowerCase() : "";
    if (!/^[^\s<>;,]+@[^\s<>;,]+\.[^\s<>;,]+$/.test(recipient)) {
      return reply(400, { error: "Cadastre um e-mail válido para o paciente.", code: "PATIENT_EMAIL_MISSING" });
    }
    const { data: link, error: linkError } = await db.from("patient_access_links")
      .select("id, expires_at, is_revoked, appointment_id, patient_id, created_by")
      .eq("token", token).eq("appointment_id", appointmentId).eq("patient_id", patientId)
      .eq("created_by", auth.user.id).eq("is_revoked", false).maybeSingle();
    if (linkError) return reply(503, { error: "Falha ao validar link" });
    if (!link || link.is_revoked !== false || link.appointment_id !== appointmentId || link.patient_id !== patientId ||
        link.created_by !== auth.user.id || !Number.isFinite(Date.parse(link.expires_at)) || Date.parse(link.expires_at) <= Date.now()) {
      return reply(400, { error: "Link inválido ou expirado" });
    }
    const { data: prof, error: profError } = await db.from("profiles")
      .select("full_name, clinic_name").eq("id", auth.user.id).maybeSingle();
    if (profError) return reply(503, { error: "Falha ao consultar profissional" });
    const date = new Date(apt.scheduled_at);
    if (!Number.isFinite(date.getTime())) return reply(400, { error: "Data da consulta inválida" });
    const portalUrl = `${site}/portal/${token}`;
    const response = await fetch(`${url}/functions/v1/send-transactional-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-email-worker-secret": secret },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        delivery: "immediate", templateName: "appointment-confirmation", recipientEmail: recipient,
        idempotencyKey: `apt-confirm-${appointmentId}-${link.id}`,
        templateData: {
          patientName: patient.full_name.split(" ")[0],
          date: date.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" }),
          time: date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }),
          duration: String(apt.duration_minutes || 50), type: apt.type || "presential",
          psychologistName: prof?.full_name, clinicName: prof?.clinic_name, portalUrl,
        },
        metadata: { appointment_id: appointmentId, patient_id: patientId },
      }),
    });
    const result = await response.json().catch(() => null);
    if (response.ok && result?.success === true &&
        result?.sent === true && result?.queued === false && typeof result?.messageId === "string" && result.messageId) {
      return reply(200, { sent: true, queued: false, already_sent: result.already_sent === true, portalUrl, messageId: result.messageId });
    }
    if (!response.ok || result?.success !== true || result?.queued !== true || result?.sent !== false || typeof result?.messageId !== "string" || !result.messageId) {
      return reply(502, { sent: false, queued: false, error: "Não foi possível confirmar o envio do e-mail" });
    }
    return reply(200, { sent: false, queued: true, manual_processing: true, portalUrl, messageId: result.messageId });
  } catch {
    // Never log tokens, credentials, clinical content or upstream response bodies.
    return reply(500, { sent: false, queued: false, error: "Erro interno" });
  }
});

