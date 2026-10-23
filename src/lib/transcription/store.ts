/**
 * Durable transcription store (IndexedDB).
 *
 * Filosofia durable-first: um chunk de áudio é persistido ANTES de ir para o
 * STT, e cada segmento transcrito é persistido ANTES de chegar ao editor.
 * Nada de conteúdo clínico depende do estado do React.
 *
 * Nenhum log técnico deste módulo contém conteúdo clínico.
 */

const DB_NAME = "psicoone-transcription";
const DB_VERSION = 1;

const S = {
  sessions: "sessions",
  chunks: "chunks",
  segments: "segments",
} as const;

export type ChunkStatus =
  | "captured"
  | "queued"
  | "processing"
  | "transcribed"
  | "failed_retryable"
  | "failed_permanent";

export type SessionStatus = "recording" | "paused" | "flushing" | "completed" | "abandoned";

export interface TranscriptionSessionRecord {
  id: string;
  context: "medical_record" | "telehealth";
  record_id?: string | null;
  patient_id?: string | null;
  patient_label?: string | null;
  status: SessionStatus;
  started_at: number;
  updated_at: number;
  completed_at?: number | null;
  duration_ms: number;
  chunk_count: number;
}

export interface TranscriptionChunkRecord {
  id: string;
  session_id: string;
  sequence: number;
  /** Áudio WAV em base64 — removido após transcrição confirmada */
  audio?: string | null;
  mime_type: string;
  duration_ms: number;
  status: ChunkStatus;
  retry_count: number;
  created_at: number;
  processed_at?: number | null;
  error_code?: string | null;
}

export interface TranscriptionSegmentRecord {
  /** `${session_id}:${sequence}` — idempotência por construção */
  id: string;
  session_id: string;
  sequence: number;
  text: string;
  created_at: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S.sessions)) {
        const store = db.createObjectStore(S.sessions, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
      }
      if (!db.objectStoreNames.contains(S.chunks)) {
        const store = db.createObjectStore(S.chunks, { keyPath: "id" });
        store.createIndex("session_id", "session_id", { unique: false });
      }
      if (!db.objectStoreNames.contains(S.segments)) {
        const store = db.createObjectStore(S.segments, { keyPath: "id" });
        store.createIndex("session_id", "session_id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest | null
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        let value: any;
        if (req) req.onsuccess = () => (value = req.result);
        t.oncomplete = () => resolve(value as T);
        t.onerror = () => reject(t.error);
      })
  );
}

function byIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const t = db.transaction(store, "readonly");
        const req = t.objectStore(store).index(index).getAll(key);
        req.onsuccess = () => resolve((req.result as T[]) || []);
        req.onerror = () => reject(req.error);
      })
  );
}

// ── Sessions ──

export const putSession = (s: TranscriptionSessionRecord) =>
  tx<void>(S.sessions, "readwrite", (st) => st.put(s));

export const getSession = (id: string) =>
  tx<TranscriptionSessionRecord | undefined>(S.sessions, "readonly", (st) => st.get(id));

export const getAllSessions = () =>
  tx<TranscriptionSessionRecord[]>(S.sessions, "readonly", (st) => st.getAll());

export async function patchSession(id: string, patch: Partial<TranscriptionSessionRecord>) {
  const current = await getSession(id);
  if (!current) return;
  await putSession({ ...current, ...patch, updated_at: Date.now() });
}

// ── Chunks ──

export const putChunk = (c: TranscriptionChunkRecord) =>
  tx<void>(S.chunks, "readwrite", (st) => st.put(c));

export const getChunk = (id: string) =>
  tx<TranscriptionChunkRecord | undefined>(S.chunks, "readonly", (st) => st.get(id));

export const getSessionChunks = (sessionId: string) =>
  byIndex<TranscriptionChunkRecord>(S.chunks, "session_id", sessionId);

export const deleteChunk = (id: string) =>
  tx<void>(S.chunks, "readwrite", (st) => st.delete(id));

/** Remove apenas o áudio, preservando o registro técnico (auditoria/telemetria). */
export async function dropChunkAudio(id: string) {
  const c = await getChunk(id);
  if (!c) return;
  await putChunk({ ...c, audio: null });
}

// ── Segments ──

export const putSegment = (s: TranscriptionSegmentRecord) =>
  tx<void>(S.segments, "readwrite", (st) => st.put(s));

export const getSessionSegments = (sessionId: string) =>
  byIndex<TranscriptionSegmentRecord>(S.segments, "session_id", sessionId);

// ── Housekeeping ──

/** Só apagar quando o texto já estiver confirmado no draft/backend. */
export async function purgeSession(sessionId: string) {
  const [chunks, segments] = await Promise.all([
    getSessionChunks(sessionId),
    getSessionSegments(sessionId),
  ]);
  await Promise.all([
    ...chunks.map((c) => deleteChunk(c.id)),
    ...segments.map((s) => tx<void>(S.segments, "readwrite", (st) => st.delete(s.id))),
    tx<void>(S.sessions, "readwrite", (st) => st.delete(sessionId)),
  ]);
}

/** Retenção: descarta áudio local de sessões concluídas há mais de N horas. */
export async function enforceRetention(maxAgeHours = 24) {
  const cutoff = Date.now() - maxAgeHours * 3600_000;
  const sessions = await getAllSessions();
  for (const s of sessions) {
    if (s.status === "completed" && (s.completed_at ?? s.updated_at) < cutoff) {
      await purgeSession(s.id);
    } else {
      const chunks = await getSessionChunks(s.id);
      for (const c of chunks) {
        if (c.audio && c.status === "transcribed") await dropChunkAudio(c.id);
      }
    }
  }
}

export interface RecoverableSession {
  session: TranscriptionSessionRecord;
  text: string;
  segmentCount: number;
  pendingChunks: number;
}

/** Sessões interrompidas (crash/reload) que ainda possuem conteúdo recuperável. */
export async function listRecoverableSessions(
  context: TranscriptionSessionRecord["context"],
  recordId?: string | null
): Promise<RecoverableSession[]> {
  const sessions = await getAllSessions();
  const out: RecoverableSession[] = [];
  for (const session of sessions) {
    if (session.context !== context) continue;
    if (session.status === "completed" || session.status === "abandoned") continue;
    if (recordId !== undefined && (session.record_id ?? null) !== (recordId ?? null)) continue;
    const [segments, chunks] = await Promise.all([
      getSessionSegments(session.id),
      getSessionChunks(session.id),
    ]);
    const pendingChunks = chunks.filter(
      (c) => c.audio && c.status !== "transcribed"
    ).length;
    const text = segments
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => s.text)
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!text && pendingChunks === 0) continue;
    out.push({ session, text, segmentCount: segments.length, pendingChunks });
  }
  return out.sort((a, b) => b.session.started_at - a.session.started_at);
}
