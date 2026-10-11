import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { integrity, transaction } from "./storage/database.js";
import { READINESS_MODEL_VERSION, type HistoryEntry } from "./readiness/model.js";
import type { Result } from "./readiness/types.js";
// Separate add-on storage: never writes to the training snapshot or source database.
export function historyStore(path: string | null, modelVersion = READINESS_MODEL_VERSION) {
  if (!/^readiness-v[1-9]\d*$/.test(modelVersion)) throw new Error("Invalid readiness model version");
  let db: DatabaseSync | null = null;
  function connection() {
    if (!path) throw new Error("History storage disabled");
    if (!db) {
      mkdirSync(dirname(path), { recursive: true });
      const candidate = new DatabaseSync(path);
      try {
        candidate.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
        transaction(candidate, () => {
          candidate.exec("CREATE TABLE IF NOT EXISTS evaluations (date TEXT PRIMARY KEY, observed_at TEXT NOT NULL, score INTEGER, confidence INTEGER NOT NULL, recommendation TEXT NOT NULL)");
          candidate.exec("CREATE TABLE IF NOT EXISTS history_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
          const migrations = candidate.prepare("SELECT version, checksum FROM history_schema_migrations ORDER BY version").all();
          if (migrations.some((row) => row.version !== 1)) throw new Error("Unsupported history schema version");
          const sql = readFileSync(new URL("./history/migrations/001_model_versions.sql", import.meta.url), "utf8");
          const checksum = createHash("sha256").update(sql).digest("hex");
          if (migrations.length) {
            if (migrations[0].checksum !== checksum) throw new Error("History migration checksum mismatch");
          } else {
            const columns = candidate.prepare("PRAGMA table_info(evaluations)").all();
            const expected = ["date", "observed_at", "score", "confidence", "recommendation"];
            if (columns.length !== expected.length || columns.some((c, i) => c.name !== expected[i]) || columns[0].pk !== 1)
              throw new Error("Unsupported legacy history schema");
            const before = candidate.prepare("SELECT COUNT(*) n FROM evaluations").get()!.n;
            candidate.exec(sql);
            if (candidate.prepare("SELECT COUNT(*) n FROM evaluations").get()!.n !== before)
              throw new Error("History migration record count mismatch");
            candidate.prepare("INSERT INTO history_schema_migrations VALUES(1,?,?)").run(checksum, new Date().toISOString());
          }
          const columns = candidate.prepare("PRAGMA table_info(evaluations)").all();
          const names = ["date", "observed_at", "score", "confidence", "recommendation", "model_version"];
          if (columns.length !== names.length || columns.some((c, i) => c.name !== names[i]) || columns[0].pk !== 1 || columns[5].pk !== 2)
            throw new Error("Unsupported versioned history schema");
          integrity(candidate);
        });
        db = candidate;
      } catch (error) {
        candidate.close();
        throw error;
      }
    }
    return db;
  }
  return {
    record(result: Result, now: Date) {
      try {
        connection().prepare("INSERT INTO evaluations(date, observed_at, score, confidence, recommendation, model_version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date, model_version) DO UPDATE SET observed_at=excluded.observed_at, score=excluded.score, confidence=excluded.confidence, recommendation=excluded.recommendation WHERE excluded.observed_at >= evaluations.observed_at")
          .run(result.date, now.toISOString(), result.score, result.confidence, result.recommendation, modelVersion);
        return true;
      } catch { return false; }
    },
    read() {
      try { return { available: true, entries: connection().prepare("SELECT * FROM evaluations WHERE date IN (SELECT DISTINCT date FROM evaluations ORDER BY date DESC LIMIT 30) ORDER BY date, observed_at, model_version").all() as HistoryEntry[], limitation: "Valutazioni osservate, ultima registrazione per giorno e modello. Legacy: modello originale non registrato. Modelli diversi non sono direttamente comparabili; nessuna ricostruzione retroattiva." }; }
      catch { return { available: false, entries: [], limitation: "Archivio Readiness non disponibile: verificare accesso e migrazione dello storico. Nessun punteggio ricostruito." }; }
    },
    close() { db?.close(); db = null; },
  };
}
