import { useState, useEffect, useMemo, useCallback } from "react";
import { useWriteGuard } from "@/components/subscription/WriteBlockedModal";
import { useSubscriptionGuard } from "@/hooks/useSubscriptionGuard";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PatientCombobox } from "@/components/shared/PatientCombobox";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Plus, Clock, User, Calendar as CalendarIcon, Video, MapPin, ChevronLeft, ChevronRight, LayoutGrid, List, Zap, Bell, RefreshCw, Repeat, DollarSign, Trash2, Filter, Download, ExternalLink, AlertTriangle, Info, Sparkles, Send } from "lucide-react";
import { syncAppointmentToGoogle } from "@/lib/google-calendar";
import { sendAppointmentNotification, resendAppointmentAccess } from "@/services/notification.service";
import { useAppointmentEmailStatus } from "@/hooks/useAppointmentEmailStatus";
import { resolveSessionTokenForAppointment, markAppointmentLive } from "@/lib/start-session";
import { usePatientContext } from "@/contexts/PatientContext";
import { useNavigate } from "react-router-dom";
import { format, isSameDay, startOfMonth, endOfMonth, addWeeks, addMonths } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppointmentTimeline } from "@/components/agenda/AppointmentTimeline";
import { QuickStats } from "@/components/agenda/QuickStats";
import { DayOverview } from "@/components/agenda/DayOverview";
import { ActionMenu } from "@/components/ui/action-menu";
import { StatsOverview } from "@/components/ui/stats-overview";
import { StatusLegend } from "@/components/agenda/StatusLegend";
import { AppointmentRequestsPanel } from "@/components/agenda/AppointmentRequestsPanel";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { exportToCSV, exportToExcel, exportToPDF } from "@/lib/export-utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Appointment {
  id: string;
  patient_id: string;
  scheduled_at: string;
  status: string;
  notes: string | null;
  type?: string;
  duration_minutes?: number;
  session_value?: number;
  recurrence_type?: string | null;
  recurrence_end_date?: string | null;
  recurrence_parent_id?: string | null;
  google_event_id?: string | null;
  patients: {
    full_name: string;
    phone: string;
  };
}

interface Patient {
  id: string;
  full_name: string;
  email?: string;
  default_session_value?: number | null;
  payment_day?: number | null;
  monthly_plan_value?: number | null;
}

function inferFrequencyFromPatient(p: Patient): string | null {
  if (!p.default_session_value || !p.monthly_plan_value) return null;
  const ratio = p.monthly_plan_value / p.default_session_value;
  if (Math.abs(ratio - 4) < 0.1) return "weekly";
  if (Math.abs(ratio - 2) < 0.1) return "biweekly";
  if (Math.abs(ratio - 1) < 0.1) return "monthly";
  return null;
}

function getNextDateByWeekday(targetDay: number): string {
  const today = new Date();
  const currentDay = today.getDay();
  let diff = targetDay - currentDay;
  if (diff < 0) diff += 7;
  const result = new Date(today);
  result.setDate(result.getDate() + diff);
  return format(result, "yyyy-MM-dd");
}

function SmallTooltip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-3 w-3 text-muted-foreground cursor-help inline-block ml-1" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px] text-xs"><p>{text}</p></TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function Agenda() {
  const navigate = useNavigate();
  const { setActivePatient } = usePatientContext();
  const { guardWrite } = useWriteGuard();
  const { checkSubscriptionBeforeWrite } = useSubscriptionGuard();
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [userId, setUserId] = useState<string>("");
  const [viewMode, setViewMode] = useState<"timeline" | "list">("timeline");
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [formData, setFormData] = useState({
    patient_id: "",
    date: format(new Date(), "yyyy-MM-dd"),
    time: "09:00",
    notes: "",
    type: "presential",
    duration: "50",
    status: "scheduled",
    session_value: "200",
    recurrence_enabled: false,
    recurrence_type: "weekly",
    recurrence_count: "4",
  });

  useEffect(() => {
    checkAuthAndLoadData();
  }, []);

  // FAB integration: respond to global events
  useEffect(() => {
    const newApt = () => setDialogOpen(true);
    const goToday = () => setSelectedDate(new Date());
    window.addEventListener("psicoone:new-appointment", newApt);
    window.addEventListener("psicoone:agenda-today", goToday);
    return () => {
      window.removeEventListener("psicoone:new-appointment", newApt);
      window.removeEventListener("psicoone:agenda-today", goToday);
    };
  }, []);
  const checkAuthAndLoadData = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    setUserId(session.user.id);
    await Promise.all([loadAppointments(session.user.id), loadPatients(session.user.id)]);
    setLoading(false);
  };

  const loadAppointments = async (psychologistId: string) => {
    const { data, error } = await supabase
      .from("appointments")
      .select(`id, patient_id, scheduled_at, status, notes, type, duration_minutes, session_value, recurrence_type, recurrence_end_date, recurrence_parent_id, google_event_id, patients (full_name, phone)`)
      .eq("psychologist_id", psychologistId)
      .is("deleted_at", null)
      .order("scheduled_at", { ascending: true });

    if (error) {
      toast.error("Erro ao carregar agendamentos");
      return;
    }
    setAppointments((data || []) as unknown as Appointment[]);
  };

  const loadPatients = async (psychologistId: string) => {
    const { data, error } = await supabase
      .from("patients")
      .select("id, full_name, email, default_session_value, payment_day, monthly_plan_value, lifecycle_status")
      .eq("psychologist_id", psychologistId)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("full_name");
    if (error) {
      toast.error("Não foi possível atualizar os pacientes. Tente abrir o agendamento novamente.");
      return;
    }
    // Exclude patients in lifecycle states that should not receive new appointments
    const blocked = new Set(["discharged", "dropout", "closed", "archived"]);
    setPatients(((data || []) as any[]).filter((p) => !blocked.has(p.lifecycle_status)) as Patient[]);
  };

  // A registration in another tab must be available without reloading the agenda.
  useEffect(() => {
    if (!userId) return;
    if (dialogOpen) void loadPatients(userId);
    const refresh = () => {
      if (document.visibilityState === "visible") void loadPatients(userId);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [userId, dialogOpen]);

  const checkConflicts = useCallback((date: string, time: string, duration: number, excludeId?: string) => {
    // Build start/end using local time components to avoid UTC shifts
    const [hours, minutes] = time.split(":").map(Number);
    const newStart = new Date(`${date}T${time}:00`);
    const newEnd = new Date(newStart.getTime() + duration * 60000);

    return appointments.filter(apt => {
      if (excludeId && apt.id === excludeId) return false;
      if (apt.status === "cancelled") return false;
      const aptStart = new Date(apt.scheduled_at);
      const aptEnd = new Date(aptStart.getTime() + (apt.duration_minutes || 50) * 60000);
      return newStart < aptEnd && newEnd > aptStart;
    });
  }, [appointments]);

  const generateRecurrenceDates = (startDate: string, startTime: string, type: string, count: number) => {
    const dates: string[] = [];
    const baseDate = new Date(`${startDate}T${startTime}:00`);
    for (let i = 1; i < count; i++) {
      let nextDate: Date;
      switch (type) {
        case "weekly": nextDate = addWeeks(baseDate, i); break;
        case "biweekly": nextDate = addWeeks(baseDate, i * 2); break;
        case "monthly": nextDate = addMonths(baseDate, i); break;
        default: nextDate = addWeeks(baseDate, i);
      }
      // Preserve local time by formatting back to local ISO string
      const localDate = format(nextDate, "yyyy-MM-dd");
      const localISO = new Date(`${localDate}T${startTime}:00`).toISOString();
      dates.push(localISO);
    }
    return dates;
  };

  const createFinancialTransaction = async (appointmentData: { patient_id: string; scheduled_at: string; session_value: number; appointment_id?: string }) => {
    try {
      await supabase.from("financial_transactions").insert({
        psychologist_id: userId,
        patient_id: appointmentData.patient_id,
        type: "income",
        amount: appointmentData.session_value,
        description: "Sessão de atendimento",
        category: "Consulta",
        payment_method: "pix",
        status: "pending",
        due_date: appointmentData.scheduled_at.split("T")[0],
        appointment_id: appointmentData.appointment_id || null,
      });
    } catch (err) {
      console.error("Error creating financial transaction:", err);
    }
  };

  const handleCreateAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating) return;
    // Server-side subscription check before write
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setDialogOpen(false); return; }
    if (!formData.patient_id) {
      toast.error("Selecione um paciente");
      return;
    }
    setCreating(true);

    const conflicts = checkConflicts(formData.date, formData.time, parseInt(formData.duration));
    if (conflicts.length > 0) {
      toast.error(`Conflito de horário com ${conflicts[0].patients.full_name} às ${format(new Date(conflicts[0].scheduled_at), "HH:mm")}`);
      setCreating(false);
      return;
    }

    const scheduledAt = new Date(`${formData.date}T${formData.time}:00`).toISOString();
    const sessionValue = parseFloat(formData.session_value) || 200;

    const appointmentBase: any = {
      patient_id: formData.patient_id,
      psychologist_id: userId,
      scheduled_at: scheduledAt,
      status: formData.status,
      notes: formData.notes || null,
      type: formData.type,
      duration_minutes: parseInt(formData.duration),
      session_value: sessionValue,
    };

    if (formData.recurrence_enabled) {
      appointmentBase.recurrence_type = formData.recurrence_type;
    }

    const { data: mainAppointment, error } = await supabase
      .from("appointments")
      .insert(appointmentBase)
      .select()
      .single();

    if (error) {
      console.error("[Agenda] insert error:", error);
      const msg = (error as any)?.message || "";
      let friendly = "Erro ao criar agendamento";
      if (/duplicate key/i.test(msg) && /room_token/i.test(msg)) {
        friendly = "Conflito na sala de teleatendimento do paciente. Recarregue a página e tente novamente.";
      } else if (/violates row-level security/i.test(msg)) {
        friendly = "Sem permissão para criar este agendamento.";
      } else if (/violates foreign key/i.test(msg) && /patient/i.test(msg)) {
        friendly = "Paciente inválido ou removido.";
      } else if (/null value in column/i.test(msg)) {
        friendly = "Preencha todos os campos obrigatórios.";
      } else if (/check constraint/i.test(msg)) {
        friendly = "Dados inválidos no agendamento.";
      } else if (msg) {
        friendly = `Erro: ${msg}`;
      }
      toast.error(friendly);
      setCreating(false);
      return;
    }

    // Sync to Google Calendar
    const patient = patients.find(p => p.id === formData.patient_id);
    syncAppointmentToGoogle("create", {
      id: mainAppointment.id,
      scheduled_at: scheduledAt,
      duration_minutes: parseInt(formData.duration),
      type: formData.type,
      notes: formData.notes || null,
      patient_name: patient?.full_name || "Paciente",
    });

    // Centralized notification: generate access link + send email (best-effort, non-blocking)
    sendAppointmentNotification({
      appointmentId: mainAppointment.id,
      patientId: formData.patient_id,
      psychologistId: userId,
      scheduledAt,
      durationMinutes: parseInt(formData.duration),
      type: formData.type,
    }).then(result => {
      if (result.emailSent) {
        toast.success("📩 E-mail de confirmação enviado ao paciente!");
      } else if (result.emailQueued) {
        toast.info("E-mail de confirmação na fila, aguardando envio.");
      } else if (result.reason === "no_email") {
        toast.info("Paciente sem e-mail cadastrado — link gerado, envio manual.");
      }
    }).catch(err => console.error("[Agenda] Notification failed:", err));

    await createFinancialTransaction({
      patient_id: formData.patient_id,
      scheduled_at: scheduledAt,
      session_value: sessionValue,
      appointment_id: mainAppointment?.id,
    });

    if (formData.recurrence_enabled && mainAppointment) {
      const isOpenEnded = formData.recurrence_count === "open";
      // Janela inicial: 90 dias para indeterminada, caso contrário N sessões
      const count = isOpenEnded
        ? Math.ceil(90 / (formData.recurrence_type === "weekly" ? 7 : formData.recurrence_type === "biweekly" ? 14 : 30))
        : parseInt(formData.recurrence_count) || 4;
      const recurrenceDates = generateRecurrenceDates(formData.date, formData.time, formData.recurrence_type, count);

      if (isOpenEnded) {
        await supabase.from("appointments").update({
          recurrence_open_ended: true,
          recurrence_extended_until: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
        } as any).eq("id", mainAppointment.id);
      }

      for (const date of recurrenceDates) {
        const childConflicts = checkConflicts(
          date.split("T")[0],
          format(new Date(date), "HH:mm"),
          parseInt(formData.duration)
        );
        if (childConflicts.length > 0) continue;

        const childData: any = {
          ...appointmentBase,
          scheduled_at: date,
          recurrence_parent_id: mainAppointment.id,
        };

        const { data: childApt, error: childError } = await supabase.from("appointments").insert(childData).select().single();
        if (!childError && childApt) {
          await createFinancialTransaction({
            patient_id: formData.patient_id,
            scheduled_at: date,
            session_value: sessionValue,
            appointment_id: childApt.id,
          });
          const patient = patients.find(p => p.id === formData.patient_id);
          syncAppointmentToGoogle("create", {
            id: childApt.id,
            scheduled_at: date,
            duration_minutes: parseInt(formData.duration),
            type: formData.type,
            notes: formData.notes || null,
            patient_name: patient?.full_name || "Paciente",
          });
        }
      }
      toast.success(isOpenEnded
        ? `Série indeterminada criada (${recurrenceDates.length} sessões iniciais — extensão automática)`
        : `Série de ${count} agendamentos criada!`);
    } else {
      toast.success("Agendamento criado!");
    }

    await supabase.from("audit_logs").insert({
      user_id: userId,
      action_type: "create",
      entity_type: "appointment",
      entity_id: mainAppointment?.id,
      new_data: { recurrence: formData.recurrence_enabled, type: formData.type, value: sessionValue },
    } as any);

    setDialogOpen(false);
    setCreating(false);
    resetForm();
    await loadAppointments(userId);
  };

  const handleEditAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAppointment) return;
    // Server-side subscription check before write
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setEditingAppointment(null); return; }

    const conflicts = checkConflicts(formData.date, formData.time, parseInt(formData.duration), editingAppointment.id);
    if (conflicts.length > 0) {
      toast.error(`Conflito de horário com ${conflicts[0].patients.full_name}`);
      return;
    }

    const scheduledAt = new Date(`${formData.date}T${formData.time}:00`).toISOString();

    const { error } = await supabase
      .from("appointments")
      .update({
        patient_id: formData.patient_id,
        scheduled_at: scheduledAt,
        notes: formData.notes || null,
        type: formData.type,
        duration_minutes: parseInt(formData.duration),
        status: formData.status,
        session_value: parseFloat(formData.session_value) || 200,
        recurrence_type: formData.recurrence_enabled ? formData.recurrence_type : null,
      } as any)
      .eq("id", editingAppointment.id);

    if (error) {
      console.error("[Agenda] update error:", error);
      toast.error((error as any)?.message ? `Erro: ${(error as any).message}` : "Erro ao atualizar agendamento");
      return;
    }


    await supabase.from("audit_logs").insert({
      user_id: userId,
      action_type: "update",
      entity_type: "appointment",
      entity_id: editingAppointment.id,
      old_data: { scheduled_at: editingAppointment.scheduled_at, status: editingAppointment.status },
      new_data: { scheduled_at: scheduledAt, status: formData.status },
    } as any);

    // Sync update to Google Calendar
    const patient = patients.find(p => p.id === formData.patient_id);
    syncAppointmentToGoogle("update", {
      id: editingAppointment.id,
      scheduled_at: scheduledAt,
      duration_minutes: parseInt(formData.duration),
      type: formData.type,
      notes: formData.notes || null,
      patient_name: patient?.full_name || "Paciente",
      google_event_id: (editingAppointment as any).google_event_id,
    });

    toast.success("Agendamento atualizado!");
    setEditingAppointment(null);
    resetForm();
    await loadAppointments(userId);
  };

  // Soft delete instead of hard delete + sync Google Calendar
  const handleDeleteAppointment = async (appointmentId: string) => {
    guardWrite(() => {
      (async () => {
        const apt = appointments.find(a => a.id === appointmentId);

        const { error } = await supabase
          .from("appointments")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: userId,
            deleted_reason: "Excluído pelo usuário",
          })
          .eq("id", appointmentId);

        if (error) {
          toast.error("Erro ao excluir agendamento");
          return;
        }

        if (apt?.google_event_id) {
          syncAppointmentToGoogle("cancel", {
            id: apt.id,
            scheduled_at: apt.scheduled_at,
            duration_minutes: apt.duration_minutes || 50,
            type: apt.type || "presential",
            patient_name: apt.patients?.full_name || "Paciente",
            google_event_id: apt.google_event_id,
          });
        }

        await supabase.from("audit_logs").insert({
          user_id: userId,
          action_type: "soft_delete",
          entity_type: "appointment",
          entity_id: appointmentId,
        } as any);

        toast.success("Agendamento excluído!");
        await loadAppointments(userId);
      })();
    });
  };

  const handleStatusChange = async (appointmentId: string, newStatus: string) => {
    guardWrite(() => {
      (async () => {
        const apt = appointments.find(a => a.id === appointmentId);
        const oldStatus = apt?.status;

        if (newStatus === "completed" && apt) {
          await supabase.from("financial_transactions")
            .update({ status: "paid", paid_date: new Date().toISOString().split("T")[0] })
            .eq("appointment_id", apt.id)
            .eq("status", "pending");
        }

        if (newStatus === "cancelled" && apt) {
          await supabase.from("financial_transactions")
            .update({ status: "cancelled" })
            .eq("appointment_id", apt.id)
            .eq("status", "pending");

          syncAppointmentToGoogle("cancel", {
            id: apt.id,
            scheduled_at: apt.scheduled_at,
            duration_minutes: apt.duration_minutes || 50,
            type: apt.type || "presential",
            patient_name: apt.patients.full_name,
            google_event_id: apt.google_event_id,
          });
        }

        const { error } = await supabase
          .from("appointments")
          .update({ status: newStatus } as any)
          .eq("id", appointmentId);

        if (error) {
          toast.error("Erro ao atualizar status");
          return;
        }

        await supabase.from("audit_logs").insert({
          user_id: userId,
          action_type: "status_change",
          entity_type: "appointment",
          entity_id: appointmentId,
          old_data: { status: oldStatus },
          new_data: { status: newStatus },
        } as any);

        toast.success("Status atualizado!");
        await loadAppointments(userId);
      })();
    });
  };

  const handleMarkPaid = async (apt: Appointment) => {
    guardWrite(() => {
      (async () => {
        const { error } = await supabase.from("financial_transactions")
          .update({ status: "paid", paid_date: new Date().toISOString().split("T")[0] })
          .eq("appointment_id", apt.id)
          .eq("status", "pending");

        if (error) {
          toast.error("Erro ao marcar como pago");
          return;
        }
        toast.success(`Pagamento de ${apt.patients.full_name} registrado!`);
      })();
    });
  };

  const handleResendAccess = async (apt: Appointment) => {
    const t = toast.loading("Gerando novo link de acesso...");
    const result = await resendAppointmentAccess(apt.id);
    toast.dismiss(t);

    if (result.portalUrl) {
      try { await navigator.clipboard.writeText(result.portalUrl); } catch {}
      if (result.emailSent) {
        toast.success(`✅ Acesso enviado para ${apt.patients.full_name}!`);
      } else if (result.emailQueued) {
        toast.info("Link gerado. E-mail na fila, aguardando envio.");
      } else if (result.reason === "no_email") {
        toast.info("Sem e-mail cadastrado. Link copiado para envio manual.");
      } else {
        toast.warning("Link copiado, mas e-mail não foi enviado.");
      }
    } else {
      toast.error("❌ Erro ao gerar acesso");
    }
  };

  const resetForm = () => {
    setFormData({
      patient_id: "",
      date: format(new Date(), "yyyy-MM-dd"),
      time: "09:00",
      notes: "",
      type: "presential",
      duration: "50",
      status: "scheduled",
      session_value: "200",
      recurrence_enabled: false,
      recurrence_type: "weekly",
      recurrence_count: "4",
    });
  };

  const openEditDialog = (appointment: Appointment) => {
    guardWrite(() => {
      const dateTime = new Date(appointment.scheduled_at);
      setFormData({
        patient_id: appointment.patient_id,
        date: format(dateTime, "yyyy-MM-dd"),
        time: format(dateTime, "HH:mm"),
        notes: appointment.notes || "",
        type: appointment.type || "presential",
        duration: String(appointment.duration_minutes || 50),
        status: appointment.status || "scheduled",
        session_value: String(appointment.session_value || 200),
        recurrence_enabled: !!(appointment.recurrence_type || (appointment as any).recurrence_parent_id),
        recurrence_type: appointment.recurrence_type || "weekly",
        recurrence_count: "4",
      });
      setEditingAppointment(appointment);
    });
  };

  const filteredAppointments = appointments.filter(apt => {
    if (!isSameDay(new Date(apt.scheduled_at), selectedDate)) return false;
    if (statusFilter !== "all" && apt.status !== statusFilter) return false;
    return true;
  });

  // Batch-fetch latest email status for visible appointments
  const filteredIds = useMemo(
    () => filteredAppointments.map((a) => a.id),
    [filteredAppointments.map((a) => a.id).join(",")]
  );
  const { statusMap: emailStatusMap, refresh: refreshEmailStatuses } = useAppointmentEmailStatus(filteredIds);

  const handleExportAgenda = (fmt: "csv" | "xlsx" | "pdf") => {
    const data = filteredAppointments.map(a => ({
      paciente: a.patients.full_name,
      data: format(new Date(a.scheduled_at), "dd/MM/yyyy"),
      horario: format(new Date(a.scheduled_at), "HH:mm"),
      status: a.status,
      tipo: a.type === "online" ? "Online" : "Presencial",
      duracao: `${a.duration_minutes || 50}min`,
      observacoes: a.notes || "",
    }));
    const headers = { paciente: "Paciente", data: "Data", horario: "Horário", status: "Status", tipo: "Tipo", duracao: "Duração", observacoes: "Observações" };
    if (fmt === "csv") exportToCSV(data, "agenda", headers);
    else if (fmt === "xlsx") exportToExcel(data, "agenda", "Agenda", headers);
    else exportToPDF(data, "agenda", "Agenda - Agendamentos", headers);
    toast.success("Exportado!");
  };

  const stats = {
    total: filteredAppointments.length,
    confirmed: filteredAppointments.filter(a => a.status === "confirmed").length,
    completed: filteredAppointments.filter(a => a.status === "completed").length,
    cancelled: filteredAppointments.filter(a => a.status === "cancelled").length,
    pending: filteredAppointments.filter(a => a.status === "scheduled").length,
  };

  const dayStats = useMemo(() => {
    const revenue = filteredAppointments
      .filter(a => a.status !== "cancelled")
      .reduce((sum, a) => sum + (a.session_value || 200), 0);
    return {
      totalSlots: 10,
      bookedSlots: filteredAppointments.length,
      confirmedSlots: filteredAppointments.filter(a => a.status === "confirmed").length,
      completedSlots: filteredAppointments.filter(a => a.status === "completed").length,
      cancelledSlots: filteredAppointments.filter(a => a.status === "cancelled").length,
      revenue,
      avgDuration: 50,
    };
  }, [filteredAppointments]);

  const monthlyStats = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const monthAppointments = appointments.filter(apt => {
      const d = new Date(apt.scheduled_at);
      return d >= monthStart && d <= monthEnd;
    });
    const completed = monthAppointments.filter(a => a.status === "completed");
    const cancelled = monthAppointments.filter(a => a.status === "cancelled");
    const noShow = monthAppointments.filter(a => a.status === "no_show");
    const online = monthAppointments.filter(a => a.type === "online");
    const presential = monthAppointments.filter(a => a.type === "presential");
    const totalRevenue = completed.reduce((sum, a) => sum + (a.session_value || 200), 0);

    return {
      total: monthAppointments.length,
      completed: completed.length,
      cancelled: cancelled.length,
      noShow: noShow.length,
      online: online.length,
      presential: presential.length,
      attendanceRate: monthAppointments.length > 0
        ? Math.round((completed.length / (monthAppointments.length - cancelled.length || 1)) * 100)
        : 0,
      revenue: totalRevenue,
    };
  }, [appointments, selectedDate]);

  const [customDuration, setCustomDuration] = useState("");
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());

  const handlePatientSelect = useCallback((value: string) => {
    const p = patients.find(pt => pt.id === value);
    const updates: Partial<typeof formData> = { patient_id: value };
    const filled = new Set<string>();

    if (p?.default_session_value) {
      updates.session_value = String(p.default_session_value);
      filled.add("session_value");
    }

    const freq = p ? inferFrequencyFromPatient(p) : null;
    if (freq) {
      updates.recurrence_enabled = true;
      updates.recurrence_type = freq;
      filled.add("recurrence_type");
    }

    setFormData(prev => ({ ...prev, ...updates }));
    setAutoFilledFields(filled);

    if (filled.size > 0) {
      toast.success("Dados do paciente aplicados automaticamente", { icon: "✨" });
    }

    setTimeout(() => setAutoFilledFields(new Set()), 3000);
  }, [patients]);

  const durationPresets = ["30", "40", "50", "60", "90", "120"];
  const isCustomDuration = !durationPresets.includes(formData.duration);

  const handleDurationPreset = (v: string) => {
    setFormData(prev => ({ ...prev, duration: v }));
    setCustomDuration("");
  };

  const handleCustomDuration = (v: string) => {
    const num = parseInt(v);
    setCustomDuration(v);
    if (num >= 10 && num <= 180) {
      setFormData(prev => ({ ...prev, duration: String(num) }));
    }
  };

  const selectedWeekday = useMemo(() => {
    if (!formData.date) return "";
    try {
      return format(new Date(formData.date + "T00:00:00"), "EEEE", { locale: ptBR });
    } catch { return ""; }
  }, [formData.date]);

  const monthlyTotal = useMemo(() => {
    const val = parseFloat(formData.session_value);
    if (!val || !formData.recurrence_enabled) return null;
    switch (formData.recurrence_type) {
      case "weekly": return val * 4;
      case "biweekly": return val * 2;
      case "monthly": return val;
      default: return null;
    }
  }, [formData.session_value, formData.recurrence_enabled, formData.recurrence_type]);

  const selectedPatientForForm = patients.find(p => p.id === formData.patient_id);

  const fieldHighlight = (field: string) =>
    autoFilledFields.has(field) ? "ring-2 ring-primary/50 transition-all" : "";

  if (loading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
          <div className="grid lg:grid-cols-[320px,1fr] gap-6">
            <Skeleton className="h-80 rounded-xl" />
            <Skeleton className="h-96 rounded-xl" />
          </div>
        </div>
      </AppLayout>
    );
  }



  const AppointmentForm = ({ onSubmit, submitLabel }: { onSubmit: (e: React.FormEvent) => void; submitLabel: string }) => (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* Patient selector */}
      <div className="space-y-2">
        <Label>Paciente *</Label>
        <PatientCombobox
          patients={patients}
          value={formData.patient_id}
          onChange={handlePatientSelect}
        />


        {/* Financial context card */}
        <AnimatePresence>
          {selectedPatientForForm && (selectedPatientForForm.default_session_value || selectedPatientForForm.monthly_plan_value || selectedPatientForForm.payment_day) && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="p-3 rounded-lg bg-muted/50 border border-border space-y-1"
            >
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Sparkles className="h-3 w-3 text-primary" /> Contexto financeiro do paciente
              </p>
              <div className="flex flex-wrap gap-3 text-xs">
                {selectedPatientForForm.default_session_value && (
                  <span>Sessão: <strong className="text-primary">R$ {selectedPatientForForm.default_session_value}</strong></span>
                )}
                {selectedPatientForForm.monthly_plan_value && (
                  <span>Plano: <strong>R$ {selectedPatientForForm.monthly_plan_value}</strong></span>
                )}
                {selectedPatientForForm.payment_day && (
                  <span>Pgto dia: <strong>{selectedPatientForForm.payment_day}</strong></span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Date / Time / Duration */}
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label className="flex items-center">Data *<SmallTooltip text="Data do atendimento." /></Label>
          <Input type="date" value={formData.date} onChange={(e) => setFormData({...formData, date: e.target.value})} required />
          {selectedWeekday && (
            <p className="text-[10px] text-muted-foreground capitalize">{selectedWeekday}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>Hora *</Label>
          <Input type="time" value={formData.time} onChange={(e) => setFormData({...formData, time: e.target.value})} required />
        </div>
        <div className="space-y-2">
          <Label className="flex items-center">Duração<SmallTooltip text="Escolha um preset ou digite uma duração personalizada (10-180 min)." /></Label>
          <Select value={isCustomDuration ? "custom" : formData.duration} onValueChange={(v) => {
            if (v === "custom") {
              setCustomDuration(formData.duration);
            } else {
              handleDurationPreset(v);
            }
          }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 min</SelectItem>
              <SelectItem value="40">40 min</SelectItem>
              <SelectItem value="50">50 min</SelectItem>
              <SelectItem value="60">1 hora</SelectItem>
              <SelectItem value="90">1h 30min</SelectItem>
              <SelectItem value="120">2 horas</SelectItem>
              <SelectItem value="custom">Personalizado...</SelectItem>
            </SelectContent>
          </Select>
          <AnimatePresence>
            {(isCustomDuration || customDuration !== "") && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                <Input
                  type="number"
                  min={10}
                  max={180}
                  placeholder="Ex: 45"
                  value={customDuration || formData.duration}
                  onChange={(e) => handleCustomDuration(e.target.value)}
                  className="h-8 text-xs mt-1"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Status + Value */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Status Inicial</Label>
          <Select value={formData.status} onValueChange={(v) => setFormData({...formData, status: v})}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="scheduled">Agendado</SelectItem>
              <SelectItem value="confirmed">Confirmado</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="flex items-center gap-1">
            <DollarSign className="h-3.5 w-3.5" />
            Valor da Sessão
            <SmallTooltip text="Valor cobrado por este atendimento. Preenchido automaticamente com base no cadastro do paciente." />
          </Label>
          <div className="relative">
            <Input
              type="number"
              step="0.01"
              value={formData.session_value}
              onChange={(e) => setFormData({...formData, session_value: e.target.value})}
              placeholder="200.00"
              className={fieldHighlight("session_value")}
            />
            {autoFilledFields.has("session_value") && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                auto
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Type */}
      <div className="space-y-2">
        <Label>Tipo de Atendimento</Label>
        <div className="flex gap-3">
          <Button type="button" variant={formData.type === "presential" ? "default" : "outline"} className="flex-1 gap-2" onClick={() => setFormData({...formData, type: "presential"})}>
            <MapPin className="h-4 w-4" /> Presencial
          </Button>
          <Button type="button" variant={formData.type === "online" ? "default" : "outline"} className="flex-1 gap-2" onClick={() => setFormData({...formData, type: "online"})}>
            <Video className="h-4 w-4" /> Online
          </Button>
        </div>
      </div>

      {/* Recurrence */}
      {!editingAppointment && (
        <motion.div layout className="space-y-3 p-4 rounded-lg border border-border bg-muted/30">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <Repeat className="h-4 w-4 text-primary" />
              Agendamento Recorrente
              {autoFilledFields.has("recurrence_type") && (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">auto</span>
              )}
            </Label>
            <Switch checked={formData.recurrence_enabled} onCheckedChange={(v) => setFormData({...formData, recurrence_enabled: v})} />
          </div>
          <AnimatePresence>
            {formData.recurrence_enabled && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="grid grid-cols-2 gap-3 pt-2"
              >
                <div className="space-y-1">
                  <Label className="text-xs">Frequência</Label>
                  <Select value={formData.recurrence_type} onValueChange={(v) => setFormData({...formData, recurrence_type: v})}>
                    <SelectTrigger className={cn("h-9", fieldHighlight("recurrence_type"))}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="weekly">Semanal</SelectItem>
                      <SelectItem value="biweekly">Quinzenal</SelectItem>
                      <SelectItem value="monthly">Mensal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Repetições</Label>
                  <Select value={formData.recurrence_count} onValueChange={(v) => setFormData({...formData, recurrence_count: v})}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[2, 4, 8, 12, 16, 24].map(n => (
                        <SelectItem key={n} value={String(n)}>{n} sessões</SelectItem>
                      ))}
                      <SelectItem value="open">Sem prazo (indeterminada)</SelectItem>
                    </SelectContent>
                  </Select>
                  {formData.recurrence_count === "open" && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Sessões geradas automaticamente em janela de 90 dias.
                    </p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Notes */}
      <div className="space-y-2">
        <Label>Observações</Label>
        <Textarea value={formData.notes} onChange={(e) => setFormData({...formData, notes: e.target.value})} placeholder="Informações adicionais" rows={3} />
      </div>

      {/* Smart Summary */}
      <AnimatePresence>
        {formData.patient_id && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="p-4 rounded-lg border border-primary/20 bg-primary/5 space-y-2"
          >
            <p className="text-xs font-semibold flex items-center gap-1.5 text-primary">
              <Sparkles className="h-3.5 w-3.5" /> Resumo do Agendamento
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">Paciente:</span>
              <span className="font-medium">{selectedPatientForForm?.full_name || "—"}</span>

              <span className="text-muted-foreground">Tipo:</span>
              <span className="font-medium">{formData.type === "online" ? "Online" : "Presencial"}</span>

              {formData.recurrence_enabled && (
                <>
                  <span className="text-muted-foreground">Frequência:</span>
                  <span className="font-medium">
                    {formData.recurrence_type === "weekly" ? "Semanal" : formData.recurrence_type === "biweekly" ? "Quinzenal" : "Mensal"}
                  </span>
                </>
              )}

              <span className="text-muted-foreground">Horário:</span>
              <span className="font-medium">{formData.time}</span>

              <span className="text-muted-foreground">Duração:</span>
              <span className="font-medium">{formData.duration} min</span>

              <span className="text-muted-foreground">Valor/sessão:</span>
              <span className="font-medium text-primary">R$ {parseFloat(formData.session_value || "0").toFixed(2)}</span>

              {monthlyTotal && (
                <>
                  <span className="text-muted-foreground">Total mensal:</span>
                  <span className="font-medium text-primary">R$ {monthlyTotal.toFixed(2)}</span>
                </>
              )}

              {formData.date && (
                <>
                  <span className="text-muted-foreground">Próxima sessão:</span>
                  <span className="font-medium capitalize">
                    {format(new Date(formData.date + "T00:00:00"), "dd/MM/yyyy")} ({selectedWeekday})
                  </span>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Button type="submit" className="w-full" disabled={creating}>{creating ? "Criando..." : submitLabel}</Button>
    </form>
  );

  return (
    <AppLayout title="Agenda Inteligente" description="Gerencie seus agendamentos com eficiência e insights em tempo real">
      <StatsOverview
        stats={[
          { label: "Consultas do Mês", value: monthlyStats.total, icon: CalendarIcon, color: "blue", change: 12 },
          { label: "Realizadas", value: monthlyStats.completed, icon: Clock, color: "green", change: 8 },
          { label: "Cancelamentos", value: monthlyStats.cancelled, icon: RefreshCw, color: "red", change: -15 },
          { label: "Taxa de Presença", value: `${monthlyStats.attendanceRate}%`, icon: Zap, color: "purple", change: 5 },
        ]}
        className="mb-6"
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1">Online vs Presencial</div>
          <div className="flex items-center gap-2">
            <Video className="h-4 w-4 text-blue-500" />
            <span className="font-bold">{monthlyStats.online}</span>
            <span className="text-muted-foreground">/</span>
            <MapPin className="h-4 w-4 text-green-500" />
            <span className="font-bold">{monthlyStats.presential}</span>
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1">No-shows</div>
          <div className="text-lg font-bold text-amber-500">{monthlyStats.noShow}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1">Faturamento Mês</div>
          <div className="text-lg font-bold text-green-500">R$ {monthlyStats.revenue.toLocaleString("pt-BR")}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground mb-1">Ticket Médio</div>
          <div className="text-lg font-bold">
            R$ {monthlyStats.completed > 0 ? Math.round(monthlyStats.revenue / monthlyStats.completed).toLocaleString("pt-BR") : "0"}
          </div>
        </Card>
      </div>

      {/* Status Legend */}
      <StatusLegend className="mb-6 p-3 rounded-lg bg-muted/30 border border-border" />

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <QuickStats stats={stats} />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px] h-9">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="scheduled">Agendado</SelectItem>
              <SelectItem value="confirmed">Confirmado</SelectItem>
              <SelectItem value="completed">Realizado</SelectItem>
              <SelectItem value="cancelled">Cancelado</SelectItem>
              <SelectItem value="rescheduled">Remarcado</SelectItem>
              <SelectItem value="no_show">Não compareceu</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />Exportar
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => handleExportAgenda("csv")} className="cursor-pointer">CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportAgenda("xlsx")} className="cursor-pointer">Excel</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportAgenda("pdf")} className="cursor-pointer">PDF</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Dialog open={dialogOpen} onOpenChange={(open) => { if (open) { guardWrite(() => setDialogOpen(true)); } else { setDialogOpen(false); } }}>
          <DialogTrigger asChild>
            <Button className="gap-2 shrink-0">
              <Plus className="h-4 w-4" />
              Novo Agendamento
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CalendarIcon className="h-5 w-5 text-primary" />
                Novo Agendamento
              </DialogTitle>
            </DialogHeader>
            <AppointmentForm onSubmit={handleCreateAppointment} submitLabel="Criar Agendamento" />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="grid lg:grid-cols-[320px,1fr] gap-6">
        <div className="space-y-4">
          <Card>
            <CardContent className="p-3">
              <Calendar mode="single" selected={selectedDate} onSelect={(date) => date && setSelectedDate(date)} locale={ptBR} className="rounded-md w-full" />
            </CardContent>
          </Card>
          <DayOverview stats={dayStats} selectedDate={selectedDate} />
          <AppointmentRequestsPanel psychologistId={userId} />
        </div>

        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" onClick={() => setSelectedDate(new Date(selectedDate.getTime() - 86400000))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <CalendarIcon className="h-5 w-5 text-primary" />
                  {format(selectedDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}
                </CardTitle>
                <Button variant="ghost" size="icon" onClick={() => setSelectedDate(new Date(selectedDate.getTime() + 86400000))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "timeline" | "list")}>
                <TabsList className="h-8">
                  <TabsTrigger value="timeline" className="px-3 text-xs"><LayoutGrid className="h-3 w-3" /></TabsTrigger>
                  <TabsTrigger value="list" className="px-3 text-xs"><List className="h-3 w-3" /></TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            {filteredAppointments.length === 0 ? (
              <div className="text-center py-16">
                <CalendarIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium mb-1">Nenhum agendamento</p>
                <p className="text-sm text-muted-foreground">
                  Não há consultas para {format(selectedDate, "dd 'de' MMMM", { locale: ptBR })}
                </p>
              </div>
            ) : viewMode === "timeline" ? (
              <AppointmentTimeline
                appointments={filteredAppointments}
                selectedDate={selectedDate}
                emailStatusMap={emailStatusMap}
                onEdit={openEditDialog}
                onDelete={handleDeleteAppointment}
                onStatusChange={handleStatusChange}
                onMarkPaid={handleMarkPaid}
                onResendAccess={async (apt) => {
                  await handleResendAccess(apt);
                  refreshEmailStatuses();
                }}
                onJoinSession={async (apt) => {
                  const patient = patients.find(p => p.id === apt.patient_id);
                  if (patient) {
                    setActivePatient({
                      id: patient.id,
                      full_name: patient.full_name,
                      default_session_value: patient.default_session_value ?? null,
                      payment_day: patient.payment_day ?? null,
                    });
                  }
                  toast.loading("Preparando sala…", { id: "start-session" });
                  const token = await resolveSessionTokenForAppointment(apt.id);
                  toast.dismiss("start-session");
                  if (!token) return;
                  // Navigate to the dedicated host page, which will auto-start pre-call
                  navigate(`/teleatendimento?session=${token}&appointment=${apt.id}&autostart=1`);
                }}
              />
            ) : (
              <div className="space-y-3">
                {filteredAppointments.map((appointment, index) => {
                  const statusMap: Record<string, { bg: string; text: string; label: string; border: string; dot: string }> = {
                    scheduled: { bg: "bg-blue-500/10", text: "text-blue-600 dark:text-blue-400", label: "Agendado", border: "border-l-blue-500", dot: "bg-blue-500" },
                    confirmed: { bg: "bg-green-500/10", text: "text-green-600 dark:text-green-400", label: "Confirmado", border: "border-l-green-500", dot: "bg-green-500" },
                    completed: { bg: "bg-purple-500/10", text: "text-purple-600 dark:text-purple-400", label: "Realizado", border: "border-l-purple-500", dot: "bg-purple-500" },
                    cancelled: { bg: "bg-destructive/10", text: "text-destructive", label: "Cancelado", border: "border-l-destructive", dot: "bg-destructive" },
                    rescheduled: { bg: "bg-orange-500/10", text: "text-orange-600 dark:text-orange-400", label: "Remarcado", border: "border-l-orange-500", dot: "bg-orange-500" },
                    no_show: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400", label: "Não compareceu", border: "border-l-amber-500", dot: "bg-amber-500" },
                  };
                  const sc = statusMap[appointment.status || "scheduled"] || statusMap.scheduled;

                  return (
                    <motion.div
                      key={appointment.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className={cn(
                        "border border-l-4 rounded-lg p-4 hover:shadow-md transition-all",
                        sc.bg, sc.border
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <div className={cn("h-2 w-2 rounded-full shrink-0", sc.dot)} />
                            <button
                              className="font-medium hover:underline text-left"
                              onClick={(e) => { e.stopPropagation(); navigate(`/pacientes/${appointment.patient_id}`); }}
                            >
                              {appointment.patients.full_name}
                            </button>
                            <Badge className={cn("text-[10px] px-1.5 py-0 h-4 border-0", sc.bg, sc.text)}>
                              {sc.label}
                            </Badge>
                            {appointment.recurrence_type && (
                              <Badge variant="outline" className="text-xs gap-1">
                                <Repeat className="h-3 w-3" />
                                {appointment.recurrence_type === "weekly" ? "Semanal" : appointment.recurrence_type === "biweekly" ? "Quinzenal" : "Mensal"}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground">
                            <Clock className="h-4 w-4" />
                            <span>{format(new Date(appointment.scheduled_at), "HH:mm")}</span>
                            <span className="text-xs">({appointment.duration_minutes || 50}min)</span>
                            {appointment.type === "online" ? (
                              <Badge variant="outline" className="text-xs"><Video className="h-3 w-3 mr-1" />Online</Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs"><MapPin className="h-3 w-3 mr-1" />Presencial</Badge>
                            )}
                            {appointment.session_value && (
                              <span className="text-xs text-green-600 font-medium">R$ {Number(appointment.session_value).toFixed(0)}</span>
                            )}
                          </div>
                        </div>
                        <ActionMenu
                          onEdit={() => openEditDialog(appointment)}
                          onDelete={() => handleDeleteAppointment(appointment.id)}
                          deleteTitle="Excluir Agendamento"
                          deleteDescription="Tem certeza que deseja excluir este agendamento?"
                          extraActions={[
                            ...(appointment.status !== "cancelled" && appointment.status !== "completed" ? [{
                              label: "Reenviar Acesso",
                              icon: <Send className="h-4 w-4" />,
                              onClick: () => handleResendAccess(appointment),
                            }] : []),
                            {
                              label: "Marcar como Pago",
                              icon: <DollarSign className="h-4 w-4" />,
                              onClick: () => handleMarkPaid(appointment),
                            },
                          ]}
                        />
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <Select value={appointment.status || "scheduled"} onValueChange={(value) => handleStatusChange(appointment.id, value)}>
                          <SelectTrigger className={cn("w-[160px] h-8 text-xs border-0", sc.bg, sc.text)}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="scheduled">Agendado</SelectItem>
                            <SelectItem value="confirmed">Confirmado</SelectItem>
                            <SelectItem value="completed">Realizado</SelectItem>
                            <SelectItem value="cancelled">Cancelado</SelectItem>
                            <SelectItem value="rescheduled">Remarcado</SelectItem>
                            <SelectItem value="no_show">Não compareceu</SelectItem>
                          </SelectContent>
                        </Select>
                        {appointment.notes && (
                          <p className="text-xs text-muted-foreground truncate flex-1">{appointment.notes}</p>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!editingAppointment} onOpenChange={(open) => { if (!open) { setEditingAppointment(null); resetForm(); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Agendamento</DialogTitle>
          </DialogHeader>
          <AppointmentForm onSubmit={handleEditAppointment} submitLabel="Salvar Alterações" />
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
