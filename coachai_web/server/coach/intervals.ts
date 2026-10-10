import { assessIntensity } from "../readiness/intensity.js";
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { jsonRequest, object } from "./http.js";
import {
  normalizeActivities,
  normalizeWellness,
} from "../readiness/sources.js";
import { recordServices } from "../services/records.js";
import { transaction, diagnostic } from "../storage/database.js";
import { shift, today, validDate, number } from "../readiness/types.js";
import { recalculate } from "./summaries.js";
import type { RuntimeConfig } from "../config.js";
export function intervalsWorker(
  db: DatabaseSync,
  runtime: RuntimeConfig,
  config: { key?: string; athlete?: string },
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
) {
  const abort = new AbortController(),
    owner = randomUUID();
  let task: Promise<void> | null = null,
    running = false;
  const state = (key: string) =>
    db.prepare("SELECT value FROM app_state WHERE key=?").get(key)?.value;
  const put = (key: string, value: string) =>
    db
      .prepare(
        "INSERT INTO app_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  function check() {
    if (!runtime.intervalsSyncEnabled) return false;
    if (
      !runtime.nodeRedStopped ||
      runtime.dataSource !== "local" ||
      state("import_mode") !== "final" ||
      !config.key ||
      !/^i?\d+$/.test(config.athlete || "")
    )
      throw new Error("intervals_prerequisites");
    return true;
  }
  function lease() {
    db.prepare(
      "INSERT INTO worker_leases VALUES('intervals',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE worker_leases.expires_at<=? OR worker_leases.owner=excluded.owner",
    ).run(owner, clock().getTime() + 90000, clock().getTime());
    return (
      db.prepare("SELECT owner FROM worker_leases WHERE name='intervals'").get()
        ?.owner === owner
    );
  }
  function owns() {
    const lease = db
      .prepare(
        "SELECT owner,expires_at FROM worker_leases WHERE name='intervals'",
      )
      .get();
    return (
      lease?.owner === owner && Number(lease.expires_at) > clock().getTime()
    );
  }
  async function get(resource: string, oldest: string, newest: string) {
    const url = new URL(
      `https://intervals.icu/api/v1/athlete/${config.athlete}/${resource}`,
    );
    url.searchParams.set("oldest", oldest);
    url.searchParams.set("newest", newest);
    return jsonRequest(
      fetcher,
      url,
      {
        headers: {
          authorization:
            "Basic " + Buffer.from("API_KEY:" + config.key).toString("base64"),
        },
        signal: abort.signal,
      },
      8000,
      8388608,
    );
  }
  async function enrich(
    rows: Map<string, Record<string, unknown>>,
    date: string,
  ) {
    if (!runtime.intervalsDetailsEnabled) return;
    // Persistent budget/cooldown survives restart; no details for powerless rides or old history.
    const budgetKey = "intervals_detail_budget";
    let budget = { date, count: 0 };
    try {
      const saved = JSON.parse(String(state(budgetKey) || "null"));
      if (saved?.date === date) budget = saved;
    } catch {}
    let calls = 0;
    for (const [id, raw] of rows) {
      let a;
      try {
        a = normalizeActivities([raw])[0];
      } catch {
        continue;
      }
      if (
        a.date < shift(date, -6) ||
        a.date > date ||
        !["Ride", "VirtualRide"].includes(a.type || "") ||
        (number(raw.icu_average_watts) === null &&
          number(raw.icu_weighted_avg_watts) === null) ||
        assessIntensity(a).status === "confermata" ||
        a.executedIntervals
      )
        continue;
      const key = "intervals_detail:" + id;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(raw))
        .digest("hex");
      let cache: {
        fingerprint?: string;
        retryAt?: number;
        data?: Record<string, unknown>;
      } = {};
      try {
        cache = JSON.parse(String(state(key) || "{}"));
      } catch {}
      if (
        cache.retryAt &&
        cache.retryAt > clock().getTime() &&
        (!cache.data || cache.fingerprint === fingerprint)
      ) {
        if (cache.data) Object.assign(raw, cache.data);
        continue;
      }
      if (
        calls >= 2 ||
        budget.count >= 10 ||
        Number(state("intervals_detail_cooldown") || 0) > clock().getTime()
      )
        continue;
      if (!owns()) throw new Error("lease_lost");
      const wait =
        Number(state("intervals_detail_last_call") || 0) +
        1000 -
        clock().getTime();
      if (wait > 0)
        await delay(Math.min(wait, 1000), undefined, { signal: abort.signal });
      calls++;
      budget.count++;
      put(budgetKey, JSON.stringify(budget));
      put("intervals_detail_last_call", String(clock().getTime()));
      try {
        const url = new URL(
          `https://intervals.icu/api/v1/activity/${encodeURIComponent(id)}`,
        );
        url.searchParams.set("intervals", "true");
        const guardedFetch: typeof fetch = async (input, init) => {
          const response = await fetcher(input, init);
          if ([401, 403, 429].includes(response.status)) {
            const retryHeader = response.headers.get("retry-after");
            const retrySeconds =
              retryHeader === null ? NaN : Number(retryHeader);
            const retry = Number.isFinite(retrySeconds)
              ? retrySeconds * 1000
              : Date.parse(retryHeader || "") - clock().getTime();
            put(
              "intervals_detail_cooldown",
              String(
                clock().getTime() +
                  Math.max(21600000, Number.isFinite(retry) ? retry : 0),
              ),
            );
          }
          return response;
        };
        const detail = object(
          await jsonRequest(
            guardedFetch,
            url,
            {
              headers: {
                authorization:
                  "Basic " +
                  Buffer.from("API_KEY:" + config.key).toString("base64"),
              },
              signal: abort.signal,
            },
            8000,
            1048576,
          ),
        );
        if (String(detail.id) !== id) throw new Error("detail_identity");
        if (number(detail.icu_ftp) !== null && number(detail.icu_ftp) !== a.ftp)
          throw new Error("detail_ftp_mismatch");
        const data: Record<string, unknown> = {};
        // Keep groups as metadata, never add their power/time to the individual intervals.
        for (const field of ["icu_intervals", "icu_groups"])
          if (Array.isArray(detail[field])) data[field] = detail[field];
        put(
          key,
          JSON.stringify({
            fingerprint,
            retryAt: clock().getTime() + 86400000,
            data,
          }),
        );
        Object.assign(raw, data);
      } catch {
        put(
          key,
          JSON.stringify({
            fingerprint,
            retryAt: clock().getTime() + 21600000,
          }),
        );
        diagnostic(db, "error", "intervals_detail_unavailable");
      }
    }
    // Cache does not accumulate the athlete's entire history.
  }
  async function pollOnce() {
    if (!check()) return "disabled";
    if (running || !lease()) return "busy";
    running = true;
    try {
      const date = today(clock()),
        previous = String(state("intervals_last_day") || ""),
        oldest = validDate(String(state("intervals_catchup_next") || ""))
          ? String(state("intervals_catchup_next"))
          : validDate(previous)
            ? shift(previous, -28)
            : shift(date, -28),
        newest = oldest < shift(date, -30) ? shift(oldest, 30) : date;
      if (oldest > date) throw new Error("intervals_checkpoint_future");
      // A long outage is caught up in bounded chunks. State advances only after both responses validate.
      const aRaw = await get("activities", oldest, newest),
        wRaw = await get("wellness", oldest, newest);
      const rawActivities = new Map(
        (aRaw as unknown[]).map((value) => {
          const row = object(value);
          if (
            !(
              (typeof row.id === "string" &&
                row.id.trim() &&
                row.id.length <= 200) ||
              (typeof row.id === "number" &&
                Number.isSafeInteger(row.id) &&
                row.id > 0)
            )
          )
            throw new Error("invalid_activity_id");
          return [String(row.id), row] as const;
        }),
      );
      const rawWellness = new Map(
        (wRaw as unknown[]).map((value) => {
          const row = object(value);
          return [String(row.id).slice(0, 10), row] as const;
        }),
      );
      await enrich(rawActivities, date);
      const activities = normalizeActivities([...rawActivities.values()]),
        wellness = normalizeWellness([...rawWellness.values()]);
      if (
        activities.some((a) => a.date < oldest || a.date > newest) ||
        wellness.some((w) => w.date < oldest || w.date > newest)
      )
        throw new Error("intervals_range");
      if (!owns() || !lease()) throw new Error("lease_lost");
      transaction(db, () => {
        const records = recordServices(db, clock),
          affected = new Set<string>();
        for (const a of activities) {
          if (
            a.id.length > 200 ||
            (!["Ride", "VirtualRide"].includes(a.type || "") && !a.type)
          )
            throw new Error("invalid_activity");
          const raw = rawActivities.get(a.id)!,
            payload = JSON.stringify(raw),
            hash = createHash("sha256").update(payload).digest("hex");
          const old = db
            .prepare(
              "SELECT p.fingerprint,a.activity_date FROM activity_processing p JOIN training_activities a USING(activity_id) WHERE activity_id=?",
            )
            .get(a.id);
          if (old?.fingerprint === hash) continue;
          if (old) affected.add(String(old.activity_date));
          records.activity(
            {
              activity_id: a.id,
              activity_date: a.date,
              name: a.name || undefined,
              category: a.commute
                ? "COMMUTING"
                : raw.paired_event_id
                  ? "PLANNED_WORKOUT"
                  : "FREE_RIDE",
              duration_min: a.duration ?? undefined,
              training_load: a.load ?? undefined,
              intensity: a.intensity ?? undefined,
            },
            `intervals:${hash}:${randomUUID()}`,
            true,
          );
          // Authoritative edits may remove a previously supplied field. Do not retain stale physiology.
          db.prepare(
            "UPDATE training_activities SET activity_date=?,name=?,category=?,activity_type=?,duration_min=?,training_load=?,intensity=?,avg_power=?,avg_hr=?,rpe=?,paired_event_id=? WHERE activity_id=?",
          ).run(
            a.date,
            a.name ?? null,
            a.commute
              ? "COMMUTING"
              : raw.paired_event_id
                ? "PLANNED_WORKOUT"
                : "FREE_RIDE",
            a.type ?? null,
            a.duration,
            a.load,
            a.intensity,
            number(raw.icu_average_watts),
            number(raw.average_heartrate),
            a.rpe ?? null,
            raw.paired_event_id === undefined || raw.paired_event_id === null
              ? null
              : String(raw.paired_event_id),
            a.id,
          );
          db.prepare(
            "INSERT INTO activity_processing VALUES(?,?,?,?) ON CONFLICT(activity_id) DO UPDATE SET payload=excluded.payload,fingerprint=excluded.fingerprint,seen_at=excluded.seen_at",
          ).run(a.id, payload, hash, clock().toISOString());
          affected.add(a.date);
        }
        db.prepare("DELETE FROM wellness_cache WHERE date BETWEEN ? AND ?").run(
          oldest,
          newest,
        );
        for (const w of wellness) {
          db.prepare(
            "INSERT INTO wellness_cache VALUES(?,?) ON CONFLICT(date) DO UPDATE SET payload=excluded.payload",
          ).run(w.date, JSON.stringify(w));
          const raw = rawWellness.get(w.date)!;
          if (number(raw.weight, 1, 500) !== null)
            db.prepare(
              "INSERT INTO daily_summary(date,weight) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET weight=excluded.weight",
            ).run(w.date, number(raw.weight, 1, 500));
        }
        for (let d = oldest; d <= newest; d = shift(d, 1)) {
          db.prepare(
            "INSERT INTO activity_coverage(date,refreshed_at,complete) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET refreshed_at=excluded.refreshed_at,complete=excluded.complete",
          ).run(
            d,
            clock().toISOString(),
            db
              .prepare(
                "SELECT activity_id FROM training_activities WHERE activity_date=?",
              )
              .all(d)
              .every((r) => activities.some((a) => a.id === r.activity_id))
              ? 1
              : 0,
          );
          affected.add(d);
        }
        for (const d of affected) recalculate(db, d);
        db.prepare(
          "DELETE FROM app_state WHERE key LIKE 'intervals_detail:%' AND substr(key,18) NOT IN (SELECT activity_id FROM training_activities WHERE activity_date>=?)",
        ).run(shift(date, -28));
        put("intervals_last_day", newest);
        put("intervals_catchup_next", newest < date ? shift(newest, 1) : "");
        put("intervals_synced_at", clock().toISOString());
        put("data_revision", String(Number(state("data_revision") || 0) + 1));
      });
      return "processed";
    } catch {
      diagnostic(db, "error", "intervals_sync_failed");
      throw new Error("intervals_sync_failed");
    } finally {
      running = false;
    }
  }
  return {
    pollOnce,
    start() {
      if (!check() || task) return;
      task = (async () => {
        while (!abort.signal.aborted) {
          try {
            await pollOnce();
          } catch {
            /* sanitized diagnostics only */
          }
          try {
            await delay(
              (runtime.intervalsPollSeconds || 900) * 1000,
              undefined,
              { signal: abort.signal },
            );
          } catch {
            break;
          }
        }
      })();
    },
    async stop() {
      abort.abort();
      await task;
      db.prepare(
        "DELETE FROM worker_leases WHERE name='intervals' AND owner=?",
      ).run(owner);
    },
  };
}
