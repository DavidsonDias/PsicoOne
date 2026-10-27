import { useEffect, useState, useMemo, useRef } from "react";
import { useWriteGuard } from "@/components/subscription/WriteBlockedModal";
import { useSubscriptionGuard } from "@/hooks/useSubscriptionGuard";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PatientCombobox } from "@/components/shared/PatientCombobox";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Plus, DollarSign, TrendingUp, TrendingDown, Calendar, Search, Filter,
  Target, PieChart, Receipt, AlertTriangle, BarChart3, Upload, FileText,
  Paperclip, Download, User, ExternalLink, CheckCircle2, Clock, XCircle,
  CreditCard, Settings, Sparkles, Repeat
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format, subMonths, startOfMonth, endOfMonth, isAfter, addMonths, setMonth, setYear } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ActionMenu } from "@/components/ui/action-menu";
import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { StatsOverview } from "@/components/ui/stats-overview";
import { FinancialChart } from "@/components/financial/FinancialChart";
import { FinancialProjections } from "@/components/financial/FinancialProjections";
import { CategoryAnalysis } from "@/components/financial/CategoryAnalysis";
import { FinancialGrowth } from "@/components/financial/FinancialGrowth";
import { RecurringBillingsPanel } from "@/components/financial/RecurringBillingsPanel";
import { BillingPlansPanel } from "@/components/financial/BillingPlansPanel";
import { ReconciliationPanel } from "@/components/financial/ReconciliationPanel";
import { OverdueSemaforo } from "@/components/financial/OverdueSemaforo";
import { SmartTransactionDialog } from "@/components/financial/SmartTransactionDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { exportToCSV, exportToExcel, exportToPDF } from "@/lib/export-utils";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Transaction {
  id: string;
  type: "income" | "expense";
  amount: number;
  description: string;
  category: string;
  payment_method: string;
  payment_status: string;
  due_date: string;
  paid_date: string | null;
  patient_id: string | null;
  patient_name?: string;
  created_at: string;
  cost_center?: string;
  attachment_url?: string;
  receipt_url?: string;
  invoice_status?: string;
  invoice_number?: string;
  tax_rate?: number;
  tax_amount?: number;
  appointment_id?: string;
  stripe_payment_link?: string | null;
}

interface PatientFull {
  id: string;
  full_name: string;
  default_session_value?: number | null;
  monthly_plan_value?: number | null;
  payment_day?: number | null;
}

const INCOME_CATEGORIES = [
  "Consulta psicológica", "Pacote mensal", "Avaliação / Laudo",
  "Atendimento online", "Atendimento presencial", "Supervisão", "Workshop", "Outros"
];
const EXPENSE_CATEGORIES = [
  "Ferramentas / Software", "Marketing", "Operacional",
  "Aluguel consultório", "Impostos", "Equipamentos", "Outros"
];
const COST_CENTERS = ["Clínica", "Marketing", "Software", "Estrutura", "Impostos", "Pessoal", "Outros"];
const PAYMENT_METHODS = [
  { value: "pix", label: "PIX" },
  { value: "credit_card", label: "Cartão Crédito" },
  { value: "debit_card", label: "Cartão Débito" },
  { value: "cash", label: "Dinheiro" },
  { value: "bank_transfer", label: "Transferência" },
];

function calcSmartDueDate(paymentDay: number): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  // If payment day already passed this month, use next month
  if (paymentDay < day) {
    const next = new Date(year, month + 1, paymentDay);
    return format(next, "yyyy-MM-dd");
  }
  return format(new Date(year, month, paymentDay), "yyyy-MM-dd");
}

function suggestDescription(patientName: string, category: string): string {
  if (category === "Consulta psicológica") return `Sessão psicológica — ${patientName}`;
  if (category === "Pacote mensal") return `Plano mensal — ${patientName}`;
  if (category === "Avaliação / Laudo") return `Avaliação — ${patientName}`;
  return `Sessão de atendimento — ${patientName}`;
}

const MONTHS = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

export default function Financeiro() {
  const { guardWrite } = useWriteGuard();
  const { checkSubscriptionBeforeWrite } = useSubscriptionGuard();
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [patients, setPatients] = useState<PatientFull[]>([]);
  const [userId, setUserId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterPatient, setFilterPatient] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMonth, setSelectedMonth] = useState(new Date());
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "by_patient">(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("financeiro:viewMode") : null;
    return (saved === "list" || saved === "by_patient") ? saved : "by_patient";
  });

  useEffect(() => {
    try { localStorage.setItem("financeiro:viewMode", viewMode); } catch {}
  }, [viewMode]);

  const [formData, setFormData] = useState({
    type: "income", amount: "", description: "", category: "",
    payment_method: "", payment_status: "pending", due_date: "",
    patient_id: "", cost_center: "",
  });

  useEffect(() => { checkAuthAndLoadData(); }, []);

  // FAB event
  useEffect(() => {
    const openNew = () => guardWrite(() => setDialogOpen(true));
    window.addEventListener("psicoone:new-transaction", openNew);
    return () => window.removeEventListener("psicoone:new-transaction", openNew);
  }, [guardWrite]);

  const checkAuthAndLoadData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    await Promise.all([loadTransactions(user.id), loadPatients(user.id)]);
    setLoading(false);
  };

  const loadTransactions = async (uid: string) => {
    const { data, error } = await supabase
      .from("financial_transactions")
      .select(`*, patients (full_name, phone, email)`)
      .eq("psychologist_id", uid)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) { toast.error("Erro ao carregar transações"); return; }

    const now = new Date();
    const formatted = (data || []).map((t: any) => {
      let computedStatus = t.status;
      if (t.status === "pending" && t.due_date && isAfter(now, new Date(t.due_date))) {
        computedStatus = "overdue";
      }
      return {
        ...t,
        patient_name: t.patients?.full_name,
        patient_phone: t.patients?.phone ?? null,
        patient_email: t.patients?.email ?? null,
        payment_status: computedStatus,
      };
    });
    setTransactions(formatted);
  };

  const loadPatients = async (uid: string) => {
    const { data } = await supabase.from("patients")
      .select("id, full_name, default_session_value, monthly_plan_value, payment_day")
      .eq("psychologist_id", uid).eq("status", "active").is("deleted_at", null).order("full_name");
    if (data) setPatients(data);
  };

  const handlePatientSelect = async (patientId: string, isEdit: boolean) => {
    if (isEdit) {
      setFormData(prev => ({ ...prev, patient_id: patientId }));
      return;
    }
    const patient = patients.find(p => p.id === patientId);
    if (!patient) {
      setFormData(prev => ({ ...prev, patient_id: patientId }));
      return;
    }

    // Smart: check for active billing plan first → falls back to cadastro
    const { data: planData } = await supabase
      .from("patient_billing_plans" as any)
      .select("billing_type, amount, day_of_month")
      .eq("patient_id", patientId)
      .eq("active", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const plan = planData as any;

    let cat = formData.category || "Consulta psicológica";
    let smartValue = formData.amount;
    let smartDueDate = formData.due_date;

    if (plan) {
      smartValue = String(plan.amount);
      cat = plan.billing_type === "monthly" ? "Pacote mensal" : "Consulta psicológica";
      if (plan.billing_type === "monthly" && plan.day_of_month) {
        smartDueDate = calcSmartDueDate(plan.day_of_month);
      } else if (plan.billing_type === "weekly") {
        smartDueDate = format(addMonths(new Date(), 0).setDate(new Date().getDate() + 7) as any, "yyyy-MM-dd");
        smartDueDate = format(new Date(Date.now() + 7 * 86400000), "yyyy-MM-dd");
      } else if (plan.billing_type === "biweekly") {
        smartDueDate = format(new Date(Date.now() + 15 * 86400000), "yyyy-MM-dd");
      }
    } else {
      smartValue = cat === "Pacote mensal" && patient.monthly_plan_value
        ? String(patient.monthly_plan_value)
        : patient.default_session_value ? String(patient.default_session_value) : formData.amount;
      smartDueDate = patient.payment_day ? calcSmartDueDate(patient.payment_day) : formData.due_date;
    }
    const smartDesc = suggestDescription(patient.full_name, cat);

    setFormData(prev => ({
      ...prev,
      patient_id: patientId,
      amount: smartValue,
      category: cat,
      description: smartDesc,
      due_date: smartDueDate,
    }));
  };

  // When category changes and patient is selected, re-sync value
  const handleCategoryChange = (category: string, isEdit: boolean) => {
    if (isEdit) {
      setFormData(prev => ({ ...prev, category }));
      return;
    }
    const patient = patients.find(p => p.id === formData.patient_id);
    const updates: Partial<typeof formData> = { category };
    if (patient) {
      if (category === "Pacote mensal" && patient.monthly_plan_value) {
        updates.amount = String(patient.monthly_plan_value);
      } else if (patient.default_session_value) {
        updates.amount = String(patient.default_session_value);
      }
      updates.description = suggestDescription(patient.full_name, category);
    }
    setFormData(prev => ({ ...prev, ...updates }));
  };

  // Period-filtered transactions
  const periodTransactions = useMemo(() => {
    const ms = startOfMonth(selectedMonth);
    const me = endOfMonth(selectedMonth);
    return transactions.filter(t => {
      const d = new Date(t.due_date);
      return d >= ms && d <= me;
    });
  }, [transactions, selectedMonth]);

  const metrics = useMemo(() => {
    const now = new Date();
    const thisMonth = periodTransactions;
    const lastMonthDate = subMonths(selectedMonth, 1);
    const lastMonth = transactions.filter(t => {
      const d = new Date(t.due_date);
      return d >= startOfMonth(lastMonthDate) && d <= endOfMonth(lastMonthDate);
    });

    const income = thisMonth.filter(t => t.type === "income" && t.payment_status === "paid").reduce((s, t) => s + Number(t.amount), 0);
    const expense = thisMonth.filter(t => t.type === "expense" && t.payment_status === "paid").reduce((s, t) => s + Number(t.amount), 0);
    const pending = thisMonth.filter(t => t.payment_status === "pending").reduce((s, t) => s + Number(t.amount), 0);
    const overdue = transactions.filter(t => t.payment_status === "pending" && t.due_date && isAfter(now, new Date(t.due_date))).reduce((s, t) => s + Number(t.amount), 0);

    const lastIncome = lastMonth.filter(t => t.type === "income" && t.payment_status === "paid").reduce((s, t) => s + Number(t.amount), 0);
    const incomeChange = lastIncome > 0 ? Math.round(((income - lastIncome) / lastIncome) * 100) : 0;

    const lastExpense = lastMonth.filter(t => t.type === "expense" && t.payment_status === "paid").reduce((s, t) => s + Number(t.amount), 0);
    const expenseChange = lastExpense > 0 ? Math.round(((expense - lastExpense) / lastExpense) * 100) : 0;

    const uniquePatients = new Set(thisMonth.filter(t => t.type === "income" && t.payment_status === "paid" && t.patient_id).map(t => t.patient_id));
    const ticketMedio = uniquePatients.size > 0 ? income / uniquePatients.size : 0;
    const mrr = income;

    const totalReceivable = thisMonth.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
    const delinquencyRate = totalReceivable > 0 ? Math.round((overdue / totalReceivable) * 100) : 0;

    const categoryMap: Record<string, number> = {};
    const expenseCategoryMap: Record<string, number> = {};
    const costCenterMap: Record<string, number> = {};
    thisMonth.forEach(t => {
      const cat = t.category || "Outros";
      if (t.type === "income") categoryMap[cat] = (categoryMap[cat] || 0) + Number(t.amount);
      else expenseCategoryMap[cat] = (expenseCategoryMap[cat] || 0) + Number(t.amount);
      if (t.cost_center) costCenterMap[t.cost_center] = (costCenterMap[t.cost_center] || 0) + Number(t.amount);
    });

    return {
      income, expense, pending, overdue, incomeChange, expenseChange, ticketMedio, mrr, delinquencyRate,
      balance: income - expense, uniquePatients: uniquePatients.size, categoryMap, expenseCategoryMap,
      costCenterMap, totalReceivable,
    };
  }, [transactions, periodTransactions, selectedMonth]);

  const chartData = useMemo(() => {
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = subMonths(new Date(), i);
      const ms = startOfMonth(d); const me = endOfMonth(d);
      const monthTxs = transactions.filter(t => { const td = new Date(t.due_date); return td >= ms && td <= me; });
      months.push({
        month: format(d, "MMM", { locale: ptBR }),
        receita: monthTxs.filter(t => t.type === "income" && t.payment_status === "paid").reduce((s, t) => s + Number(t.amount), 0),
        despesa: monthTxs.filter(t => t.type === "expense" && t.payment_status === "paid").reduce((s, t) => s + Number(t.amount), 0),
      });
    }
    return months;
  }, [transactions]);

  const handleUploadAttachment = async (transactionId: string, file: File) => {
    setUploading(true);
    const path = `${userId}/${transactionId}/${file.name}`;
    const { error: uploadError } = await supabase.storage.from("financial-attachments").upload(path, file);
    if (uploadError) { toast.error("Erro ao enviar arquivo"); setUploading(false); return; }
    const { data: updated, error: linkError } = await supabase.from("financial_transactions")
      .update({ attachment_url: path } as any).eq("id", transactionId).select("id");
    if (linkError || !updated?.length) {
      toast.error("Arquivo enviado, mas não foi possível vinculá-lo ao lançamento. Atualize a página antes de tentar novamente.");
      setUploading(false);
      return;
    }
    toast.success("Comprovante anexado!");
    setUploading(false);
    await loadTransactions(userId);
  };

  const handleMarkAsPaid = async (transaction: Transaction) => {
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) return;
    const { error } = await supabase.from("financial_transactions").update({
      status: "paid", paid_date: new Date().toISOString().split("T")[0],
    } as any).eq("id", transaction.id);
    if (error) { toast.error("Erro ao atualizar"); return; }
    toast.success("Pagamento confirmado!");
    loadTransactions(userId);
  };

  const handleCreateTransaction = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setDialogOpen(false); return; }

    const amount = parseFloat(formData.amount);
    const pid = formData.patient_id;
    const dueDate = formData.due_date;

    // Duplicate detection
    if (pid && dueDate) {
      const duplicate = transactions.find(t =>
        t.patient_id === pid && t.due_date === dueDate && Number(t.amount) === amount && t.payment_status !== "cancelled"
      );
      if (duplicate) {
        const confirmed = window.confirm("⚠️ Já existe uma cobrança para este paciente nesta data com o mesmo valor. Deseja criar mesmo assim?");
        if (!confirmed) return;
      }
    }

    const txData: any = {
      psychologist_id: userId, type: formData.type, amount,
      description: formData.description, category: formData.category,
      payment_method: formData.payment_method, status: formData.payment_status,
      due_date: dueDate, cost_center: formData.cost_center || null,
    };
    if (pid) txData.patient_id = pid;
    if (txData.status === "paid") txData.paid_date = new Date().toISOString().split("T")[0];

    const { error } = await supabase.from("financial_transactions").insert(txData);
    if (error) { toast.error("Erro ao criar transação"); console.error(error); return; }

    await supabase.from("audit_logs").insert({
      user_id: userId, action_type: "create", entity_type: "financial_transaction",
      new_data: { type: txData.type, amount, category: txData.category },
    } as any);

    toast.success("Transação criada!");
    setDialogOpen(false);
    resetForm();
    loadTransactions(userId);
  };

  const handleEditTransaction = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingTransaction) return;
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setEditingTransaction(null); return; }

    const amount = parseFloat(formData.amount);

    const updateData: any = {
      type: formData.type, amount, description: formData.description,
      category: formData.category, payment_method: formData.payment_method,
      status: formData.payment_status, due_date: formData.due_date,
      patient_id: formData.patient_id || null, cost_center: formData.cost_center || null,
    };

    if (formData.payment_status === "paid" && editingTransaction.payment_status !== "paid") {
      updateData.paid_date = new Date().toISOString().split("T")[0];
    }

    const { error } = await supabase.from("financial_transactions").update(updateData).eq("id", editingTransaction.id);
    if (error) { toast.error("Erro ao atualizar"); return; }

    toast.success("Transação atualizada!");
    setEditingTransaction(null);
    resetForm();
    loadTransactions(userId);
  };

  const handleDeleteTransaction = async (id: string) => {
    guardWrite(() => {
      (async () => {
        const { error } = await supabase.from("financial_transactions")
          .update({ deleted_at: new Date().toISOString(), deleted_by: userId, deleted_reason: "Excluído pelo usuário" })
          .eq("id", id);
        if (error) { toast.error("Erro ao excluir"); return; }
        toast.success("Transação excluída!");
        loadTransactions(userId);
      })();
    });
  };

  const openEditDialog = (t: Transaction) => {
    guardWrite(() => {
      setFormData({
        type: t.type, amount: t.amount.toString(), description: t.description,
        category: t.category, payment_method: t.payment_method,
        payment_status: t.payment_status, due_date: t.due_date,
        patient_id: t.patient_id || "", cost_center: t.cost_center || "",
      });
      setEditingTransaction(t);
    });
  };

  const resetForm = () => setFormData({
    type: "income", amount: "", description: "", category: "",
    payment_method: "", payment_status: "pending", due_date: "",
    patient_id: "", cost_center: "",
  });

  const filteredTransactions = periodTransactions.filter(t => {
    if (filterType !== "all" && t.type !== filterType) return false;
    if (filterStatus !== "all" && t.payment_status !== filterStatus) return false;
    if (filterPatient !== "all" && t.patient_id !== filterPatient) return false;
    if (searchTerm && !t.description?.toLowerCase().includes(searchTerm.toLowerCase()) && !t.patient_name?.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  const getStatusConfig = (status: string) => {
    const configs: Record<string, { color: string; bg: string; border: string; label: string; icon: React.ElementType }> = {
      paid: { color: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-500/10", border: "border-emerald-200 dark:border-emerald-500/20", label: "Pago", icon: CheckCircle2 },
      pending: { color: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-500/10", border: "border-amber-200 dark:border-amber-500/20", label: "Pendente", icon: Clock },
      overdue: { color: "text-red-700 dark:text-red-400", bg: "bg-red-50 dark:bg-red-500/10", border: "border-red-200 dark:border-red-500/20", label: "Vencido", icon: AlertTriangle },
      cancelled: { color: "text-muted-foreground", bg: "bg-muted/50", border: "border-border", label: "Cancelado", icon: XCircle },
      exempt: { color: "text-blue-700 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-500/10", border: "border-blue-200 dark:border-blue-500/20", label: "Isento", icon: CheckCircle2 },
    };
    return configs[status] || configs.pending;
  };

  const getTypeLabel = (t: Transaction) => {
    if (t.type === "expense") return "Despesa";
    if (t.category?.includes("Consulta")) return "Consulta";
    if (t.category?.includes("Pacote") || t.description?.toLowerCase().includes("plano")) return "Plano mensal";
    return "Avulso";
  };

  const periodSummary = useMemo(() => {
    const incomeTotal = periodTransactions.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
    const incomePaid = periodTransactions.filter(t => t.type === "income" && t.payment_status === "paid").reduce((s, t) => s + Number(t.amount), 0);
    const incomePending = periodTransactions.filter(t => t.type === "income" && t.payment_status === "pending").reduce((s, t) => s + Number(t.amount), 0);
    const expenseTotal = periodTransactions.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
    const countPaid = periodTransactions.filter(t => t.payment_status === "paid").length;
    const countPending = periodTransactions.filter(t => t.payment_status === "pending").length;
    const countOverdue = periodTransactions.filter(t => t.payment_status === "pending" && t.due_date && isAfter(new Date(), new Date(t.due_date))).length;
    return { incomeTotal, incomePaid, incomePending, expenseTotal, countPaid, countPending, countOverdue };
  }, [periodTransactions]);

  const fmtCurrency = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;

  if (loading) return (
    <AppLayout>
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">{[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </AppLayout>
  );

  const currentCategories = formData.type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  const incomeCategories = Object.entries(metrics.categoryMap).map(([name, value], i) => {
    const total = Object.values(metrics.categoryMap).reduce((s, v) => s + v, 0) || 1;
    const colors = ["hsl(142, 76%, 36%)", "hsl(217, 91%, 60%)", "hsl(262, 83%, 58%)", "hsl(45, 93%, 47%)"];
    return { name, value, percentage: Math.round((value / total) * 100), trend: "stable" as const, color: colors[i % colors.length] };
  });

  const expenseCategories = Object.entries(metrics.expenseCategoryMap).map(([name, value], i) => {
    const total = Object.values(metrics.expenseCategoryMap).reduce((s, v) => s + v, 0) || 1;
    const colors = ["hsl(0, 84%, 60%)", "hsl(45, 93%, 47%)", "hsl(262, 83%, 58%)", "hsl(var(--muted-foreground))"];
    return { name, value, percentage: Math.round((value / total) * 100), trend: "stable" as const, color: colors[i % colors.length] };
  });

  // Transaction form — used for both create and edit
  const TransactionForm = ({ onSubmit, isEdit }: { onSubmit: (e: React.FormEvent<HTMLFormElement>) => void; isEdit?: boolean }) => {
    const selectedPatient = patients.find(p => p.id === formData.patient_id);
    const [showAdvanced, setShowAdvanced] = useState(false);

    return (
      <form onSubmit={onSubmit} className="space-y-5">
        {/* Section 1: Dados Principais */}
        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Dados Principais</h4>

          {/* Row 1: Tipo + Paciente */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Tipo</Label>
              <Select
                value={formData.type}
                onValueChange={(v) => setFormData({ ...formData, type: v, category: "" })}
                {...(!isEdit && { name: "type" })}
              >
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Receita</SelectItem>
                  <SelectItem value="expense">Despesa</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Paciente</Label>
              <PatientCombobox
                patients={patients}
                value={formData.patient_id}
                onChange={(v) => handlePatientSelect(v, !!isEdit)}
                placeholder="Opcional"
              />

            </div>
          </div>

          {/* Row 2: Categoria + Valor */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Categoria</Label>
              <Select value={formData.category} onValueChange={(v) => handleCategoryChange(v, !!isEdit)} {...(!isEdit && { name: "category" })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{currentCategories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor (R$)</Label>
              <div className="relative">
                <Input
                  name="amount"
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                  required
                />
                {selectedPatient && !isEdit && formData.amount && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    auto
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Smart fill indicator */}
          <AnimatePresence>
            {selectedPatient && !isEdit && (selectedPatient.default_session_value || selectedPatient.payment_day) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-muted/30 rounded-lg p-3 flex items-center gap-3"
              >
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Sparkles className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">Preenchimento automático</p>
                  <p className="text-sm font-medium truncate">
                    {selectedPatient.full_name}
                    {selectedPatient.default_session_value && ` · Sessão R$ ${selectedPatient.default_session_value}`}
                    {selectedPatient.monthly_plan_value && ` · Plano R$ ${selectedPatient.monthly_plan_value}`}
                    {selectedPatient.payment_day && ` · Pgto dia ${selectedPatient.payment_day}`}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Descrição full width */}
          <div>
            <Label>Descrição</Label>
            <Input
              name="description"
              placeholder="Sessão de atendimento"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              required
            />
          </div>
        </div>

        <Separator />

        {/* Section 2: Pagamento */}
        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Pagamento</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Forma de Pagamento</Label>
              <Select value={formData.payment_method} onValueChange={(v) => setFormData({ ...formData, payment_method: v })} {...(!isEdit && { name: "payment_method" })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{PAYMENT_METHODS.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={formData.payment_status} onValueChange={(v) => setFormData({ ...formData, payment_status: v })} {...(!isEdit && { name: "payment_status" })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pendente</SelectItem>
                  <SelectItem value="paid">Pago</SelectItem>
                  <SelectItem value="overdue">Atrasado</SelectItem>
                  <SelectItem value="cancelled">Cancelado</SelectItem>
                  <SelectItem value="exempt">Isento</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Vencimento</Label>
            <div className="relative">
              <Input
                name="due_date"
                type="date"
                value={formData.due_date}
                onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
                required
              />
              {selectedPatient && !isEdit && selectedPatient.payment_day && formData.due_date && (
                <span className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  dia {selectedPatient.payment_day}
                </span>
              )}
            </div>
          </div>

          {/* Avançado (collapsible) */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground gap-1"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <Settings className="h-3 w-3" />
            {showAdvanced ? "Ocultar opções avançadas" : "Opções avançadas"}
          </Button>
          <AnimatePresence>
            {showAdvanced && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-4 overflow-hidden"
              >
                <div>
                  <Label>Centro de Custo</Label>
                  <Select value={formData.cost_center} onValueChange={(v) => setFormData({ ...formData, cost_center: v })} {...(!isEdit && { name: "cost_center" })}>
                    <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
                    <SelectContent>{COST_CENTERS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => { isEdit ? setEditingTransaction(null) : setDialogOpen(false); resetForm(); }}>Cancelar</Button>
          <Button type="submit">{isEdit ? "Salvar" : "Criar"}</Button>
        </div>
      </form>
    );
  };

  // Month/Year Picker
  const MonthYearPicker = () => {
    const currentYear = selectedMonth.getFullYear();
    const currentMonthIdx = selectedMonth.getMonth();

    return (
      <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="min-w-[200px] justify-center font-medium capitalize gap-2">
            <Calendar className="h-4 w-4" />
            {format(selectedMonth, "MMMM yyyy", { locale: ptBR })}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-4 pointer-events-auto" align="start">
          <div className="space-y-4">
            {/* Year selector */}
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setSelectedMonth(setYear(selectedMonth, currentYear - 1))}>←</Button>
              <span className="font-bold text-lg">{currentYear}</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedMonth(setYear(selectedMonth, currentYear + 1))}>→</Button>
            </div>
            {/* Month grid */}
            <div className="grid grid-cols-3 gap-2">
              {MONTHS.map((month, idx) => (
                <Button
                  key={month}
                  variant={idx === currentMonthIdx ? "default" : "ghost"}
                  size="sm"
                  className="text-xs h-9"
                  onClick={() => {
                    setSelectedMonth(setMonth(selectedMonth, idx));
                    setMonthPickerOpen(false);
                  }}
                >
                  {month.slice(0, 3)}
                </Button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={() => {
              setSelectedMonth(new Date());
              setMonthPickerOpen(false);
            }}>
              Mês atual
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  return (
    <AppLayout title="PsicoBank Enterprise" description="Gestão financeira completa com insights e automações">
      {/* Top Dashboard — Reduced to essential 4 cards */}
      <StatsOverview
        stats={[
          { label: "Receitas", value: fmtCurrency(metrics.income), icon: TrendingUp, color: "green", change: metrics.incomeChange },
          { label: "Despesas", value: fmtCurrency(metrics.expense), icon: TrendingDown, color: "red", change: metrics.expenseChange },
          { label: "Saldo Líquido", value: fmtCurrency(metrics.balance), icon: DollarSign, color: "blue" },
          { label: "Pendente", value: fmtCurrency(metrics.pending), icon: Calendar, color: "amber" },
        ]}
        className="mb-6"
      />

      {/* Secondary metrics — condensed row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1">Ticket Médio</div>
          <div className="text-lg font-bold">{fmtCurrency(metrics.ticketMedio)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1">Pacientes Ativos</div>
          <div className="text-lg font-bold">{metrics.uniquePatients}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1">Inadimplência</div>
          <div className={cn("text-lg font-bold", metrics.delinquencyRate > 20 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>{metrics.delinquencyRate}%</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-500" />Vencidos</div>
          <div className="text-lg font-bold text-red-600 dark:text-red-400">{fmtCurrency(metrics.overdue)}</div>
        </Card>
      </div>

      <Tabs defaultValue="pagamentos" className="mb-6">
        <TabsList className="bg-muted/50 mb-6 flex flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="pagamentos" className="gap-2"><Receipt className="h-4 w-4" />Pagamentos & Cobranças</TabsTrigger>
          <TabsTrigger value="reconciliacao" className="gap-2"><CheckCircle2 className="h-4 w-4" />Reconciliação</TabsTrigger>
          <TabsTrigger value="resumo" className="gap-2"><TrendingUp className="h-4 w-4" />Resumo</TabsTrigger>
          <TabsTrigger value="notas" className="gap-2"><FileText className="h-4 w-4" />Notas Fiscais</TabsTrigger>
          <TabsTrigger value="relatorios" className="gap-2"><BarChart3 className="h-4 w-4" />Relatórios</TabsTrigger>
        </TabsList>

        <TabsContent value="reconciliacao" className="space-y-6">
          <ReconciliationPanel
            patients={patients as any}
            onChanged={() => { if (userId) loadTransactions(userId); }}
          />
        </TabsContent>


        {/* ========== PAGAMENTOS TAB ========== */}
        <TabsContent value="pagamentos" className="space-y-6">
          <OverdueSemaforo
            transactions={transactions as any}
            onSync={async () => {
              const t = toast.loading("Sincronizando pagamentos Stripe...");
              try {
                const { data, error } = await supabase.functions.invoke("sync-patient-payments", { body: {} });
                if (error) throw error;
                toast.success(`${data?.updated || 0} pagamento(s) confirmado(s)`, { id: t });
                const { data: { user } } = await supabase.auth.getUser();
                if (user) loadTransactions(user.id);
              } catch (e: any) {
                toast.error(e.message || "Erro ao sincronizar", { id: t });
              }
            }}
          />
          {/* Period Controls */}
          <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
            <MonthYearPicker />
            <div className="flex gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="gap-2"><Download className="h-4 w-4" />Exportar</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem className="cursor-pointer" onClick={() => {
                    const data = filteredTransactions.map(t => ({
                      descricao: t.description, tipo: t.type === "income" ? "Receita" : "Despesa",
                      valor: t.amount, status: t.payment_status, paciente: t.patient_name || "-",
                      categoria: t.category, vencimento: t.due_date, pagamento: t.paid_date || "-",
                    }));
                    const h = { descricao: "Descrição", tipo: "Tipo", valor: "Valor", status: "Status", paciente: "Paciente", categoria: "Categoria", vencimento: "Vencimento", pagamento: "Pago em" };
                    exportToCSV(data, "financeiro", h);
                    toast.success("CSV exportado!");
                  }}>CSV</DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onClick={() => {
                    const data = filteredTransactions.map(t => ({
                      descricao: t.description, tipo: t.type === "income" ? "Receita" : "Despesa",
                      valor: t.amount, status: t.payment_status, paciente: t.patient_name || "-",
                      categoria: t.category, vencimento: t.due_date, pagamento: t.paid_date || "-",
                    }));
                    const h = { descricao: "Descrição", tipo: "Tipo", valor: "Valor", status: "Status", paciente: "Paciente", categoria: "Categoria", vencimento: "Vencimento", pagamento: "Pago em" };
                    exportToExcel(data, "financeiro", "Financeiro", h);
                    toast.success("Excel exportado!");
                  }}>Excel (.xlsx)</DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onClick={() => {
                    const data = filteredTransactions.map(t => ({
                      descricao: t.description, tipo: t.type === "income" ? "Receita" : "Despesa",
                      valor: `R$ ${Number(t.amount).toFixed(2)}`, status: t.payment_status,
                      paciente: t.patient_name || "-", categoria: t.category,
                      vencimento: t.due_date, pagamento: t.paid_date || "-",
                    }));
                    const h = { descricao: "Descrição", tipo: "Tipo", valor: "Valor", status: "Status", paciente: "Paciente", categoria: "Categoria", vencimento: "Vencimento", pagamento: "Pago em" };
                    exportToPDF(data, "financeiro", "Relatório Financeiro", h);
                    toast.success("PDF exportado!");
                  }}>PDF</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button className="gap-2" onClick={() => guardWrite(() => setDialogOpen(true))}>
                <Plus className="h-4 w-4" />Nova Transação
              </Button>
              <SmartTransactionDialog
                open={dialogOpen}
                onOpenChange={(o) => { setDialogOpen(o); if (!o) resetForm(); }}
                onCreated={() => { if (userId) loadTransactions(userId); }}
              />
            </div>
          </div>

          {/* Period Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}
              className="rounded-xl border border-border bg-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Target className="h-4 w-4" />Total Previsto</div>
              <p className="text-2xl font-bold">{fmtCurrency(periodSummary.incomeTotal)}</p>
              <p className="text-xs text-muted-foreground">{periodTransactions.filter(t => t.type === "income").length} recebimentos e {periodTransactions.filter(t => t.type === "expense").length} despesas</p>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
              className="rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/5 p-4 space-y-1">
              <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />Já Recebido</div>
              <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{fmtCurrency(periodSummary.incomePaid)}</p>
              <p className="text-xs text-muted-foreground">{periodSummary.countPaid} pagamentos confirmados</p>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
              className="rounded-xl border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/5 p-4 space-y-1">
              <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400"><Clock className="h-4 w-4" />Pendente</div>
              <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">{fmtCurrency(periodSummary.incomePending)}</p>
              <p className="text-xs text-muted-foreground">
                {periodSummary.countPending} pendentes
                {periodSummary.countOverdue > 0 && <span className="text-red-500"> · {periodSummary.countOverdue} vencidos</span>}
              </p>
            </motion.div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Buscar..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 w-[200px]" />
            </div>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-[130px]"><Filter className="h-4 w-4 mr-2" /><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="income">Receitas</SelectItem>
                <SelectItem value="expense">Despesas</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos Status</SelectItem>
                <SelectItem value="paid">Pago</SelectItem>
                <SelectItem value="pending">Pendente</SelectItem>
                <SelectItem value="overdue">Vencido</SelectItem>
                <SelectItem value="exempt">Isento</SelectItem>
                <SelectItem value="cancelled">Cancelado</SelectItem>
              </SelectContent>
            </Select>
            <div className="w-[200px]">
              <PatientCombobox
                patients={patients}
                value={filterPatient}
                onChange={setFilterPatient}
                allowAll
                allLabel="Todos pacientes"
                placeholder="Todos pacientes"
              />
            </div>

            {/* View mode toggle */}
            <div className="ml-auto inline-flex rounded-md border bg-muted/30 p-0.5">
              <Button
                type="button"
                variant={viewMode === "list" ? "default" : "ghost"}
                size="sm"
                className="h-8 text-xs"
                onClick={() => setViewMode("list")}
              >
                Lista
              </Button>
              <Button
                type="button"
                variant={viewMode === "by_patient" ? "default" : "ghost"}
                size="sm"
                className="h-8 text-xs"
                onClick={() => setViewMode("by_patient")}
              >
                <User className="h-3.5 w-3.5 mr-1" />Por paciente
              </Button>
            </div>
          </div>

          {/* GROUPED BY PATIENT VIEW */}
          {viewMode === "by_patient" && (() => {
            const groups = new Map<string, { name: string; items: Transaction[] }>();
            filteredTransactions.forEach(t => {
              const key = t.patient_id || "__none__";
              const name = t.patient_name || "Sem paciente";
              if (!groups.has(key)) groups.set(key, { name, items: [] });
              groups.get(key)!.items.push(t);
            });
            const arr = Array.from(groups.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
            if (arr.length === 0) {
              return (
                <div className="rounded-xl border bg-card py-16 text-center text-muted-foreground">
                  <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="font-medium">Nenhuma transação encontrada</p>
                </div>
              );
            }
            return (
              <div className="space-y-3">
                {arr.map(([key, g]) => {
                  const total = g.items.reduce((s, x) => s + (x.type === "income" ? Number(x.amount) : -Number(x.amount)), 0);
                  const paid = g.items.filter(x => x.payment_status === "paid").reduce((s, x) => s + Number(x.amount), 0);
                  const pending = g.items.filter(x => x.payment_status === "pending").reduce((s, x) => s + Number(x.amount), 0);
                  return (
                    <Card key={key} className="overflow-hidden">
                      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-muted/30 border-b">
                        <button
                          className="flex items-center gap-3 min-w-0 text-left hover:underline"
                          onClick={() => key !== "__none__" && navigate(`/pacientes/${key}`)}
                          disabled={key === "__none__"}
                        >
                          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <User className="h-4 w-4 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-sm truncate">{g.name}</p>
                            <p className="text-xs text-muted-foreground">{g.items.length} transação(ões)</p>
                          </div>
                        </button>
                        <div className="flex items-center gap-3 text-xs shrink-0">
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">Pago {fmtCurrency(paid)}</span>
                          <span className="text-amber-600 dark:text-amber-400 font-medium">Pendente {fmtCurrency(pending)}</span>
                          <span className={cn("font-bold", total >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                            {fmtCurrency(total)}
                          </span>
                        </div>
                      </div>
                      <div className="divide-y divide-border">
                        {g.items.map(t => {
                          const sc = getStatusConfig(t.payment_status);
                          const SI = sc.icon;
                          return (
                            <div key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/20">
                              <div className="flex items-center gap-3 min-w-0">
                                <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0", sc.bg, sc.color, sc.border)}>
                                  <SI className="h-3 w-3" />{sc.label}
                                </span>
                                <div className="min-w-0">
                                  <p className="text-sm truncate">{t.description}</p>
                                  <p className="text-[11px] text-muted-foreground">
                                    {getTypeLabel(t)} · Venc. {t.due_date && format(new Date(t.due_date), "dd/MM/yyyy")}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className={cn("text-sm font-semibold", t.type === "income" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                                  {t.type === "income" ? "+" : "-"}{fmtCurrency(Number(t.amount))}
                                </span>
                                {(t.payment_status === "pending" || t.payment_status === "overdue") && (
                                  <Button variant="outline" size="sm" className="h-7 px-2 text-[11px] gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10" onClick={() => handleMarkAsPaid(t)}>
                                    <CheckCircle2 className="h-3.5 w-3.5" />Pago
                                  </Button>
                                )}
                                <ActionMenu onEdit={() => openEditDialog(t)} onDelete={() => handleDeleteTransaction(t.id)}
                                  deleteTitle="Excluir Transação" deleteDescription="Excluir esta transação?" />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  );
                })}
              </div>
            );
          })()}

          {viewMode === "list" && (
          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <input ref={fileInputRef} type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => {
              const file = e.target.files?.[0];
              const txId = fileInputRef.current?.dataset.txId;
              if (file && txId) handleUploadAttachment(txId, file);
            }} />

            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Tipo</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Descrição</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Paciente</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Categoria</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Vencimento</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Valor</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence mode="popLayout">
                    {filteredTransactions.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-16 text-center text-muted-foreground">
                          <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-30" />
                          <p className="font-medium">Nenhuma transação encontrada</p>
                          <p className="text-sm mt-1">Nenhum registro para {format(selectedMonth, "MMMM yyyy", { locale: ptBR })}</p>
                        </td>
                      </tr>
                    ) : (
                      filteredTransactions.map((t, index) => {
                        const sc = getStatusConfig(t.payment_status);
                        const StatusIcon = sc.icon;
                        return (
                          <motion.tr key={t.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            transition={{ delay: index * 0.02 }}
                            className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                            <td className="px-4 py-3">
                              <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border", sc.bg, sc.color, sc.border)}>
                                <StatusIcon className="h-3 w-3" />{sc.label}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className={cn("p-1 rounded", t.type === "income" ? "bg-emerald-500/10" : "bg-red-500/10")}>
                                  {t.type === "income" ? <TrendingUp className="h-3.5 w-3.5 text-emerald-600" /> : <TrendingDown className="h-3.5 w-3.5 text-red-500" />}
                                </div>
                                <span className="text-sm">{getTypeLabel(t)}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1.5 max-w-[240px]">
                                <p className="text-sm font-medium truncate">{t.description}</p>
                                {t.stripe_payment_link && (
                                  <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-violet-400/40 text-violet-600 dark:text-violet-300 shrink-0">
                                    <CreditCard className="h-2.5 w-2.5 mr-0.5" />Stripe
                                  </Badge>
                                )}
                                {t.attachment_url && <Paperclip className="h-3 w-3 text-primary shrink-0" />}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              {t.patient_id && t.patient_name ? (
                                <button className="text-sm text-primary hover:underline flex items-center gap-1"
                                  onClick={() => navigate(`/pacientes/${t.patient_id}`)}>
                                  {t.patient_name}<ExternalLink className="h-3 w-3" />
                                </button>
                              ) : <span className="text-sm text-muted-foreground">—</span>}
                            </td>
                            <td className="px-4 py-3"><span className="text-sm">{t.category || "—"}</span></td>
                            <td className="px-4 py-3"><span className="text-sm">{t.due_date && format(new Date(t.due_date), "dd/MM/yyyy")}</span></td>
                            <td className="px-4 py-3 text-right">
                              <span className={cn("text-sm font-semibold", t.type === "income" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                                {t.type === "income" ? "+" : "-"} {fmtCurrency(Number(t.amount))}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-1">
                                {(t.payment_status === "pending" || t.payment_status === "overdue") && (
                                  <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
                                    onClick={() => handleMarkAsPaid(t)} title="Registrar pagamento">
                                    <CheckCircle2 className="h-3.5 w-3.5" />Registrar pgto
                                  </Button>
                                )}
                                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => {
                                  if (fileInputRef.current) { fileInputRef.current.dataset.txId = t.id; fileInputRef.current.click(); }
                                }} title="Anexar comprovante"><Upload className="h-4 w-4" /></Button>
                                <ActionMenu onEdit={() => openEditDialog(t)} onDelete={() => handleDeleteTransaction(t.id)}
                                  deleteTitle="Excluir Transação" deleteDescription="Tem certeza que deseja excluir esta transação?" />
                              </div>
                            </td>
                          </motion.tr>
                        );
                      })
                    )}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>

            {/* Mobile List */}
            <div className="md:hidden">
              {filteredTransactions.length === 0 ? (
                <div className="py-16 text-center text-muted-foreground">
                  <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="font-medium">Nenhuma transação encontrada</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {filteredTransactions.map((t, index) => {
                    const sc = getStatusConfig(t.payment_status);
                    const StatusIcon = sc.icon;
                    return (
                      <motion.div key={t.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.03 }} className="p-4 space-y-3">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <p className="font-medium text-sm">{t.description}</p>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border", sc.bg, sc.color, sc.border)}>
                                <StatusIcon className="h-3 w-3" />{sc.label}
                              </span>
                              <span className="text-xs text-muted-foreground">{getTypeLabel(t)}</span>
                              {t.stripe_payment_link && (
                                <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-violet-400/40 text-violet-600 dark:text-violet-300">
                                  <CreditCard className="h-2.5 w-2.5 mr-0.5" />Stripe
                                </Badge>
                              )}
                            </div>
                          </div>
                          <span className={cn("text-sm font-bold", t.type === "income" ? "text-emerald-600" : "text-red-600")}>
                            {t.type === "income" ? "+" : "-"}{fmtCurrency(Number(t.amount))}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <div className="flex items-center gap-3">
                            {t.patient_name && <span className="text-primary">{t.patient_name}</span>}
                            <span>{t.due_date && format(new Date(t.due_date), "dd/MM/yyyy")}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            {(t.payment_status === "pending" || t.payment_status === "overdue") && (
                              <Button variant="outline" size="sm" className="h-7 px-2 text-[11px] gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400" onClick={() => handleMarkAsPaid(t)}>
                                <CheckCircle2 className="h-3 w-3" />Pago
                              </Button>
                            )}
                            <ActionMenu onEdit={() => openEditDialog(t)} onDelete={() => handleDeleteTransaction(t.id)}
                              deleteTitle="Excluir" deleteDescription="Excluir esta transação?" />
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          )}

          {/* ========== UNIFIED: Recurring plans & Stripe billings ========== */}
          <div className="pt-6 mt-2 border-t border-border space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2">
                  <Repeat className="h-4 w-4 text-primary" />
                  Planos & Cobranças recorrentes
                </h3>
                <p className="text-xs text-muted-foreground">
                  Mesmo motor inteligente: valor e vencimento calculados pelo plano ativo do paciente. Cobranças Stripe aparecem na lista acima com o selo <Badge variant="outline" className="ml-1 text-[10px] py-0 px-1.5 border-violet-400/40 text-violet-600 dark:text-violet-300">Stripe</Badge>.
                </p>
              </div>
            </div>
            <BillingPlansPanel
              patients={patients.map(p => ({ id: p.id, full_name: p.full_name }))}
              onChanged={() => { if (userId) loadTransactions(userId); }}
            />
            <RecurringBillingsPanel onChanged={() => { if (userId) loadTransactions(userId); }} />
          </div>
        </TabsContent>


        {/* ========== RESUMO TAB ========== */}
        <TabsContent value="resumo" className="space-y-6">
          <FinancialGrowth transactions={transactions} />
          <FinancialChart data={chartData} />
          <div className="grid lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Receipt className="h-5 w-5 text-primary" />DRE Simplificada</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-center p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                  <span className="font-medium text-emerald-600">Receita Bruta</span>
                  <span className="font-bold text-emerald-600">{fmtCurrency(metrics.income)}</span>
                </div>
                <div className="flex justify-between items-center p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                  <span className="font-medium text-red-600">(-) Despesas</span>
                  <span className="font-bold text-red-600">{fmtCurrency(metrics.expense)}</span>
                </div>
                <div className="border-t pt-3">
                  <div className="flex justify-between items-center p-3 rounded-lg bg-primary/5 border border-primary/20">
                    <span className="font-bold text-lg">Lucro Líquido</span>
                    <span className={cn("font-bold text-lg", metrics.balance >= 0 ? "text-emerald-600" : "text-red-600")}>
                      {fmtCurrency(metrics.balance)}
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center p-3 rounded-lg bg-muted/50">
                  <span className="text-sm text-muted-foreground">Margem de Lucro</span>
                  <span className="font-bold">{metrics.income > 0 ? Math.round((metrics.balance / metrics.income) * 100) : 0}%</span>
                </div>
              </CardContent>
            </Card>
            <div className="space-y-6">
              <CategoryAnalysis type="income"
                categories={incomeCategories.length > 0 ? incomeCategories : [{ name: "Consultas", value: 0, percentage: 0, trend: "stable" as const, color: "hsl(142, 76%, 36%)" }]}
              />
              <CategoryAnalysis type="expense"
                categories={expenseCategories.length > 0 ? expenseCategories : [{ name: "Sem despesas", value: 0, percentage: 0, trend: "stable" as const, color: "hsl(0, 84%, 60%)" }]}
              />
            </div>
          </div>
          <FinancialProjections
            data={{
              currentMonth: metrics.income,
              projectedMonth: Math.round(metrics.income * 1.15),
              yearToDate: metrics.income * 6,
              projectedYear: Math.round(metrics.income * 12 * 1.1),
              avgSessionValue: metrics.ticketMedio || 200,
              monthlyTarget: 15000,
              trend: metrics.incomeChange > 0 ? "up" : metrics.incomeChange < 0 ? "down" : "stable",
              insights: [
                metrics.incomeChange > 0
                  ? `📈 Receita cresceu ${metrics.incomeChange}% vs mês anterior`
                  : `📉 Receita caiu ${Math.abs(metrics.incomeChange)}% vs mês anterior`,
                `💰 Ticket médio: ${fmtCurrency(metrics.ticketMedio)}`,
                metrics.delinquencyRate > 10
                  ? `⚠️ Inadimplência em ${metrics.delinquencyRate}%`
                  : `✅ Inadimplência controlada em ${metrics.delinquencyRate}%`,
                `🎯 Faltam ${fmtCurrency(Math.max(0, 15000 - metrics.income))} para a meta`,
              ],
            }}
          />
        </TabsContent>

        {/* ========== NOTAS FISCAIS TAB ========== */}
        <TabsContent value="notas" className="space-y-6">
          <Card>
            <CardContent className="py-16 text-center">
              <FileText className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-30" />
              <h3 className="text-lg font-semibold mb-2">Emissão de Notas Fiscais</h3>
              <p className="text-muted-foreground mb-4 max-w-md mx-auto">
                A emissão de NFS-e será integrada com serviços como Focus NFe ou eNotas.
              </p>
              <div className="flex flex-col gap-2 max-w-sm mx-auto">
                {[
                  { num: "1", text: <>Pagamento marcado como <strong>Pago</strong></> },
                  { num: "2", text: <>Botão <strong>"Emitir Nota Fiscal"</strong> disponível</> },
                  { num: "3", text: <>PDF da nota salvo e disponível para download</> },
                ].map(step => (
                  <div key={step.num} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 text-left">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-primary text-sm font-bold">{step.num}</span>
                    </div>
                    <span className="text-sm">{step.text}</span>
                  </div>
                ))}
              </div>
              <Badge variant="secondary" className="mt-6">Em breve</Badge>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ========== RELATÓRIOS TAB ========== */}
        <TabsContent value="relatorios" className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-primary" />Relatórios Financeiros</CardTitle></CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { title: "Faturamento Mensal", desc: "Receitas e despesas do mês atual", action: () => {
                    const data = filteredTransactions.map(t => ({ descricao: t.description, tipo: t.type === "income" ? "Receita" : "Despesa", valor: `R$ ${Number(t.amount).toFixed(2)}`, status: t.payment_status, paciente: t.patient_name || "-" }));
                    const h = { descricao: "Descrição", tipo: "Tipo", valor: "Valor", status: "Status", paciente: "Paciente" };
                    exportToPDF(data, "faturamento-mensal", "Faturamento Mensal", h);
                    toast.success("Relatório gerado!");
                  }},
                  { title: "Pagamentos Pendentes", desc: "Lista de pagamentos em aberto", action: () => {
                    const pending = transactions.filter(t => t.payment_status === "pending");
                    const data = pending.map(t => ({ descricao: t.description, valor: `R$ ${Number(t.amount).toFixed(2)}`, vencimento: t.due_date, paciente: t.patient_name || "-" }));
                    const h = { descricao: "Descrição", valor: "Valor", vencimento: "Vencimento", paciente: "Paciente" };
                    exportToPDF(data, "pendentes", "Pagamentos Pendentes", h);
                    toast.success("Relatório gerado!");
                  }},
                  { title: "Pacientes Inadimplentes", desc: "Pacientes com pagamentos atrasados", action: () => {
                    const overdue = transactions.filter(t => t.payment_status === "pending" && t.due_date && isAfter(new Date(), new Date(t.due_date)));
                    const data = overdue.map(t => ({ paciente: t.patient_name || "-", valor: `R$ ${Number(t.amount).toFixed(2)}`, vencimento: t.due_date, dias_atraso: Math.ceil((new Date().getTime() - new Date(t.due_date).getTime()) / 86400000) }));
                    const h = { paciente: "Paciente", valor: "Valor", vencimento: "Vencimento", dias_atraso: "Dias Atraso" };
                    exportToPDF(data, "inadimplentes", "Pacientes Inadimplentes", h);
                    toast.success("Relatório gerado!");
                  }},
                  { title: "Exportação Completa", desc: "Todas as transações em Excel", action: () => {
                    const data = transactions.map(t => ({ descricao: t.description, tipo: t.type === "income" ? "Receita" : "Despesa", valor: t.amount, status: t.payment_status, paciente: t.patient_name || "-", categoria: t.category, vencimento: t.due_date, pagamento: t.paid_date || "-" }));
                    const h = { descricao: "Descrição", tipo: "Tipo", valor: "Valor", status: "Status", paciente: "Paciente", categoria: "Categoria", vencimento: "Vencimento", pagamento: "Pago em" };
                    exportToExcel(data, "financeiro-completo", "Financeiro Completo", h);
                    toast.success("Excel exportado!");
                  }},
                ].map((report, i) => (
                  <Card key={i} className="cursor-pointer hover:border-primary/30 hover:shadow-md transition-all" onClick={report.action}>
                    <CardContent className="py-6 text-center">
                      <Download className="h-8 w-8 mx-auto mb-3 text-primary" />
                      <p className="font-medium text-sm">{report.title}</p>
                      <p className="text-xs text-muted-foreground mt-1">{report.desc}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Dialog — unified SmartTransactionDialog (plan-aware) */}
      <SmartTransactionDialog
        open={!!editingTransaction}
        onOpenChange={(o) => { if (!o) { setEditingTransaction(null); resetForm(); } }}
        onCreated={() => { if (userId) loadTransactions(userId); }}
        editing={editingTransaction ? {
          id: editingTransaction.id,
          type: editingTransaction.type as "income" | "expense",
          amount: Number(editingTransaction.amount),
          description: editingTransaction.description || "",
          category: editingTransaction.category || "",
          payment_method: editingTransaction.payment_method || "pix",
          status: editingTransaction.payment_status as any,
          due_date: editingTransaction.due_date,
          patient_id: editingTransaction.patient_id || null,
        } : null}
      />
    </AppLayout>
  );
}
