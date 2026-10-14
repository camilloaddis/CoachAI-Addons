import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { transaction } from "./database.js";
import {
  normalizeLibraryWorkout,
  type NormalizedWorkout,
  type NormalizationIssue,
  type NormalizationWarning,
} from "../coach/workout-normalizer.js";

export type CachedWorkout = {
  accountId: string;
  workoutId: number;
  folderId: number | null;
  name: string;
  sport: string;
  metadata: { target: string | null; targets: string[] | null; indoor: boolean | null; trainingLoad?: number | null; trainingLoadSource?: 'intervals.icu_training_load'; normalizationWarnings?: NormalizationWarning[] };
  original: Record<string, unknown>;
  originalComplete: boolean;
  normalized: NormalizedWorkout | null;
  durationSeconds: number | null;
  peakPowerPercentFtp: number | null;
  normalizerVersion: string;
  compatible: boolean;
  exclusionReasons: NormalizationIssue[];
  contentHash: string;
  sourceUpdatedAt: string | null;
  lastSyncedAt: string;
  available: boolean;
};
export type SyncErrorCode = "validation_failed" | "database_failed" | "interrupted" | "provider_unavailable";
export type LibrarySyncState = {
  accountId: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  status: "complete" | "incomplete" | "error";
  lastErrorCode: SyncErrorCode | "incomplete_enumeration" | null;
  lastCompleteCount: number | null;
  generation: number;
};
export type Enumeration =
  | { complete: true; expectedCount: number }
  | { complete: false; expectedCount?: number };
export class WorkoutLibraryError extends Error {
  constructor(public readonly code: "invalid_account" | "invalid_workout" | "invalid_enumeration" | "database_failed") {
    super(code);
  }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (): never => { throw new WorkoutLibraryError("invalid_workout"); };
function account(value: string) {
  // Identity comes from the configured athlete ID, never the API credential.
  if (typeof value !== "string" || !/^i?[1-9]\d{0,19}$/.test(value)) throw new WorkoutLibraryError("invalid_account");
  return "i" + value.replace(/^i/, "");
}
function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) return invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid();
  return value
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "[redacted-url]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]+/gi, "[redacted]")
    .replace(/(?:authorization|api[_ -]?key|(?:access[_ -]?)?token|shareToken|password|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[redacted]");
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return invalid();
}

/** Local repository only: constructing it never opens databases or starts workers. */
export function workoutLibraryRepository(db: DatabaseSync, clock: () => Date = () => new Date()) {
  function prepare(input: unknown, accountId: string, at: string): CachedWorkout {
    if (!object(input)) return invalid();
    if (input.athlete_id !== undefined && (typeof input.athlete_id !== "string" || account(input.athlete_id) !== accountId)) return invalid();
    const workoutId = id(input.id);
    const folderId = input.folder_id === undefined || input.folder_id === null ? null : id(input.folder_id);
    const name = text(input.name, 300), sport = text(input.type, 100);
    let updated: string | null = null;
    if (input.updated !== undefined && input.updated !== null) {
      if (typeof input.updated !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.updated) || !Number.isFinite(Date.parse(input.updated))) return invalid();
      updated = new Date(input.updated).toISOString();
    }
    // Enforce bounded JSON before any recursive hashing or sanitization.
    let raw: Record<string, unknown>;
    try {
      const encoded = JSON.stringify(input);
      if (Buffer.byteLength(encoded) > 1_048_576) return invalid();
      raw = JSON.parse(encoded);
    } catch { return invalid(); }
    const normalization = normalizeLibraryWorkout(raw);
    let complete = true, nodes = 0;
    const stepFields = new Set(["duration", "distance", "reps", "ramp", "text", "steps", "power", "cadence"]);
    function safeSteps(value: unknown, depth = 0): unknown {
      if (depth > 16 || ++nodes > 2000) { complete = false; return null; }
      if (!Array.isArray(value)) { complete = false; return null; }
      return value.map(v => {
        if (++nodes > 2000) { complete = false; return null; }
        if (!object(v)) { complete = false; return null; }
        const out: Record<string, unknown> = {};
        if (Object.keys(v).some(k => !stepFields.has(k))) complete = false;
        for (const k of ["duration", "distance", "reps", "ramp"])
          if (typeof v[k] === "number" || typeof v[k] === "boolean") out[k] = v[k];
          else if (Object.hasOwn(v, k)) complete = false;
        if (typeof v.text === "string" && v.text.trim()) out.text = text(v.text, 2000);
        else if (v.text !== undefined) complete = false;
        for (const k of ["power", "cadence"]) if (object(v[k])) {
          const target: Record<string, unknown> = {};
          if (Object.keys(v[k]).some(q => !["units", "value", "start", "end", ...(k === "power" ? ["target"] : [])].includes(q))) complete = false;
          for (const q of ["value", "start", "end"]) if (typeof v[k][q] === "number") target[q] = v[k][q];
          else if (Object.hasOwn(v[k], q)) complete = false;
          if (typeof v[k].units === "string") target.units = text(v[k].units, 40);
          if (k === "power" && Object.hasOwn(v[k], "target")) {
            if (v[k].target === "3s") target.target = "3s";
            else complete = false; // Unknown values can contain private data.
          }
          out[k] = target;
        }
        for (const k of ["power", "cadence"]) if (v[k] !== undefined && !object(v[k])) complete = false;
        if (Object.hasOwn(v, "steps")) out.steps = safeSteps(v.steps, depth + 1);
        return out;
      });
    }
    const doc = object(raw.workout_doc) ? raw.workout_doc : {};
    const safeDoc: Record<string, unknown> = { steps: safeSteps(doc.steps) };
    for (const k of ["duration", "distance"]) if (typeof doc[k] === "number") safeDoc[k] = doc[k];
    else if (Object.hasOwn(doc, k)) complete = false;
    if (doc.options !== undefined && (!object(doc.options) || Object.keys(doc.options).length)) complete = false;
    const target = typeof raw.target === "string" ? text(raw.target, 40) : null;
    const targets = Array.isArray(raw.targets) && raw.targets.every(v => typeof v === "string")
      ? raw.targets.map(v => text(v, 40)) : null;
    const original: Record<string, unknown> = { workout_doc: safeDoc };
    if (typeof raw.moving_time === "number") original.moving_time = raw.moving_time;
    else if (Object.hasOwn(raw, "moving_time")) complete = false;
    if (raw.target !== undefined && raw.target !== null && typeof raw.target !== "string") complete = false;
    if (raw.targets !== undefined && targets === null) complete = false;
    original.target = target; original.targets = targets;
    if (typeof raw.description === "string") {
      // Keep native workout instructions, not import URLs or surrounding free-form notes.
      const lines = raw.description.split("\n").filter(l => !l.trim() || /^\s*(?:-|\d+x\s*$)/.test(l));
      original.description = lines.map(l => l.trim() ? text(l, 4000) : "").join("\n");
    }
    const normalized = normalization.workout;
    // Provider load only: never estimate it from duration or power targets.
    const trainingLoad = typeof raw.icu_training_load === 'number' && Number.isFinite(raw.icu_training_load) && raw.icu_training_load >= 0 && raw.icu_training_load <= 2000 ? raw.icu_training_load : null;
    // Normalize stored labels too; raw text must never bypass metadata sanitization.
    function safeLabels(steps: NormalizedWorkout["steps"]) {
      for (const s of steps) {
        if (s.label?.trim()) s.label = text(s.label, 2000);
        else delete s.label;
        if (s.kind === "repeat") safeLabels(s.steps);
      }
    }
    if (normalized) safeLabels(normalized.steps);
    let contentHash: string;
    try {
      // Unknown operative fields affect the hash but are not persisted verbatim.
      contentHash = createHash("sha256").update(canonical({
        folderId, name, sport, target: raw.target ?? null, targets: raw.targets ?? null,
        indoor: raw.indoor ?? null, moving_time: raw.moving_time ?? null, trainingLoad,
        description: raw.description ?? null, workout_doc: { steps: doc.steps ?? null, duration: doc.duration ?? null, distance: doc.distance ?? null, options: doc.options ?? null },
      })).digest("hex");
    } catch { return invalid(); }
    return {
      accountId, workoutId, folderId, name, sport,
      metadata: { target, targets, indoor: typeof raw.indoor === "boolean" ? raw.indoor : null,
        trainingLoad, trainingLoadSource: 'intervals.icu_training_load',
        ...(normalization.warnings.length ? { normalizationWarnings: normalization.warnings } : {}) },
      original, originalComplete: complete, normalized,
      durationSeconds: normalized?.durationSeconds ?? null,
      peakPowerPercentFtp: normalized?.peakPowerPercentFtp ?? null,
      normalizerVersion: normalization.version,
      compatible: normalization.status === "compatible",
      exclusionReasons: normalization.issues, contentHash, sourceUpdatedAt: updated,
      lastSyncedAt: at, available: true,
    };
  }
  function write(w: CachedWorkout) {
    db.prepare(`INSERT INTO workout_library VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,workout_id) DO UPDATE SET
      folder_id=excluded.folder_id,name=excluded.name,sport=excluded.sport,metadata_json=excluded.metadata_json,
      original_json=excluded.original_json,original_complete=excluded.original_complete,normalized_json=excluded.normalized_json,
      duration_seconds=excluded.duration_seconds,peak_power_percent_ftp=excluded.peak_power_percent_ftp,
      normalizer_version=excluded.normalizer_version,compatible=excluded.compatible,exclusion_reasons_json=excluded.exclusion_reasons_json,
      content_hash=excluded.content_hash,source_updated_at=excluded.source_updated_at,last_synced_at=excluded.last_synced_at,available=1`).run(
      w.accountId, w.workoutId, w.folderId, w.name, w.sport, JSON.stringify(w.metadata), JSON.stringify(w.original),
      Number(w.originalComplete), w.normalized ? JSON.stringify(w.normalized) : null, w.durationSeconds, w.peakPowerPercentFtp,
      w.normalizerVersion, Number(w.compatible), JSON.stringify(w.exclusionReasons), w.contentHash, w.sourceUpdatedAt, w.lastSyncedAt, 1,
    );
  }
  function read(r: Record<string, unknown>): CachedWorkout {
    return {
      accountId: String(r.account_id), workoutId: Number(r.workout_id), folderId: r.folder_id === null ? null : Number(r.folder_id),
      name: String(r.name), sport: String(r.sport), metadata: JSON.parse(String(r.metadata_json)),
      original: JSON.parse(String(r.original_json)), originalComplete: r.original_complete === 1,
      normalized: r.normalized_json === null ? null : JSON.parse(String(r.normalized_json)),
      durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
      peakPowerPercentFtp: r.peak_power_percent_ftp === null ? null : Number(r.peak_power_percent_ftp),
      normalizerVersion: String(r.normalizer_version), compatible: r.compatible === 1,
      exclusionReasons: JSON.parse(String(r.exclusion_reasons_json)), contentHash: String(r.content_hash),
      sourceUpdatedAt: r.source_updated_at === null ? null : String(r.source_updated_at),
      lastSyncedAt: String(r.last_synced_at), available: r.available === 1,
    };
  }
  function syncFailure(a: string, status: "incomplete" | "error", code: LibrarySyncState["lastErrorCode"], at: string) {
    db.prepare(`INSERT INTO workout_library_sync(account_id,last_attempt_at,status,last_error_code) VALUES(?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status=excluded.status,last_error_code=excluded.last_error_code`).run(a, at, status, code);
  }
  function list(accountId: string, filters: { availableOnly?: boolean; compatibleOnly?: boolean } = {}): CachedWorkout[] {
    return db.prepare(`SELECT * FROM workout_library WHERE account_id=?${filters.availableOnly ? " AND available=1" : ""}${filters.compatibleOnly ? " AND compatible=1" : ""} ORDER BY workout_id`)
      .all(account(accountId)).map(read);
  }
  function get(accountId: string, workoutId: number): CachedWorkout | null {
    const row = db.prepare("SELECT * FROM workout_library WHERE account_id=? AND workout_id=?").get(account(accountId), id(workoutId));
    return row ? read(row) : null;
  }
  function syncState(accountId: string): LibrarySyncState | null {
    const r = db.prepare("SELECT * FROM workout_library_sync WHERE account_id=?").get(account(accountId));
    return r ? {
      accountId: String(r.account_id), lastAttemptAt: String(r.last_attempt_at),
      lastSuccessAt: r.last_success_at === null ? null : String(r.last_success_at),
      status: r.status as LibrarySyncState["status"], lastErrorCode: r.last_error_code as LibrarySyncState["lastErrorCode"],
      lastCompleteCount: r.last_complete_count === null ? null : Number(r.last_complete_count), generation: Number(r.generation),
    } : null;
  }
  return {
    list, get, syncState,
    upsert(accountId: string, input: unknown): CachedWorkout {
      const w = prepare(input, account(accountId), clock().toISOString());
      transaction(db, () => write(w));
      return w;
    },
    applyEnumeration(accountId: string, inputs: readonly unknown[], enumeration: Enumeration): LibrarySyncState {
      const a = account(accountId), at = clock().toISOString();
      if (!enumeration || enumeration.complete !== true) {
        transaction(db, () => syncFailure(a, "incomplete", "incomplete_enumeration", at));
        return syncState(a)!;
      }
      let prepared: CachedWorkout[];
      try {
        if (!Array.isArray(inputs) || inputs.length > 10_000 || !Number.isSafeInteger(enumeration.expectedCount) || enumeration.expectedCount !== inputs.length)
          throw new WorkoutLibraryError("invalid_enumeration");
        prepared = inputs.map(input => prepare(input, a, at));
        if (new Set(prepared.map(w => w.workoutId)).size !== prepared.length) throw new WorkoutLibraryError("invalid_enumeration");
      } catch (error) {
        transaction(db, () => syncFailure(a, "error", "validation_failed", at));
        throw error;
      }
      try {
        transaction(db, () => {
          db.prepare("UPDATE workout_library SET available=0 WHERE account_id=?").run(a);
          for (const w of prepared) write(w);
          db.prepare(`INSERT INTO workout_library_sync(account_id,last_attempt_at,last_success_at,status,last_complete_count,generation)
            VALUES(?,?,?,'complete',?,1) ON CONFLICT(account_id) DO UPDATE SET
            last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,status='complete',last_error_code=NULL,
            last_complete_count=excluded.last_complete_count,generation=workout_library_sync.generation+1`).run(a, at, at, prepared.length);
        });
      } catch (error) {
        transaction(db, () => syncFailure(a, "error", "database_failed", at));
        throw new WorkoutLibraryError("database_failed");
      }
      return syncState(a)!;
    },
    recordFailure(accountId: string, code: SyncErrorCode): void {
      if (!["validation_failed", "database_failed", "interrupted", "provider_unavailable"].includes(code)) throw new WorkoutLibraryError("invalid_enumeration");
      transaction(db, () => syncFailure(account(accountId), "error", code, clock().toISOString()));
    },
  };
}
