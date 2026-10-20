import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

type CalendarAppointment = {
  id: string;
  scheduled_at: string;
  duration_minutes: number | null;
  type: string | null;
  google_event_id: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildEvent(appointment: CalendarAppointment) {
  const startTime = new Date(appointment.scheduled_at);
  const duration = appointment.duration_minutes || 50;
  const endTime = new Date(startTime.getTime() + duration * 60000);

  return {
    summary: "Compromisso — PsicoOne",
    description: "Agendamento gerenciado pelo PsicoOne.",
    start: { dateTime: startTime.toISOString(), timeZone: "America/Sao_Paulo" },
    end: { dateTime: endTime.toISOString(), timeZone: "America/Sao_Paulo" },
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { psicooneAppointmentId: appointment.id } },
  };
}


async function createOrRecoverEvent(api: string, accessToken: string, userId: string, appointmentId: string, event: ReturnType<typeof buildEvent>) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([SUPABASE_URL, userId, appointmentId])));
  const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const created = await fetch(api, { method: "POST", headers, signal: AbortSignal.timeout(15000), body: JSON.stringify({ ...event, id }) });
  if (created.ok) {
    const data = await created.json();
    return data.id === id ? { id, status: 200 } : { id: null, status: 502 };
  }
  if (created.status !== 409) return { id: null, status: created.status };
  // A retry may find an event created before its database link was saved.
  const existing = await fetch(`${api}/${id}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!existing.ok) return { id: null, status: 502 };
  const data = await existing.json();
  if (data.id !== id || data.status === "cancelled" || data.extendedProperties?.private?.psicooneAppointmentId !== appointmentId) return { id: null, status: 409 };
  return { id, status: 200 };
}

async function getValidAccessToken(serviceClient: any, userId: string): Promise<string | null> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  const { data: tokenData, error: tokenError } = await serviceClient
    .from("google_calendar_tokens")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (tokenError || !tokenData || typeof tokenData.access_token !== "string" || !tokenData.access_token) return null;

  // Check if token is expired (with 5 min buffer)
  const expiresAt = new Date(tokenData.token_expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return tokenData.access_token;
  }

  // Refresh token
  if (typeof tokenData.refresh_token !== "string" || !tokenData.refresh_token) return null;
  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokenData.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const refreshData = await refreshRes.json();
  if (!refreshRes.ok || typeof refreshData.access_token !== "string" || !refreshData.access_token || !Number.isFinite(refreshData.expires_in) || refreshData.expires_in <= 0 || refreshData.expires_in > 86400) {
    console.error("Token refresh failed");
    return null;
  }

  const newExpiresAt = new Date(Date.now() + refreshData.expires_in * 1000).toISOString();
  const { data: savedToken, error: saveError } = await serviceClient
    .from("google_calendar_tokens")
    .update({
      access_token: refreshData.access_token,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .select("user_id")
    .maybeSingle();

  if (saveError || !savedToken) return null;

  return refreshData.access_token;
}

const TEST_MARKER = "migration-check-2026-10-20-v2";
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (SUPABASE_URL !== "https://jeguvjpfuyksqiqrrvyz.supabase.co" || Date.now() >= Date.parse("2026-10-20T16:00:00Z")) return json({ error: "Test closed" }, 403);
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY!, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return json({ error: "Unauthorized" }, 401);
    if (await digest(user.id) !== "22ed549770256ec3622d65f18479d82a0e09b4349879f7f661473453fed8b250") return json({ error: "Forbidden" }, 403);
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY!);
    const { data: prefs, error: prefsError } = await service.from("google_calendar_tokens")
      .select("google_email, sync_enabled, auto_create, auto_update").eq("user_id", user.id).single();
    if (prefsError || !prefs || prefs.sync_enabled !== false || prefs.auto_create !== false || prefs.auto_update !== false ||
        await digest(String(prefs.google_email).trim().toLowerCase()) !== "970d02b0923c8fcb887a0fb2247927a6d75c53bff35f28246969034795429f49") return json({ error: "Test prerequisites failed" }, 409);
    const token = await getValidAccessToken(service, user.id);
    if (!token) return json({ error: "Reconnect Google" }, 401);
    // Fixed payload: request bodies cannot select a patient, event, calendar or time.
    const appointment = { id: TEST_MARKER, scheduled_at: "2026-10-20T15:30:00Z", duration_minutes: 5, type: null, google_event_id: null };
    const event = { ...buildEvent(appointment), summary: "TESTE PSICOONE — SEM PACIENTE", description: "Validação técnica da migração. Evento fictício." };
    const api = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const result = await createOrRecoverEvent(api, token, user.id, TEST_MARKER, event);
    if (!result.id) return json({ error: "Test create/recovery failed", provider_status: result.status }, 502);
    const url = `${api}/${result.id}`;
    let verified = false;
    let cleaned = false;
    try {
      const repeated = await createOrRecoverEvent(api, token, user.id, TEST_MARKER, event);
      if (repeated.id !== result.id) throw new Error("Repeat mismatch");
      const before = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const record = await before.json();
      if (!before.ok || record.extendedProperties?.private?.psicooneAppointmentId !== TEST_MARKER || record.summary !== event.summary) throw new Error("Marker mismatch");
      const end = { dateTime: "2026-10-20T15:36:00Z", timeZone: "America/Sao_Paulo" };
      const updated = await fetch(url, { method: "PATCH", headers, signal: AbortSignal.timeout(15000), body: JSON.stringify({ end }) });
      if (!updated.ok) throw new Error("Update failed");
      const read = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const saved = await read.json();
      verified = read.ok && saved.id === result.id && Date.parse(saved.end?.dateTime) === Date.parse(end.dateTime);
    } finally {
      // Recheck the exact synthetic marker before cleanup; never delete a supplied ID.
      const check = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const current = await check.json();
      if (check.ok && current.extendedProperties?.private?.psicooneAppointmentId === TEST_MARKER && current.summary === event.summary) {
        const removed = await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(15000) });
        if (removed.ok || removed.status === 404 || removed.status === 410) {
          const after = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
          cleaned = after.status === 404 || after.status === 410 || (after.ok && (await after.json()).status === "cancelled");
        }
      }
    }
    return json({ success: verified && cleaned, verified, cleaned, event_id: result.id }, verified && cleaned ? 200 : 502);
  } catch {
    return json({ error: "Test failed; inspect synthetic-event cleanup before retrying" }, 502);
  }
});
