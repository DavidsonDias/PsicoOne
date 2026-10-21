import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { token, action } = body;

    if (!token || typeof token !== "string") {
      return new Response(JSON.stringify({ error: "Token obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Fetch link
    const { data: link, error: linkErr } = await supabase
      .from("patient_access_links")
      .select("*")
      .eq("token", token)
      .single();

    if (linkErr || !link) {
      return new Response(JSON.stringify({ error: "Link não encontrado" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (link.is_revoked) {
      return new Response(JSON.stringify({ error: "Link revogado" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!Number.isFinite(Date.parse(link.expires_at)) || Date.parse(link.expires_at) <= Date.now()) {
      return new Response(JSON.stringify({ error: "Link expirado" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // A bearer link must not bridge patients or professionals.
    const { data: linkedPatient, error: patientError } = await supabase
      .from("patients")
      .select("id, psychologist_id, deleted_at")
      .eq("id", link.patient_id)
      .single();
    if (patientError) throw new Error("Portal relationship lookup failed");
    if (!linkedPatient || linkedPatient.deleted_at || !link.created_by ||
        linkedPatient.psychologist_id !== link.created_by) {
      return new Response(JSON.stringify({ error: "Vínculo do portal inválido" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (link.appointment_id) {
      const { data: linkedAppointment, error: appointmentError } = await supabase
        .from("appointments")
        .select("id, patient_id, psychologist_id, deleted_at")
        .eq("id", link.appointment_id)
        .single();
      if (appointmentError) throw new Error("Portal relationship lookup failed");
      if (!linkedAppointment || linkedAppointment.deleted_at ||
          linkedAppointment.patient_id !== link.patient_id ||
          linkedAppointment.psychologist_id !== link.created_by) {
        return new Response(JSON.stringify({ error: "Vínculo do portal inválido" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Helper: get psychologist_id for the appointment
    const getPsychologistId = async (): Promise<string | null> => {
      if (!link.appointment_id) return null;
      const { data } = await supabase
        .from("appointments")
        .select("psychologist_id")
        .eq("id", link.appointment_id)
        .single();
      return data?.psychologist_id || null;
    };

    // Helper: notify psychologist via internal notifications + email
    const notifyPsychologist = async (
      psychologistId: string,
      title: string,
      message: string,
      type: string = "patient_action",
      emailContext?: {
        actionType: "cancel" | "reschedule" | "message" | "confirm";
        patientName?: string;
        appointmentDate?: string;
        appointmentTime?: string;
        reason?: string;
        userMessage?: string;
        proposedDate?: string;
      }
    ) => {
      // 1) Internal realtime notification (sino)
      await supabase.from("notifications").insert({
        user_id: psychologistId,
        title,
        message,
        type,
        action_path: "/agenda",
        action_label: "Abrir agenda",
      });

      // 2) Email (best-effort, never blocks the flow)
      if (!emailContext) return;
      try {
        // Resolve psychologist email + name from auth.users + profiles
        const { data: prof } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("id", psychologistId)
          .single();
        const { data: authUser } = await supabase.auth.admin.getUserById(psychologistId);
        const recipientEmail = authUser?.user?.email;
        if (!recipientEmail) return;

        const siteUrl = "https://psicoone.vercel.app";

        await supabase.functions.invoke("send-transactional-email", {
          body: {
            templateName: "psychologist-patient-action",
            recipientEmail,
            idempotencyKey: `psy-action-${emailContext.actionType}-${link.appointment_id}-${Date.now()}`,
            templateData: {
              psychologistName: prof?.full_name,
              patientName: emailContext.patientName,
              actionType: emailContext.actionType,
              appointmentDate: emailContext.appointmentDate,
              appointmentTime: emailContext.appointmentTime,
              reason: emailContext.reason,
              message: emailContext.userMessage,
              proposedDate: emailContext.proposedDate,
              agendaUrl: `${siteUrl}/agenda`,
            },
            metadata: {
              appointment_id: link.appointment_id,
              action_type: emailContext.actionType,
            },
          },
        });
      } catch (e) {
        console.warn("[patient-portal] Psychologist email failed:", e);
      }
    };

    // Helper: format appointment date/time for emails
    const formatAptDateTime = async () => {
      if (!link.appointment_id) return { date: "", time: "" };
      const { data: apt } = await supabase
        .from("appointments")
        .select("scheduled_at")
        .eq("id", link.appointment_id)
        .single();
      if (!apt?.scheduled_at) return { date: "", time: "" };
      const d = new Date(apt.scheduled_at);
      return {
        date: d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" }),
        time: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }),
      };
    };

    // ====== ACTION: confirm presence ======
    if (action === "confirm") {
      await supabase
        .from("patient_access_links")
        .update({ used_at: new Date().toISOString() })
        .eq("id", link.id);

      if (link.appointment_id) {
        await supabase
          .from("appointments")
          .update({
            status: "confirmed",
            patient_confirmed_at: new Date().toISOString(),
          })
          .eq("id", link.appointment_id);

        const psychId = await getPsychologistId();
        if (psychId) {
          const { data: pat } = await supabase
            .from("patients")
            .select("full_name")
            .eq("id", link.patient_id)
            .single();

          await supabase.from("appointment_requests").insert({
            appointment_id: link.appointment_id,
            patient_id: link.patient_id,
            psychologist_id: psychId,
            request_type: "confirm",
            status: "acknowledged",
            responded_at: new Date().toISOString(),
          });

          await notifyPsychologist(
            psychId,
            "✅ Presença confirmada",
            `${pat?.full_name || "Paciente"} confirmou a sessão.`,
            "appointment_confirmed"
          );
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ====== ACTION: cancel session ======
    if (action === "cancel") {
      const reason = (body.reason || "").toString().slice(0, 500);
      if (!link.appointment_id) {
        return new Response(JSON.stringify({ error: "Sem agendamento vinculado" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase
        .from("appointments")
        .update({
          status: "cancelled",
          patient_cancelled_at: new Date().toISOString(),
          cancellation_reason: reason || "Cancelado pelo paciente",
        })
        .eq("id", link.appointment_id);

      const psychId = await getPsychologistId();
      if (psychId) {
        const { data: pat } = await supabase
          .from("patients")
          .select("full_name")
          .eq("id", link.patient_id)
          .single();

        await supabase.from("appointment_requests").insert({
          appointment_id: link.appointment_id,
          patient_id: link.patient_id,
          psychologist_id: psychId,
          request_type: "cancel",
          status: "acknowledged",
          reason: reason || null,
          responded_at: new Date().toISOString(),
        });

        const aptFmt = await formatAptDateTime();
        await notifyPsychologist(
          psychId,
          "❌ Sessão cancelada pelo paciente",
          `${pat?.full_name || "Paciente"} cancelou a sessão.${reason ? ` Motivo: ${reason}` : ""}`,
          "appointment_cancelled",
          {
            actionType: "cancel",
            patientName: pat?.full_name,
            appointmentDate: aptFmt.date,
            appointmentTime: aptFmt.time,
            reason: reason || undefined,
          }
        );
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ====== ACTION: reschedule (creates a request, does NOT change appointment yet) ======
    if (action === "reschedule") {
      const proposedDate = body.proposed_date as string | undefined;
      const reason = (body.reason || "").toString().slice(0, 500);

      if (!link.appointment_id) {
        return new Response(JSON.stringify({ error: "Sem agendamento vinculado" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!proposedDate || isNaN(new Date(proposedDate).getTime())) {
        return new Response(JSON.stringify({ error: "Data proposta inválida" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const psychId = await getPsychologistId();
      if (!psychId) {
        return new Response(JSON.stringify({ error: "Psicólogo não encontrado" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: pat } = await supabase
        .from("patients")
        .select("full_name")
        .eq("id", link.patient_id)
        .single();

      await supabase.from("appointment_requests").insert({
        appointment_id: link.appointment_id,
        patient_id: link.patient_id,
        psychologist_id: psychId,
        request_type: "reschedule",
        status: "pending",
        proposed_date: proposedDate,
        reason: reason || null,
      });

      const newDate = new Date(proposedDate).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
      });
      const aptFmtR = await formatAptDateTime();
      await notifyPsychologist(
        psychId,
        "🔄 Solicitação de reagendamento",
        `${pat?.full_name || "Paciente"} solicitou reagendar para ${newDate}.${reason ? ` Motivo: ${reason}` : ""}`,
        "reschedule_request",
        {
          actionType: "reschedule",
          patientName: pat?.full_name,
          appointmentDate: aptFmtR.date,
          appointmentTime: aptFmtR.time,
          proposedDate: newDate,
          reason: reason || undefined,
        }
      );

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ====== ACTION: send message to psychologist ======
    if (action === "message") {
      const message = (body.message || "").toString().trim().slice(0, 2000);
      if (!message) {
        return new Response(JSON.stringify({ error: "Mensagem vazia" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!link.appointment_id) {
        return new Response(JSON.stringify({ error: "Sem agendamento vinculado" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const psychId = await getPsychologistId();
      if (!psychId) {
        return new Response(JSON.stringify({ error: "Psicólogo não encontrado" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: pat } = await supabase
        .from("patients")
        .select("full_name")
        .eq("id", link.patient_id)
        .single();

      await supabase.from("appointment_requests").insert({
        appointment_id: link.appointment_id,
        patient_id: link.patient_id,
        psychologist_id: psychId,
        request_type: "message",
        status: "pending",
        message,
      });

      const aptFmtM = await formatAptDateTime();
      await notifyPsychologist(
        psychId,
        "💬 Nova mensagem do paciente",
        `${pat?.full_name || "Paciente"}: ${message.slice(0, 120)}${message.length > 120 ? "..." : ""}`,
        "patient_message",
        {
          actionType: "message",
          patientName: pat?.full_name,
          appointmentDate: aptFmtM.date,
          appointmentTime: aptFmtM.time,
          userMessage: message,
        }
      );

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ====== ACTION: join telehealth session ======
    if (action === "join") {
      if (!link.appointment_id) {
        return new Response(JSON.stringify({ error: "Sem agendamento vinculado" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check appointment meeting_status
      const { data: apt } = await supabase
        .from("appointments")
        .select("meeting_status, type")
        .eq("id", link.appointment_id)
        .single();

      if (apt?.type !== "online") {
        return new Response(JSON.stringify({ error: "Sessão não é online" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (apt?.meeting_status !== "live") {
        return new Response(
          JSON.stringify({
            room_token: null,
            waiting: true,
            message: "Aguardando o profissional iniciar a sessão",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: session } = await supabase
        .from("telehealth_sessions")
        .select("room_token")
        .eq("appointment_id", link.appointment_id)
        .in("status", ["waiting", "active"])
        .single();

      return new Response(
        JSON.stringify({ room_token: session?.room_token || null, waiting: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ====== Default: return portal data ======
    let appointment = null;
    let patient = null;
    let psychologist = null;

    if (link.appointment_id) {
      const { data: apt } = await supabase
        .from("appointments")
        .select("id, scheduled_at, duration_minutes, type, status, notes, psychologist_id, meeting_status, patient_confirmed_at, patient_cancelled_at")
        .eq("id", link.appointment_id)
        .single();
      appointment = apt;

      if (apt?.psychologist_id) {
        const { data: prof } = await supabase
          .from("profiles")
          .select("full_name, specialty, clinic_name")
          .eq("id", apt.psychologist_id)
          .single();
        psychologist = prof;
      }
    }

    const { data: pat } = await supabase
      .from("patients")
      .select("full_name, email, phone")
      .eq("id", link.patient_id)
      .single();
    patient = pat;

    return new Response(
      JSON.stringify({
        link: { id: link.id, expires_at: link.expires_at, used_at: link.used_at },
        appointment,
        patient,
        psychologist,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[patient-portal] Request failed");
    return new Response(JSON.stringify({ error: "Erro interno" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
