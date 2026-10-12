import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Plus, Calendar, Repeat, Trash2, Zap, User, Loader2,
  ChevronDown, ChevronUp, CheckCircle2, Clock, AlertCircle,
} from "lucide-react";
import { SmartTransactionDialog } from "@/components/financial/SmartTransactionDialog";
import { toast } from "sonner";
import { format, addDays, isBefore, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { fromYMD, nextChargeDates, toYMD } from "@/lib/billing-rules-engine";

type Plan = {
  id: string;
  psychologist_id: string;
  patient_id: string;
  billing_type: "per_session" | "weekly" | "biweekly" | "monthly";
  amount: number;
  sessions_per_cycle: number | null;
  day_of_month: number | null;
  active: boolean;
  description: string | null;
  last_generated_at: string | null;
  start_date: string | null;
  payment_method: string | null;
};

type Installment = {
  id: string;
  amount: number;
  due_date: string;
  paid_date: string | null;
  status: string;
  description: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  per_session: "Por sessão",
  weekly: "Semanal",
  biweekly: "Quinzenal",
  monthly: "Mensal",
};

const TYPE_TONE: Record<string, string> = {
  per_session: "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30",
  weekly: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  biweekly: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  monthly: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
};

function nextDueDate(plan: Plan): Date {
  // Motor único de regras de cobrança (BillingRulesEngine)
  const base = plan.last_generated_at
    ? new Date(plan.last_generated_at)
    : plan.start_date
      ? fromYMD(plan.start_date.slice(0, 10))
      : new Date();
  const [next] = nextChargeDates(
    {
      billing_type: plan.billing_type,
      day_of_month: plan.day_of_month,
      first_charge_date: toYMD(base),
      biweekly_mode: "every_14_days",
    },
    { count: 1 },
  );
  return next ? fromYMD(next) : new Date();
}

function effectiveStatus(i: Installment): "paid" | "overdue" | "pending" {
  if (i.status === "paid") return "paid";
  if (i.status === "pending" && isBefore(new Date(i.due_date + "T23:59:59"), startOfDay(new Date()))) return "overdue";
  return "pending";
}

const STATUS_TONE: Record<string, string> = {
  paid: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  overdue: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};

const STATUS_LABEL: Record<string, string> = {
  paid: "Paga",
  pending: "Gerada",
  overdue: "Em atraso",
};

const STATUS_ICON: Record<string, any> = {
  paid: CheckCircle2,
  pending: Clock,
  overdue: AlertCircle,
};

export function BillingPlansPanel({
  patients,
  onChanged,
}: {
  patients: { id: string; full_name: string }[];
  onChanged?: () => void;
}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [open, setOpen] = useState(false);
  const generatingRef = useRef(false);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [installments, setInstallments] = useState<Record<string, Installment[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [markingId, setMarkingId] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("patient_billing_plans" as any)
      .select("*")
      .is("deleted_at", null)
      .order("active", { ascending: false })
      .order("created_at", { ascending: false });
    const list = ((data as any) || []) as Plan[];
    setPlans(list);

    if (list.length > 0) {
      const ids = list.map(p => p.id);
      const { data: tx } = await (supabase as any)
        .from("financial_transactions")
        .select("id, amount, due_date, paid_date, status, description, billing_plan_id")
        .in("billing_plan_id", ids)
        .is("deleted_at", null)
        .order("due_date", { ascending: false });
      const grouped: Record<string, Installment[]> = {};
      ((tx as any[]) || []).forEach((t) => {
        const k = t.billing_plan_id as string;
        (grouped[k] ||= []).push(t as Installment);
      });
      setInstallments(grouped);
    } else {
      setInstallments({});
    }
  };

  useEffect(() => { load(); }, []);

  const monthlyForecast = plans
    .filter((p) => p.active)
    .reduce((s, p) => {
      const multiplier = p.billing_type === "weekly" ? 4 : p.billing_type === "biweekly" ? 2 : 1;
      return s + Number(p.amount) * multiplier;
    }, 0);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const togglePlan = async (plan: Plan) => {
    const { error } = await supabase
      .from("patient_billing_plans" as any)
      .update({ active: !plan.active })
      .eq("id", plan.id);
    if (error) { toast.error(error.message); return; }
    toast.success(plan.active ? "Plano pausado" : "Plano ativado");
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Excluir este plano de cobrança?")) return;
    await supabase
      .from("patient_billing_plans" as any)
      .update({ deleted_at: new Date().toISOString(), active: false })
      .eq("id", id);
    toast.success("Plano excluído");
    load();
    onChanged?.();
  };

  const markInstallmentPaid = async (i: Installment) => {
    setMarkingId(i.id);
    const { error } = await supabase
      .from("financial_transactions")
      .update({
        status: "paid",
        paid_date: new Date().toISOString().slice(0, 10),
      } as any)
      .eq("id", i.id);
    setMarkingId(null);
    if (error) { toast.error(error.message); return; }
    toast.success("Parcela marcada como paga");
    load();
    onChanged?.();
  };

  const generateNow = async (plan: Plan) => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGeneratingId(plan.id);
    try {
      const due = nextDueDate(plan);
      const { data, error } = await (supabase as any).rpc("generate_manual_billing_cycle", {
        p_plan_id: plan.id,
        p_expected_last_generated_at: plan.last_generated_at,
        p_due_date: format(due, "yyyy-MM-dd"),
      });
      if (error) throw error;
      if (data?.created === false && data?.reason === "stale_plan") {
        toast.info("Este plano já foi atualizado. Confira os lançamentos antes de gerar outro.");
      } else if (data?.created === true && typeof data?.transaction_id === "string") {
        toast.success(`Cobrança gerada para ${format(due, "dd/MM/yyyy")}`);
      } else {
        throw new Error("Resposta inesperada");
      }
      await load();
      onChanged?.();
    } catch {
      toast.error("Não foi possível confirmar a geração. Atualize a lista e confira os lançamentos antes de tentar novamente.");
    } finally {
      generatingRef.current = false;
      setGeneratingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Repeat className="h-4 w-4 text-primary" /> Planos de Cobrança
          </CardTitle>
          <CardDescription>
            Cobrança recorrente por paciente.{" "}
            <span className="font-medium text-foreground">
              Receita mensal prevista: R$ {monthlyForecast.toFixed(2)}
            </span>
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Novo plano
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {plans.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Nenhum plano configurado</p>
        ) : (
          plans.map((p) => {
            const patient = patients.find((x) => x.id === p.patient_id);
            const due = nextDueDate(p);
            const isGen = generatingId === p.id;
            const list = installments[p.id] || [];
            const summary = list.reduce(
              (acc, i) => {
                const s = effectiveStatus(i);
                acc[s] = (acc[s] || 0) + 1;
                return acc;
              },
              { paid: 0, pending: 0, overdue: 0 } as Record<string, number>
            );
            const isOpen = expanded.has(p.id);

            return (
              <div
                key={p.id}
                className={`rounded-xl border p-3 sm:p-4 transition-colors ${
                  p.active ? "bg-card hover:border-primary/40" : "bg-muted/30 opacity-70"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <User className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm truncate">
                          {patient?.full_name || "Paciente"}
                        </span>
                        <Badge variant="outline" className={`text-[10px] ${TYPE_TONE[p.billing_type]}`}>
                          {TYPE_LABEL[p.billing_type]}
                        </Badge>
                        {!p.active && <Badge variant="secondary" className="text-[10px]">Pausado</Badge>}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        <span className="font-medium text-foreground">R$ {Number(p.amount).toFixed(2)}</span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          Próx. {format(due, "dd 'de' MMM", { locale: ptBR })}
                        </span>
                        {p.last_generated_at && (
                          <span className="text-[11px]">Última: {format(new Date(p.last_generated_at), "dd/MM")}</span>
                        )}
                      </div>

                      {/* Status pills aggregating installments */}
                      {list.length > 0 && (
                        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                          {summary.overdue > 0 && (
                            <Badge variant="outline" className={`text-[10px] ${STATUS_TONE.overdue}`}>
                              <AlertCircle className="h-3 w-3 mr-1" />{summary.overdue} em atraso
                            </Badge>
                          )}
                          {summary.pending > 0 && (
                            <Badge variant="outline" className={`text-[10px] ${STATUS_TONE.pending}`}>
                              <Clock className="h-3 w-3 mr-1" />{summary.pending} a vencer
                            </Badge>
                          )}
                          {summary.paid > 0 && (
                            <Badge variant="outline" className={`text-[10px] ${STATUS_TONE.paid}`}>
                              <CheckCircle2 className="h-3 w-3 mr-1" />{summary.paid} paga{summary.paid > 1 ? "s" : ""}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <Switch
                    checked={p.active}
                    onCheckedChange={() => togglePlan(p)}
                    aria-label={p.active ? "Pausar plano" : "Ativar plano"}
                  />
                </div>

                {/* Expandable installments list */}
                {list.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/60">
                    <button
                      type="button"
                      onClick={() => toggleExpand(p.id)}
                      className="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span>{isOpen ? "Ocultar parcelas" : `Ver ${list.length} parcela${list.length > 1 ? "s" : ""}`}</span>
                      {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>

                    {isOpen && (
                      <div className="mt-2 space-y-1.5">
                        {list.map((i) => {
                          const st = effectiveStatus(i);
                          const Ico = STATUS_ICON[st];
                          return (
                            <div
                              key={i.id}
                              className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-md bg-muted/40 text-xs"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <div className={`h-7 w-7 rounded-md flex items-center justify-center ${STATUS_TONE[st]}`}>
                                  <Ico className="h-3.5 w-3.5" />
                                </div>
                                <div className="min-w-0">
                                  <div className="font-medium truncate">
                                    R$ {Number(i.amount).toFixed(2)} · {format(new Date(i.due_date + "T00:00:00"), "dd/MM/yyyy")}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {STATUS_LABEL[st]}
                                    {i.paid_date && st === "paid" && ` em ${format(new Date(i.paid_date + "T00:00:00"), "dd/MM/yyyy")}`}
                                  </div>
                                </div>
                              </div>
                              {st !== "paid" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] gap-1"
                                  onClick={() => markInstallmentPaid(i)}
                                  disabled={markingId === i.id}
                                >
                                  {markingId === i.id
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <CheckCircle2 className="h-3 w-3" />}
                                  Marcar paga
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-border/60">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    onClick={() => generateNow(p)}
                    disabled={!p.active || isGen}
                  >
                    {isGen ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                    Gerar cobrança agora
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    onClick={() => remove(p.id)}
                    aria-label="Excluir plano"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>

      <SmartTransactionDialog
        open={open}
        onOpenChange={setOpen}
        defaultMode="recurring"
        lockMode
        onCreated={() => {
          load();
          onChanged?.();
        }}
      />
    </Card>
  );
}

