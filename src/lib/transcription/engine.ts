/**
 * ClinicalTranscriptionEngine — fonte única de verdade da transcrição clínica.
 *
 * Arquitetura:
 *   Captura (Web Audio + VAD)
 *     → Chunk durável (IndexedDB)  ← nada vai ao STT antes de ser persistido
 *     → Fila com retry/backoff + jitter
 *     → STT (Edge Function speech-to-text, pt-BR travado)
 *     → Segmento durável (ordenado por sequence, deduplicado)
 *     → Editor / Draft
 *     → Final Flush (stop aguarda drenagem completa)
 *
 * Consumida pelo prontuário e pelo teleatendimento — sem lógica duplicada.
 */

import { supabase } from "@/integrations/supabase/client";
import { DictationRecorder } from "@/lib/audio/dictation-recorder";
import { captureSupportError } from "@/lib/audio/capture-diagnostics";
import { dedupeOverlap } from "@/lib/audio/dedupe-overlap";
import {
  deleteChunk,
  dropChunkAudio,
  getSessionChunks,
  getSessionSegments,
  patchSession,
  putChunk,
  putSegment,
  putSession,
  purgeSession,
  enforceRetention,
  type TranscriptionChunkRecord,
} from "./store";

export type EngineState =
  | "idle"
  | "initializing"
  | "recording"
  | "paused"
  | "background"
  | "stopping"
  | "flushing"
  | "saving"
  | "completed"
  | "error";

export type EngineNotice =
  | "capture_interrupted"
  | "capture_resumed"
  | "no_audio_detected"
  | "chunk_failed"
  | "credits"
  | "rate_limited";

export interface EngineMetrics {
  chunks: number;
  transcribed: number;
  pending: number;
  retries: number;
  failed: number;
  avgLatencyMs: number;
  lastSegmentAt: number | null;
  durationMs: number;
}

export interface EngineEvents {
  onState?: (state: EngineState) => void;
  /** Texto novo, já ordenado e deduplicado. Persistido ANTES de ser emitido. */
  onSegment?: (text: string) => void;
  onLevel?: (level: number) => void;
  onMetrics?: (metrics: EngineMetrics) => void;
  onNotice?: (notice: EngineNotice, message: string) => void;
  onGainChange?: (gain: number) => void;
}

export interface EngineOptions extends EngineEvents {
  context: "medical_record" | "telehealth";
  recordId?: string | null;
  patientId?: string | null;
  patientLabel?: string | null;
  language?: string;
  gain?: number;
  autoGain?: boolean;
}

const MAX_ATTEMPTS = 4;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Telemetria técnica — jamais conteúdo clínico. */
function telemetry(event: string, data: Record<string, unknown> = {}) {
  if (typeof console !== "undefined") {
    console.debug(`[transcription] ${event}`, data);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) =>
  Math.min(12_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 400;

export class ClinicalTranscriptionEngine {
  readonly sessionId: string;
  private opts: EngineOptions;
  private recorder: DictationRecorder | null = null;
  private state: EngineState = "idle";
  private startedAt = 0;

  private nextSequence = 0;
  private expectedSequence = 0;
  private ordered = new Map<number, string>();
  private inflight = new Set<Promise<void>>();
  private acceptingChunks = true;
  private text = "";

  private gain: number;
  private autoGain: boolean;
  private levelPeak = 0;
  private levelNoise = 0.002;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private wasInterrupted = false;

  private metrics: EngineMetrics = {
    chunks: 0,
    transcribed: 0,
    pending: 0,
    retries: 0,
    failed: 0,
    avgLatencyMs: 0,
    lastSegmentAt: null,
    durationMs: 0,
  };
  private latencySum = 0;
  private latencyCount = 0;

  constructor(options: EngineOptions) {
    this.opts = options;
    this.gain = options.gain ?? 2.5;
    this.autoGain = options.autoGain ?? true;
    this.sessionId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  get currentState() {
    return this.state;
  }

  get currentText() {
    return this.text;
  }

  get currentMetrics(): EngineMetrics {
    return { ...this.metrics, durationMs: this.startedAt ? Date.now() - this.startedAt : 0 };
  }

  private setState(state: EngineState) {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state);
    telemetry("state", { session: this.sessionId, state });
  }

  private emitMetrics() {
    this.opts.onMetrics?.(this.currentMetrics);
  }

  // ── Ciclo de vida ──

  async start(): Promise<boolean> {
    if (this.state === "recording" || this.state === "initializing") return true;
    this.setState("initializing");
    const unsupported = captureSupportError();
    if (unsupported) {
      this.opts.onNotice?.("capture_interrupted", unsupported);
      this.setState("error");
      return false;
    }
    try {
      const { data, error } = await supabase.functions.invoke("speech-to-text", { body: { healthCheck: true } });
      if (error || !data?.available) {
        this.opts.onNotice?.("capture_interrupted", "Serviço de transcrição indisponível. Verifique a conexão ou contate o suporte. Nenhum áudio foi gravado.");
        this.setState("error");
        return false;
      }
    } catch {
      this.opts.onNotice?.("capture_interrupted", "Sem conexão com a transcrição. Tente novamente. Nenhum áudio foi gravado.");
      this.setState("error");
      return false;
    }
    this.startedAt = Date.now();
    this.acceptingChunks = true;

    await putSession({
      id: this.sessionId,
      context: this.opts.context,
      record_id: this.opts.recordId ?? null,
      patient_id: this.opts.patientId ?? null,
      patient_label: this.opts.patientLabel ?? null,
      status: "recording",
      started_at: this.startedAt,
      updated_at: this.startedAt,
      duration_ms: 0,
      chunk_count: 0,
    }).catch(() => undefined);

    void enforceRetention().catch(() => undefined);

    const recorder = new DictationRecorder({
      gain: this.gain,
      // Janela maior = muito menos chamadas de STT para a mesma sessão,
      // mantendo a continuidade pelo overlap e pela deduplicação.
      windowMs: 24_000,
      onWindow: ({ base64, mimeType, durationMs }) =>
        void this.captureChunk(base64, mimeType, durationMs),
      onLevel: (rms) => this.handleLevel(rms),
      onError: (msg) => this.opts.onNotice?.("chunk_failed", msg),
      onBackgroundState: (bg) => {
        if (this.state === "recording" && bg) this.setState("background");
        else if (this.state === "background" && !bg) this.setState("recording");
      },
    });

    let ok = false;
    try { ok = await recorder.start(); }
    catch {
      await recorder.stop().catch(() => undefined);
      this.opts.onNotice?.("capture_interrupted", "Falha ao iniciar o áudio. Atualize o navegador e verifique o microfone.");
    }
    if (!ok) {
      this.setState("error");
      return false;
    }
    this.recorder = recorder;
    this.setState("recording");
    telemetry("session_started", { session: this.sessionId, context: this.opts.context });
    this.startHealthMonitor();
    return true;
  }

  async pause() {
    if (!this.recorder) return;
    await this.recorder.pause();
    this.setState("paused");
    await patchSession(this.sessionId, { status: "paused" }).catch(() => undefined);
    telemetry("capture_paused", { session: this.sessionId });
  }

  resume() {
    if (!this.recorder) return;
    this.recorder.resume();
    this.setState("recording");
    void patchSession(this.sessionId, { status: "recording" }).catch(() => undefined);
  }

  setGain(gain: number, manual = true) {
    this.gain = Math.min(6, Math.max(0.5, gain));
    if (manual) this.autoGain = false;
    this.recorder?.setGain(this.gain);
    this.opts.onGainChange?.(this.gain);
  }

  setAutoGain(enabled: boolean) {
    this.autoGain = enabled;
  }

  /**
   * ZERO-LOSS STOP PROTOCOL.
   * 1) bloqueia novos chunks  2) fecha o buffer restante  3) drena a fila STT
   * 4) processa retries  5) ordena + deduplica  6) persiste  7) só então libera recursos.
   */
  async stopAndSave(): Promise<{ text: string; metrics: EngineMetrics; integrity: boolean }> {
    if (this.state === "stopping" || this.state === "flushing" || this.state === "saving") {
      // Clique duplo: aguarda a finalização em curso
      while (this.state === "stopping" || this.state === "flushing" || this.state === "saving") {
        await sleep(120);
      }
      return { text: this.text, metrics: this.currentMetrics, integrity: this.metrics.pending === 0 };
    }

    this.setState("stopping");
    telemetry("flush_started", { session: this.sessionId });
    await patchSession(this.sessionId, { status: "flushing" }).catch(() => undefined);
    this.stopHealthMonitor();

    const recorder = this.recorder;
    this.recorder = null;

    // (2) fecha o último chunk — stop() do recorder já faz flush(force) e o
    // chunk é persistido antes de qualquer liberação de recurso.
    await recorder?.stop();

    // (1) somente depois de capturar o restante paramos de aceitar chunks
    this.acceptingChunks = false;

    this.setState("flushing");
    // (3/4) drena tudo que está em voo, incluindo retries
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }

    // (5) ordena e libera qualquer resultado retido
    this.drain(true);

    this.setState("saving");
    const chunks = await getSessionChunks(this.sessionId).catch(() => []);
    const pending = chunks.filter(
      (c) => c.status !== "transcribed"
    ).length;
    this.metrics.pending = pending;
    this.metrics.durationMs = Date.now() - this.startedAt;

    await patchSession(this.sessionId, {
      status: pending === 0 ? "completed" : "flushing",
      completed_at: Date.now(),
      duration_ms: this.metrics.durationMs,
      chunk_count: this.metrics.chunks,
    }).catch(() => undefined);

    this.setState("completed");
    this.emitMetrics();
    telemetry("flush_completed", {
      session: this.sessionId,
      chunks: this.metrics.chunks,
      pending,
      retries: this.metrics.retries,
      failed: this.metrics.failed,
      durationMs: this.metrics.durationMs,
    });

    return { text: this.text, metrics: this.currentMetrics, integrity: pending === 0 };
  }

  /** Pausa longa/abandono: preserva tudo para o Recovery Engine. */
  async detach() {
    this.stopHealthMonitor();
    const recorder = this.recorder;
    this.recorder = null;
    await recorder?.stop();
    this.acceptingChunks = false;
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
    this.drain(true);
  }

  /** Descarte explícito — remove áudio e segmentos locais desta sessão. */
  async discard() {
    await this.detach();
    await purgeSession(this.sessionId).catch(() => undefined);
    this.setState("idle");
  }

  /** Confirmação de commit: só então o áudio local pode ser removido. */
  async confirmPersisted() {
    const chunks = await getSessionChunks(this.sessionId).catch(() => []);
    await Promise.all(chunks.filter((c) => c.audio && c.status === "transcribed").map((c) => dropChunkAudio(c.id)));
  }

  // ── Captura → chunk durável ──

  private async captureChunk(base64: string, mimeType: string, durationMs: number) {
    if (!this.acceptingChunks && this.state !== "stopping") return;
    const sequence = this.nextSequence++;
    const chunk: TranscriptionChunkRecord = {
      id: `${this.sessionId}:${sequence}`,
      session_id: this.sessionId,
      sequence,
      audio: base64,
      mime_type: mimeType,
      duration_ms: Math.round(durationMs),
      status: "captured",
      retry_count: 0,
      created_at: Date.now(),
    };

    // durable-first: persiste antes de enfileirar
    try {
      await putChunk(chunk);
    } catch {
      /* IndexedDB indisponível: segue em memória para não perder a fala */
    }
    this.metrics.chunks += 1;
    this.metrics.pending += 1;
    this.emitMetrics();
    telemetry("chunk_created", { session: this.sessionId, sequence, durationMs: chunk.duration_ms });

    const task = this.processChunk(chunk).finally(() => this.inflight.delete(task));
    this.inflight.add(task);
  }

  private async processChunk(chunk: TranscriptionChunkRecord) {
    const startedAt = Date.now();
    let attempt = 0;
    let text = "";
    let permanent = false;
    let succeeded = false;

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      if (attempt > 1) {
        this.metrics.retries += 1;
        telemetry("chunk_retry", { session: this.sessionId, sequence: chunk.sequence, attempt });
        await sleep(backoff(attempt));
      }
      try {
        // Falha de IndexedDB nunca deve virar falha de STT
        await putChunk({
          ...chunk,
          status: attempt === 1 ? "queued" : "processing",
          retry_count: attempt - 1,
        }).catch(() => undefined);
        const { data, error } = await supabase.functions.invoke("speech-to-text", {
          body: {
            audio: chunk.audio,
            mimeType: chunk.mime_type,
            language: (this.opts.language ?? "pt-BR").split("-")[0],
          },
        });
        const status = Number((error as any)?.context?.status ?? 0);
        if (error) {
          if (status === 402) this.opts.onNotice?.("credits", "Créditos de IA insuficientes para transcrever.");
          if (status === 429) this.opts.onNotice?.("rate_limited", "Muitas transcrições em sequência. Reduzindo o ritmo.");
          if (!RETRYABLE.has(status) && status !== 0) {
            permanent = true;
            break;
          }
          if (attempt >= MAX_ATTEMPTS) break;
          continue;
        }
        if (data?.error) {
          permanent = true;
          break;
        }
        text = typeof data?.text === "string" ? data.text : "";
        succeeded = true;
        break;
      } catch {
        if (attempt >= MAX_ATTEMPTS) break;
      }
    }

    const latency = Date.now() - startedAt;
    this.latencySum += latency;
    this.latencyCount += 1;
    this.metrics.avgLatencyMs = Math.round(this.latencySum / this.latencyCount);

    const transcribed = succeeded;
    const finalStatus: TranscriptionChunkRecord["status"] = permanent
      ? "failed_permanent"
      : transcribed
        ? "transcribed"
        : "failed_retryable";

    // Segmento durável ANTES de chegar ao editor (idempotente por id)
    await putSegment({
      id: `${this.sessionId}:${chunk.sequence}`,
      session_id: this.sessionId,
      sequence: chunk.sequence,
      text,
      created_at: Date.now(),
    }).catch(() => undefined);

    await putChunk({
      ...chunk,
      audio: finalStatus === "transcribed" ? null : chunk.audio,
      status: finalStatus,
      retry_count: attempt - 1,
      processed_at: Date.now(),
    }).catch(() => undefined);

    if (finalStatus === "transcribed") {
      this.metrics.transcribed += 1;
      this.metrics.pending = Math.max(0, this.metrics.pending - 1);
      telemetry("chunk_transcribed", { session: this.sessionId, sequence: chunk.sequence, latency });
    } else {
      this.metrics.failed += 1;
      this.metrics.pending = Math.max(0, this.metrics.pending - 1);
      telemetry("chunk_failed", {
        session: this.sessionId,
        sequence: chunk.sequence,
        status: finalStatus,
      });
      this.opts.onNotice?.(
        "chunk_failed",
        "Um trecho não pôde ser transcrito agora. O áudio foi preservado para reprocessar."
      );
    }

    this.ordered.set(chunk.sequence, text);
    this.drain(false);
    this.emitMetrics();
  }

  /** Emite na ordem das janelas — nunca na ordem de conclusão HTTP. */
  private drain(force: boolean) {
    while (this.ordered.has(this.expectedSequence)) {
      const value = this.ordered.get(this.expectedSequence) ?? "";
      this.ordered.delete(this.expectedSequence);
      this.expectedSequence += 1;
      this.append(value);
    }
    if (force && this.ordered.size > 0) {
      // Sequências faltantes (falha permanente sem segmento): libera o resto
      const rest = [...this.ordered.keys()].sort((a, b) => a - b);
      for (const seq of rest) {
        const value = this.ordered.get(seq) ?? "";
        this.ordered.delete(seq);
        this.append(value);
      }
      this.expectedSequence = this.nextSequence;
    }
  }

  private append(raw: string) {
    const clean = dedupeOverlap(this.text, raw);
    if (!clean) return;
    this.text = this.text ? `${this.text} ${clean}` : clean;
    this.metrics.lastSegmentAt = Date.now();
    this.opts.onSegment?.(clean);
  }

  /** Reprocessa chunks pendentes (após rede voltar, ou na recuperação). */
  async retryPending(): Promise<number> {
    const chunks = await getSessionChunks(this.sessionId).catch(() => []);
    const pending = chunks.filter((c) => c.audio && c.status !== "transcribed");
    for (const chunk of pending) {
      const task = this.processChunk(chunk).finally(() => this.inflight.delete(task));
      this.inflight.add(task);
    }
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    this.drain(true);
    return pending.length;
  }

  // ── AGC + monitor de saúde ──

  private handleLevel(rms: number) {
    this.levelPeak = Math.max(this.levelPeak * 0.92, rms);
    if (rms < 0.004) this.levelNoise = this.levelNoise * 0.98 + rms * 0.02;
    this.opts.onLevel?.(Math.min(1, rms * 12));

    if (!this.autoGain) return;
    // AGC controlado: mira pico útil ~0.2 RMS, sem amplificar ruído puro
    const speaking = rms > Math.max(0.006, this.levelNoise * 3);
    if (!speaking) return;
    const target = 0.09;
    if (this.levelPeak < target * 0.55 && this.gain < 6) {
      this.gain = Math.min(6, this.gain + 0.1);
      this.recorder?.setGain(this.gain);
      this.opts.onGainChange?.(this.gain);
    } else if (this.levelPeak > target * 2.4 && this.gain > 0.5) {
      this.gain = Math.max(0.5, this.gain - 0.1);
      this.recorder?.setGain(this.gain);
      this.opts.onGainChange?.(this.gain);
    }
  }

  private startHealthMonitor() {
    this.stopHealthMonitor();
    this.healthTimer = setInterval(() => {
      const recorder = this.recorder;
      if (!recorder) return;
      const h = recorder.health;
      const dead = !h.trackLive || h.frameAgeMs > 4000 || h.contextState !== "running";

      if (dead && !this.wasInterrupted) {
        this.wasInterrupted = true;
        telemetry("capture_interrupted", { session: this.sessionId, ...h });
        this.opts.onNotice?.(
          "capture_interrupted",
          "A captura de áudio foi interrompida pelo sistema. Mantenha o PsicoOne aberto durante a sessão."
        );
      } else if (!dead && this.wasInterrupted) {
        this.wasInterrupted = false;
        telemetry("capture_resumed", { session: this.sessionId });
        this.opts.onNotice?.("capture_resumed", "Captura de áudio retomada.");
      }

      if (!dead && !recorder.isPaused && h.speechAgeMs > 120_000) {
        this.opts.onNotice?.(
          "no_audio_detected",
          "Não estamos detectando fala há alguns minutos. Verifique o microfone."
        );
      }
      this.emitMetrics();
    }, 5000);
  }

  private stopHealthMonitor() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }
}

/** Texto recuperado de uma sessão anterior (usado pelo Recovery Engine). */
export async function loadSessionText(sessionId: string): Promise<string> {
  const segments = await getSessionSegments(sessionId);
  return segments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => s.text)
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Reprocessa chunks pendentes de uma sessão recuperada. */
export async function reprocessSession(
  sessionId: string,
  language = "pt"
): Promise<{ processed: number; text: string }> {
  const chunks = (await getSessionChunks(sessionId)).filter(
    (c) => c.audio && c.status !== "transcribed"
  );
  let processed = 0;
  for (const chunk of chunks.sort((a, b) => a.sequence - b.sequence)) {
    try {
      const { data, error } = await supabase.functions.invoke("speech-to-text", {
        body: { audio: chunk.audio, mimeType: chunk.mime_type, language },
      });
      if (error || data?.error) continue;
      const text = typeof data?.text === "string" ? data.text : "";
      await putSegment({
        id: `${sessionId}:${chunk.sequence}`,
        session_id: sessionId,
        sequence: chunk.sequence,
        text,
        created_at: Date.now(),
      });
      await putChunk({ ...chunk, audio: null, status: "transcribed", processed_at: Date.now() });
      processed += 1;
    } catch {
      /* mantém o chunk para uma próxima tentativa */
    }
  }
  return { processed, text: await loadSessionText(sessionId) };
}

export async function finishRecovery(sessionId: string) {
  const chunks = await getSessionChunks(sessionId);
  if (chunks.some((chunk) => chunk.audio && chunk.status !== "transcribed")) return false;
  await patchSession(sessionId, { status: "completed", completed_at: Date.now() });
  return true;
}

export async function discardRecovery(sessionId: string) {
  await purgeSession(sessionId);
}

export { deleteChunk };
