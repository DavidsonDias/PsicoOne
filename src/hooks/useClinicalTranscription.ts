import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClinicalTranscriptionEngine,
  type EngineMetrics,
  type EngineState,
} from "@/lib/transcription/engine";
import { loadAutoGain, loadStoredGain, storeAutoGain, storeGain } from "@/lib/transcription/gain";
import {
  listRecoverableSessions,
  type RecoverableSession,
} from "@/lib/transcription/store";

interface Options {
  context: "medical_record" | "telehealth";
  recordId?: string | null;
  patientId?: string | null;
  patientLabel?: string | null;
  language?: string;
  /** Cada trecho confirmado — grave imediatamente no editor/rascunho */
  onSegment?: (text: string) => void;
  onNotice?: (message: string) => void;
}

const EMPTY_METRICS: EngineMetrics = {
  chunks: 0,
  transcribed: 0,
  pending: 0,
  retries: 0,
  failed: 0,
  avgLatencyMs: 0,
  lastSegmentAt: null,
  durationMs: 0,
};

export function useClinicalTranscription({
  context,
  recordId,
  patientId,
  patientLabel,
  language = "pt-BR",
  onSegment,
  onNotice,
}: Options) {
  const [state, setState] = useState<EngineState>("idle");
  const [level, setLevel] = useState(0);
  const [text, setText] = useState("");
  const [metrics, setMetrics] = useState<EngineMetrics>(EMPTY_METRICS);
  const [gain, setGainState] = useState(() => loadStoredGain());
  const [autoGain, setAutoGainState] = useState(() => loadAutoGain());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableSession[]>([]);

  const engineRef = useRef<ClinicalTranscriptionEngine | null>(null);
  const segmentRef = useRef(onSegment);
  const noticeRef = useRef(onNotice);
  segmentRef.current = onSegment;
  noticeRef.current = onNotice;

  const isActive = state === "recording" || state === "paused" || state === "background";
  const isFinalizing = state === "stopping" || state === "flushing" || state === "saving";

  // Recovery Engine: procura sessões interrompidas deste contexto
  const refreshRecoverable = useCallback(async () => {
    try {
      setRecoverable(await listRecoverableSessions(context, recordId ?? null));
    } catch {
      setRecoverable([]);
    }
  }, [context, recordId]);

  useEffect(() => {
    void refreshRecoverable();
  }, [refreshRecoverable]);

  useEffect(() => {
    if (!isActive) return;
    const id = window.setInterval(() => {
      setElapsedMs(engineRef.current?.currentMetrics.durationMs ?? 0);
    }, 500);
    return () => window.clearInterval(id);
  }, [isActive]);

  // Alerta ao sair da página durante o flush
  useEffect(() => {
    if (!isActive && !isFinalizing) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue =
        "A transcrição ainda está sendo finalizada. Aguarde alguns segundos para garantir que todo o conteúdo seja salvo.";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isActive, isFinalizing]);

  const start = useCallback(async () => {
    if (engineRef.current && isActive) return true;
    setText("");
    setWarning(null);
    const engine = new ClinicalTranscriptionEngine({
      context,
      recordId,
      patientId,
      patientLabel,
      language,
      gain,
      autoGain,
      onState: setState,
      onLevel: setLevel,
      onMetrics: setMetrics,
      onSegment: (chunk) => {
        setText((prev) => (prev ? `${prev} ${chunk}` : chunk));
        segmentRef.current?.(chunk);
      },
      onGainChange: (g) => {
        setGainState(g);
        storeGain(g);
      },
      onNotice: (kind, message) => {
        if (kind !== "capture_resumed") setWarning(message);
        if (kind === "capture_resumed") setWarning(null);
        noticeRef.current?.(message);
      },
    });
    engineRef.current = engine;
    const ok = await engine.start();
    if (!ok) engineRef.current = null;
    return ok;
  }, [autoGain, context, gain, isActive, language, patientId, patientLabel, recordId]);

  const pause = useCallback(async () => {
    await engineRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    engineRef.current?.resume();
  }, []);

  /** Zero-loss stop: aguarda o Final Flush completo antes de resolver. */
  const stopAndSave = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return { text: "", integrity: true, metrics: EMPTY_METRICS };
    const result = await engine.stopAndSave();
    setMetrics(result.metrics);
    await engine.confirmPersisted().catch(() => undefined);
    engineRef.current = null;
    void refreshRecoverable();
    return result;
  }, [refreshRecoverable]);

  const discard = useCallback(async () => {
    const engine = engineRef.current;
    engineRef.current = null;
    await engine?.discard();
    setState("idle");
    setText("");
    void refreshRecoverable();
  }, [refreshRecoverable]);

  const retryPending = useCallback(async () => {
    return (await engineRef.current?.retryPending()) ?? 0;
  }, []);

  const setGain = useCallback((value: number) => {
    setGainState(value);
    storeGain(value);
    setAutoGainState(false);
    storeAutoGain(false);
    engineRef.current?.setGain(value, true);
  }, []);

  const setAutoGain = useCallback((enabled: boolean) => {
    setAutoGainState(enabled);
    storeAutoGain(enabled);
    engineRef.current?.setAutoGain(enabled);
  }, []);

  // Desmontagem: nunca abortar — preserva tudo para recuperação
  useEffect(() => {
    return () => {
      const engine = engineRef.current;
      engineRef.current = null;
      void engine?.detach();
    };
  }, []);

  return {
    state,
    isActive,
    isFinalizing,
    isRecording: state === "recording" || state === "background",
    isPaused: state === "paused",
    inBackground: state === "background",
    level,
    text,
    metrics,
    elapsedMs,
    warning,
    gain,
    autoGain,
    recoverable,
    refreshRecoverable,
    start,
    pause,
    resume,
    stopAndSave,
    discard,
    retryPending,
    setGain,
    setAutoGain,
  };
}
