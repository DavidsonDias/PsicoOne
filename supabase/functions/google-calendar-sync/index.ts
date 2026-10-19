import { unvalidatedIntegrationResponse } from "../_shared/staging-isolation.ts";
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
  notes: string | null;
  google_event_id: string | null;
  patients: { full_name?: string | null } | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildEvent(appointment: CalendarAppointment, patientName: string) {
  const startTime = new Date(appointment.scheduled_at);
  const duration = appointment.duration_minutes || 50;
  const endTime = new Date(startTime.getTime() + duration * 60000);

  return {
    summary: `Consulta — ${patientName}`,
    description: `Sessão agendada pelo sistema PsicoOne.\n\nTipo: ${appointment.type === "online" ? "Online" : "Presencial"}\nDuração: ${duration} minutos${appointment.notes ? `\nObservações: ${appointment.notes}` : ""}`,
    start: { dateTime: startTime.toISOString(), timeZone: "America/Sao_Paulo" },
    end: { dateTime: endTime.toISOString(), timeZone: "America/Sao_Paulo" },
    reminders: { useDefault: true },
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

Deno.serve(async (req) => {
  const migrationPause = unvalidatedIntegrationResponse(req);
  if (migrationPause) return migrationPause;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "Configuração interna do calendário incompleta" }, 500);
    }

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

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();
    const action = body?.action;
    if (!["create", "update", "cancel", "delete", "sync_all"].includes(action)) return json({ error: "Invalid action" }, 400);
    let appointment: any;
    if (action !== "sync_all") {
      const id = body?.appointment?.id;
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return json({ error: "Agendamento inválido" }, 400);
      const { data: owned, error: ownedError } = await supabase.from("appointments")
        .select("id, scheduled_at, duration_minutes, type, notes, status, deleted_at, google_event_id, patients(full_name)")
        .eq("id", id).eq("psychologist_id", userId).maybeSingle();
      if (ownedError) return json({ error: "Não foi possível consultar o agendamento" }, 503);
      if (!owned) return json({ error: "Agendamento não encontrado" }, 404);
      if ((action === "create" || action === "update") && (owned.deleted_at || owned.status === "cancelled")) return json({ error: "Agendamento indisponível" }, 409);
      appointment = { ...owned, patient_name: owned.patients?.full_name || "Paciente" };
    }

    // Check sync preferences
    const { data: prefs, error: prefsError } = await serviceClient
      .from("google_calendar_tokens")
      .select("sync_enabled, auto_create, auto_update, sync_new_only, calendar_id")
      .eq("user_id", userId)
      .single();

    if (prefsError) return json({ error: "Não foi possível consultar preferências" }, 503);
    if (!prefs?.sync_enabled) {
      return new Response(JSON.stringify({ skipped: true, reason: "sync_disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getValidAccessToken(serviceClient, userId);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Token inválido. Reconecte sua conta Google." }), {
        status: 401, headers: corsHeaders,
      });
    }

    const calendarId = prefs.calendar_id || "primary";

    const CALENDAR_API = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

    // CREATE event
    if (action === "create") {
      if (!prefs.auto_create) {
        return new Response(JSON.stringify({ skipped: true, reason: "auto_create_disabled" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (appointment.google_event_id) return json({ skipped: true, reason: "already_linked" });
      const event = buildEvent(appointment, appointment.patient_name || "Paciente");
      const eventData = await createOrRecoverEvent(CALENDAR_API, accessToken, userId, appointment.id, event);
      if (!eventData.id) return json({ error: "Não foi possível criar ou reconciliar evento" }, eventData.status);

      // Save google_event_id
      if (typeof eventData.id !== "string" || !eventData.id) return json({ error: "Resposta inválida do Google Calendar" }, 502);
      const { data: linked, error: linkError } = await serviceClient
        .from("appointments")
        .update({ google_event_id: eventData.id })
        .eq("id", appointment.id).eq("psychologist_id", userId)
        .select("id").maybeSingle();

      if (linkError || !linked) return json({ error: "Evento criado, mas o vínculo não foi salvo. Reconciliação necessária.", reconciliation_required: true }, 503);

      return new Response(JSON.stringify({ success: true, google_event_id: eventData.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // UPDATE event
    if (action === "update") {
      if (!prefs.auto_update || !appointment.google_event_id) {
        return new Response(JSON.stringify({ skipped: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const event = buildEvent(appointment, appointment.patient_name || "Paciente");

      const res = await fetch(`${CALENDAR_API}/${encodeURIComponent(appointment.google_event_id)}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      });

      if (!res.ok) {
        const errData = await res.json();
        console.error("Google Calendar update failed");
        return json({ error: "Falha ao atualizar evento" }, res.status);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CANCEL/DELETE event
    if (action === "cancel" || action === "delete") {
      if (!appointment.google_event_id) {
        return new Response(JSON.stringify({ skipped: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(`${CALENDAR_API}/${encodeURIComponent(appointment.google_event_id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok && res.status !== 404) {
        return json({ error: "Falha ao remover evento" }, 502);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SYNC ALL - reconcile every eligible appointment with Google Calendar.
    // Existing links are updated, missing Google events are recreated, and new
    // appointments are created. This makes the manual action deterministic.
    if (action === "sync_all") {
      let query = serviceClient
        .from("appointments")
        .select("id, scheduled_at, duration_minutes, type, notes, status, google_event_id, patient_id, patients(full_name)")
        .eq("psychologist_id", userId)
        .is("deleted_at", null)
        .neq("status", "cancelled")
        .order("scheduled_at", { ascending: true });

      if (prefs.sync_new_only) {
        query = query.gte("scheduled_at", new Date().toISOString());
      }

      const { data: appointments, error: appointmentsError } = await query;

      if (appointmentsError) {
        return json({ error: "Falha ao carregar agendamentos", details: appointmentsError.message }, 500);
      }

      if (!appointments || appointments.length === 0) {
        return json({ success: true, synced: 0, created: 0, updated: 0, recreated: 0, failed: 0 });
      }

      const result = { created: 0, updated: 0, recreated: 0, failed: 0 };
      const failures: Array<{ appointment_id: string; status: number; message: string }> = [];

      for (const rawAppointment of appointments) {
        const apt = rawAppointment as CalendarAppointment;
        const patientName = apt.patients?.full_name || "Paciente";
        const event = buildEvent(apt, patientName);
        let eventId = apt.google_event_id;
        let wasMissing = false;

        if (eventId) {
          const updateRes = await fetch(`${CALENDAR_API}/${encodeURIComponent(eventId)}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(event),
          });

          if (updateRes.ok) {
            result.updated++;
            continue;
          }

          if (updateRes.status !== 404 && updateRes.status !== 410) {
            const details = await updateRes.text();
            result.failed++;
            failures.push({ appointment_id: apt.id, status: updateRes.status, message: details.slice(0, 300) });
            continue;
          }

          eventId = null;
          wasMissing = true;
        }

        const eventData = await createOrRecoverEvent(CALENDAR_API, accessToken, userId, apt.id, event);
        if (!eventData.id) {
          result.failed++;
          failures.push({ appointment_id: apt.id, status: eventData.status, message: "Não foi possível criar ou reconciliar evento" });
          continue;
        }
        if (typeof eventData.id !== "string" || !eventData.id) {
          result.failed++;
          failures.push({ appointment_id: apt.id, status: 502, message: "Resposta inválida do Google Calendar" });
          continue;
        }
        const { data: linked, error: linkError } = await serviceClient
          .from("appointments")
          .update({ google_event_id: eventData.id })
          .eq("id", apt.id)
          .eq("psychologist_id", userId)
          .select("id").maybeSingle();

        if (linkError || !linked) {
          result.failed++;
          failures.push({ appointment_id: apt.id, status: 503, message: "Evento criado, mas o vínculo não foi salvo. Reconciliação necessária." });
          continue;
        }

        if (wasMissing) result.recreated++;
        else result.created++;
      }

      const synced = result.created + result.updated + result.recreated;
      console.log("Google Calendar reconciliation completed", { userId, synced, ...result });
      return json({ success: result.failed === 0, synced, ...result, failures });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("Calendar synchronization failed");
    const message = "Erro inesperado de sincronização";
    return json({ error: message }, 500);
  }
});
