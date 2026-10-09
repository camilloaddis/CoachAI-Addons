import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  openStore,
  separatePaths,
  transaction,
  integrity,
  diagnostic,
} from "./database.js";

const required: Record<string, string[]> = {
  training_activities: ["activity_id", "activity_date"],
  meals: [
    "id",
    "date",
    "meal_type",
    "description",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
  ],
  training_feedback: ["activity_id", "legs", "updated_at"],
  daily_summary: [
    "date",
    "weight",
    "calories_in",
    "protein_g",
    "carbs_g",
    "fat_g",
    "exercise_kcal",
    "training_load",
  ],
  training_config: [
    "id",
    "start_date",
    "goal",
    "ftp",
    "target_weight",
    "workout_duration_min",
    "plan_weeks",
  ],
};
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const encode = (value: unknown): unknown =>
  typeof value === "bigint"
    ? { $integer: value.toString() }
    : value instanceof Uint8Array
      ? { $blob: Buffer.from(value).toString("base64") }
      : value;
function schemaReport(source: DatabaseSync) {
  const tables = source
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const schema = tables.map((t) => ({
    name: String(t.name),
    sql: String(t.sql),
    columns: source
      .prepare(`PRAGMA table_info(${quote(String(t.name))})`)
      .all(),
  }));
  const schemaObjects = source
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  const hash = createHash("sha256")
    .update(JSON.stringify({ schema, schemaObjects }))
    .digest("hex");
  const missing = Object.entries(required).flatMap(([table, cols]) => {
    const actual = schema.find((t) => t.name === table);
    return !actual
      ? [table + ": table unavailable"]
      : cols
          .filter((c) => !actual.columns.some((x) => x.name === c))
          .map((c) => table + "." + c + ": column unavailable");
  });
  const counts = Object.fromEntries(
    schema.map((t) => [
      t.name,
      Number(
        source.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}`).get()!.n,
      ),
    ]),
  );
  return {
    schema,
    schemaObjects,
    hash,
    missing,
    counts,
    unmappedTables: schema
      .filter(
        (t) =>
          !Object.hasOwn(required, t.name) &&
          t.name !== "coachai_snapshot_metadata",
      )
      .map((t) => t.name),
  };
}
export function importHistory(options: {
  source: string;
  destination?: string;
  mode: "inspect" | "preliminary" | "final";
  schemaHash?: string;
  nodeRedStopped?: boolean;
}) {
  if (!["inspect", "preliminary", "final"].includes(options.mode))
    throw new Error("Invalid import mode");
  if (options.mode !== "inspect" && !options.destination)
    throw new Error("Destination required");
  if (options.destination) separatePaths(options.destination, options.source);
  // No writes or schema changes on the source. A read transaction pins a consistent view.
  const source = new DatabaseSync(options.source, { readOnly: true });
  let destination: DatabaseSync | null = null;
  try {
    source.exec("PRAGMA busy_timeout=5000; BEGIN");
    integrity(source);
    const report = schemaReport(source);
    if (options.mode === "inspect") return { mode: options.mode, ...report };
    if (
      options.mode === "final" &&
      (!options.nodeRedStopped ||
        options.schemaHash !== report.hash ||
        report.missing.length)
    )
      throw new Error(
        "Final import requires stopped Node-RED, reviewed schema hash and all required source fields",
      );
    if (
      options.mode === "preliminary" &&
      resolve(options.destination!) ===
        resolve(process.env.COACHAI_APP_DB ?? "/data/coachai.db")
    )
      throw new Error("Preliminary import requires separate preview storage");
    destination = openStore(options.destination!);
    transaction(destination, () => {
      const dst = destination!;
      if (
        Number(dst.prepare("SELECT COUNT(*) AS n FROM import_runs").get()!.n) ||
        Number(
          dst.prepare("SELECT COUNT(*) AS n FROM service_requests").get()!.n,
        ) ||
        Number(
          dst.prepare("SELECT COUNT(*) AS n FROM telegram_updates").get()!.n,
        )
      )
        throw new Error(
          "Import destination must be fresh; never overwrite local writes",
        );
      for (const table of Object.keys(required))
        if (
          Number(
            dst.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get()!.n,
          )
        )
          throw new Error("Import destination must be empty");
      const archive = dst.prepare("INSERT INTO source_archive VALUES(?,?,?)");
      // Activities first, then feedback to satisfy application foreign keys.
      const ordered = [...report.schema].sort(
        (a, b) =>
          (a.name === "training_activities" ? -1 : 0) -
          (b.name === "training_activities" ? -1 : 0),
      );
      for (const table of ordered) {
        if (/CREATE\s+VIRTUAL/i.test(table.sql))
          throw new Error(
            "Virtual source tables require explicit migration review",
          );
        const statement = source.prepare(`SELECT * FROM ${quote(table.name)}`);
        statement.setReadBigInts(true);
        const target = Object.hasOwn(required, table.name)
          ? dst
              .prepare(`PRAGMA table_info(${quote(table.name)})`)
              .all()
              .map((c) => String(c.name))
          : [];
        const columns = table.columns
          .map((c) => String(c.name))
          .filter(
            (c) =>
              target.includes(c) &&
              ![
                "request_key",
                "request_hash",
                "origin",
                "recorded_at",
                "sensation_date",
              ].includes(c),
          );
        const names = [
          ...columns,
          ...(["meals", "training_feedback"].includes(table.name)
            ? ["origin"]
            : []),
        ];
        const insert = names.length
          ? dst.prepare(
              `INSERT INTO ${quote(table.name)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
            )
          : null;
        let ordinal = 0;
        for (const row of statement.iterate()) {
          const identity = Object.hasOwn(required, table.name)
            ? required[table.name][0]
            : null;
          if (
            identity &&
            (row[identity] === null ||
              row[identity] === undefined ||
              String(row[identity]).trim() === "")
          )
            throw new Error(
              "Source identity missing; never generate historical IDs",
            );
          archive.run(
            table.name,
            ++ordinal,
            JSON.stringify(
              Object.fromEntries(
                Object.entries(row).map(([k, v]) => [k, encode(v)]),
              ),
            ),
          );
          if (insert)
            insert.run(
              ...columns.map((c) => row[c] as SQLInputValue),
              ...(["meals", "training_feedback"].includes(table.name)
                ? ["import"]
                : []),
            );
        }
        if (ordinal !== report.counts[table.name])
          throw new Error("Source record count changed");
        if (
          insert &&
          Number(
            dst.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`).get()!
              .n,
          ) !== ordinal
        )
          throw new Error("Imported record count mismatch");
      }
      dst
        .prepare(
          "INSERT INTO import_runs(mode,imported_at,schema_hash,counts_json,schema_json) VALUES(?,?,?,?,?)",
        )
        .run(
          options.mode,
          new Date().toISOString(),
          report.hash,
          JSON.stringify(report.counts),
          JSON.stringify({
            tables: report.schema,
            objects: report.schemaObjects,
          }),
        );
      dst
        .prepare("INSERT INTO app_state VALUES(?,?)")
        .run("import_mode", options.mode);
      diagnostic(
        dst,
        "import",
        options.mode === "final" ? "final_complete" : "preliminary_complete",
      );
      integrity(dst);
    });
    return {
      mode: options.mode,
      ...report,
      integrity: "ok",
      archivedRecords: Object.values(report.counts).reduce((a, b) => a + b, 0),
    };
  } finally {
    destination?.close();
    try {
      if (source.isTransaction) source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }
}
