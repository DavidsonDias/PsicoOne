import { formatRecordLocally } from "@/lib/local-record-format";
import { useState, useCallback, useRef, memo, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, ChevronUp, Lightbulb, Edit3, Sparkles, Brain, Loader2, MessageSquare, Wand2, FileText, Type, Target, CheckCircle, Expand } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { VoiceRecorder } from "./VoiceRecorder";
import { AIRefinementModal } from "./AIRefinementModal";
import { AIChatPanel } from "./AIChatPanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

interface FreeFormEditorProps {
  value: string;
  onChange: (value: string) => void;
  structuredFields?: {
    complaints: string;
    observations: string;
    techniques_used: string;
    evolution: string;
    next_steps: string;
  };
  onStructuredChange?: (field: string, value: string) => void;
  className?: string;
  /** Contexto clínico para a engine de transcrição (recuperação por prontuário) */
  recordId?: string | null;
  patientId?: string | null;
  patientLabel?: string | null;
}

const APPROACHES = [
  { value: "neutral", label: "Neutra / Técnica", icon: "📋" },
  { value: "tcc", label: "Comportamental (TCC)", icon: "🧠" },
  { value: "psychoanalytic", label: "Psicanalítica", icon: "🛋️" },
  { value: "humanistic", label: "Humanista", icon: "🌱" },
  { value: "systemic", label: "Sistêmica", icon: "🔗" },
  { value: "integrative", label: "Integrativa", icon: "🔄" },
  { value: "phenomenological", label: "Fenomenológica Existencial", icon: "🌀" },
];

const AI_ACTIONS = [
  { value: "refine", label: "Melhorar escrita", icon: Wand2 },
  { value: "organize", label: "Reorganizar texto", icon: FileText },
  { value: "summarize", label: "Resumir sessão", icon: Target },
  { value: "clinical", label: "Tornar mais clínica", icon: Brain },
  { value: "objective", label: "Tornar mais objetiva", icon: CheckCircle },
  { value: "grammar", label: "Corrigir gramática", icon: Type },
  { value: "expand", label: "Expandir reflexão", icon: Expand },
];

const suggestions = [
  "Descreva o estado emocional do paciente",
  "Registre técnicas aplicadas",
  "Anote próximos passos",
  "Documente evolução observada",
];

const StructuredField = memo(({ label, value, placeholder, field, onChange }: {
  label: string; value: string; placeholder: string; field: string;
  onChange: (field: string, value: string) => void;
}) => {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(field, e.target.value);
  }, [field, onChange]);

  return (
    <div className="space-y-2">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      <Textarea value={value} onChange={handleChange} placeholder={placeholder} rows={2} className="text-sm" />
    </div>
  );
});
StructuredField.displayName = "StructuredField";

const MainTextarea = memo(({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  }, [onChange]);

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={handleChange}
      placeholder="Escreva livremente suas anotações sobre a sessão. Você tem total liberdade para registrar da forma que preferir..."
      rows={8}
      className="min-h-[200px] resize-y text-base leading-relaxed"
    />
  );
});
MainTextarea.displayName = "MainTextarea";

export const FreeFormEditor = memo(function FreeFormEditor({
  value, onChange, structuredFields, onStructuredChange, className,
  recordId, patientId, patientLabel,

}: FreeFormEditorProps) {
  const [showStructured, setShowStructured] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentAction, setCurrentAction] = useState<string | null>(null);
  const [refinementModal, setRefinementModal] = useState<{
    open: boolean; original: string; refined: string; mode: "refine" | "organize" | "local";
  }>({ open: false, original: "", refined: "", mode: "refine" });
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [approach, setApproach] = useState("neutral");
  const [customInstruction, setCustomInstruction] = useState("");
  const [showCustomInstruction, setShowCustomInstruction] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  // Load saved preference
  useEffect(() => {
    const loadPreference = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { data } = await supabase
        .from("profiles")
        .select("preferred_clinical_style")
        .eq("id", session.user.id)
        .single();
      if (data?.preferred_clinical_style) {
        setApproach(data.preferred_clinical_style);
      }
    };
    loadPreference();
  }, []);

  // Save preference when changed
  const handleApproachChange = useCallback(async (newApproach: string) => {
    setApproach(newApproach);
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      await supabase.from("profiles").update({ preferred_clinical_style: newApproach } as any).eq("id", session.user.id);
    }
  }, []);

  const insertSuggestion = useCallback((text: string) => {
    onChange(value ? `${value}\n\n${text}: ` : `${text}: `);
  }, [value, onChange]);

  const handleVoiceTranscript = useCallback((transcript: string, live?: boolean) => {
    const newValue = value ? `${value} ${transcript}` : transcript;
    // Em streaming não empilha undo a cada trecho (seriam dezenas por sessão)
    if (!live) setUndoStack(prev => [...prev, value]);
    onChange(newValue);
  }, [value, onChange]);


  const handleLocalFormat = useCallback(() => {
    const formatted = formatRecordLocally(value);
    if (!formatted) return;
    if (formatted === value) { toast.info("Os espaços e parágrafos já estão organizados."); return; }
    setRefinementModal({ open: true, original: value, refined: formatted, mode: "local" });
  }, [value]);

  const handleAIAction = useCallback(async (action: string) => {
    if (!value?.trim()) {
      toast.error("Escreva ou dite algo antes de usar a IA.");
      return;
    }

    setIsProcessing(true);
    setCurrentAction(action);

    try {
      const { data, error } = await supabase.functions.invoke("refine-record", {
        body: { text: value, action, approach, customInstruction: customInstruction || undefined },
      });

      // supabase.functions.invoke does not parse the error body for non-2xx;
      // fetch it manually so we can surface 402 (credits) / 429 (rate limit) properly.
      if (error) {
        let serverMsg: string | null = null;
        try {
          const ctx: any = (error as any).context;
          if (ctx && typeof ctx.json === "function") {
            const body = await ctx.json();
            serverMsg = body?.error || null;
          } else if (ctx && typeof ctx.text === "function") {
            const txt = await ctx.text();
            try { serverMsg = JSON.parse(txt)?.error ?? txt; } catch { serverMsg = txt; }
          }
        } catch {}
        throw new Error(serverMsg || error.message || "Erro ao processar com IA");
      }
      if (data?.error) throw new Error(data.error);

      setRefinementModal({
        open: true,
        original: value,
        refined: data.refined || "",
        mode: action === "organize" ? "organize" : "refine",
      });
    } catch (err: any) {
      console.error("AI error:", err);
      const msg: string = err?.message || "Erro ao processar com IA";
      if (/cr[eé]ditos/i.test(msg) || /402/.test(msg)) {
        toast.error("Créditos de IA insuficientes. Seu texto foi preservado. Você pode usar Formatar sem IA para ajustar espaços e linhas sem créditos.");
      } else if (/limite/i.test(msg) || /429/.test(msg)) {
        toast.error("Muitas requisições. Aguarde alguns instantes e tente novamente.");
      } else {
        toast.error(msg);
      }
    } finally {
      setIsProcessing(false);
      setCurrentAction(null);
    }
  }, [value, approach, customInstruction]);

  const handleReplace = useCallback(() => {
    setUndoStack(prev => [...prev, value]);
    onChange(refinementModal.refined);
    setRefinementModal(prev => ({ ...prev, open: false }));
    toast.success("Texto substituído!");
  }, [value, refinementModal.refined, onChange]);

  const handleMerge = useCallback(() => {
    setUndoStack(prev => [...prev, value]);
    onChange(`${value}\n\n--- Versão Refinada ---\n\n${refinementModal.refined}`);
    setRefinementModal(prev => ({ ...prev, open: false }));
    toast.success("Textos mesclados!");
  }, [value, refinementModal.refined, onChange]);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));
    onChange(previous);
    toast.info("Ação desfeita");
  }, [undoStack, onChange]);

  const handleApplyFromChat = useCallback((text: string) => {
    setUndoStack(prev => [...prev, value]);
    onChange(text);
  }, [value, onChange]);

  const currentApproach = APPROACHES.find(a => a.value === approach);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-3">
        {/* Header row */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label className="flex items-center gap-2">
            <Edit3 className="h-4 w-4 text-primary" />
            Anotações da Sessão
            <Badge variant="outline" className="text-xs font-normal">Campo livre</Badge>
          </Label>

          <div className="flex items-center gap-2 flex-wrap">
            {undoStack.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={handleUndo} className="text-xs h-7">
                Desfazer
              </Button>
            )}
            <VoiceRecorder
              onTranscript={handleVoiceTranscript}
              recordId={recordId ?? null}
              patientId={patientId ?? null}
              patientLabel={patientLabel ?? null}
            />
          </div>
        </div>

        {/* AI Controls Row */}
        <div className="flex items-center gap-2 flex-wrap p-3 rounded-lg bg-muted/30 border">
          {/* Approach Selector */}
          <Select value={approach} onValueChange={handleApproachChange}>
            <SelectTrigger className="w-auto min-w-[180px] h-8 text-xs">
              <SelectValue>
                {currentApproach && `${currentApproach.icon} ${currentApproach.label}`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {APPROACHES.map((a) => (
                <SelectItem key={a.value} value={a.value}>
                  <span className="flex items-center gap-2">
                    <span>{a.icon}</span>
                    <span>{a.label}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* AI Action Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={isProcessing || !value?.trim()} className="gap-2 h-8">
                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                <span className="hidden sm:inline">Ações IA</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Ações de IA</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {AI_ACTIONS.map((action) => (
                <DropdownMenuItem
                  key={action.value}
                  onClick={() => handleAIAction(action.value)}
                  disabled={isProcessing}
                >
                  <action.icon className="h-4 w-4 mr-2" />
                  {action.label}
                  {currentAction === action.value && <Loader2 className="h-3 w-3 animate-spin ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button type="button" variant="outline" size="sm" onClick={handleLocalFormat}
            disabled={isProcessing || !value?.trim()} className="h-8 gap-2"
            title="Organiza espaços e linhas neste dispositivo. Não usa IA nem créditos.">
            <FileText className="h-4 w-4" /> Formatar sem IA
          </Button>

          {/* Chat Button */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setChatOpen(true)}
            className="gap-2 h-8"
          >
            <MessageSquare className="h-4 w-4" />
            <span className="hidden sm:inline">Assistente</span>
          </Button>

          {/* Custom Instruction Toggle */}
          <Button
            type="button"
            variant={showCustomInstruction ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowCustomInstruction(!showCustomInstruction)}
            className="h-8 text-xs"
          >
            Instrução
          </Button>
        </div>

        {/* Custom Instruction Field */}
        {showCustomInstruction && (
          <div className="flex gap-2">
            <Input
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder="Ex: Use linguagem psicanalítica, foque em transferência..."
              className="text-sm"
            />
          </div>
        )}

        <MainTextarea value={value} onChange={onChange} />

        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Lightbulb className="h-3 w-3" />
            Sugestões:
          </span>
          {suggestions.map((suggestion) => (
            <Button key={suggestion} type="button" variant="outline" size="sm" className="h-6 text-xs" onClick={() => insertSuggestion(suggestion)}>
              + {suggestion}
            </Button>
          ))}
        </div>
      </div>

      {structuredFields && onStructuredChange && (
        <Collapsible open={showStructured} onOpenChange={setShowStructured}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" className="w-full justify-between text-muted-foreground hover:text-foreground">
              <span className="flex items-center gap-2">Campos estruturados (opcional)</span>
              {showStructured ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <p className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg">
              💡 Estes campos são totalmente opcionais. Use-os apenas se preferir organizar suas anotações de forma estruturada.
            </p>
            <StructuredField label="Queixas Apresentadas" value={structuredFields.complaints} placeholder="Opcional: motivo da consulta e queixas do paciente" field="complaints" onChange={onStructuredChange} />
            <StructuredField label="Observações Clínicas" value={structuredFields.observations} placeholder="Opcional: estado emocional, comportamento, relatos relevantes" field="observations" onChange={onStructuredChange} />
            <StructuredField label="Técnicas Utilizadas" value={structuredFields.techniques_used} placeholder="Opcional: técnicas aplicadas, exercícios propostos" field="techniques_used" onChange={onStructuredChange} />
            <StructuredField label="Evolução do Tratamento" value={structuredFields.evolution} placeholder="Opcional: progressos observados e mudanças no quadro" field="evolution" onChange={onStructuredChange} />
            <StructuredField label="Próximos Passos" value={structuredFields.next_steps} placeholder="Opcional: plano para as próximas sessões" field="next_steps" onChange={onStructuredChange} />
          </CollapsibleContent>
        </Collapsible>
      )}

      <AIRefinementModal
        open={refinementModal.open}
        onOpenChange={(open) => setRefinementModal(prev => ({ ...prev, open }))}
        originalText={refinementModal.original}
        refinedText={refinementModal.refined}
        mode={refinementModal.mode}
        onReplace={handleReplace}
        onMerge={handleMerge}
      />

      <AIChatPanel
        open={chatOpen}
        onOpenChange={setChatOpen}
        currentText={value}
        approach={approach}
        onApplyText={handleApplyFromChat}
      />
    </div>
  );
});
