import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Result } from "./readiness/types.js";
// Separate add-on storage: never writes to the training snapshot or source database.
export function historyStore(path: string | null) {
  let db: DatabaseSync | null = null;
  function connection() {
    if (!path) throw new Error("History storage disabled");
    if (!db) {
      mkdirSync(dirname(path), { recursive: true });
      db = new DatabaseSync(path);
      db.exec("CREATE TABLE IF NOT EXISTS evaluations (date TEXT PRIMARY KEY, observed_at TEXT NOT NULL, score INTEGER, confidence INTEGER NOT NULL, recommendation TEXT NOT NULL)");
    }
    return db;
  }
  return {
    record(result: Result, now: Date) {
      try {
        connection().prepare("INSERT INTO evaluations VALUES (?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET observed_at=excluded.observed_at, score=excluded.score, confidence=excluded.confidence, recommendation=excluded.recommendation WHERE excluded.observed_at >= evaluations.observed_at")
          .run(result.date, now.toISOString(), result.score, result.confidence, result.recommendation);
        return true;
      } catch { return false; }
    },
    read() {
      try { return { available: true, entries: connection().prepare("SELECT * FROM (SELECT * FROM evaluations ORDER BY date DESC LIMIT 30) ORDER BY date").all(), limitation: "Valutazioni osservate, ultima registrazione per giorno. Nessuna ricostruzione retroattiva." }; }
      catch { return { available: false, entries: [], limitation: "Archivio Readiness non disponibile: verificare la scrittura nella directory dati dell’add-on." }; }
    },
    close() { db?.close(); db = null; },
  };
}
