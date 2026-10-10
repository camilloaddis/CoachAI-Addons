import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  openSync,
  closeSync,
  chmodSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function separatePaths(destination: string, source: string) {
  const canonical = (p: string) =>
    existsSync(p) ? realpathSync(p) : resolve(p);
  if (
    canonical(destination) === canonical(source) ||
    canonical(destination) === "/config/cycling_coach.db"
  )
    throw new Error("Destination must be separate from source");
  if (existsSync(destination) && existsSync(source)) {
    // Hard links are aliases too, even when realpath differs.
    const { dev: d, ino: i } = statSync(destination),
      s = statSync(source);
    if (d === s.dev && i === s.ino)
      throw new Error("Destination must be separate from source");
  }
}
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function integrity(db: DatabaseSync) {
  const rows = db.prepare("PRAGMA integrity_check").all();
  if (
    rows.length !== 1 ||
    Object.values(rows[0])[0] !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Database integrity failed");
}
const migrations = [
  "001_initial.sql",
  "002_coach_services.sql",
  "003_telegram_envelopes.sql",
  "004_feedback_context_edits.sql",
];
export function openStore(
  path: string,
  migrationDirectory = fileURLToPath(new URL("./migrations/", import.meta.url)),
) {
  separatePaths(path, "/share/coachai/cycling_coach.db");
  mkdirSync(dirname(resolve(path)), { recursive: true });
  if (!existsSync(path)) closeSync(openSync(path, "ax", 0o600));
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL",
    );
    transaction(db, () => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      const applied = db
        .prepare(
          "SELECT version, checksum FROM schema_migrations ORDER BY version",
        )
        .all();
      if (applied.some((r) => Number(r.version) > migrations.length))
        throw new Error("Database migration newer than application");
      for (const [index, name] of migrations.entries()) {
        const version = index + 1,
          sql = readFileSync(resolve(migrationDirectory, name), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const previous = applied.find((r) => r.version === version);
        if (previous) {
          if (previous.checksum !== checksum)
            throw new Error("Migration checksum mismatch");
          continue;
        }
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
          version,
          checksum,
          new Date().toISOString(),
        );
      }
      integrity(db);
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function diagnostic(
  db: DatabaseSync,
  category:
    | "feedback_scheduled"
    | "activity_detected"
    | "telegram_sent"
    | "telegram_edited"
    | "feedback_received"
    | "meal_recorded"
    | "error"
    | "import"
    | "telegram_received",
  code: string,
) {
  db.prepare(
    "INSERT INTO diagnostics(occurred_at,category,code) VALUES(?,?,?)",
  ).run(new Date().toISOString(), category, code);
}
