import { useEffect, useState, useCallback, useRef } from "react";
import { useWriteGuard } from "@/components/subscription/WriteBlockedModal";
import { useSubscriptionGuard } from "@/hooks/useSubscriptionGuard";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Search, Users, LayoutGrid, List, UserPlus, TrendingUp, Clock, Upload, Calendar, DollarSign, Repeat, CheckCircle2, Download, Info } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppLayout } from "@/components/layout/AppLayout";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PatientImportCSV } from "@/components/patients/PatientImportCSV";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatsOverview } from "@/components/ui/stats-overview";
import { PatientCard } from "@/components/patients/PatientCard";
import { PatientDetailSheet } from "@/components/patients/PatientDetailSheet";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActions } from "@/components/patients/BulkActions";
import { PatientForm, PatientFormData, SessionFrequency, type PatientDraftApi } from "@/components/patients/PatientForm";
import { exportToCSV, exportToExcel, exportToPDF } from "@/lib/export-utils";
import { format, addWeeks, addDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LIFECYCLE_STATUSES, type LifecycleStatus } from "@/lib/patient-lifecycle";


interface Patient {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  birth_date: string | null;
  notes: string | null;
  status: string;
  cpf: string | null;
  address: string | null;
  emergency_contact: string | null;
  emergency_phone: string | null;
  created_at?: string;
  default_session_value?: number | null;
  payment_day?: number | null;
  monthly_plan_value?: number | null;
  lifecycle_status?: string | null;
}

const formatPhone = (value: string): string => {
  const numbers = value.replace(/\D/g, "");
  if (numbers.length <= 2) return `(${numbers}`;
  if (numbers.length <= 7) return `(${numbers.slice(0, 2)}) ${numbers.slice(2)}`;
  if (numbers.length <= 11) return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7)}`;
  return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7, 11)}`;
};

const formatCPF = (value: string): string => {
  const numbers = value.replace(/\D/g, "");
  if (numbers.length <= 3) return numbers;
  if (numbers.length <= 6) return `${numbers.slice(0, 3)}.${numbers.slice(3)}`;
  if (numbers.length <= 9) return `${numbers.slice(0, 3)}.${numbers.slice(3, 6)}.${numbers.slice(6)}`;
  return `${numbers.slice(0, 3)}.${numbers.slice(3, 6)}.${numbers.slice(6, 9)}-${numbers.slice(9, 11)}`;
};

const WEEKDAYS = [
  { value: "1", label: "Segunda-feira" },
  { value: "2", label: "Terça-feira" },
  { value: "3", label: "Quarta-feira" },
  { value: "4", label: "Quinta-feira" },
  { value: "5", label: "Sexta-feira" },
  { value: "6", label: "Sábado" },
  { value: "0", label: "Domingo" },
];

const PATIENT_EXPORT_HEADERS = {
  full_name: "Nome Completo",
  email: "E-mail",
  phone: "Telefone",
  cpf: "CPF",
  birth_date: "Data de Nascimento",
  status: "Status",
  address: "Endereço",
  emergency_contact: "Contato de Emergência",
  emergency_phone: "Tel. Emergência",
  notes: "Observações",
};

export default function Patients() {
  const navigate = useNavigate();
  const { guardWrite } = useWriteGuard();
  const { checkSubscriptionBeforeWrite } = useSubscriptionGuard();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPatient, setEditingPatient] = useState<Patient | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<string>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const createDraftApi = useRef<PatientDraftApi | null>(null);
  const editDraftApi = useRef<PatientDraftApi | null>(null);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Masked fields
  const [phone, setPhone] = useState("");
  const [cpf, setCpf] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editCpf, setEditCpf] = useState("");
  const [editEmergencyPhone, setEditEmergencyPhone] = useState("");

  // Scheduling fields
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleWeekday, setScheduleWeekday] = useState("3");
  const [scheduleTime, setScheduleTime] = useState("19:00");
  const [scheduleDuration, setScheduleDuration] = useState("50");
  const [customDuration, setCustomDuration] = useState("");
  const [scheduleValue, setScheduleValue] = useState("200");
  const [scheduleStartDate, setScheduleStartDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [scheduleEndType, setScheduleEndType] = useState<"indefinite" | "date">("indefinite");
  const [scheduleEndDate, setScheduleEndDate] = useState("");
  const [scheduleType, setScheduleType] = useState("presential");
  const [scheduleFrequency, setScheduleFrequency] = useState<SessionFrequency>("semanal");

  useEffect(() => { loadPatients(); }, []);

  // FAB events
  useEffect(() => {
    const openNew = () => guardWrite(() => setDialogOpen(true));
    const focusSearch = () => {
      const el = document.querySelector<HTMLInputElement>('input[placeholder*="Buscar"], input[type="search"]');
      el?.focus();
    };
    window.addEventListener("psicoone:new-patient", openNew);
    window.addEventListener("psicoone:search-patient", focusSearch);
    return () => {
      window.removeEventListener("psicoone:new-patient", openNew);
      window.removeEventListener("psicoone:search-patient", focusSearch);
    };
  }, [guardWrite]);

  // Smart date: auto-calculate start date based on selected weekday
  const getNextDateForWeekday = useCallback((weekdayStr: string) => {
    const target = parseInt(weekdayStr);
    const today = new Date();
    const currentDay = today.getDay();
    const daysUntil = (target - currentDay + 7) % 7;
    const nextDate = addDays(today, daysUntil);
    return format(nextDate, "yyyy-MM-dd");
  }, []);

  // Auto-update start date when weekday changes
  useEffect(() => {
    setScheduleStartDate(getNextDateForWeekday(scheduleWeekday));
  }, [scheduleWeekday, getNextDateForWeekday]);

  // Sync financial data from PatientForm to scheduling section
  const handleFinancialChange = useCallback((data: { sessionValue: string; frequency: SessionFrequency; monthlyPlan: string }) => {
    if (data.sessionValue) setScheduleValue(data.sessionValue);
    if (data.frequency) setScheduleFrequency(data.frequency);
  }, []);

  const getEffectiveDuration = () => {
    if (scheduleDuration === "custom") return parseInt(customDuration) || 50;
    return parseInt(scheduleDuration) || 50;
  };

  const resetCreateForm = () => {
    setPhone(""); setCpf(""); setEmergencyPhone("");
    setScheduleEnabled(false); setScheduleWeekday("3");
    setScheduleTime("19:00"); setScheduleDuration("50");
    setCustomDuration(""); setScheduleValue("200");
    setScheduleStartDate(format(new Date(), "yyyy-MM-dd"));
    setScheduleEndType("indefinite"); setScheduleEndDate("");
    setScheduleType("presential"); setScheduleFrequency("semanal");
  };

  const loadPatients = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setPatients([]); return; }
      const { data, error } = await supabase
        .from("patients")
        .select("*")
        .eq("psychologist_id", session.user.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setPatients(data || []);
    } catch {
      toast.error("Erro ao carregar pacientes");
    } finally {
      setLoading(false);
    }
  };

  const generateRecurringDates = (startDate: string, weekday: number, freq: SessionFrequency, endDate?: string, maxWeeks = 12) => {
    const dates: Date[] = [];
    let current = new Date(startDate + "T00:00:00");
    const currentDay = current.getDay();
    const daysUntilTarget = (weekday - currentDay + 7) % 7;
    if (daysUntilTarget > 0) current = addDays(current, daysUntilTarget);
    const end = endDate ? new Date(endDate + "T23:59:59") : null;
    const limit = end ? 52 : maxWeeks;
    const weekStep = freq === "quinzenal" ? 2 : freq === "mensal" ? 4 : 1;
    for (let i = 0; i < limit; i++) {
      const d = addWeeks(current, i * weekStep);
      if (end && d > end) break;
      dates.push(d);
    }
    return dates;
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setCurrentUserId(data.session?.user.id || ""));
  }, []);

  const handleCreatePatientFromForm = async (formValues: PatientFormData) => {
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setDialogOpen(false); return; }
    setCreating(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const userId = session.user.id;
      const fullName = formValues.full_name;

      const { data: newPatient, error } = await supabase.from("patients").insert({
        psychologist_id: userId,
        full_name: fullName,
        email: formValues.email || null,
        phone: formValues.phone || null,
        birth_date: formValues.birth_date || null,
        notes: formValues.notes || null,
        cpf: formValues.cpf || null,
        address: formValues.address || null,
        emergency_contact: formValues.emergency_contact || null,
        emergency_phone: formValues.emergency_phone || null,
        default_session_value: formValues.default_session_value ? parseFloat(formValues.default_session_value) : null,
        payment_day: formValues.payment_day ? parseInt(formValues.payment_day) : null,
        monthly_plan_value: formValues.monthly_plan_value ? parseFloat(formValues.monthly_plan_value) : null,
        social_name: formValues.social_name || null,
        birth_place: formValues.birth_place || null,
        gender: formValues.gender || null,
        marital_status: formValues.marital_status || null,
        rg: formValues.rg || null,
        rg_issuer: formValues.rg_issuer || null,
        profession: formValues.profession || null,
        education_level: formValues.education_level || null,
        initial_demand: formValues.initial_demand || null,
      } as any).select().single();

      if (error) throw error;

      if (scheduleEnabled && newPatient) {
        const weekday = parseInt(scheduleWeekday);
        const sessionValue = parseFloat(scheduleValue) || 200;
        const duration = getEffectiveDuration();
        const endDt = scheduleEndType === "date" && scheduleEndDate ? scheduleEndDate : undefined;
        const recurrenceType = scheduleFrequency === "quinzenal" ? "biweekly" : scheduleFrequency === "mensal" ? "monthly" : "weekly";
        const dates = scheduleFrequency === "avulso" ? [] : generateRecurringDates(scheduleStartDate, weekday, scheduleFrequency, endDt);

        if (dates.length > 0) {
          const { data: existingApts } = await supabase
            .from("appointments")
            .select("scheduled_at, duration_minutes, patients(full_name)")
            .eq("psychologist_id", userId)
            .is("deleted_at", null)
            .neq("status", "cancelled");

          const conflicts: string[] = [];
          const validDates: Date[] = [];

          for (const date of dates) {
            const scheduledAt = new Date(`${format(date, "yyyy-MM-dd")}T${scheduleTime}:00`);
            const newEnd = new Date(scheduledAt.getTime() + duration * 60000);
            const hasConflict = (existingApts || []).some((apt: any) => {
              const aptStart = new Date(apt.scheduled_at);
              const aptEnd = new Date(aptStart.getTime() + (apt.duration_minutes || 50) * 60000);
              return scheduledAt < aptEnd && newEnd > aptStart;
            });
            if (hasConflict) conflicts.push(format(date, "dd/MM"));
            else validDates.push(date);
          }

          let parentId: string | null = null;
          for (let i = 0; i < validDates.length; i++) {
            const date = validDates[i];
            const scheduledAt = new Date(`${format(date, "yyyy-MM-dd")}T${scheduleTime}:00`).toISOString();
            const aptData: any = {
              patient_id: newPatient.id, psychologist_id: userId, scheduled_at: scheduledAt,
              status: "scheduled", type: scheduleType, duration_minutes: duration,
              session_value: sessionValue, recurrence_type: recurrenceType,
            };
            if (i > 0 && parentId) aptData.recurrence_parent_id = parentId;

            const { data: apt, error: aptError } = await supabase.from("appointments").insert(aptData).select().single();
            if (aptError) continue;
            if (i === 0 && apt) parentId = apt.id;
            if (apt) {
              await supabase.from("financial_transactions").insert({
                psychologist_id: userId, patient_id: newPatient.id, type: "income",
                amount: sessionValue, description: `Sessão - ${fullName}`, category: "Consulta",
                payment_method: "pix", status: "pending", due_date: format(date, "yyyy-MM-dd"),
                appointment_id: apt.id,
              });
            }
          }
          if (conflicts.length > 0) toast.warning(`${conflicts.length} horário(s) com conflito ignorados`);
          toast.success(`Paciente criado e ${validDates.length} agendamentos configurados!`, { duration: 5000 });
        }
      } else {
        toast.success("Paciente cadastrado com sucesso!");
      }

      await supabase.from("audit_logs").insert({
        user_id: session.user.id, action_type: "create", entity_type: "patient",
        entity_id: newPatient?.id, new_data: { schedule_enabled: scheduleEnabled, full_name: fullName },
      } as any);

      await createDraftApi.current?.commit();
      setDialogOpen(false);
      loadPatients();
      resetCreateForm();
    } catch {
      toast.error("Erro ao cadastrar paciente");
    } finally {
      setCreating(false);
    }
  };

  const handleEditPatientFromForm = async (formValues: PatientFormData) => {
    if (!editingPatient) return;
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setEditingPatient(null); return; }
    try {
      const { error } = await supabase.from("patients").update({
        full_name: formValues.full_name,
        email: formValues.email || null,
        phone: formValues.phone || null,
        birth_date: formValues.birth_date || null,
        notes: formValues.notes || null,
        cpf: formValues.cpf || null,
        address: formValues.address || null,
        emergency_contact: formValues.emergency_contact || null,
        emergency_phone: formValues.emergency_phone || null,
        default_session_value: formValues.default_session_value ? parseFloat(formValues.default_session_value) : null,
        payment_day: formValues.payment_day ? parseInt(formValues.payment_day) : null,
        monthly_plan_value: formValues.monthly_plan_value ? parseFloat(formValues.monthly_plan_value) : null,
        social_name: formValues.social_name || null,
        birth_place: formValues.birth_place || null,
        gender: formValues.gender || null,
        marital_status: formValues.marital_status || null,
        rg: formValues.rg || null,
        rg_issuer: formValues.rg_issuer || null,
        profession: formValues.profession || null,
        education_level: formValues.education_level || null,
        initial_demand: formValues.initial_demand || null,
      } as any).eq("id", editingPatient.id);
      if (error) throw error;
      toast.success("Paciente atualizado com sucesso!");
      await editDraftApi.current?.commit();
      setEditingPatient(null);
      loadPatients();
    } catch {
      toast.error("Erro ao atualizar paciente");
    }
  };



  const handleDeletePatient = async (patientId: string) => {
    guardWrite(() => {
      (async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) return;
          const { error } = await supabase.from("patients").update({
            deleted_at: new Date().toISOString(), deleted_by: session.user.id, deleted_reason: "Excluído pelo usuário",
          }).eq("id", patientId);
          if (error) throw error;
          await supabase.from("audit_logs").insert({
            user_id: session.user.id, action_type: "soft_delete", entity_type: "patient", entity_id: patientId,
          } as any);
          toast.success("Paciente excluído!");
          loadPatients();
        } catch {
          toast.error("Erro ao excluir paciente");
        }
      })();
    });
  };

  const handleToggleStatus = async (patientId: string, currentStatus: string) => {
    guardWrite(() => {
      (async () => {
        try {
          const newStatus = currentStatus === "active" ? "inactive" : "active";
          const { error } = await supabase.from("patients").update({ status: newStatus }).eq("id", patientId);
          if (error) throw error;
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            await supabase.from("audit_logs").insert({
              user_id: session.user.id, action_type: "status_change", entity_type: "patient", entity_id: patientId,
              old_data: { status: currentStatus }, new_data: { status: newStatus },
            } as any);
          }
          toast.success(newStatus === "active" ? "Paciente reativado!" : "Paciente inativado!");
          loadPatients();
        } catch {
          toast.error("Erro ao alterar status");
        }
      })();
    });
  };

  // Bulk delete
  const handleBulkDelete = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        await supabase.from("patients").update({
          deleted_at: new Date().toISOString(), deleted_by: session.user.id, deleted_reason: "Exclusão em massa",
        }).eq("id", id);
        await supabase.from("audit_logs").insert({
          user_id: session.user.id, action_type: "soft_delete", entity_type: "patient", entity_id: id,
          new_data: { bulk_action: true },
        } as any);
      }
      toast.success(`${ids.length} paciente(s) excluído(s)!`);
      setSelectedIds(new Set());
      loadPatients();
    } catch {
      toast.error("Erro ao excluir pacientes");
    }
  };

  // Alteração de ciclo de vida em massa (fonte única de verdade: lifecycle_status)
  const handleBulkLifecycle = async (newStatus: LifecycleStatus) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const ids = Array.from(selectedIds);
      // status legado permanece espelhado para compatibilidade dos módulos antigos
      const legacy = newStatus === "active" ? "active" : "inactive";

      const { error } = await supabase
        .from("patients")
        .update({
          lifecycle_status: newStatus,
          lifecycle_updated_at: new Date().toISOString(),
          status: legacy,
        } as any)
        .in("id", ids);
      if (error) throw error;

      await supabase.from("patient_status_history").insert(
        ids.map((id) => ({
          patient_id: id,
          psychologist_id: session.user.id,
          changed_by: session.user.id,
          previous_status: patients.find((p) => p.id === id)?.lifecycle_status || "active",
          new_status: newStatus,
          reason: "Alteração em massa",
        })) as any,
      );

      const label = LIFECYCLE_STATUSES.find((s) => s.value === newStatus)?.label || newStatus;
      toast.success(`${ids.length} paciente(s) atualizados para ${label}`);
      setSelectedIds(new Set());
      loadPatients();
    } catch {
      toast.error("Erro ao alterar status dos pacientes");
    }
  };

  // Bulk inactivate (atalho)
  const handleBulkInactivate = () => handleBulkLifecycle("inactive");


  // Selection helpers
  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPatients.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredPatients.map(p => p.id)));
    }
  };

  // Export helpers
  const getExportData = () => {
    const ids = selectedIds.size > 0 ? Array.from(selectedIds) : filteredPatients.map(p => p.id);
    return patients.filter(p => ids.includes(p.id));
  };

  const handleExportCSV = () => {
    exportToCSV(getExportData(), "pacientes", PATIENT_EXPORT_HEADERS);
    toast.success("CSV exportado!");
  };
  const handleExportExcel = () => {
    exportToExcel(getExportData(), "pacientes", "Pacientes", PATIENT_EXPORT_HEADERS);
    toast.success("Excel exportado!");
  };
  const handleExportPDF = () => {
    exportToPDF(getExportData(), "pacientes", "Relatório de Pacientes", PATIENT_EXPORT_HEADERS);
    toast.success("PDF exportado!");
  };

  const filteredPatients = patients.filter((patient) => {
    const matchesSearch = patient.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      patient.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      patient.cpf?.includes(searchTerm);
    const matchesStatus = statusFilter === "all" || patient.status === statusFilter;
    const matchesLifecycle =
      lifecycleFilter === "all" ||
      (patient.lifecycle_status || "active") === lifecycleFilter;
    return matchesSearch && matchesStatus && matchesLifecycle;
  });

  const scheduleSummary = scheduleEnabled ? {
    weekdayLabel: WEEKDAYS.find(w => w.value === scheduleWeekday)?.label || "",
    time: scheduleTime,
    value: parseFloat(scheduleValue) || 200,
    duration: getEffectiveDuration(),
    type: scheduleType === "online" ? "Online" : "Presencial",
    frequency: scheduleFrequency,
  } : null;

  return (
    <AppLayout title="Gestão de Pacientes" description="Cadastro completo e acompanhamento de pacientes">
      <StatsOverview
        stats={[
          { label: "Total de Pacientes", value: patients.length, icon: Users, color: "blue", change: 12 },
          { label: "Pacientes Ativos", value: patients.filter(p => p.status === "active").length, icon: TrendingUp, color: "green", change: 8 },
          { label: "Novos este Mês", value: patients.filter(p => {
            const created = new Date(p.created_at || "");
            const now = new Date();
            return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
          }).length, icon: UserPlus, color: "purple", change: 15 },
          { label: "Selecionados", value: selectedIds.size, icon: CheckCircle2, color: "amber" },
        ]}
        className="mb-6"
      />

      <div className="flex flex-col sm:flex-row gap-4 justify-between mb-6 bg-card border border-border rounded-xl p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Buscar por nome, email ou CPF..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 w-[280px]" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="active">Ativos</SelectItem>
              <SelectItem value="inactive">Inativos</SelectItem>
            </SelectContent>
          </Select>
          <Select value={lifecycleFilter} onValueChange={setLifecycleFilter}>
            <SelectTrigger className="w-[170px]"><SelectValue placeholder="Ciclo de vida" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os ciclos</SelectItem>
              {LIFECYCLE_STATUSES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "grid" | "table")}>
            <TabsList className="h-9">
              <TabsTrigger value="grid" className="px-3"><LayoutGrid className="h-4 w-4" /></TabsTrigger>
              <TabsTrigger value="table" className="px-3"><List className="h-4 w-4" /></TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Download className="w-4 h-4" />Exportar
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={handleExportCSV} className="cursor-pointer">CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportExcel} className="cursor-pointer">Excel (.xlsx)</DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportPDF} className="cursor-pointer">PDF</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" className="gap-2" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4" />Importar
          </Button>
          <Dialog open={dialogOpen} onOpenChange={(open) => { if (open) { guardWrite(() => setDialogOpen(true)); } else { setDialogOpen(false); resetCreateForm(); } }}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="w-4 h-4" />Novo Paciente</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden">
              <DialogHeader>
                <DialogTitle>Cadastrar Novo Paciente</DialogTitle>
                <DialogDescription>Preencha os dados do paciente para criar o cadastro</DialogDescription>
              </DialogHeader>
              <ScrollArea className="max-h-[calc(90vh-140px)] pr-4">
                <PatientForm
                  draft={{ mode: "new", userId: currentUserId, label: "Novo paciente" }}
                  draftApiRef={createDraftApi}
                  onSubmit={handleCreatePatientFromForm}
                  submitLabel={scheduleEnabled ? "Cadastrar e Agendar" : "Cadastrar Paciente"}
                  loading={creating}
                  onCancel={() => setDialogOpen(false)}
                  onFinancialChange={handleFinancialChange}
                  extraContent={
                    <>
                      <Separator />
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            <h3 className="text-sm font-medium flex items-center gap-2"><Calendar className="h-4 w-4 text-primary" />Criar agendamento recorrente agora?</h3>
                            <p className="text-xs text-muted-foreground">Configure sessões automáticas para este paciente</p>
                          </div>
                          <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
                        </div>
                        <AnimatePresence>
                          {scheduleEnabled && (
                            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                              <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                  <div className="space-y-2"><Label className="text-xs">Dia da Semana</Label><Select value={scheduleWeekday} onValueChange={setScheduleWeekday}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{WEEKDAYS.map(d => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent></Select></div>
                                  <div className="space-y-2"><Label className="text-xs">Horário</Label><Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} /></div>
                                  <div className="space-y-2">
                                    <Label className="text-xs">Duração</Label>
                                    <Select value={scheduleDuration} onValueChange={setScheduleDuration}>
                                      <SelectTrigger><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="30">30 min</SelectItem>
                                        <SelectItem value="40">40 min</SelectItem>
                                        <SelectItem value="50">50 min</SelectItem>
                                        <SelectItem value="60">1 hora</SelectItem>
                                        <SelectItem value="90">1h 30min</SelectItem>
                                        <SelectItem value="120">2 horas</SelectItem>
                                        <SelectItem value="custom">Personalizado</SelectItem>
                                      </SelectContent>
                                    </Select>
                                    {scheduleDuration === "custom" && (
                                      <Input
                                        type="number"
                                        min={10}
                                        max={180}
                                        placeholder="Ex: 45"
                                        value={customDuration}
                                        onChange={(e) => setCustomDuration(e.target.value)}
                                        className="mt-2"
                                      />
                                    )}
                                  </div>
                                  <div className="space-y-2"><Label className="text-xs flex items-center gap-1"><DollarSign className="h-3 w-3" />Valor</Label><Input type="number" step="0.01" value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} /></div>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                  <div className="space-y-2">
                                    <Label className="text-xs">Data de Início</Label>
                                    <Input type="date" value={scheduleStartDate} onChange={(e) => setScheduleStartDate(e.target.value)} />
                                    {scheduleStartDate && (
                                      <p className="text-[11px] text-muted-foreground">
                                        Início: {format(new Date(scheduleStartDate + "T00:00:00"), "dd/MM/yyyy (EEEE)", { locale: ptBR })}
                                      </p>
                                    )}
                                  </div>
                                  <div className="space-y-2"><Label className="text-xs">Tipo</Label><Select value={scheduleType} onValueChange={setScheduleType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="presential">Presencial</SelectItem><SelectItem value="online">Online</SelectItem></SelectContent></Select></div>
                                </div>
                                <div className="space-y-2">
                                  <Label className="text-xs">Término</Label>
                                  <div className="flex gap-4">
                                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="endType" checked={scheduleEndType === "indefinite"} onChange={() => setScheduleEndType("indefinite")} className="accent-primary" /><span className="text-sm">Indeterminado (12 semanas)</span></label>
                                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="endType" checked={scheduleEndType === "date"} onChange={() => setScheduleEndType("date")} className="accent-primary" /><span className="text-sm">Até data</span></label>
                                  </div>
                                  {scheduleEndType === "date" && <Input type="date" value={scheduleEndDate} onChange={(e) => setScheduleEndDate(e.target.value)} className="mt-2 w-[200px]" />}
                                </div>
                                {scheduleSummary && (
                                  <div className="p-3 rounded-lg bg-background border border-border">
                                    <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><Repeat className="h-3 w-3" /> Resumo</div>
                                    <div className="grid grid-cols-2 gap-2 text-sm">
                                      <div><span className="text-muted-foreground">Dia:</span> <span className="font-medium">{scheduleSummary.weekdayLabel}</span></div>
                                      <div><span className="text-muted-foreground">Horário:</span> <span className="font-medium">{scheduleSummary.time}</span></div>
                                      <div><span className="text-muted-foreground">Valor:</span> <span className="font-medium text-emerald-600 dark:text-emerald-400">R$ {scheduleSummary.value.toFixed(2)}</span></div>
                                      <div><span className="text-muted-foreground">Tipo:</span> <span className="font-medium">{scheduleSummary.type}</span></div>
                                      <div><span className="text-muted-foreground">Frequência:</span> <span className="font-medium capitalize">{scheduleFrequency}</span></div>
                                      <div><span className="text-muted-foreground">Duração:</span> <span className="font-medium">{getEffectiveDuration()} min</span></div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </>
                  }
                />
              </ScrollArea>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Select All in grid mode */}
      {viewMode === "grid" && filteredPatients.length > 0 && (
        <div className="flex items-center gap-3 mb-4 px-1">
          <Checkbox
            checked={selectedIds.size === filteredPatients.length && filteredPatients.length > 0}
            onCheckedChange={toggleSelectAll}
          />
          <span className="text-sm text-muted-foreground">
            {selectedIds.size > 0 ? `${selectedIds.size} selecionado(s)` : "Selecionar todos"}
          </span>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12"><Users className="w-12 h-12 text-primary mx-auto animate-pulse mb-4" /><p className="text-muted-foreground">Carregando...</p></div>
      ) : filteredPatients.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium mb-2">{searchTerm ? "Nenhum paciente encontrado" : "Nenhum paciente cadastrado ainda"}</p>
          <p className="text-muted-foreground mb-6">{searchTerm ? "Tente ajustar os filtros" : "Comece cadastrando seu primeiro paciente"}</p>
          {!searchTerm && <Button onClick={() => guardWrite(() => setDialogOpen(true))}><Plus className="w-4 h-4 mr-2" />Cadastrar Primeiro Paciente</Button>}
        </CardContent></Card>
      ) : viewMode === "grid" ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          <AnimatePresence>
            {filteredPatients.map((patient, index) => (
              <div key={patient.id} className="relative">
                <div className="absolute top-3 left-3 z-10">
                  <Checkbox
                    checked={selectedIds.has(patient.id)}
                    onCheckedChange={() => toggleSelection(patient.id)}
                    className="bg-background/80 backdrop-blur-sm"
                  />
                </div>
                <PatientCard
                  patient={patient}
                  index={index}
                  onEdit={() => setEditingPatient(patient)}
                  onDelete={() => handleDeletePatient(patient.id)}
                  onClick={() => navigate(`/pacientes/${patient.id}`)}
                  onToggleStatus={() => handleToggleStatus(patient.id, patient.status)}
                />
              </div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-3 mb-3 px-1">
            <Checkbox
              checked={selectedIds.size === filteredPatients.length && filteredPatients.length > 0}
              onCheckedChange={toggleSelectAll}
            />
            <span className="text-sm text-muted-foreground">{selectedIds.size > 0 ? `${selectedIds.size} selecionado(s)` : "Selecionar todos"}</span>
          </div>
          <DataTable
            data={filteredPatients as Patient[]}
            searchPlaceholder="Buscar paciente..."
            searchKey={"full_name" as keyof Patient}
            columns={[
              {
                key: "select", header: "",
                render: (p) => (
                  <Checkbox
                    checked={selectedIds.has(p.id)}
                    onCheckedChange={() => toggleSelection(p.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ),
                className: "w-[40px]",
              },
              {
                key: "full_name", header: "Nome", sortable: true,
                render: (p) => (
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium text-xs">
                      {p.full_name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase()}
                    </div>
                    <span className="font-medium">{p.full_name}</span>
                  </div>
                ),
              },
              { key: "email", header: "Email", sortable: true },
              { key: "phone", header: "Telefone" },
              {
                key: "birth_date", header: "Nascimento",
                render: (p) => p.birth_date ? format(new Date(p.birth_date + "T00:00:00"), "dd/MM/yyyy") : "-",
              },
              {
                key: "status", header: "Status",
                render: (p) => <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status === "active" ? "Ativo" : "Inativo"}</Badge>,
              },
            ]}
            actions={(p) => <Button variant="ghost" size="sm" onClick={() => navigate(`/pacientes/${(p as Patient).id}`)}>Ver</Button>}
            onRowClick={(p) => navigate(`/pacientes/${(p as Patient).id}`)}
          />
        </div>
      )}

      <BulkActions
        selectedCount={selectedIds.size}
        totalCount={filteredPatients.length}
        onDelete={handleBulkDelete}
        onInactivate={handleBulkInactivate}
        onChangeLifecycle={handleBulkLifecycle}
        onExportCSV={handleExportCSV}
        onExportExcel={handleExportExcel}
        onExportPDF={handleExportPDF}
        onClearSelection={() => setSelectedIds(new Set())}
      />

      <PatientDetailSheet patient={selectedPatient} open={!!selectedPatient} onClose={() => setSelectedPatient(null)} onEdit={() => { setEditingPatient(selectedPatient); setSelectedPatient(null); }} />

      <Dialog open={!!editingPatient} onOpenChange={(open) => !open && setEditingPatient(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader><DialogTitle>Editar Paciente</DialogTitle><DialogDescription>Atualize os dados do paciente</DialogDescription></DialogHeader>
          {editingPatient && (
            <ScrollArea className="max-h-[calc(90vh-140px)] pr-4">
              <PatientForm
                draft={{ mode: "edit", entityId: editingPatient.id, userId: currentUserId, savedAt: (editingPatient as any).updated_at || null, label: editingPatient.full_name }}
                draftApiRef={editDraftApi}
                initialData={{
                  full_name: editingPatient.full_name,
                  email: editingPatient.email || "",
                  phone: editingPatient.phone || "",
                  cpf: editingPatient.cpf || "",
                  birth_date: editingPatient.birth_date || "",
                  address: editingPatient.address || "",
                  emergency_contact: editingPatient.emergency_contact || "",
                  emergency_phone: editingPatient.emergency_phone || "",
                  notes: editingPatient.notes || "",
                  default_session_value: editingPatient.default_session_value != null ? String(editingPatient.default_session_value) : "",
                  payment_day: editingPatient.payment_day != null ? String(editingPatient.payment_day) : "",
                  monthly_plan_value: editingPatient.monthly_plan_value != null ? String(editingPatient.monthly_plan_value) : "",
                  social_name: (editingPatient as any).social_name || "",
                  birth_place: (editingPatient as any).birth_place || "",
                  gender: (editingPatient as any).gender || "",
                  marital_status: (editingPatient as any).marital_status || "",
                  rg: (editingPatient as any).rg || "",
                  rg_issuer: (editingPatient as any).rg_issuer || "",
                  profession: (editingPatient as any).profession || "",
                  education_level: (editingPatient as any).education_level || "",
                  initial_demand: (editingPatient as any).initial_demand || "",
                }}
                onSubmit={handleEditPatientFromForm}
                submitLabel="Salvar"
                onCancel={() => setEditingPatient(null)}
              />
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>

      <PatientImportCSV
        open={importOpen}
        onOpenChange={setImportOpen}
        onImportComplete={loadPatients}
        existingPatients={patients.map(p => ({ full_name: p.full_name, email: p.email, cpf: p.cpf }))}
      />
    </AppLayout>
  );
}
