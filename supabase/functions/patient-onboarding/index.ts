// Public edge function — paciente completa o próprio cadastro via token seguro
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const BUCKET = "patient-documents";

async function ensureBucket() {
  try {
    const { data } = await supabase.storage.getBucket(BUCKET);
    if (!data) {
      await supabase.storage.createBucket(BUCKET, { public: false });
    }
  } catch {
    try { await supabase.storage.createBucket(BUCKET, { public: false }); } catch {}
  }
}

async function getValidToken(token: string) {
  const { data, error } = await supabase
    .from("patient_onboarding_tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return { error: "Token inválido", code: 404 };
  if (data.status !== "pending") return { error: "Token já utilizado ou revogado", code: 410 };
  if (new Date(data.expires_at) < new Date()) {
    await supabase.from("patient_onboarding_tokens").update({ status: "expired" }).eq("id", data.id);
    return { error: "Token expirado", code: 410 };
  }
  return { row: data };
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.split(",")[1] : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const action = url.searchParams.get("action");
    if (!token) return json({ error: "token requerido" }, 400);

    const v = await getValidToken(token);
    if ("error" in v) return json({ error: v.error }, v.code);

    if (req.method === "GET") {
      const { data: patient } = await supabase
        .from("patients")
        .select("id, full_name, email, phone, onboarding_status")
        .eq("id", v.row.patient_id)
        .maybeSingle();
      const { data: psy } = await supabase
        .from("profiles")
        .select("full_name, clinic_name, logo_url, crp")
        .eq("id", v.row.psychologist_id)
        .maybeSingle();
      // Draft vinculado ao paciente (não ao token) — sobrevive a reenvio de link
      const { data: draft } = await supabase
        .from("patient_onboarding_drafts")
        .select("payload, completion_percentage, current_step, version, status, updated_at")
        .eq("patient_id", v.row.patient_id)
        .maybeSingle();
      return json({
        patient,
        psychologist: psy,
        expires_at: v.row.expires_at,
        draft: draft && draft.status !== "completed" ? draft : null,
      });
    }

    // Autosave do rascunho (silencioso, sem notificações)
    if (req.method === "POST" && action === "draft") {
      const body = await req.json().catch(() => ({}));
      const payload = body?.payload ?? {};
      if (typeof payload !== "object" || Array.isArray(payload)) {
        return json({ error: "payload inválido" }, 400);
      }
      const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
      if (size > 1_000_000) return json({ error: "rascunho muito grande" }, 413);

      const { data: existing } = await supabase
        .from("patient_onboarding_drafts")
        .select("id, version")
        .eq("patient_id", v.row.patient_id)
        .maybeSingle();

      const row = {
        patient_id: v.row.patient_id,
        psychologist_id: v.row.psychologist_id,
        payload,
        completion_percentage: Math.max(0, Math.min(100, Number(body?.completion_percentage) || 0)),
        current_step: Math.max(0, Number(body?.current_step) || 0),
        status: "in_progress",
        last_synced_at: new Date().toISOString(),
        version: (existing?.version ?? 0) + 1,
      };

      const { error: dErr } = existing
        ? await supabase.from("patient_onboarding_drafts").update(row).eq("id", existing.id)
        : await supabase.from("patient_onboarding_drafts").insert(row);
      if (dErr) return json({ error: dErr.message }, 500);
      return json({ ok: true, version: row.version, synced_at: row.last_synced_at });
    }


    // Upload de documento via base64 (contorna RLS do storage de forma segura — só com token válido)
    if (req.method === "POST" && action === "upload") {
      await ensureBucket();
      const body = await req.json();
      const { filename, content_type, data: b64 } = body || {};
      if (!filename || !b64) return json({ error: "filename e data são obrigatórios" }, 400);

      const bytes = base64ToBytes(b64);
      const MAX = 10 * 1024 * 1024; // 10MB
      if (bytes.byteLength > MAX) return json({ error: "Arquivo excede 10MB" }, 413);

      const safeName = String(filename).replace(/[^\w.\-]+/g, "_");
      const path = `${v.row.patient_id}/${Date.now()}_${safeName}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: content_type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) return json({ error: upErr.message }, 500);
      return json({ ok: true, path, name: filename, type: content_type || "application/octet-stream" });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const { documents, ...patientData } = body;
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
        || req.headers.get("cf-connecting-ip")
        || req.headers.get("x-real-ip")
        || null;

      // SECURITY: allowlist fields the patient may set via onboarding.
      // Never trust arbitrary body keys — service_role bypasses RLS.
      const ALLOWED_FIELDS = new Set([
        "full_name","social_name","birth_date","birth_place","gender","religion","marital_status",
        "cpf","rg","rg_issuer","cnh","phone","phone_residential","whatsapp_phone","email",
        "cep","street","address","address_number","complement","neighborhood","city","state",
        "education","education_level","profession","profession_role","company",
        "spouse_name","spouse_relationship_time","children",
        "father_name","father_profession","mother_name","mother_profession",
        "siblings_brothers","siblings_sisters",
        "emergency_contact","emergency_relationship","emergency_phone","emergency_whatsapp",
        "prior_therapy","prior_therapy_duration","prior_therapy_when","prior_therapy_reason",
        "uses_medication","medications","initial_demand",
        "health_plan","health_plan_id","health_plan_expiry",
        "lgpd_truth_declaration","lgpd_privacy_consent","lgpd_data_consent",
        "lgpd_signature_data","lgpd_signed_at","recording_authorization",
        "signature_device","signature_timestamp","preferred_notification_channel"
      ]);
      const safeData: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(patientData || {})) {
        if (ALLOWED_FIELDS.has(k) && val !== "" && val !== undefined) safeData[k] = val;
      }
      if (!safeData.full_name || String(safeData.full_name).trim().length < 2) {
        return json({ error: "Nome completo é obrigatório" }, 400);
      }
      const anyPhone = safeData.whatsapp_phone || safeData.phone;
      if (!anyPhone || String(anyPhone).replace(/\D/g, "").length < 8) {
        return json({ error: "Telefone/celular é obrigatório" }, 400);
      }

      const { error: upErr } = await supabase
        .from("patients")
        .update({
          ...safeData,
          signature_ip: ip,
          uploaded_documents: documents || [],
          onboarding_status: "review",
          onboarding_completed_at: new Date().toISOString(),
        })
        .eq("id", v.row.patient_id);
      if (upErr) throw upErr;


      await supabase
        .from("patient_onboarding_tokens")
        .update({ status: "used", used_at: new Date().toISOString() })
        .eq("id", v.row.id);

      // Só marca o rascunho como concluído DEPOIS da persistência confirmada
      await supabase
        .from("patient_onboarding_drafts")
        .update({ status: "completed", last_synced_at: new Date().toISOString() })
        .eq("patient_id", v.row.patient_id);


      // Notificação unificada via dispatch-notification (insert + push + preferências)
      // Mesmo fluxo de Agenda/Financeiro: garante toast + badge + central + push
      try {
        const dispatched = await fetch(`${SUPABASE_URL}/functions/v1/dispatch-notification`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
            apikey: SERVICE_KEY,
          },
          body: JSON.stringify({
            user_id: v.row.psychologist_id,
            category: "paciente",
            type: "patient_onboarding",
            title: "Paciente concluiu o cadastro",
            message: `${patientData.full_name || "Paciente"} preencheu o formulário e aguarda revisão.`,
            action_path: `/pacientes/${v.row.patient_id}`,
            action_label: "Revisar informações",
            metadata: { patient_id: v.row.patient_id, event: "completed" },
          }),
        });
        if (!dispatched.ok) throw new Error("Notification dispatch failed");
      } catch (e) {
        console.warn("[patient-onboarding] using notification fallback");
        await supabase.from("notifications").insert({
          user_id: v.row.psychologist_id,
          type: "patient_onboarding",
          category: "paciente",
          title: "Paciente concluiu o cadastro",
          message: `${patientData.full_name || "Paciente"} preencheu o formulário e aguarda revisão.`,
          action_path: `/pacientes/${v.row.patient_id}`,
          action_label: "Revisar informações",
        });
      }

      return json({ ok: true });
    }

    return json({ error: "método não suportado" }, 405);
  } catch (e: any) {
    console.error("[patient-onboarding]", e);
    return json({ error: e?.message || "erro interno" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
