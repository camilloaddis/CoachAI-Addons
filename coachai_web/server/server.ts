import { calendarPublication } from "./coach/calendar-publication.js";
import { trendService } from "./coach/trends.js";
import { readDailySummary } from "./coach/summaries.js";
import { backupBefore006 } from "./storage/upgrade-backup.js";
import { workoutLibrarySync } from "./coach/workout-library-sync.js";
import { LibraryError } from "./coach/workout-library-client.js";
import { diagnosticWorkoutId, workoutLibraryDiagnostics } from "./coach/workout-library-diagnostics.js";
import { wellnessDiagnostics, derivedMetric } from "./readiness/diagnostics.js";
import { telemetryDiagnostics } from "./coach/telemetry-diagnostics.js";
import { telemetry, compareActivities } from "./readiness/telemetry.js";
import { selectWorkout } from "./coach/training.js";
import { trainingConfig } from "./coach/training.js";
import { webServices } from "./services/web.js";
import { ProviderError } from "./coach/http.js";
import { ValidationError } from "./services/records.js";
import { intervalsWorker } from "./coach/intervals.js";
import { normalizeActivities } from "./readiness/sources.js";
import {
  today,
  shift,
  feedbackTimestamp,
  validDate,
  type Wellness,
} from "./readiness/types.js";
import Fastify from "fastify";
import packageMetadata from "../package.json" with { type: "json" };
import fastifyStatic from "@fastify/static";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readinessService } from "./readiness/service.js";
import { historyStore } from "./history.js";
import { openStore, separatePaths } from "./storage/database.js";
import { runtimeConfig, listenConfig, type RuntimeConfig } from "./config.js";
import { accessMethod, safeIngressWrite } from "./auth.js";
import { lanAccess } from "./lan-auth.js";
import { intervalsConfig } from "./readiness/config.js";

export async function createApp(
  options: {
    dbPath?: string;
    appDbPath?: string | null;
    runtime?: RuntimeConfig;
    groqFetcher?: typeof fetch;
    historyPath?: string | null;
    intervalsKey?: string;
    athlete?: string;
    fetcher?: typeof fetch;
    clock?: () => Date;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({
    trustProxy: false,
    logger: options.logger === false ? false : {
      // Never log credentials, cookies, request bodies or query strings.
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
      serializers: { req: request => ({ method: request.method, url: request.url?.split("?")[0] }) },
    },
  });
  const runtime = options.runtime ?? runtimeConfig();
  const lan = lanAccess(app, runtime, options.clock);
  const requestAccess = (request: import("fastify").FastifyRequest) =>
    accessMethod(request, runtime.adminToken) ??
    (!request.headers.authorization && lan.authenticated(request) ? lan.method : null);
  app.setErrorHandler((error, _request, reply) => {
    const code = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    const status = typeof code === "number" && code >= 400 && code < 500 ? code : 500;
    // Fastify's default error text can reveal absolute file paths.
    return reply.code(status).send({ error: status === 500 ? "internal_error" : "invalid_request" });
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
  });
  app.get("/healthz", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({ status: "ok" }));
  // Central aliases share exactly the same handlers, authentication and storage.
  // Keep legacy URLs for existing Ingress, scripts and clients.
  app.addHook("onRoute", route => {
    if (route.url.startsWith("/api/") && !route.url.startsWith("/api/v1/"))
      // The original GET generates a HEAD route, which is aliased separately.
      app.route({ ...route, exposeHeadRoute: false, url: route.url.replace(/^\/api\//, "/api/v1/") });
  });
  const snapshotPath =
    options.dbPath ??
    process.env.COACHAI_DB ??
    "/share/coachai/cycling_coach.db";
  const appDbPath =
    options.appDbPath === undefined
      ? (process.env.COACHAI_APP_DB ?? "/data/coachai.db")
      : options.appDbPath;
  if (appDbPath) separatePaths(appDbPath, snapshotPath);
  if (appDbPath) await backupBefore006(appDbPath);
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
    result.metricDiagnostics = [
      ...result.metricDiagnostics.filter((m) => m.key !== "ftp"),
      derivedMetric(
        "ftp",
        "FTP operativa",
        "Configurazione Coach",
        result.profile.ftp,
        null,
      ),
    ];
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
  const library = store ? workoutLibrarySync(store, { ...intervalSettings, enabled: runtime.intervalsLibrarySyncEnabled }, options.fetcher, options.clock) : null;
  const calendar = store ? calendarPublication(store, { ...intervalSettings, enabled: runtime.intervalsCalendarWriteEnabled === true && runtime.dataSource === "local" }, readiness, options.fetcher, options.clock) : null;
  const web = store
    ? webServices(
        store,
        runtime,
        readiness,
        options.groqFetcher ?? options.fetcher,
        options.clock,
        intervalSettings.athlete,
        intervalSettings,
        options.fetcher,
      )
    : null;
  app.addHook("onRequest", async (request, reply) => {
    if (!/^\/api(?:\/|\?|$)/.test(request.url)) return;
    reply.header("Cache-Control", "no-store");
    const method = requestAccess(request);
    if (!method) return reply.code(401).send({ error: "unauthorized" });
    if (
      (method === "ingress" || method === "session" || method === "lan") &&
      !["GET", "HEAD"].includes(request.method) &&
      !(method === "ingress" ? safeIngressWrite(request) : lan.safeWrite(request))
    )
      return reply.code(403).send({ error: "same_origin_request_required" });
  });
  app.get("/api/workout-library/status", async () => library?.status() ?? { error: "database_unavailable" });
  const libraryDiagnostic = store ? workoutLibraryDiagnostics(store, intervalSettings, options.fetcher, options.clock) : null;
  const diagnosticError = (error: unknown, reply: import('fastify').FastifyReply) => {
    const code = error instanceof LibraryError ? error.code : 'diagnostic_failed';
    const status = code === 'workout_not_found' ? 404 : code === 'busy' ? 409 : code === 'cooldown' ? 429 : code === 'diagnostic_output_limit' ? 413 : 503;
    return reply.code(status).send({ error: code });
  };
  app.get<{ Querystring: { workoutId?: string } }>("/api/workout-library/diagnostics", async (request, reply) => {
    if (!libraryDiagnostic) return reply.code(503).send({ error: 'database_unavailable' });
    const value = request.query.workoutId;
    const id = typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? diagnosticWorkoutId(Number(value)) : null;
    if (value !== undefined && !id) return reply.code(400).send({ error: 'invalid_workout_id' });
    try { return libraryDiagnostic.summary(id ?? undefined); }
    catch (error) { return diagnosticError(error, reply); }
  });
  app.post<{ Body: { workoutId?: unknown; confirmRead?: unknown } }>("/api/workout-library/diagnostics/export", async (request, reply) => {
    if (!libraryDiagnostic) return reply.code(503).send({ error: 'database_unavailable' });
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirmRead !== true)
      return reply.code(400).send({ error: 'explicit_read_confirmation_required' });
    const id = diagnosticWorkoutId(body.workoutId);
    if (!id) return reply.code(400).send({ error: 'invalid_workout_id' });
    try {
      const result = await libraryDiagnostic.exportWorkout(id);
      return reply.header('Content-Disposition', `attachment; filename="workout-diagnostic-${id}.json"`).send(result);
    } catch (error) { return diagnosticError(error, reply); }
  });
  app.post("/api/workout-library/sync", async (_request, reply) => {
    if (!library) return reply.code(503).send({ error: "database_unavailable" });
    try { return await library.syncOnce(); }
    catch (error) { return reply.code(error instanceof LibraryError && error.code === "busy" ? 409 : 503).send({ error: error instanceof LibraryError ? error.code : "library_sync_failed" }); }
  });
  const trends = store ? trendService(store, runtime, options.groqFetcher ?? options.fetcher, options.clock) : null;
  for (const method of ["GET", "POST"] as const) app.route<{ Querystring: { days?: string } }>({
    method, url: method === "GET" ? "/api/trends" : "/api/trends/summary",
    handler: async (request, reply) => {
      if (!trends) return reply.code(503).send({ error: "database_unavailable" });
      if (request.query.days !== "7" && request.query.days !== "30") return reply.code(400).send({ error: "invalid_period" });
      const days = Number(request.query.days) as 7 | 30;
      if (method === "GET") return trends.report(days);
      if (runtime.dataSource !== "local") return reply.code(409).send({ error: "local_database_required" });
      try { return await trends.summarize(days); }
      catch { return reply.code(503).send({ error: "summary_unavailable" }); }
    },
  });
  app.get("/api/access", async (request) => ({
    method: requestAccess(request),
  }));
  app.get("/api/coach", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!web) return reply.code(503).send({ error: "database_unavailable" });
    const state = web.state();
    return { ...state, calendarEnabled: calendar?.enabled ?? false, proposals: state.proposals.map(p => ({ ...p, publication: calendar?.summary(String(p.id)) ?? null })) };
  });
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/coach/proposals/:id/publish", async (request, reply) => {
    if (!calendar || runtime.dataSource !== "local") return reply.code(409).send({ error: "local_database_required" });
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return reply.code(400).send({ error: "invalid_request" });
    try { return await calendar.publish(request.params.id, request.body); }
    catch (error) { return reply.code(error instanceof ValidationError ? 400 : 503).send({ error: error instanceof ValidationError ? error.message : "publication_unavailable" }); }
  });
  app.post<{ Params: { action: string }; Body: Record<string, unknown> }>(
    "/api/coach/:action",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!web || runtime.dataSource !== "local")
        return reply.code(409).send({ error: "local_database_required" });
      if (
        !request.body ||
        typeof request.body !== "object" ||
        Array.isArray(request.body)
      )
        return reply.code(400).send({ error: "invalid_request" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      try {
        return await web.mutate(request.params.action, request.body, key);
      } catch (error) {
        if (
          error instanceof ValidationError ||
          (error instanceof ProviderError &&
            (error.code === "settings" || error.code.startsWith("nutrition_")))
        )
          return reply.code(400).send({
            error:
              ["stale_proposal", "no_compatible_workout"].includes(error.message)
                ? error.message
                : "invalid_request",
          });
        return reply.code(503).send({ error: "operation_unavailable" });
      }
    },
  );
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
  app.get("/api/diagnostics/intervals", async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "database_unavailable" });
    reply.header("Cache-Control", "no-store");
    return telemetryDiagnostics(store, options.clock?.() ?? new Date());
  });
  app.get("/api/diagnostics", async () => {
    const now = options.clock?.() ?? new Date();
    const state = (key: string) =>
      store?.prepare("SELECT value FROM app_state WHERE key=?").get(key)?.value;
    const lastSyncAt = feedbackTimestamp(
      state("intervals_synced_at"),
    ).updatedAt;
    const age = lastSyncAt ? now.getTime() - Date.parse(lastSyncAt) : NaN;
    const evaluated = await readiness();
    const prescription = store ? selectWorkout(store, evaluated, now, undefined, false, undefined, intervalSettings.athlete) : null;
    // Stale cache may be inspected, but these observations never re-enter scoring.
    const cachedWellness =
      store
        ?.prepare(
          "SELECT payload FROM wellness_cache WHERE date BETWEEN ? AND ?",
        )
        .all(shift(today(now), -28), today(now))
        .flatMap((row) => {
          try {
            const w = JSON.parse(String(row.payload));
            return w && typeof w === "object" && !Array.isArray(w)
              ? [w as Wellness]
              : [];
          } catch {
            return [];
          }
        }) ?? [];
    const diagnosticMetrics = evaluated.metricDiagnostics.map((m) => {
      if (
        m.normalized !== null ||
        m.state === "invalid" ||
        !["ctl", "atl", "hrv", "restingHR", "sleepScore", "sleepSecs"].includes(m.key)
      )
        return m;
      const reference = wellnessDiagnostics(cachedWellness, today(now)).find(
        (c) => c.key === m.key,
      );
      if (!reference || (reference.normalized === null && !reference.fallback))
        return m;
      return {
        ...reference,
        normalized: null,
        state: "stale" as const,
        scoreEligible: false,
        fallback:
          reference.normalized !== null && reference.sourceDate
            ? {
                value: reference.normalized,
                date: reference.sourceDate,
                use: "display_only" as const,
              }
            : reference.fallback,
        reason:
          "Cache inammissibile per la valutazione attuale. Valore mostrato solo come riferimento, escluso dalla Readiness.",
      };
    });
    return {
      integrations: {
        groqEnabled: runtime.groqEnabled ?? false,
        intervalsSyncEnabled: runtime.intervalsSyncEnabled ?? false,
        intervalsDetailsEnabled: runtime.intervalsDetailsEnabled ?? false,
        intervalsWriteEnabled: calendar?.enabled ?? false,
        intervalsCalendarWriteEnabled: calendar?.enabled ?? false,
      },
      cache: {
        lastSyncAt,
        fresh:
          Number.isFinite(age) &&
          age >= 0 &&
          age < (runtime.intervalsPollSeconds || 900) * 2000,
        coveredDays:
          store
            ?.prepare(
              "SELECT COUNT(*) n FROM activity_coverage WHERE date BETWEEN ? AND ? AND complete=1",
            )
            .get(shift(today(now), -28), today(now))?.n ?? 0,
        expectedDays: 29,
        latestWellnessDate: (() => {
          const date = store
            ?.prepare("SELECT MAX(date) date FROM wellness_cache WHERE date<=?")
            .get(today(now))?.date;
          return typeof date === "string" && validDate(date) ? date : null;
        })(),
      },
      metrics: diagnosticMetrics,
      normalized: {
        date: evaluated.date,
        score: evaluated.score,
        physiology: evaluated.physiology,
        planner: {
          mode: "automatic",
          recommendation: prescription?.recommendation ?? evaluated.recommendation,
          week: prescription?.week ?? null,
          phase: prescription?.phase ?? null,
        },
        confidence: evaluated.confidence,
        completeness: evaluated.completeness,
        ctl: evaluated.metrics.ctl,
        atl: evaluated.metrics.atl,
        tsb: evaluated.metrics.tsb,
        load7: evaluated.metrics.load7,
        ftp: evaluated.profile.ftp,
      },
      // Closed projection: no activity names, IDs, payloads, feedback notes, or configuration secrets.
      classification: evaluated.metrics.intensityAssessments.map(
        (a, index) => ({
          sample: index + 1,
          status: a.status,
          evidence: a.evidence,
          isHard: a.isHard,
          sessionType: a.sessionType,
          measurements: a.measurements,
        }),
      ),
      missing: evaluated.missing,
      factors: evaluated.factors.filter(
        (f) => f.category !== "activity" && f.category !== "feedback",
      ),
      limits: (prescription?.constraints ?? evaluated.constraints).map((c) => ({
        code: c.code,
        category: c.category,
        evidence: c.evidence,
        ceiling: c.ceiling,
        before: c.before,
        after: c.after,
        applied: c.applied,
        blocksRequested: c.blocksRequested ?? false,
      })),
      events:
        store
          ?.prepare(
            "SELECT occurred_at,category,code FROM diagnostics ORDER BY id DESC LIMIT 100",
          )
          .all()
          .map((row) => ({
            occurred_at: feedbackTimestamp(row.occurred_at).updatedAt,
            category: [
              "activity_detected",
              "feedback_received",
              "meal_recorded",
              "error",
              "import",
              "current_recovery",
            ].includes(String(row.category))
              ? row.category
              : "legacy",
            code: [
              "saved",
              "recorded",
              "current_recovery",
              "intervals_detail_unavailable",
              "intervals_sync_failed",
              "final_complete",
              "preliminary_complete",
            ].includes(String(row.code))
              ? row.code
              : "unrecognized_code_redacted",
          })) ?? [],
    };
  });
  app.addHook("onReady", async () => {
    sync?.start();
    library?.start();
  });
  app.addHook("onClose", async () => {
    await library?.stop();
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
    groqEnabled: runtime.groqEnabled ?? false,
    intervalsSyncEnabled: runtime.intervalsSyncEnabled ?? false,
    intervalsWriteEnabled: calendar?.enabled ?? false,
    intervalsCalendarWriteEnabled: calendar?.enabled ?? false,
    database: existsSync(dbPath),
    ...snapshot(),
    version: packageMetadata.version,
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
            return {
              ...a,
              activity_id: String(a.activity_id),
              activity_date: String(a.activity_date),
              startLocal: telemetry(raw ?? {}).startLocal,
            };
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
          "SELECT id,date, meal_type, description, calories, protein_g, carbs_g, fat_g FROM meals ORDER BY date DESC, id DESC LIMIT 12",
        )
      : [];
    const dailyDb = database();
    const daily = availability.daily_summary
      ? safeQuery<Record<string, unknown>>(
          availability.meals
            ? "SELECT date FROM daily_summary UNION SELECT date FROM meals ORDER BY date DESC LIMIT 30"
            : "SELECT date, weight, calories_in, protein_g, carbs_g, fat_g, exercise_kcal, training_load FROM daily_summary ORDER BY date DESC LIMIT 30",
        )
          .map((row) => {
            if (!availability.meals || !dailyDb) return row;
            const latest = readDailySummary(dailyDb, String(row.date));
            // Preserve the overview projection; do not expose legacy estimates.
            return Object.fromEntries(
              ["date", "weight", "calories_in", "protein_g", "carbs_g", "fat_g", "exercise_kcal", "training_load"]
                .map((key) => [key, latest?.[key] ?? null]),
            );
          })
      : [];
    const evaluated = await readiness();
    const prescription =
      runtime.dataSource === "local" && store
        ? selectWorkout(store, evaluated, options.clock?.() ?? new Date(), undefined, false, undefined, intervalSettings.athlete)
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
      const dayDb = database();
      const stored = safeQuery<Record<string, unknown>>(
        "SELECT * FROM daily_summary WHERE date = ?", request.params.date,
      )[0];
      if (stored) delete stored.food_complete;
      return {
        date: request.params.date,
        summary: dayDb && tableExists("daily_summary") && tableExists("meals")
          ? readDailySummary(dayDb, request.params.date)
          : stored ?? null,
        meals: safeQuery<Record<string, unknown>>(
          "SELECT id,date,meal_type,description,calories,protein_g,carbs_g,fat_g FROM meals WHERE date = ? ORDER BY id",
          request.params.date,
        ),
      };
    },
  );
  function indexPage(
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) {
    const html = readFileSync(
      resolve(process.cwd(), "dist/index.html"),
      "utf8",
    );
    const prefix =
      accessMethod(request, runtime.adminToken) === "ingress"
        ? String(request.headers["x-ingress-path"]).replace(/\/$/, "")
        : "";
    // prefix passed strict auth validation; never reflect untrusted request paths.
    return reply
      .type("text/html")
      .header("Cache-Control", "no-store")
      .send(html.replace("<head>", `<head><base href="${prefix}/">`));
  }
  app.get("/", indexPage);
  await app.register(fastifyStatic, {
    root: resolve(process.cwd(), "dist"),
    prefix: "/",
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/"))
      return reply.code(404).send({ error: "API endpoint not found" });
    return indexPage(request, reply);
  });
  return app;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const listen = listenConfig();
  const app = await createApp();
  await app.listen(listen);
}
