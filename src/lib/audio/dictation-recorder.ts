/**
 * DictationRecorder — captura contínua de áudio com:
 *  - Ganho ajustável + compressor (sensibilidade do microfone)
 *  - Janelas WAV completas (funciona em qualquer navegador / iOS Safari)
 *  - Continuidade em background (PWA minimizado): keep-alive de áudio,
 *    MediaSession, Wake Lock e retomada automática do AudioContext.
 */

import { blobToBase64, concatFloat32, downsample, encodeWav, normalizePeak } from "./wav";
import { AdaptiveVoiceActivityDetector } from "./voice-activity";
import { captureSupportError, captureErrorMessage } from "./capture-diagnostics";
import { DICTATION_WINDOW_MS, shouldFlushDictation } from "./dictation-window";

export interface DictationRecorderOptions {
  /** Ganho aplicado ao microfone (1 = normal, 3 = alta sensibilidade) */
  gain?: number;
  /** Duração de cada janela enviada para transcrição (ms) */
  windowMs?: number;
  /** Nível RMS mínimo para considerar que houve fala na janela */
  silenceThreshold?: number;
  targetSampleRate?: number;
  onWindow: (payload: { base64: string; mimeType: string; durationMs: number }) => void;
  onLevel?: (rms: number) => void;
  onError?: (message: string) => void;
  onBackgroundState?: (active: boolean) => void;
}

const KEEP_ALIVE_WAV =
  "data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQ4AAAAAAAAAAAAAAAAAAAAAAA==";

export class DictationRecorder {
  private opts: Required<Omit<DictationRecorderOptions, "onWindow" | "onLevel" | "onError" | "onBackgroundState">> &
    DictationRecorderOptions;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private presence: BiquadFilterNode | null = null;
  private gainNode: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private buffer: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  private bufferedSamples = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveEl: HTMLAudioElement | null = null;
  private wakeLock: any = null;
  private visibilityHandler: (() => void) | null = null;
  private running = false;
  private paused = false;
  private lastFrameAt = 0;
  private lastSpeechAt = 0;
  private peakRms = 0;
  private readonly voiceDetector = new AdaptiveVoiceActivityDetector();
  private speechMs = 0;
  private silenceMs = 0;
  /** Cauda da janela anterior: evita perder palavras cortadas na fronteira */
  private overlapTail: Float32Array[] = [];
  private overlapSamples = 0;


  constructor(options: DictationRecorderOptions) {
    this.opts = {
      gain: 2,
      windowMs: DICTATION_WINDOW_MS,
      silenceThreshold: 0.006,
      targetSampleRate: 16000,

      ...options,
    } as any;
  }


  get isRunning() {
    return this.running;
  }

  get isPaused() {
    return this.paused;
  }

  /** Sinais reais de saúde da captura (detecção de "gravação fantasma"). */
  get health() {
    const track = this.stream?.getAudioTracks?.()[0];
    return {
      trackLive: !!track && track.readyState === "live" && !track.muted,
      contextState: this.ctx?.state ?? "closed",
      frameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : Infinity,
      speechAgeMs: this.lastSpeechAt ? Date.now() - this.lastSpeechAt : Infinity,
    };
  }

  /** Pausa mantendo os recursos e a sessão recuperável (não é "parar"). */
  async pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    await this.flush(true);
  }

  resume() {
    if (!this.running) return;
    this.paused = false;
    void this.ctx?.resume().catch(() => undefined);
  }

  setGain(gain: number) {
    this.opts.gain = gain;
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.05);
    }
  }

  async start(): Promise<boolean> {
    if (this.running) return true;
    const unsupported = captureSupportError();
    if (unsupported) { this.opts.onError?.(unsupported); return false; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // A finalidade clínica inclui captar a voz remota reproduzida pelo
          // alto-falante em Meet/WhatsApp. Cancelamento de eco e supressão de
          // ruído costumam apagar exatamente essa voz, sobretudo no mobile.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (e) {
      this.opts.onError?.(
        captureErrorMessage(e)
      );
      return false;
    }

    const Ctor: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctor();
    await this.ctx.resume().catch(() => {});

    this.source = this.ctx.createMediaStreamSource(this.stream);

    // Cadeia de tratamento: corta rumor de fundo, realça a banda da fala,
    // aplica ganho e comprime — voz baixa fica audível sem distorcer.
    this.highpass = this.ctx.createBiquadFilter();
    this.highpass.type = "highpass";
    this.highpass.frequency.value = 80;
    this.highpass.Q.value = 0.7;

    this.presence = this.ctx.createBiquadFilter();
    this.presence.type = "peaking";
    this.presence.frequency.value = 2600;
    this.presence.Q.value = 0.9;
    this.presence.gain.value = 4;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.opts.gain;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -50;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.3;

    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      this.lastFrameAt = Date.now();
      if (this.paused) return;
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input);
      const frameMs = (copy.length / (this.ctx?.sampleRate || 48000)) * 1000;

      let sum = 0;
      for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
      const rms = Math.sqrt(sum / copy.length);

      const activity = this.voiceDetector.analyze(rms);
      const isSpeech = activity.isSpeech || rms >= this.opts.silenceThreshold;

      if (this.speechMs === 0) {
        this.preRoll.push(copy);
        this.preRollSamples += copy.length;
        // Pré-buffer generoso (1,5s): nunca perde o início da frase, mesmo
        // quando o começo da fala é sussurrado.
        const maxPreRollSamples = Math.round((this.ctx?.sampleRate || 48000) * 1.5);
        while (this.preRollSamples > maxPreRollSamples && this.preRoll.length > 1) {
          const removed = this.preRoll.shift();
          if (removed) this.preRollSamples -= removed.length;
        }
      }

      if (isSpeech && this.speechMs === 0) {
        if (this.overlapSamples > 0) {
          this.buffer.push(...this.overlapTail);
          this.bufferedSamples += this.overlapSamples;
          this.overlapTail = [];
          this.overlapSamples = 0;
        }
        this.buffer.push(...this.preRoll);
        this.bufferedSamples += this.preRollSamples;
        this.preRoll = [];
        this.preRollSamples = 0;
      } else if (this.speechMs > 0) {
        this.buffer.push(copy);
        this.bufferedSamples += copy.length;
      }

      if (isSpeech) {
        this.lastSpeechAt = Date.now();
        this.speechMs += frameMs;
        this.silenceMs = 0;
      } else if (this.speechMs > 0) {
        this.silenceMs += frameMs;
      }

      this.peakRms = Math.max(this.peakRms, rms);
      this.opts.onLevel?.(rms);

      // Envia na pausa natural ou a cada 8s; overlap e dedupe preservam a fronteira.
      const totalMs = (this.bufferedSamples / (this.ctx?.sampleRate || 48000)) * 1000;
      if (shouldFlushDictation(totalMs, this.speechMs, this.silenceMs, this.opts.windowMs)) void this.flush(false);
    };

    // Saída silenciosa: mantém o grafo ativo sem devolver áudio ao usuário
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;

    this.source.connect(this.highpass);
    this.highpass.connect(this.presence);
    this.presence.connect(this.gainNode);
    this.gainNode.connect(this.compressor);
    this.compressor.connect(this.processor);
    this.processor.connect(this.sink);

    this.sink.connect(this.ctx.destination);

    this.running = true;

    this.startKeepAlive();
    this.requestWakeLock();
    // Retoma o contexto se o navegador o suspender ao trocar de app/tela.
    this.flushTimer = setInterval(() => {
      if (this.running && this.ctx?.state === "suspended") {
        void this.ctx.resume().catch(() => undefined);
      }
    }, 1500);


    this.visibilityHandler = () => {
      if (!this.running) return;
      this.ctx?.resume().catch(() => {});
      this.keepAliveEl?.play().catch(() => {});
      if (document.visibilityState === "visible") this.requestWakeLock();
      this.opts.onBackgroundState?.(document.visibilityState !== "visible");
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
    window.addEventListener("pagehide", this.visibilityHandler);

    return true;
  }

  /** Envia o áudio acumulado imediatamente (usado ao parar a gravação) */
  async flushNow() {
    await this.flush(true);
  }

  private async flush(force: boolean) {
    if (!this.ctx) return;
    if (this.bufferedSamples === 0) return;

    const chunks = this.buffer;
    const peak = this.peakRms;
    const speechMs = this.speechMs;
    this.buffer = [];
    this.preRoll = [];
    this.preRollSamples = 0;
    this.bufferedSamples = 0;
    this.peakRms = 0;
    this.speechMs = 0;
    this.silenceMs = 0;

    // Sem fala suficiente: transcrever ruído é o que gera texto inventado
    // (alucinação do modelo em outros idiomas). Descarta a janela.
    const minSpeechMs = force ? 150 : 220;
    if (speechMs < minSpeechMs) return;
    if (peak < 0.0022) return;

    const merged = concatFloat32(chunks);
    const rate = this.ctx.sampleRate;

    // Guarda uma cauda curta (0,25s) para a próxima janela: suficiente para
    // não perder a palavra na fronteira, com o mínimo de áudio reenviado.
    if (!force) {
      const tailSamples = Math.min(merged.length, Math.round(rate * 0.25));
      this.overlapTail = [merged.slice(merged.length - tailSamples)];
      this.overlapSamples = tailSamples;
    } else {
      this.overlapTail = [];
      this.overlapSamples = 0;
    }

    const resampled = downsample(merged, rate, this.opts.targetSampleRate);
    const durationMs = (merged.length / rate) * 1000;
    if (durationMs < 300) return;

    // AGC por janela: entrega amplitude útil ao modelo mesmo com voz baixa
    const leveled = normalizePeak(resampled);
    const wav = encodeWav(leveled, this.opts.targetSampleRate);
    if (wav.size < 2048) return;


    try {
      const base64 = await blobToBase64(wav);
      this.opts.onWindow({ base64, mimeType: "audio/wav", durationMs });
    } catch {
      this.opts.onError?.("Falha ao preparar o áudio para transcrição.");
    }
  }

  private startKeepAlive() {
    try {
      const el = document.createElement("audio");
      el.src = KEEP_ALIVE_WAV;
      el.loop = true;
      el.volume = 0.0001;
      (el as any).playsInline = true;
      el.setAttribute("aria-hidden", "true");
      el.style.display = "none";
      document.body.appendChild(el);
      el.play().catch(() => {});
      this.keepAliveEl = el;

      if ("mediaSession" in navigator) {
        (navigator as any).mediaSession.metadata = new (window as any).MediaMetadata({
          title: "Gravando sessão clínica",
          artist: "PsicoOne",
        });
        (navigator as any).mediaSession.playbackState = "playing";
      }
    } catch {
      /* keep-alive é best effort */
    }
  }

  private async requestWakeLock() {
    try {
      if (this.wakeLock || !("wakeLock" in navigator)) return;
      this.wakeLock = await (navigator as any).wakeLock.request("screen");
      this.wakeLock.addEventListener?.("release", () => {
        this.wakeLock = null;
      });
    } catch {
      this.wakeLock = null;
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;

    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      window.removeEventListener("pagehide", this.visibilityHandler);
      this.visibilityHandler = null;
    }

    await this.flush(true);

    try {
      if (this.processor) this.processor.onaudioprocess = null as any;
      this.processor?.disconnect();
      this.compressor?.disconnect();
      this.gainNode?.disconnect();
      this.presence?.disconnect();
      this.highpass?.disconnect();

      this.source?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* noop */
    }

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.overlapTail = [];
    this.overlapSamples = 0;
    this.voiceDetector.reset();


    if (this.keepAliveEl) {
      this.keepAliveEl.pause();
      this.keepAliveEl.remove();
      this.keepAliveEl = null;
    }
    if ("mediaSession" in navigator) {
      try {
        (navigator as any).mediaSession.playbackState = "none";
      } catch {}
    }
    try {
      await this.wakeLock?.release?.();
    } catch {}
    this.wakeLock = null;
  }
}
