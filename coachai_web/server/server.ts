import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readinessService } from "./readiness/service.js";
import { historyStore } from "./history.js";
import { intervalsConfig } from "./readiness/config.js";

export async function createApp(
  options: {
    dbPath?: string;
    historyPath?: string | null;
    intervalsKey?: string;
    athlete?: string;
    fetcher?: typeof fetch;
    clock?: () => Date;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({ logger: options.logger ?? true });
  const dbPath =
    options.dbPath ??
    process.env.COACHAI_DB ??
    "/share/coachai/cycling_coach.db";
  let db: DatabaseSync | null = null;

  let fingerprint = "";
  const historyPath = options.historyPath === undefined ? (process.env.COACHAI_HISTORY ?? "/data/coachai/readiness-history.sqlite") : options.historyPath;
  const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
  if (historyPath && (canonical(historyPath) === canonical(dbPath) || canonical(historyPath) === "/config/cycling_coach.db")) throw new Error("History must use separate add-on storage");
  const history = historyStore(historyPath);
  function revision() {
    if (!existsSync(dbPath)) return "missing";
    const s = statSync(dbPath, { bigint: true });
    return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.size}`;
  }
  function database(): DatabaseSync | null {
    const next = revision();
    if (next !== fingerprint) { db?.close(); db = null; fingerprint = next; }
    if (next === "missing") return null;
    if (!db) db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  }
  function safeQuery<T>(sql: string, ...params: (string | number)[]): T[] {
    const conn = database();
    if (!conn) return [];
    try {
      return conn.prepare(sql).all(...params) as T[];
    } catch (error) {
      app.log.warn({ err: error }, "SQL read failed");
      return [];
    }
  }
  function tableExists(name: string): boolean {
    return Boolean(
      safeQuery<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
        "table",
        name,
      ).length,
    );
  }
  const configured = intervalsConfig();
  const calculate = readinessService(
    database,
    {
      key: options.intervalsKey ?? configured.key,
      athlete: options.athlete ?? configured.athlete,
    },
    options.fetcher,
    options.clock,
    revision,
  );
  let recorded: Awaited<ReturnType<typeof calculate>> | null = null;
  async function readiness() {
    const result = await calculate();
    if (result !== recorded && history.record(result, options.clock?.() ?? new Date())) recorded = result;
    return result;
  }
  function snapshot() {
    const row = safeQuery<{ synced_at: string }>("SELECT synced_at FROM coachai_snapshot_metadata WHERE id = 1")[0];
    return { snapshotUpdatedAt: row?.synced_at ?? (existsSync(dbPath) ? statSync(dbPath).mtime.toISOString() : null), snapshotVerified: Boolean(row) };
  }
  app.get("/api/readiness/history", async () => history.read());
  app.addHook("onClose", async () => {
    db?.close();
    history.close();
    db = null;
  });
  app.get("/api/readiness", async () => readiness());
  const dateUtc = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  app.get("/api/health", async () => ({
    status: database() ? "ready" : "waiting_for_snapshot",
    mode: "read_only_snapshot",
    database: existsSync(dbPath),
    ...snapshot(),
    version: "0.3.0",
  }));
  app.get("/api/overview", async () => {
    const availability = {
      training_activities: tableExists("training_activities"),
      meals: tableExists("meals"),
      daily_summary: tableExists("daily_summary"),
    };
    const activities = availability.training_activities
      ? safeQuery<Record<string, unknown>>(
          "SELECT activity_date, name, category, duration_min, training_load, avg_power FROM training_activities ORDER BY activity_date DESC, activity_id DESC LIMIT 12",
        )
      : [];
    const meals = availability.meals
      ? safeQuery<Record<string, unknown>>(
          "SELECT date, meal_type, description, calories, protein_g, carbs_g, fat_g FROM meals ORDER BY date DESC, id DESC LIMIT 12",
        )
      : [];
    const daily = availability.daily_summary
      ? safeQuery<Record<string, unknown>>(
          "SELECT date, weight, calories_in, protein_g, carbs_g, fat_g, exercise_kcal, training_load FROM daily_summary ORDER BY date DESC LIMIT 30",
        )
      : [];
    return {
      status: database() ? "ready" : "waiting_for_snapshot",
      ...snapshot(),
      availability,
      activities,
      meals,
      daily,
      readiness: await readiness(),
      history: history.read(),
    };
  });
  app.get<{ Params: { date: string } }>(
    "/api/day/:date",
    async (request, reply) => {
      if (!dateUtc(request.params.date))
        return reply
          .code(400)
          .send({ error: "Formato data richiesto: YYYY-MM-DD" });
      return {
        date: request.params.date,
        summary:
          safeQuery<Record<string, unknown>>(
            "SELECT * FROM daily_summary WHERE date = ?",
            request.params.date,
          )[0] ?? null,
        meals: safeQuery<Record<string, unknown>>(
          "SELECT id,date,meal_type,description,calories,protein_g,carbs_g,fat_g FROM meals WHERE date = ? ORDER BY id",
          request.params.date,
        ),
      };
    },
  );
  await app.register(fastifyStatic, {
    root: resolve(process.cwd(), "dist"),
    prefix: "/",
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/"))
      return reply.code(404).send({ error: "API endpoint not found" });
    return reply.sendFile("index.html");
  });
  return app;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await createApp();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT || 8099) });
}
