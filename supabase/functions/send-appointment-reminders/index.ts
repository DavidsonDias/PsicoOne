// Sends configurable reminders ahead of upcoming appointments.
// Triggered by pg_cron every 5–15 minutes.
//
// Strategy:
// - For each enabled offset (in minutes) from the psychologist's preferences,
//   find appointments scheduled in [now + offset - WINDOW/2, now + offset + WINDOW/2].
// - A deterministic key identifies each reminder; atomic queue deduplication is a separate concern.
// Staging defaults to dry-run. No scheduler or worker is activated by this function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://psicoone.vercel.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-email-worker-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const DEFAULT_OFFSETS_MIN = [1440, 180, 60, 15];
// Half-window in minutes around each offset. Must cover the cron interval.
const HALF_WINDOW: Record<number, number> = {
  1440: 15, // 24h ± 15min
  720: 15,
  180: 10,
  120: 10,
  60: 10,
  30: 7,
  15: 5,
};

interface AptRow {
  id: string;
  patient_id: string;
  psychologist_id: string;
  scheduled_at: string;
  duration_minutes: number | null;
  type: string | null;
  status: string | null;
  patients: { full_name: string; email: string | null; psychologist_id: string; deleted_at: string | null } | null;
}

Deno.serve(async (req) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "POST required" });
  const secret = Deno.env.get("EMAIL_WORKER_SECRET");
  if (!secret || secret.length < 32 || req.headers.get("x-email-worker-secret") !== secret) {
    return reply(403, { error: "Forbidden" });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const recipient = Deno.env.get("EMAIL_TEST_RECIPIENT")?.trim().toLowerCase();
  if (supabaseUrl !== "https://jeguvjpfuyksqiqrrvyz.supabase.co" || !serviceKey || !recipient) {
    return reply(503, { error: "Invalid staging configuration" });
  }
  let body;
  try { body = await req.json(); } catch { return reply(400, { error: "Invalid JSON" }); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      (body.dry_run !== undefined && typeof body.dry_run !== "boolean")) return reply(400, { error: "Invalid dry_run" });
  const dryRun = body.dry_run !== false;
  try {
  const supabase = createClient(supabaseUrl, serviceKey);
  const now = new Date();
  const stats: Record<string, number> = { checked: 0, eligible: 0, queued: 0, sent: 0, already_sent: 0, skipped: 0, failed: 0 };

  // Map psychologist_id -> enabled offsets
  const { data: prefRows, error: prefError } = await supabase
    .from("user_preferences")
    .select("user_id, settings");
  if (prefError) return reply(503, { error: "Falha ao consultar preferências" });
  const prefMap = new Map<string, number[]>();
  for (const r of (prefRows ?? []) as any[]) {
    const list = r?.settings?.reminder_minutes;
    if (Array.isArray(list)) prefMap.set(r.user_id, list.filter((m: unknown) => typeof m === "number" && Number.isInteger(m) && m > 0 && m <= 10080));
  }

  // All offsets that might be enabled across users
  const allOffsets = new Set<number>(DEFAULT_OFFSETS_MIN);
  prefMap.forEach((arr) => arr.forEach((m) => allOffsets.add(m)));

  for (const offset of allOffsets) {
    const half = HALF_WINDOW[offset] ?? 10;
    const from = new Date(now.getTime() + (offset - half) * 60_000).toISOString();
    const to = new Date(now.getTime() + (offset + half) * 60_000).toISOString();

    const { data: apts, error } = await supabase
      .from("appointments")
      .select("id, patient_id, psychologist_id, scheduled_at, duration_minutes, type, status, patients(full_name, email, psychologist_id, deleted_at)")
      .gte("scheduled_at", from)
      .lt("scheduled_at", to)
      .is("deleted_at", null)
      .in("status", ["scheduled", "confirmed"])
      .returns<AptRow[]>();

    if (error) {
      stats.failed++;
      continue;
    }
    if (!apts?.length) continue;

    for (const apt of apts) {
      stats.checked++;
      if (!apt.patients?.email || apt.patients.email.trim().toLowerCase() !== recipient ||
          apt.patients.psychologist_id !== apt.psychologist_id || apt.patients.deleted_at !== null) { stats.skipped++; continue; }

      // Honor psychologist preference (fallback to defaults)
      const enabled = prefMap.get(apt.psychologist_id) ?? DEFAULT_OFFSETS_MIN;
      if (!enabled.includes(offset)) { stats.skipped++; continue; }

      const idempotencyKey = `apt-rem-${offset}-${apt.id}`;

      // Dedup via email_send_log
      const { data: existing, error: historyError } = await supabase
        .from("email_send_log")
        .select("id")
        .eq("template_name", "appointment-reminder")
        .eq("metadata->>idempotency_key", idempotencyKey)
        .in("status", ["pending", "sent"])
        .limit(1)
        .maybeSingle();
      if (historyError) { stats.failed++; continue; }
      if (existing) { stats.skipped++; continue; }
      stats.eligible++;
      if (dryRun) continue;

      const { data: prof, error: profileError } = await supabase
        .from("profiles")
        .select("full_name, clinic_name")
        .eq("id", apt.psychologist_id)
        .single();

      if (profileError || !prof) { stats.failed++; continue; }
      const aptTime = new Date(apt.scheduled_at).getTime();
      if (!Number.isFinite(aptTime)) { stats.failed++; continue; }
      const linkExpiresAt = new Date(aptTime + 6 * 60 * 60_000).toISOString();
      const { data: link, error: linkError } = await supabase
        .from("patient_access_links")
        .insert({
          patient_id: apt.patient_id,
          appointment_id: apt.id,
          created_by: apt.psychologist_id,
          expires_at: linkExpiresAt,
        })
        .select("token")
        .single();

      if (linkError || typeof link?.token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(link.token)) { stats.failed++; continue; }
      const portalUrl = link?.token ? `https://psicoone.vercel.app/portal/${link.token}` : undefined;
      const dateStr = new Date(apt.scheduled_at).toLocaleDateString("pt-BR", {
        weekday: "long", day: "2-digit", month: "long", year: "numeric",
        timeZone: "America/Sao_Paulo",
      });
      const timeStr = new Date(apt.scheduled_at).toLocaleTimeString("pt-BR", {
        hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
      });

      // Friendly label per offset
      const label =
        offset >= 1440 ? "24 horas" :
        offset >= 60 ? `${Math.round(offset / 60)} hora${offset >= 120 ? "s" : ""}` :
        `${offset} minutos`;

      try {
      const sendRes = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-email-worker-secret": secret,
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          templateName: "appointment-reminder",
          recipientEmail: recipient,
          idempotencyKey,
          templateData: {
            patientName: apt.patients.full_name.split(" ")[0],
            date: dateStr,
            time: timeStr,
            duration: String(apt.duration_minutes || 50),
            type: apt.type || "presential",
            psychologistName: prof?.full_name,
            clinicName: prof?.clinic_name,
            portalUrl,
            hoursAhead: String(offset / 60),
            offsetLabel: label,
          },
          metadata: {
            appointment_id: apt.id,
            patient_id: apt.patient_id,
            idempotency_key: idempotencyKey,
            offset_minutes: offset,
          },
        }),
      });

      const result = await sendRes.json().catch(() => null);
      if (sendRes.ok && result?.success === true && result?.queued === true && result?.sent === false &&
          typeof result?.messageId === "string" && result.messageId.length > 0) stats.queued++;
      else if (sendRes.ok && result?.success === true && result?.queued === false &&
          result?.sent === true && result?.already_sent === true &&
          typeof result?.messageId === "string" && result.messageId.length > 0) stats.already_sent++;
      else stats.failed++;
      } catch { stats.failed++; }
    }
  }

  return reply(stats.failed ? 503 : 200, { ok: stats.failed === 0, dry_run: dryRun, manual_processing: true, stats });
  } catch {
    return reply(500, { error: "Falha ao processar lembretes" });
  }
});
