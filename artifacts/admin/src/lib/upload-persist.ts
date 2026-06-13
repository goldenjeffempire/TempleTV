/**
 * IndexedDB-backed upload session persistence.
 *
 * Persists in-progress upload sessions so they survive a page reload,
 * browser restart, or accidental tab close.  The server preserves session
 * state for 48 h after the last chunk; a client that reloads within that
 * window can query GET /upload/:sessionId/status, skip already-confirmed
 * chunks, and resume exactly where it left off.
 *
 * File objects (including File subclass properties — name, type,
 * lastModified) are stored directly via IndexedDB's structured-clone
 * algorithm.  fileName and fileMime are also stored redundantly so a plain
 * Blob (returned by older Safari / Firefox versions) can be reconstructed
 * into a proper File on restore.
 *
 * Lifecycle
 * ─────────
 *   enqueue  → persistUploadSession()
 *   retry    → updatePersistedSession()   (new sessionId assigned)
 *   complete / cancel / dismiss → removePersistedSession()
 *   clearAll → clearAllPersistedSessions()
 *   page load → loadPersistedSessions()  (restore as paused items)
 */

const DB_NAME = "ttv-upload-queue";
const STORE_NAME = "sessions";
const DB_VERSION = 1;

export interface PersistedUploadSession {
  /** Queue-local UUID — stable across retries and reloads. */
  id: string;
  /** Server upload session UUID — changes on normal retry. */
  sessionId: string;
  /** Stored via structured clone; may come back as Blob on older browsers. */
  file: File;
  /** Redundant — used to reconstruct a File when the IDB returns a plain Blob. */
  fileName: string;
  fileMime: string;
  title: string;
  description: string;
  category: string;
  preacher: string;
  featured: boolean;
  /**
   * When false (default on old records) the video is broadcast-only and hidden
   * from the public library. When true it will be visible in the catalog
   * immediately after upload finishes. Optional for backward compat with IDB
   * records written before this field was added — treated as true (broadcast
   * only) when absent.
   */
  broadcastOnly?: boolean;
  addedAt: number;
  priority: number;
  /**
   * When true all chunks are already on the server — resume skips chunk
   * upload and calls /finalize directly on the same sessionId.
   */
  finalizeOnly: boolean;
  /**
   * When true the user explicitly paused this upload; auto-resume should
   * leave it alone.  When false (or absent — old IDB records), the upload
   * was interrupted by a page refresh, browser close, network drop, or auth
   * expiry and will be auto-resumed the next time auth is confirmed.
   */
  wasUserPaused: boolean;
  /**
   * Progress percentage (0–100) at the time the item was paused or the page
   * was refreshed.  Restored on load so the progress bar shows the last
   * known position rather than jumping back to 0 %.
   */
  progressPercent?: number;
}

// ── DB singleton ──────────────────────────────────────────────────────────────

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null; // allow retry on next call
      reject(req.error);
    };
    req.onblocked = () => {
      _dbPromise = null;
      reject(new Error("IndexedDB open blocked"));
    };
  });
  return _dbPromise;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function persistUploadSession(session: PersistedUploadSession): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updatePersistedSession(
  id: string,
  patch: Partial<Pick<PersistedUploadSession, "sessionId" | "finalizeOnly" | "wasUserPaused" | "progressPercent">>,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      const existing = req.result as PersistedUploadSession | undefined;
      if (!existing) { resolve(); return; }
      const putReq = store.put({ ...existing, ...patch });
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function removePersistedSession(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllPersistedSessions(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPersistedSessions(): Promise<PersistedUploadSession[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as PersistedUploadSession[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}
