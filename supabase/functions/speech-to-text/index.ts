import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUser } from "../_shared/require-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
};

/** Frases típicas de alucinação em janelas sem fala real */
const HALLUCINATION_PATTERNS = [
  /^(legendas?|amara\.?org|subtitles?)[\s.!?]*$/i,
  /legendas? pela comunidade/i,
  /amara\.org/i,
  /subscribe|subtitles by|www\./i,
  /^[\s.,!?…-]*$/,
];

/**
 * Rejeita saídas que não são português real:
 *  - presença de escritas não latinas (chinês, japonês, cirílico, árabe, tailandês…)
 *  - excesso de caracteres fora do alfabeto latino/acentuado
 *  - frases-fantasma clássicas de janelas silenciosas
 */
function sanitizePt(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (HALLUCINATION_PATTERNS.some((re) => re.test(t))) return "";

  const nonLatinScript =
    /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]/;
  if (nonLatinScript.test(t)) return "";

  const letters = t.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return "";
  const latin = letters.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (latin.length / letters.length < 0.95) return "";

  // Repetição patológica ("blá blá blá blá…")
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 6) {
    const unique = new Set(words).size;
    if (unique / words.length < 0.3) return "";
  }

  return t;
}


serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const auth = await requireUser(req, corsHeaders);
  if ("error" in auth) return auth.error;

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) return json({ error: "Serviço de transcrição não configurado. Contate o suporte." }, 503);

    const body = await req.json();
    // Modelo econômico como padrão (etapa A): mantém qualidade adequada em
    // pt-BR com custo bem menor por minuto de áudio.
    const DEFAULT_MODEL = "openai/gpt-4o-mini-transcribe";
    if (body.healthCheck) return json({ available: true, model: DEFAULT_MODEL });

    const {
      audio,
      mimeType = "audio/wav",
      language = "pt",
      model = DEFAULT_MODEL,
    } = body as {
      audio?: string;
      mimeType?: string;
      language?: string;
      model?: string;
    };

    if (typeof audio !== "string" || !audio) return json({ error: "No audio data provided" }, 400);
    if (audio.length > 32 * 1024 * 1024) return json({ error: "Áudio muito grande" }, 413);
    if (model !== DEFAULT_MODEL) return json({ error: "Modelo de transcrição inválido" }, 400);
    if (typeof mimeType !== "string" || typeof language !== "string") return json({ error: "Formato inválido" }, 400);

    // Decode base64 → bytes
    const binary = atob(audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // ~2 KB WAV = header only / silence: nothing to transcribe
    if (bytes.byteLength < 2048) return json({ text: "", empty: true });
    if (bytes.byteLength > 24 * 1024 * 1024) return json({ error: "Áudio muito grande" }, 413);

    const base = (mimeType || "audio/wav").split(";")[0];
    const lang = (language || "pt").split("-")[0].toLowerCase();
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([bytes], { type: base }), `recording.${EXT[base] ?? "wav"}`);
    form.append("language", lang);
    form.append("temperature", "0");
    if (lang === "pt") {
      form.append(
        "prompt",
        "Transcreva literalmente em português do Brasil. Contexto: sessão de psicoterapia clínica. Não traduza, não invente conteúdo e não use outros idiomas. Se não houver fala audível, devolva vazio."
      );
    }

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(45000),
    });

    if (!resp.ok) {
      console.error("speech-to-text gateway status:", resp.status);
      if (resp.status === 429) {
        return json({ error: "Muitas solicitações de transcrição. Aguarde alguns segundos." }, 429);
      }
      if (resp.status === 402) {
        return json({ error: "Créditos de IA insuficientes para transcrever o áudio." }, 402);
      }
      if (resp.status === 403) {
        return json({ error: "Transcrição por IA bloqueada nas configurações do workspace." }, 403);
      }
      return json({ error: `Serviço de transcrição indisponível [${resp.status}]` }, 502);
    }

    const data = await resp.json();
    const raw = (data?.text ?? "").trim();
    const clean = lang === "pt" ? sanitizePt(raw) : raw;
    return json({ text: clean, usage: data?.usage, discarded: raw !== "" && clean === "" });

  } catch (e) {
    console.error("speech-to-text failure", e instanceof Error ? e.name : "UnknownError");
    return json({ error: "Não foi possível processar o áudio. Tente novamente." }, 500);
  }
});
