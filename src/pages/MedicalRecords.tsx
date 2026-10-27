import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useWriteGuard } from "@/components/subscription/WriteBlockedModal";
import { useSubscriptionGuard } from "@/hooks/useSubscriptionGuard";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PatientCombobox } from "@/components/shared/PatientCombobox";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { 
  Plus, FileText, Calendar, User, Search, Sparkles, Paperclip, 
  Download, Trash2, Upload, TrendingUp, Eye, Hash,
  SortAsc, SortDesc, CalendarDays, ExternalLink
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ActionMenu } from "@/components/ui/action-menu";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { StatsOverview } from "@/components/ui/stats-overview";
import { ProntuarioEditor } from "@/components/medical-records/ProntuarioEditor";
import { FilePreviewModal } from "@/components/medical-records/FilePreviewModal";
import { QuickPatientForm } from "@/components/medical-records/QuickPatientForm";
import { useAutosave } from "@/hooks/useAutosave";
import { AutosaveIndicator } from "@/components/medical-records/AutosaveIndicator";
import { useDraftRecovery } from "@/hooks/useDraftRecovery";
import { draftKeys, deleteDraft } from "@/lib/draft-engine";
import { DraftStatusIndicator } from "@/components/drafts/DraftStatusIndicator";
import { DraftRecoveryBanner } from "@/components/drafts/DraftRecoveryBanner";
import { VersionHistory } from "@/components/medical-records/VersionHistory";

interface MedicalRecord {
  id: string;
  patient_id: string;
  updated_at?: string | null;
  session_date: string;
  session_number: number | null;
  complaints: string | null;
  observations: string | null;
  techniques_used: string | null;
  evolution: string | null;
  next_steps: string | null;
  patients: {
    full_name: string;
  };
}

interface Attachment {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number;
  created_at: string;
}

interface Patient {
  id: string;
  full_name: string;
}

interface PendingFile {
  id: string;
  file: File;
  preview?: string;
}

interface PreviewFile {
  name: string;
  type: string;
  size: number;
  url: string;
  createdAt?: string;
}

interface RecordFormState {
  patient_id: string;
  session_date: string;
  session_number: number;
  complaints: string;
  observations: string;
  techniques_used: string;
  evolution: string;
  next_steps: string;
}

interface RecordDraftPayload {
  formData: RecordFormState;
  freeFormNotes: string;
  updatedAt: string;
}

// RecordFormContent is now the shared ProntuarioEditor component
// ===== Patient Record Folder (collapsible grouping) =====
interface PatientRecordFolderProps {
  patientId: string;
  patientName: string;
  records: MedicalRecord[];
  onView: (r: MedicalRecord) => void;
  onEdit: (r: MedicalRecord) => void;
  onDelete: (id: string) => void;
  onNavigate: () => void;
}

function PatientRecordFolder({ patientId, patientName, records, onView, onEdit, onDelete, onNavigate }: PatientRecordFolderProps) {
  const [open, setOpen] = useState(true);
  return (
    <Card className="overflow-hidden">
      <button
        className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
            <User className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">{patientName}</h3>
            <p className="text-xs text-muted-foreground">{records.length} prontuário(s)</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="text-xs gap-1" onClick={(e) => { e.stopPropagation(); onNavigate(); }}>
            <ExternalLink className="h-3 w-3" /> Perfil
          </Button>
          <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <SortDesc className="h-4 w-4 text-muted-foreground" />
          </motion.div>
        </div>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-2 border-t">
              {records.map(record => (
                <div key={record.id} className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => onView(record)}>
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 text-primary" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Sessão {record.session_number || "—"}</span>
                        <span className="text-xs text-muted-foreground">{format(new Date(record.session_date), "dd/MM/yyyy", { locale: ptBR })}</span>
                      </div>
                      {record.observations && <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{record.observations}</p>}
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <ActionMenu onEdit={() => onEdit(record)} onDelete={() => onDelete(record.id)} deleteTitle="Excluir" deleteDescription="Excluir este prontuário?" />
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

// ===== Main Component =====
const MedicalRecords = () => {
  const navigate = useNavigate();
  const { guardWrite } = useWriteGuard();
  const { checkSubscriptionBeforeWrite } = useSubscriptionGuard();
  const [records, setRecords] = useState<MedicalRecord[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<MedicalRecord | null>(null);
  const [editingRecord, setEditingRecord] = useState<MedicalRecord | null>(null);
  const [userId, setUserId] = useState<string>("");
  const [generatingAI, setGeneratingAI] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [freeFormNotes, setFreeFormNotes] = useState("");
  const NEW_DRAFT_POINTER_KEY = "draft:prontuario:last-new-key";
  const [quickPatientOpen, setQuickPatientOpen] = useState(false);
  const [newDraftTempId, setNewDraftTempId] = useState<string>(() => `temp-${Date.now()}`);
  const [lastCommittedSnapshot, setLastCommittedSnapshot] = useState<string>("");
  const [lastLocalDraftSavedAt, setLastLocalDraftSavedAt] = useState<Date | null>(null);
  const lastNewDraftKeyRef = useRef<string | null>(null);

  // New filter states
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [sortBy, setSortBy] = useState<"date" | "session">("date");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [formData, setFormData] = useState<RecordFormState>({
    patient_id: "",
    session_date: format(new Date(), "yyyy-MM-dd"),
    session_number: 1,
    complaints: "",
    observations: "",
    techniques_used: "",
    evolution: "",
    next_steps: ""
  });

  const currentEditorSnapshot = useMemo(
    () => JSON.stringify({ formData, freeFormNotes }),
    [formData, freeFormNotes],
  );

  const isDirty = useMemo(() => {
    const isEditorOpen = dialogOpen || !!editingRecord;
    if (!isEditorOpen || !lastCommittedSnapshot) return false;
    return currentEditorSnapshot !== lastCommittedSnapshot;
  }, [dialogOpen, editingRecord, currentEditorSnapshot, lastCommittedSnapshot]);

  const newDraftKey = useMemo(
    () => `draft:prontuario:${formData.patient_id || newDraftTempId}`,
    [formData.patient_id, newDraftTempId],
  );

  const saveDraftLocally = useCallback((key: string, payload: RecordDraftPayload) => {
    try {
      localStorage.setItem(key, JSON.stringify(payload));
      setLastLocalDraftSavedAt(new Date(payload.updatedAt));
    } catch {
      // ignore localStorage failures
    }
  }, []);

  const readDraftLocally = useCallback((key: string): RecordDraftPayload | null => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as RecordDraftPayload;
    } catch {
      return null;
    }
  }, []);

  const removeDraftLocally = useCallback((key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore localStorage failures
    }
  }, []);

  const markSnapshotCommitted = useCallback((nextSnapshot: string) => {
    setLastCommittedSnapshot(nextSnapshot);
  }, []);

  // FAB event
  useEffect(() => {
    const openNew = () => guardWrite(() => setDialogOpen(true));
    window.addEventListener("psicoone:new-record", openNew);
    return () => window.removeEventListener("psicoone:new-record", openNew);
  }, [guardWrite]);

  useEffect(() => {
    checkAuthAndLoadData();
  }, []);

  // Auto-calculate session number when patient changes (only for NEW records)
  const calculateNextSessionNumber = useCallback((patientId: string) => {
    if (!patientId) return 1;
    const patientRecords = records.filter(r => r.patient_id === patientId);
    const maxSession = Math.max(0, ...patientRecords.map(r => r.session_number || 0));
    return maxSession + 1;
  }, [records]);

  // Update session number when patient is selected — ONLY for new records, not editing
  useEffect(() => {
    if (formData.patient_id && !editingRecord) {
      const nextSession = calculateNextSessionNumber(formData.patient_id);
      setFormData(prev => ({ ...prev, session_number: nextSession }));
    }
  }, [formData.patient_id, calculateNextSessionNumber, editingRecord]);

  // ── Autosave: EDIT mode (saves to DB) ──
  const autosaveEditData = useMemo(() => {
    if (!editingRecord) return null;
    return { formData, freeFormNotes, recordId: editingRecord.id };
  }, [formData, freeFormNotes, editingRecord]);

  const handleAutosaveEdit = useCallback(async (data: any, signal: AbortSignal) => {
    if (!data?.recordId) return;

    const localPayload: RecordDraftPayload = {
      formData: data.formData,
      freeFormNotes: data.freeFormNotes || "",
      updatedAt: new Date().toISOString(),
    };
    saveDraftLocally(`draft:prontuario:${data.recordId}`, localPayload);

    const combinedObservations = data.freeFormNotes
      ? (data.formData.observations ? `${data.formData.observations}\n\n--- Anotações Livres ---\n${data.freeFormNotes}` : data.freeFormNotes)
      : data.formData.observations;

    const { error } = await supabase
      .from("medical_records")
      .update({
        patient_id: data.formData.patient_id,
        session_date: data.formData.session_date,
        session_number: data.formData.session_number,
        complaints: data.formData.complaints || null,
        observations: combinedObservations || null,
        techniques_used: data.formData.techniques_used || null,
        evolution: data.formData.evolution || null,
        next_steps: data.formData.next_steps || null,
      })
      .eq("id", data.recordId);

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (error) throw error;
  }, [saveDraftLocally]);

  const { status: autosaveEditStatus, save: triggerAutosaveEdit, lastSavedAt: editSavedAt } = useAutosave({
    data: autosaveEditData,
    onSave: handleAutosaveEdit,
    interval: 1500,
    enabled: !!editingRecord,
  });

  // ── Draft Engine (Zero Data Loss): cobre criação e edição ──
  const draftKey = useMemo(() => {
    if (editingRecord) return draftKeys.medicalRecordEdit(editingRecord.id);
    if (!dialogOpen || !userId) return null;
    return draftKeys.medicalRecordNew(formData.patient_id || "sem-paciente", userId);
  }, [editingRecord, dialogOpen, userId, formData.patient_id]);

  const draftData = useMemo(
    () => (draftKey ? { formData, freeFormNotes } : null),
    [draftKey, formData, freeFormNotes],
  );

  const patientLabel = useMemo(
    () => patients.find((p) => p.id === formData.patient_id)?.full_name || "Prontuário sem paciente",
    [patients, formData.patient_id],
  );

  const {
    status: draftStatus,
    isOnline: draftOnline,
    lastLocalAt: draftLocalAt,
    lastSyncedAt: draftSyncedAt,
    pendingDraft,
    checkForDraft,
    restore: restoreDraft,
    discard: discardDraft,
    commit: commitDraft,
    saveNow: saveDraftNow,
    setBaseline: setDraftBaseline,
  } = useDraftRecovery<{ formData: RecordFormState; freeFormNotes: string }>({
    draftKey,
    entityType: "medical_record",
    entityId: editingRecord?.id ?? formData.patient_id ?? null,
    userId,
    data: draftData,
    enabled: !!draftKey,
    label: patientLabel,
    savedAt: editingRecord?.updated_at ?? null,
  });

  // Ao selecionar o paciente, migra o rascunho temporário para a nova chave
  const prevDraftKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevDraftKeyRef.current;
    if (prev && draftKey && prev !== draftKey && !editingRecord) {
      void deleteDraft(prev);
    }
    prevDraftKeyRef.current = draftKey;
  }, [draftKey, editingRecord]);

  // Procura rascunho pendente ao abrir criação
  useEffect(() => {
    if (!dialogOpen && !editingRecord) return;
    void checkForDraft();
  }, [dialogOpen, editingRecord, checkForDraft]);

  useEffect(() => {
    if (autosaveEditStatus === "saved" && editingRecord) {
      markSnapshotCommitted(currentEditorSnapshot);
    }
  }, [autosaveEditStatus, editingRecord, currentEditorSnapshot, markSnapshotCommitted]);

  useEffect(() => {
    if ((draftStatus === "local" || draftStatus === "synced") && dialogOpen && !editingRecord) {
      markSnapshotCommitted(currentEditorSnapshot);
    }
  }, [draftStatus, dialogOpen, editingRecord, currentEditorSnapshot, markSnapshotCommitted]);

  useEffect(() => {
    if (!(dialogOpen || editingRecord) || !isDirty) return;

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dialogOpen, editingRecord, isDirty]);

  useEffect(() => {
    if (!(dialogOpen || editingRecord)) return;

    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      void saveDraftNow();
      if (editingRecord) void triggerAutosaveEdit();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [dialogOpen, editingRecord, triggerAutosaveEdit, saveDraftNow]);

  const autosaveStatus = autosaveEditStatus;
  const lastSavedAt = editSavedAt || lastLocalDraftSavedAt;

  const checkAuthAndLoadData = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    setUserId(session.user.id);
    await Promise.all([loadRecords(session.user.id), loadPatients()]);
    setLoading(false);
  };

  const loadRecords = async (psychologistId: string) => {
    const { data, error } = await supabase
      .from("medical_records")
      .select(`*, patients (full_name)`)
      .eq("psychologist_id", psychologistId)
      .is("deleted_at", null)
      .order("session_date", { ascending: false });

    if (error) {
      toast.error("Erro ao carregar prontuários");
      return;
    }
    setRecords(data || []);
  };

  const loadPatients = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setPatients([]); return; }
    const { data, error } = await supabase
      .from("patients")
      .select("id, full_name")
      .eq("psychologist_id", session.user.id)
      .is("deleted_at", null)
      .eq("status", "active")
      .order("full_name");

    if (error) {
      toast.error("Erro ao carregar pacientes");
      return;
    }
    setPatients(data || []);
  };

  const loadAttachments = async (recordId: string) => {
    const { data, error } = await supabase
      .from("medical_record_attachments")
      .select("*")
      .eq("medical_record_id", recordId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading attachments:", error);
      return;
    }
    setAttachments(data || []);
  };

  const generateWithAI = useCallback(async () => {
    if (!formData.patient_id) {
      toast.error("Selecione um paciente primeiro");
      return;
    }

    const patient = patients.find(p => p.id === formData.patient_id);
    if (!patient) return;

    setGeneratingAI(true);

    try {
      const { data, error } = await supabase.functions.invoke('generate-medical-record', {
        body: {
          complaints: formData.complaints,
          observations: formData.observations,
          techniques_used: formData.techniques_used,
          evolution: formData.evolution,
          patient_name: patient.full_name,
          free_notes: freeFormNotes
        }
      });

      if (error) throw error;

      setFormData(prev => ({
        ...prev,
        complaints: data.complaints || prev.complaints,
        observations: data.observations || prev.observations,
        techniques_used: data.techniques_used || prev.techniques_used,
        evolution: data.evolution || prev.evolution,
        next_steps: data.next_steps || prev.next_steps
      }));

      toast.success("Prontuário gerado com IA!");
    } catch (error) {
      console.error('Error generating with AI:', error);
      toast.error("Erro ao gerar com IA");
    } finally {
      setGeneratingAI(false);
    }
  }, [formData, patients, freeFormNotes]);

  const uploadPendingFiles = async (recordId: string) => {
    for (const pf of pendingFiles) {
      const filePath = `${userId}/${recordId}/${Date.now()}_${pf.file.name}`;

      const { error: uploadError } = await supabase.storage
        .from("medical-attachments")
        .upload(filePath, pf.file);

      if (uploadError) {
        console.error("Upload error:", uploadError);
        continue;
      }

      await supabase
        .from("medical_record_attachments")
        .insert({
          medical_record_id: recordId,
          file_name: pf.file.name,
          file_path: filePath,
          file_type: pf.file.type,
          file_size: pf.file.size,
          uploaded_by: userId
        });

      if (pf.preview) {
        URL.revokeObjectURL(pf.preview);
      }
    }
  };

  const handleCreateRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.patient_id) {
      toast.error("Selecione um paciente");
      return;
    }
    // Server-side subscription check before write
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setDialogOpen(false); return; }

    const combinedObservations = freeFormNotes 
      ? (formData.observations ? `${formData.observations}\n\n--- Anotações Livres ---\n${freeFormNotes}` : freeFormNotes)
      : formData.observations;

    const { data: newRecord, error } = await supabase
      .from("medical_records")
      .insert({
        patient_id: formData.patient_id,
        psychologist_id: userId,
        session_date: formData.session_date,
        session_number: formData.session_number,
        complaints: formData.complaints || null,
        observations: combinedObservations || null,
        techniques_used: formData.techniques_used || null,
        evolution: formData.evolution || null,
        next_steps: formData.next_steps || null
      })
      .select()
      .single();

    if (error) {
      toast.error("Erro ao criar prontuário");
      return;
    }

    if (pendingFiles.length > 0 && newRecord) {
      await uploadPendingFiles(newRecord.id);
    }

    toast.success("Prontuário criado com sucesso!");
    await commitDraft();
    setDialogOpen(false);
    setNewDraftTempId(`temp-${Date.now()}`);
    resetForm();
    await loadRecords(userId);
  };

  const handleEditRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRecord) return;
    // Server-side subscription check before write
    const canProceed = await checkSubscriptionBeforeWrite();
    if (!canProceed) { setEditingRecord(null); return; }

    const combinedObservations = freeFormNotes 
      ? (formData.observations ? `${formData.observations}\n\n--- Anotações Livres ---\n${freeFormNotes}` : freeFormNotes)
      : formData.observations;

    const updatePayload = {
      patient_id: formData.patient_id,
      session_date: formData.session_date,
      session_number: formData.session_number,
      complaints: formData.complaints || null,
      observations: combinedObservations || null,
      techniques_used: formData.techniques_used || null,
      evolution: formData.evolution || null,
      next_steps: formData.next_steps || null,
    };

    const { error } = await supabase
      .from("medical_records")
      .update(updatePayload)
      .eq("id", editingRecord.id);

    if (error) {
      toast.error("Erro ao atualizar prontuário");
      return;
    }

    // Snapshot version after successful save
    try {
      const { data: sess } = await supabase.auth.getSession();
      if (sess?.session) {
        const { data: last } = await supabase
          .from("medical_record_versions" as any)
          .select("version_number")
          .eq("record_id", editingRecord.id)
          .order("version_number", { ascending: false })
          .limit(1)
          .maybeSingle();
        const next = ((last as any)?.version_number ?? 0) + 1;
        await supabase.from("medical_record_versions" as any).insert({
          record_id: editingRecord.id,
          version_number: next,
          content: updatePayload,
          created_by: sess.session.user.id,
          change_reason: "Edição manual",
        });
      }
    } catch (e) {
      console.warn("[version snapshot]", e);
    }

    if (pendingFiles.length > 0) {
      await uploadPendingFiles(editingRecord.id);
    }

    toast.success("Prontuário atualizado com sucesso!");
    await commitDraft();
    setEditingRecord(null);
    resetForm();
    await loadRecords(userId);
  };

  const handleDeleteRecord = async (recordId: string) => {
    guardWrite(() => {
      (async () => {
        const { error } = await supabase
          .from("medical_records")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: userId,
            deleted_reason: "Excluído pelo usuário",
          })
          .eq("id", recordId);

        if (error) {
          toast.error("Erro ao excluir prontuário");
          return;
        }

        await supabase.from("audit_logs").insert({
          user_id: userId,
          action_type: "soft_delete",
          entity_type: "medical_record",
          entity_id: recordId,
        } as any);

        toast.success("Prontuário excluído com sucesso!");
        setViewDialogOpen(false);
        setSelectedRecord(null);
        await loadRecords(userId);
      })();
    });
  };

  const openEditDialog = (record: MedicalRecord) => {
    guardWrite(() => {
      const obsContent = record.observations || "";
      const freeNotesMarker = "--- Anotações Livres ---";
      const markerIndex = obsContent.indexOf(freeNotesMarker);

      let observations = "";
      let freeNotes = "";

      if (markerIndex !== -1) {
        observations = obsContent.substring(0, markerIndex).trim();
        freeNotes = obsContent.substring(markerIndex + freeNotesMarker.length).trim();
      } else {
        freeNotes = obsContent;
      }

      setDialogOpen(false);
      setViewDialogOpen(false);

      const baseFormData: RecordFormState = {
        patient_id: record.patient_id,
        session_date: record.session_date,
        session_number: record.session_number || 1,
        complaints: record.complaints || "",
        observations: observations,
        techniques_used: record.techniques_used || "",
        evolution: record.evolution || "",
        next_steps: record.next_steps || ""
      };

      const editKey = `draft:prontuario:${record.id}`;
      const localDraft = readDraftLocally(editKey);
      const localDraftTs = localDraft?.updatedAt ? new Date(localDraft.updatedAt).getTime() : 0;
      const dbTs = record.updated_at ? new Date(record.updated_at).getTime() : 0;
      const localIsNewer = !!localDraft && localDraftTs > dbTs;

      const shouldRecoverLocal = localIsNewer
        ? window.confirm("📝 Rascunho local mais recente encontrado\n\nDeseja recuperar o conteúdo não sincronizado?")
        : false;

      const effectiveFormData = shouldRecoverLocal && localDraft ? localDraft.formData : baseFormData;
      const effectiveNotes = shouldRecoverLocal && localDraft ? localDraft.freeFormNotes || "" : freeNotes;

      if (!shouldRecoverLocal && localIsNewer) {
        removeDraftLocally(editKey);
      }

      setEditingRecord(record);
      setFormData(effectiveFormData);
      setFreeFormNotes(effectiveNotes);
      setPendingFiles([]);
      markSnapshotCommitted(JSON.stringify({ formData: effectiveFormData, freeFormNotes: effectiveNotes }));
    });
  };

  const resetForm = () => {
    setFormData({
      patient_id: "",
      session_date: format(new Date(), "yyyy-MM-dd"),
      session_number: 1,
      complaints: "",
      observations: "",
      techniques_used: "",
      evolution: "",
      next_steps: ""
    });
    setFreeFormNotes("");
    setPendingFiles([]);
    setLastCommittedSnapshot("");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedRecord || !e.target.files?.[0]) return;

    const file = e.target.files[0];
    const maxSize = 10 * 1024 * 1024;

    if (file.size > maxSize) {
      toast.error("Arquivo muito grande. Máximo 10MB.");
      return;
    }

    setUploadingFile(true);

    try {
      const filePath = `${userId}/${selectedRecord.id}/${Date.now()}_${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from("medical-attachments")
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { error: dbError } = await supabase
        .from("medical_record_attachments")
        .insert({
          medical_record_id: selectedRecord.id,
          file_name: file.name,
          file_path: filePath,
          file_type: file.type,
          file_size: file.size,
          uploaded_by: userId
        });

      if (dbError) throw dbError;

      toast.success("Arquivo anexado com sucesso!");
      await loadAttachments(selectedRecord.id);
    } catch (error) {
      console.error("Upload error:", error);
      toast.error("Erro ao anexar arquivo");
    } finally {
      setUploadingFile(false);
    }
  };

  const handlePreviewAttachment = async (attachment: Attachment) => {
    setPreviewFile({
      name: attachment.file_name,
      type: attachment.file_type,
      size: attachment.file_size,
      url: '',
      createdAt: attachment.created_at
    });
    setPreviewOpen(true);

    try {
      const { data: signedData, error: signedError } = await supabase.storage
        .from("medical-attachments")
        .createSignedUrl(attachment.file_path, 3600);

      if (!signedError && signedData?.signedUrl) {
        setPreviewFile(prev => prev ? { ...prev, url: signedData.signedUrl } : null);
        return;
      }

      const { data, error } = await supabase.storage
        .from("medical-attachments")
        .download(attachment.file_path);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      setPreviewFile(prev => prev ? { ...prev, url } : null);
    } catch (error) {
      console.error("Preview error:", error);
      setPreviewOpen(false);
      setPreviewFile(null);
      toast.error("Erro ao carregar arquivo. Tente baixar o arquivo.");
    }
  };

  const handlePreviewPendingFile = useCallback((pf: PendingFile) => {
    const url = pf.preview || URL.createObjectURL(pf.file);
    setPreviewFile({
      name: pf.file.name,
      type: pf.file.type,
      size: pf.file.size,
      url
    });
    setPreviewOpen(true);
  }, []);

  const handleDownloadAttachment = async (attachment: Attachment) => {
    try {
      const { data, error } = await supabase.storage
        .from("medical-attachments")
        .download(attachment.file_path);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.file_name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error("Erro ao baixar arquivo");
    }
  };

  const handleDeleteAttachment = async (attachment: Attachment) => {
    try {
      const { error: storageError } = await supabase.storage
        .from("medical-attachments")
        .remove([attachment.file_path]);

      if (storageError) throw storageError;

      const { data: deleted, error: deleteError } = await supabase
        .from("medical_record_attachments")
        .delete()
        .eq("id", attachment.id)
        .select("id");

      if (deleteError || !deleted?.length) {
        toast.error("O arquivo foi removido, mas o registro do anexo não foi atualizado. Tente novamente.");
        return;
      }

      toast.success("Arquivo excluído!");
      if (selectedRecord) {
        await loadAttachments(selectedRecord.id);
      }
    } catch (error) {
      toast.error("Erro ao excluir arquivo");
    }
  };

  const openViewDialog = async (record: MedicalRecord) => {
    setSelectedRecord(record);
    setViewDialogOpen(true);
    await loadAttachments(record.id);
  };

  // Enhanced filtering with date range and sorting
  const filteredRecords = useMemo(() => {
    let result = records.filter(record => {
      const matchesSearch = record.patients.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           record.complaints?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesPatient = selectedPatient === "all" || record.patient_id === selectedPatient;

      // Date range filter
      let matchesDate = true;
      if (dateFrom) {
        matchesDate = matchesDate && record.session_date >= dateFrom;
      }
      if (dateTo) {
        matchesDate = matchesDate && record.session_date <= dateTo;
      }

      return matchesSearch && matchesPatient && matchesDate;
    });

    // Sort
    result.sort((a, b) => {
      if (sortBy === "date") {
        const cmp = a.session_date.localeCompare(b.session_date);
        return sortOrder === "asc" ? cmp : -cmp;
      } else {
        const aNum = a.session_number || 0;
        const bNum = b.session_number || 0;
        return sortOrder === "asc" ? aNum - bNum : bNum - aNum;
      }
    });

    return result;
  }, [records, searchTerm, selectedPatient, dateFrom, dateTo, sortBy, sortOrder]);

  // Stats calculations
  const recordStats = useMemo(() => {
    const thisMonth = new Date();
    const monthRecords = records.filter(r => {
      const d = new Date(r.session_date);
      return d.getMonth() === thisMonth.getMonth() && d.getFullYear() === thisMonth.getFullYear();
    });
    const uniquePatients = new Set(records.map(r => r.patient_id)).size;
    return {
      total: records.length,
      thisMonth: monthRecords.length,
      uniquePatients,
      avgSessions: uniquePatients > 0 ? Math.round(records.length / uniquePatients) : 0,
    };
  }, [records]);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const handleQuickPatientCreated = useCallback((patient: { id: string; full_name: string }) => {
    setPatients(prev => [...prev, patient].sort((a, b) => a.full_name.localeCompare(b.full_name)));
    setFormData(prev => ({ ...prev, patient_id: patient.id }));
  }, []);

  const openQuickPatient = useCallback(() => {
    setQuickPatientOpen(true);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-primary">Carregando...</div>
      </div>
    );
  }

  return (
    <AppLayout title="Prontuários Clínicos" description="Registros flexíveis com anexos e pré-visualização">
      {/* Stats Overview */}
      <StatsOverview
        stats={[
          { label: "Total de Prontuários", value: recordStats.total, icon: FileText, color: "blue", change: 15 },
          { label: "Registros este Mês", value: recordStats.thisMonth, icon: Calendar, color: "purple", change: 8 },
          { label: "Pacientes Atendidos", value: recordStats.uniquePatients, icon: User, color: "green", change: 12 },
          { label: "Média de Sessões", value: recordStats.avgSessions, icon: TrendingUp, color: "amber" },
        ]}
        className="mb-6"
      />

      {/* Filters Bar */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar prontuários..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 w-[250px]"
              />
            </div>
            <div className="w-[220px]">
              <PatientCombobox
                patients={patients}
                value={selectedPatient}
                onChange={setSelectedPatient}
                allowAll
                allLabel="Todos os pacientes"
                placeholder="Filtrar paciente"
              />
            </div>

          </div>
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            if (open) {
              guardWrite(() => {
                const defaultForm: RecordFormState = {
                  patient_id: "",
                  session_date: format(new Date(), "yyyy-MM-dd"),
                  session_number: 1,
                  complaints: "",
                  observations: "",
                  techniques_used: "",
                  evolution: "",
                  next_steps: "",
                };
                setNewDraftTempId(`temp-${Date.now()}`);
                setFormData(defaultForm);
                setFreeFormNotes("");
                markSnapshotCommitted(JSON.stringify({ formData: defaultForm, freeFormNotes: "" }));
                setDialogOpen(true);
              });
            } else {
              if (isDirty) {
                const leaveAnyway = window.confirm("⚠️ Você possui alterações não salvas.\n\nSair mesmo assim?");
                if (!leaveAnyway) return;
              }
              void saveDraftNow();
              setDialogOpen(false);
              resetForm();
            }
          }}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Novo Prontuário
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <div className="flex items-center justify-between">
                  <DialogTitle>Novo Registro de Sessão</DialogTitle>
                  <DraftStatusIndicator
                    status={draftStatus}
                    isOnline={draftOnline}
                    lastLocalAt={draftLocalAt}
                    lastSyncedAt={draftSyncedAt}
                  />
                </div>
              </DialogHeader>
              {pendingDraft && (
                <DraftRecoveryBanner
                  draft={pendingDraft}
                  savedData={{ formData, freeFormNotes }}
                  onRestore={() =>
                    restoreDraft((payload) => {
                      if (payload?.formData) setFormData(payload.formData);
                      setFreeFormNotes(payload?.freeFormNotes || "");
                    })
                  }
                  onDiscard={() => void discardDraft()}
                />
              )}
              <form
                onSubmit={handleCreateRecord}
                onBlurCapture={() => {
                  void saveDraftNow();
                }}
              >
                <ProntuarioEditor
                  formData={formData}
                  setFormData={setFormData}
                  freeFormNotes={freeFormNotes}
                  setFreeFormNotes={setFreeFormNotes}
                  patients={patients}
                  pendingFiles={pendingFiles}
                  setPendingFiles={setPendingFiles}
                  onPreviewPendingFile={handlePreviewPendingFile}
                  generatingAI={generatingAI}
                  onGenerateAI={generateWithAI}
                  onOpenQuickPatient={openQuickPatient}
                />
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Date range filters and sort */}
        <div className="flex flex-wrap gap-3 items-center bg-card border border-border rounded-lg p-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Período:</span>
          </div>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-[150px] h-9"
            placeholder="De"
          />
          <span className="text-muted-foreground text-sm">até</span>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-[150px] h-9"
            placeholder="Até"
          />
          {(dateFrom || dateTo) && (
            <Button variant="ghost" size="sm" onClick={() => { setDateFrom(""); setDateTo(""); }}>
              Limpar
            </Button>
          )}
          <Separator orientation="vertical" className="h-6 hidden sm:block" />
          <div className="flex items-center gap-2">
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as "date" | "session")}>
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Ordenar por Data</SelectItem>
                <SelectItem value="session">Ordenar por Sessão</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setSortOrder(prev => prev === "asc" ? "desc" : "asc")}
            >
              {sortOrder === "asc" ? <SortAsc className="h-4 w-4" /> : <SortDesc className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Records List — grouped by patient */}
      <div className="space-y-4">
        {filteredRecords.length === 0 ? (
          <div className="text-center py-12 bg-card border border-border rounded-lg">
            <FileText className="h-16 w-16 text-muted-foreground mx-auto mb-4 opacity-50" />
            <p className="text-muted-foreground">Nenhum prontuário encontrado</p>
          </div>
        ) : selectedPatient !== "all" ? (
          // Flat list when a specific patient is filtered
          <>
            <p className="text-sm text-muted-foreground">
              {filteredRecords.length} prontuário{filteredRecords.length !== 1 ? "s" : ""} encontrado{filteredRecords.length !== 1 ? "s" : ""}
            </p>
            <div className="grid gap-4">
              {filteredRecords.map(record => (
                <motion.div key={record.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                  <Card className="hover:border-primary/50 transition-colors">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className="space-y-1 cursor-pointer flex-1" onClick={() => openViewDialog(record)}>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              <span>{format(new Date(record.session_date), "dd/MM/yyyy", { locale: ptBR })}</span>
                            </div>
                            <Badge variant="outline"><Hash className="h-3 w-3 mr-1" />Sessão {record.session_number || 1}</Badge>
                          </div>
                        </div>
                        <ActionMenu onEdit={() => openEditDialog(record)} onDelete={() => handleDeleteRecord(record.id)} deleteTitle="Excluir Prontuário" deleteDescription="Tem certeza que deseja excluir este prontuário?" />
                      </div>
                      <div className="cursor-pointer" onClick={() => openViewDialog(record)}>
                        {record.observations && <p className="text-sm text-muted-foreground line-clamp-2">{record.observations}</p>}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </>
        ) : (
          // Grouped by patient (collapsible folders)
          <>
            <p className="text-sm text-muted-foreground">
              {filteredRecords.length} prontuário{filteredRecords.length !== 1 ? "s" : ""} • {Object.keys(
                filteredRecords.reduce((acc, r) => { acc[r.patient_id] = true; return acc; }, {} as Record<string, boolean>)
              ).length} paciente(s)
            </p>
            <div className="space-y-3">
              {(() => {
                const grouped: Record<string, { name: string; records: typeof filteredRecords }> = {};
                filteredRecords.forEach(r => {
                  if (!grouped[r.patient_id]) grouped[r.patient_id] = { name: r.patients.full_name, records: [] };
                  grouped[r.patient_id].records.push(r);
                });
                return Object.entries(grouped).map(([patientId, group]) => (
                  <PatientRecordFolder
                    key={patientId}
                    patientId={patientId}
                    patientName={group.name}
                    records={group.records}
                    onView={openViewDialog}
                    onEdit={openEditDialog}
                    onDelete={handleDeleteRecord}
                    onNavigate={() => navigate(`/pacientes/${patientId}`)}
                  />
                ));
              })()}
            </div>
          </>
        )}
      </div>

      {/* View Dialog with Attachments */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle>Detalhes do Prontuário</DialogTitle>
              {selectedRecord && (
                <VersionHistory
                  recordId={selectedRecord.id}
                  onRestored={() => { loadRecords(userId); setViewDialogOpen(false); }}
                />
              )}
            </div>
          </DialogHeader>
          {selectedRecord && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 pb-4 border-b border-border">
                <div>
                  <p className="text-sm text-muted-foreground">Paciente</p>
                  <p className="font-semibold">{selectedRecord.patients.full_name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Data da Sessão</p>
                  <p className="font-semibold">{format(new Date(selectedRecord.session_date), "dd/MM/yyyy")}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Número da Sessão</p>
                  <p className="font-semibold">#{selectedRecord.session_number || 1}</p>
                </div>
              </div>

              {selectedRecord.observations && (
                <div>
                  <h4 className="font-semibold text-foreground mb-2">Anotações da Sessão</h4>
                  <p className="text-muted-foreground whitespace-pre-wrap">{selectedRecord.observations}</p>
                </div>
              )}

              {selectedRecord.complaints && (
                <div>
                  <h4 className="font-semibold text-foreground mb-2">Queixas Apresentadas</h4>
                  <p className="text-muted-foreground">{selectedRecord.complaints}</p>
                </div>
              )}

              {selectedRecord.techniques_used && (
                <div>
                  <h4 className="font-semibold text-foreground mb-2">Técnicas Utilizadas</h4>
                  <p className="text-muted-foreground whitespace-pre-wrap">{selectedRecord.techniques_used}</p>
                </div>
              )}

              {selectedRecord.evolution && (
                <div>
                  <h4 className="font-semibold text-foreground mb-2">Evolução do Tratamento</h4>
                  <p className="text-muted-foreground">{selectedRecord.evolution}</p>
                </div>
              )}

              {selectedRecord.next_steps && (
                <div>
                  <h4 className="font-semibold text-foreground mb-2">Próximos Passos</h4>
                  <p className="text-muted-foreground">{selectedRecord.next_steps}</p>
                </div>
              )}

              {/* Attachments Section */}
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-semibold text-foreground flex items-center gap-2">
                    <Paperclip className="h-4 w-4" />
                    Anexos ({attachments.length})
                  </h4>
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      onChange={handleFileUpload}
                      disabled={uploadingFile}
                    />
                    <Button type="button" variant="outline" size="sm" className="gap-2" asChild>
                      <span>
                        <Upload className="h-4 w-4" />
                        {uploadingFile ? "Enviando..." : "Anexar Arquivo"}
                      </span>
                    </Button>
                  </label>
                </div>

                {attachments.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Nenhum anexo neste prontuário
                  </p>
                ) : (
                  <div className="space-y-2">
                    {attachments.map(attachment => (
                      <div key={attachment.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                        <div 
                          className="flex items-center gap-3 cursor-pointer flex-1"
                          onClick={() => handlePreviewAttachment(attachment)}
                        >
                          <FileText className="h-5 w-5 text-primary" />
                          <div>
                            <p className="font-medium text-sm hover:underline">{attachment.file_name}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatFileSize(attachment.file_size)} • {format(new Date(attachment.created_at), "dd/MM/yyyy HH:mm")}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => handlePreviewAttachment(attachment)} title="Visualizar">
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDownloadAttachment(attachment)} title="Baixar">
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => handleDeleteAttachment(attachment)}
                            title="Excluir"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingRecord} onOpenChange={(open) => { 
        if (!open) { 
          if (isDirty) {
            const leaveAnyway = window.confirm("⚠️ Você possui alterações não salvas.\n\nSair mesmo assim?");
            if (!leaveAnyway) return;
          }
          void triggerAutosaveEdit();
          setEditingRecord(null); 
          resetForm(); 
        } 
      }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle>Editar Prontuário</DialogTitle>
              <div className="flex flex-col items-end gap-1">
                <AutosaveIndicator status={autosaveEditStatus} lastSavedAt={editSavedAt || lastLocalDraftSavedAt} />
                <DraftStatusIndicator
                  status={draftStatus}
                  isOnline={draftOnline}
                  lastLocalAt={draftLocalAt}
                  lastSyncedAt={draftSyncedAt}
                />
              </div>
            </div>
          </DialogHeader>
          {pendingDraft && (
            <DraftRecoveryBanner
              draft={pendingDraft}
              savedData={{ formData, freeFormNotes }}
              onRestore={() =>
                restoreDraft((payload) => {
                  if (payload?.formData) setFormData(payload.formData);
                  setFreeFormNotes(payload?.freeFormNotes || "");
                })
              }
              onDiscard={() => void discardDraft()}
            />
          )}
          <form
            onSubmit={handleEditRecord}
            onBlurCapture={() => {
              void saveDraftNow();
              void triggerAutosaveEdit();
            }}
          >
            <ProntuarioEditor
              formData={formData}
              setFormData={setFormData}
              freeFormNotes={freeFormNotes}
              setFreeFormNotes={setFreeFormNotes}
              patients={patients}
              pendingFiles={pendingFiles}
              setPendingFiles={setPendingFiles}
              onPreviewPendingFile={handlePreviewPendingFile}
              generatingAI={generatingAI}
              onGenerateAI={generateWithAI}
              isEdit
              onOpenQuickPatient={openQuickPatient}
            />
          </form>
        </DialogContent>
      </Dialog>

      {/* Quick Patient Form */}
      <QuickPatientForm
        open={quickPatientOpen}
        onOpenChange={setQuickPatientOpen}
        onPatientCreated={handleQuickPatientCreated}
      />

      {/* File Preview Modal */}
      <FilePreviewModal
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open && previewFile) {
            URL.revokeObjectURL(previewFile.url);
            setPreviewFile(null);
          }
        }}
        file={previewFile}
        onDownload={() => {
          if (previewFile) {
            const a = document.createElement("a");
            a.href = previewFile.url;
            a.download = previewFile.name;
            a.click();
          }
        }}
      />
    </AppLayout>
  );
};

export default MedicalRecords;
