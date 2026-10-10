import { telemetry, compareActivities } from "./readiness/telemetry.js";
import { selectWorkout } from "./coach/training.js";
import { trainingConfig } from "./coach/training.js";
import { coachCommands } from "./coach/commands.js";
import { intervalsWorker } from "./coach/intervals.js";
import { normalizeActivities } from "./readiness/sources.js";
import { today, shift, type Wellness } from "./readiness/types.js";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readinessService } from "./readiness/service.js";
import { historyStore } from "./history.js";
import { openStore, separatePaths } from "./storage/database.js";
import { runtimeConfig, type RuntimeConfig } from "./telegram/config.js";
import { telegramWorker } from "./telegram/poller.js";
import { timingSafeEqual } from "node:crypto";
import { intervalsConfig } from "./readiness/config.js";

export async function createApp(
  options: {
    dbPath?: string;
    appDbPath?: string | null;
    runtime?: RuntimeConfig;
    telegramFetcher?: typeof fetch;
    groqFetcher?: typeof fetch;
    historyPath?: string | null;
    intervalsKey?: string;
    athlete?: string;
    fetcher?: typeof fetch;
    clock?: () => Date;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({ logger: options.logger ?? true });
  const runtime = options.runtime ?? runtimeConfig();
  const snapshotPath =
    options.dbPath ??
    process.env.COACHAI_DB ??
    "/share/coachai/cycling_coach.db";
  const appDbPath =
    options.appDbPath === undefined
      ? (process.env.COACHAI_APP_DB ?? "/data/coachai.db")
      : options.appDbPath;
  if (appDbPath) separatePaths(appDbPath, snapshotPath);
  const store = appDbPath ? openStore(appDbPath) : null;
  if (
    runtime.dataSource === "local" &&
    (!store ||
      store.prepare("SELECT value FROM app_state WHERE key='import_mode'").get()
        ?.value !== "final")
  ) {
    store?.close();
    throw new Error("Local mode requires final import");
  }
  if (runtime.telegramEnabled && !store)
    throw new Error("Telegram requires application database");

  const dbPath = runtime.dataSource === "local" ? appDbPath! : snapshotPath;
  let db: DatabaseSync | null = null;

  let fingerprint = "";
  const historyPath =
    options.historyPath === undefined
      ? (process.env.COACHAI_HISTORY ??
        "/data/coachai/readiness-history.sqlite")
      : options.historyPath;
  if (historyPath) {
    try {
      separatePaths(historyPath, snapshotPath);
      if (appDbPath) separatePaths(historyPath, appDbPath);
    } catch (error) {
      store?.close();
      throw new Error("History must use separate add-on storage", {
        cause: error,
      });
    }
  }
  const history = historyStore(historyPath);
  function revision() {
    if (runtime.dataSource === "local" && store)
      return `${store.prepare("PRAGMA data_version").get()!.data_version}:${store.prepare("SELECT value FROM app_state WHERE key='data_revision'").get()?.value ?? 0}`;
    if (!existsSync(dbPath)) return "missing";
    const s = statSync(dbPath, { bigint: true });
    return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.size}`;
  }
  function database(): DatabaseSync | null {
    if (runtime.dataSource === "local") return store;
    const next = revision();
    if (next !== fingerprint) {
      db?.close();
      db = null;
      fingerprint = next;
    }
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
    () => {
      if (
        runtime.dataSource !== "local" ||
        !store ||
        !runtime.intervalsSyncEnabled
      )
        return null;
      const now = options.clock?.() ?? new Date(),
        date = today(now);
      const synced = store
        .prepare("SELECT value FROM app_state WHERE key='intervals_synced_at'")
        .get()?.value;
      const fresh =
        typeof synced === "string" &&
        now.getTime() - Date.parse(synced) >= 0 &&
        now.getTime() - Date.parse(synced) <
          (runtime.intervalsPollSeconds || 900) * 2000;
      const complete =
        store
          .prepare(
            "SELECT COUNT(*) n FROM activity_coverage WHERE date BETWEEN ? AND ? AND complete=1",
          )
          .get(shift(date, -28), date)?.n === 29;
      if (!fresh || !complete)
        return {
          wellness: [],
          activities: [],
          historyComplete: false,
          issues: [
            "Cache Intervals incompleta o scaduta: nessun dato fisiologico sostitutivo.",
          ],
        };
      return {
        wellness: store
          .prepare(
            "SELECT payload FROM wellness_cache WHERE date BETWEEN ? AND ?",
          )
          .all(shift(date, -28), date)
          .map((r) => JSON.parse(String(r.payload)) as Wellness),
        activities: normalizeActivities(
          store
            .prepare(
              "SELECT payload FROM activity_processing p JOIN training_activities a USING(activity_id) WHERE activity_date BETWEEN ? AND ? AND activity_type IN ('Ride','VirtualRide')",
            )
            .all(shift(date, -28), date)
            .map((r) => JSON.parse(String(r.payload))),
        ),
        historyComplete: true,
        issues: [],
      };
    },
  );
  let recorded: Awaited<ReturnType<typeof calculate>> | null = null;
  async function readiness() {
    const result = await calculate();
    if (runtime.dataSource === "local" && store)
      result.profile.ftp = trainingConfig(store).ftp;
    if (
      result !== recorded &&
      history.record(result, options.clock?.() ?? new Date())
    )
      recorded = result;
    return result;
  }
  const intervalSettings = {
    key: options.intervalsKey ?? configured.key,
    athlete: options.athlete ?? configured.athlete,
  };
  const sync = store
    ? intervalsWorker(
        store,
        runtime,
        intervalSettings,
        options.fetcher,
        options.clock,
      )
    : null;
  const commands = store
    ? coachCommands(
        store,
        runtime,
        readiness,
        intervalSettings,
        options.groqFetcher ?? options.fetcher,
        options.clock,
      )
    : undefined;
  const worker = store
    ? telegramWorker(
        store,
        runtime,
        options.telegramFetcher,
        options.clock,
        commands,
      )
    : null;
  function snapshot() {
    if (runtime.dataSource === "local")
      return { snapshotUpdatedAt: null, snapshotVerified: false };
    const row = tableExists("coachai_snapshot_metadata")
      ? safeQuery<{ synced_at: string }>(
          "SELECT synced_at FROM coachai_snapshot_metadata WHERE id = 1",
        )[0]
      : undefined;
    return {
      snapshotUpdatedAt:
        row?.synced_at ??
        (existsSync(dbPath) ? statSync(dbPath).mtime.toISOString() : null),
      snapshotVerified: Boolean(row),
    };
  }
  app.get("/api/readiness/history", async () => history.read());
  app.get("/api/diagnostics", async (request, reply) => {
    const token = runtime.adminToken,
      supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const left = Buffer.from(token),
      right = Buffer.from(supplied);
    if (
      token.length < 32 ||
      left.length !== right.length ||
      !timingSafeEqual(left, right)
    )
      return reply.code(401).send({ error: "Unauthorized" });
    return {
      events:
        store
          ?.prepare(
            "SELECT occurred_at,category,code FROM diagnostics ORDER BY id DESC LIMIT 100",
          )
          .all() ?? [],
    };
  });
  app.addHook("onReady", async () => {
    sync?.start();
    worker?.start();
  });
  app.addHook("onClose", async () => {
    await worker?.stop();
    await sync?.stop();
    store?.close();
    db?.close();
    history.close();
    db = null;
  });
  app.get("/api/readiness", async () => readiness());
  const dateUtc = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  app.get("/api/health", async () => ({
    status: database() ? "ready" : "waiting_for_snapshot",
    mode:
      runtime.dataSource === "local" ? "local_database" : "read_only_snapshot",
    applicationDatabase: Boolean(store),
    telegramEnabled: runtime.telegramEnabled,
    groqEnabled: runtime.groqEnabled ?? false,
    intervalsSyncEnabled: runtime.intervalsSyncEnabled ?? false,
    intervalsWriteEnabled: runtime.intervalsWriteEnabled ?? false,
    database: existsSync(dbPath),
    ...snapshot(),
    version: "0.6.0",
  }));
  app.get("/api/overview", async () => {
    const availability = {
      training_activities: tableExists("training_activities"),
      meals: tableExists("meals"),
      daily_summary: tableExists("daily_summary"),
    };
    const hasPayload = tableExists("activity_processing");
    const activities = availability.training_activities
      ? safeQuery<Record<string, unknown>>(
          `SELECT a.activity_id,a.activity_date,a.name,a.category,a.duration_min,a.training_load,a.avg_power,${hasPayload ? "p.payload" : "NULL AS payload"} FROM training_activities a ${hasPayload ? "LEFT JOIN activity_processing p USING(activity_id)" : ""}`,
        )
          .map((row) => {
            let raw = {};
            try {
              raw = JSON.parse(String(row.payload));
            } catch {
              /* old snapshot */
            }
            const { payload, ...a } = row;
            return { ...a, activity_id:String(a.activity_id),activity_date:String(a.activity_date),startLocal: telemetry(raw ?? {}).startLocal };
          })
          .sort((a, b) =>
            compareActivities(
              {
                id: String(a.activity_id),
                date: String(a.activity_date),
                startLocal: a.startLocal,
              },
              {
                id: String(b.activity_id),
                date: String(b.activity_date),
                startLocal: b.startLocal,
              },
            ),
          )
          .slice(0, 12)
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
    const evaluated = await readiness();
    const prescription =
      runtime.dataSource === "local" && store
        ? selectWorkout(store, evaluated, options.clock?.() ?? new Date())
        : {
            recommendation: evaluated.recommendation,
            constraints: evaluated.constraints,
            limitingFactors: evaluated.constraints.filter((c) => c.ceiling < 5),
          };
    return {
      prescription,
      status: database() ? "ready" : "waiting_for_snapshot",
      ...snapshot(),
      dataSource: runtime.dataSource,
      availability,
      activities,
      meals,
      daily,
      readiness: evaluated,
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
