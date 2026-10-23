import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Mic,
  Loader2,
  Square,
  SlidersHorizontal,
  MoonStar,
  Pause,
  Play,
  AlertTriangle,
  ShieldCheck,
  History,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useClinicalTranscription } from "@/hooks/useClinicalTranscription";
import { calibrateMicrophone } from "@/lib/audio/mic-calibration";
import { discardRecovery, finishRecovery, reprocessSession } from "@/lib/transcription/engine";

interface VoiceRecorderProps {
  /** Recebe cada trecho transcrito (streaming) — grave imediatamente para não perder nada */
  onTranscript: (text: string, live?: boolean) => void;
  disabled?: boolean;
  recordId?: string | null;
  patientId?: string | null;
  patientLabel?: string | null;
}

function polish(raw: string): string {
  let text = raw.trim().replace(/\s{2,}/g, " ");
  if (!text) return "";
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) text += ".";
  return text;
}

const fmt = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const FINALIZING_LABEL: Record<string, string> = {
  stopping: "Finalizando transcrição...",
  flushing: "Processando os últimos trechos...",
  saving: "Salvando transcrição...",
};

export function VoiceRecorder({
  onTranscript,
  disabled,
  recordId,
  patientId,
  patientLabel,
}: VoiceRecorderProps) {
  const [calibrating, setCalibrating] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [starting, setStarting] = useState(false);

  const dictation = useClinicalTranscription({
    context: "medical_record",
    recordId: recordId ?? null,
    patientId: patientId ?? null,
    patientLabel: patientLabel ?? null,
    language: "pt-BR",
    onSegment: (chunk) => {
      const piece = polish(chunk);
      if (piece) onTranscript(piece, true);
    },
    onNotice: (message) => toast.warning(message),
  });

  const {
    state,
    isActive,
    isFinalizing,
    isPaused,
    inBackground,
    level,
    text,
    metrics,
    elapsedMs,
    warning,
    gain,
    autoGain,
    recoverable,
    refreshRecoverable,
  } = dictation;

  const handleStart = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      const ok = await dictation.start();
      if (ok) toast.info("🎙️ Gravando. Cada trecho entra no prontuário e no rascunho em tempo real.");
    } catch {
      toast.error("Não foi possível iniciar a transcrição. Verifique o microfone e tente novamente.");
    } finally { setStarting(false); }
  }, [dictation, starting]);

  const handleStop = useCallback(async () => {
    const result = await dictation.stopAndSave();
    if (!result.text.trim() && result.integrity) {
      toast.info("Nenhuma fala foi reconhecida.");
      return;
    }
    if (result.integrity) {
      toast.success("✓ Transcrição finalizada e salva com segurança.");
    } else {
      toast.warning(
        `${result.metrics.pending} trecho(s) ainda aguardam processamento. Use "Processar pendentes".`
      );
    }
  }, [dictation]);

  const handleCalibrate = useCallback(async () => {
    setCalibrating(true);
    try {
      const result = await calibrateMicrophone();
      if (result.ok) {
        dictation.setGain(result.recommendedGain);
        toast.success(`✓ ${result.message}`);
      } else {
        toast.error(result.message);
      }
    } finally {
      setCalibrating(false);
    }
  }, [dictation]);

  const handleRecover = useCallback(
    async (sessionId: string, recoveredText: string, pending: number) => {
      setRecovering(true);
      try {
        let finalText = recoveredText;
        if (pending > 0) {
          const res = await reprocessSession(sessionId);
          if (res.text) finalText = res.text;
          toast.info(`${res.processed} trecho(s) pendente(s) processado(s).`);
          if (res.processed < pending) {
            toast.warning("Ainda há trechos pendentes. A recuperação foi preservada para tentar novamente.");
            return;
          }
        }
        if (finalText.trim()) onTranscript(polish(finalText), true);
        await finishRecovery(sessionId);
        toast.success("Transcrição recuperada e inserida no prontuário.");
      } finally {
        setRecovering(false);
        void refreshRecoverable();
      }
    },
    [onTranscript, refreshRecoverable]
  );

  const handleDiscardRecovery = useCallback(
    async (sessionId: string) => {
      if (!window.confirm("Descartar definitivamente essa transcrição recuperada?")) return;
      await discardRecovery(sessionId);
      void refreshRecoverable();
    },
    [refreshRecoverable]
  );

  const sensitivityControl = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          title="Sensibilidade do microfone"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(18rem,90vw)] space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Sensibilidade do microfone</p>
          <p className="text-xs text-muted-foreground">
            No modo automático o sistema ajusta o ganho conforme a voz e o ruído.
          </p>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">Automática</span>
          <Switch checked={autoGain} onCheckedChange={dictation.setAutoGain} />
        </div>
        <Slider
          value={[gain]}
          min={0.5}
          max={6}
          step={0.1}
          onValueChange={([v]) => dictation.setGain(v)}
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{autoGain ? "Ajuste automático" : "Manual"}</span>
          <span>{gain.toFixed(1)}x</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={handleCalibrate}
          disabled={calibrating || isActive}
        >
          {calibrating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
          {calibrating ? "Fale normalmente..." : "Testar microfone"}
        </Button>
      </PopoverContent>
    </Popover>
  );

  if (isFinalizing) {
    return (
      <Button type="button" variant="outline" size="sm" disabled className="gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {FINALIZING_LABEL[state] ?? "Finalizando..."}
      </Button>
    );
  }

  if (isActive) {
    const lastAgeS = metrics.lastSegmentAt
      ? Math.round((Date.now() - metrics.lastSegmentAt) / 1000)
      : null;

    return (
      <div className="w-full space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 sm:p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs font-semibold",
              isPaused ? "text-muted-foreground" : "text-destructive"
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isPaused ? "bg-muted-foreground" : "animate-pulse bg-destructive"
              )}
            />
            {isPaused ? "PAUSADO" : "GRAVANDO"}
          </span>
          <span className="font-mono text-xs tabular-nums">{fmt(elapsedMs)}</span>

          <div className="flex items-end gap-0.5" aria-hidden>
            {[...Array(6)].map((_, i) => {
              const active = !isPaused && level > (i + 1) / 7;
              return (
                <div
                  key={i}
                  className={cn(
                    "w-1 rounded-full transition-all duration-100",
                    active ? "bg-destructive" : "bg-destructive/20"
                  )}
                  style={{ height: `${8 + i * 3}px` }}
                />
              );
            })}
          </div>

          {inBackground && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <MoonStar className="h-3 w-3" /> em segundo plano
            </span>
          )}
          <div className="ml-auto">{sensitivityControl}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isPaused ? (
            <Button type="button" variant="outline" size="sm" onClick={dictation.resume} className="gap-2">
              <Play className="h-3 w-3" /> Retomar
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={dictation.pause} className="gap-2">
              <Pause className="h-3 w-3" /> Pausar
            </Button>
          )}
          <Button type="button" variant="destructive" size="sm" onClick={handleStop} className="gap-2">
            <Square className="h-3 w-3 fill-current" />
            <span className="hidden xs:inline">Parar e salvar transcrição</span>
            <span className="xs:hidden">Parar e salvar</span>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>Trechos: {metrics.transcribed}/{metrics.chunks}</span>
          {metrics.pending > 0 && (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> {metrics.pending} processando
            </span>
          )}
          {metrics.retries > 0 && <span>Retentativas: {metrics.retries}</span>}
          {lastAgeS !== null && <span>Última transcrição: há {lastAgeS}s</span>}
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3 w-3" /> rascunho protegido
          </span>
        </div>

        {warning && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-1">
              <p>{warning}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[11px]"
                onClick={handleCalibrate}
              >
                Testar microfone
              </Button>
            </div>
          </div>
        )}

        {text ? (
          <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-foreground/80">{text}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Fale normalmente — a transcrição aparece a cada poucos segundos.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto">
      {warning && <p role="alert" className="max-w-md text-xs text-destructive">{warning}</p>}
      {recoverable.length > 0 && (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-2 text-xs">
          {recoverable.map((item) => (
            <div key={item.session.id} className="space-y-1">
              <p className="flex items-center gap-1.5 font-medium">
                <History className="h-3.5 w-3.5" /> Encontramos uma transcrição não finalizada
              </p>
              <p className="text-muted-foreground">
                Duração recuperada: {fmt(item.session.duration_ms || Date.now() - item.session.started_at)} ·
                Trechos: {item.segmentCount} · Pendentes: {item.pendingChunks}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={recovering}
                  onClick={() => handleRecover(item.session.id, item.text, item.pendingChunks)}
                >
                  {recovering ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  {item.pendingChunks > 0 ? "Recuperar e processar pendentes" : "Recuperar transcrição"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => handleDiscardRecovery(item.session.id)}
                >
                  Descartar
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleStart}
          disabled={disabled || starting}
          className="gap-2"
          title="Iniciar transcrição (voz)"
        >
          <Mic className="h-4 w-4" />
          <span className="hidden sm:inline">{starting ? "Preparando microfone..." : "Iniciar transcrição"}</span>
          <span className="sm:hidden">{starting ? "Preparando..." : "Voz"}</span>
        </Button>
        {sensitivityControl}
      </div>
    </div>
  );
}
