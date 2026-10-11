import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { transaction } from "../storage/database.js";
import { workoutLibraryRepository } from "../storage/workout-library.js";
import { type WorkoutNode } from "./workout-normalizer.js";
import { selectWorkout, templateDuration, trainingConfig, type Proposal } from "./training.js";
import { validateIntent } from "./intent.js";
import { readJsonResponse } from "./http.js";
import { today, validDate, type Result } from "../readiness/types.js";
import { ValidationError } from "../services/records.js";

export type Publication = {
  status: "sending" | "scheduled" | "error" | "unknown";
  date: string;
  remoteId: number | null;
  retryable: boolean;
  error: string | null;
};
type Saved = Publication & { updatedAt: string; externalId: string; event: Record<string, unknown> };

/** Native Intervals syntax; expand repeats to preserve even nested repeat semantics. */
export function nativeDescription(steps: WorkoutNode[]): string {
  const lines: string[] = [];
  function visit(nodes: WorkoutNode[]) {
    for (const s of nodes) {
      if (s.kind === "repeat") {
        for (let i = 0; i < s.repetitions; i++) visit(s.steps);
      } else {
        if (lines.length >= 2000) throw new ValidationError("workout_too_complex");
        const p = s.power, c = s.cadence;
        const power = p.kind === "constant" ? `${p.value}%` : `${p.kind === "ramp" ? "ramp " : ""}${p.start}-${p.end}%`;
        const cadence = !c ? "" : ` ${c.kind === "constant" ? c.value : `${c.start}-${c.end}`}rpm`;
        lines.push(`- ${s.durationSeconds}s ${power}${cadence}`);
      }
    }
  }
  visit(steps);
  return lines.join("\n");
}

export function calendarPublication(db: DatabaseSync, settings: { key?: string; athlete?: string; enabled?: boolean },
  readiness: () => Promise<Result>, fetcher: typeof fetch = fetch, clock: () => Date = () => new Date(), timeoutMs = 15000) {
  const active = new Set<string>();
  const account = /^i?[1-9]\d{0,19}$/.test(settings.athlete ?? "") ? "i" + settings.athlete!.replace(/^i/, "") : "";
  const enabled = settings.enabled === true && !!settings.key && !!account;
  const get = (key: string) => db.prepare("SELECT value FROM app_state WHERE key=?").get(key)?.value;
  const put = (key: string, value: unknown) => db.prepare("INSERT INTO app_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  const alias = (id: string) => `calendar_proposal:${account}:${id}`;
  function locate(id: string): { key: string; saved: Saved } | null {
    const value = get(alias(id));
    if (typeof value !== "string") return null;
    const key = JSON.parse(value) as string, stored = get(key);
    return typeof stored === "string" ? { key, saved: JSON.parse(stored) } : null;
  }
  function summary(id: string): Publication | null {
    const found = locate(id);
    if (!found) return null;
    const { saved, key } = found;
    const interrupted = saved.status === "sending" && !active.has(key);
    return { status: interrupted ? "unknown" : saved.status, date: saved.date, remoteId: saved.remoteId,
      retryable: saved.retryable, error: interrupted ? "ambiguous_result" : saved.error };
  }
  function matches(v: unknown, saved: Saved): v is { id: number } {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const e = v as Record<string, unknown>;
    return Number.isSafeInteger(e.id) && Number(e.id) > 0 && e.category === "WORKOUT" &&
      e.start_date_local === saved.event.start_date_local && e.external_id === saved.externalId &&
      e.type === saved.event.type && e.name === saved.event.name &&
      (e.athlete_id === undefined || e.athlete_id === account);
  }
  async function request(url: string, init: RequestInit): Promise<Response> {
    return fetcher(url, { ...init, redirect: "error", headers: { Authorization: "Basic " + Buffer.from("API_KEY:" + settings.key).toString("base64"),
      "Content-Type": "application/json" }, signal: init.signal });
  }
  async function publish(id: string, body: Record<string, unknown>): Promise<Publication> {
    if (!enabled) throw new ValidationError("calendar_disabled");
    if (!id || id.length > 160 || Object.keys(body).some(k => !["date", "allowStatic", "verify"].includes(k)) ||
      typeof body.date !== "string" || !validDate(body.date) || (body.allowStatic !== undefined && typeof body.allowStatic !== "boolean") ||
      (body.verify !== undefined && typeof body.verify !== "boolean")) throw new ValidationError("invalid_request");
    if (get("import_mode") !== "final") throw new ValidationError("local_database_required");
    const existing = locate(id);
    if (existing && existing.saved.date !== body.date) throw new ValidationError("invalid_request");
    if (existing && (existing.saved.status === "scheduled" || active.has(existing.key))) return summary(id)!;
    if (existing && !existing.saved.retryable) {
      if (body.verify !== true) return summary(id)!;
      // Read-only reconciliation. Absence never authorizes another potentially duplicate POST.
      const saved = existing.saved;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await request(`https://intervals.icu/api/v1/athlete/${account}/events?oldest=${saved.date}&newest=${saved.date}&category=WORKOUT`, { method: "GET", signal: controller.signal });
          if (!response.ok) { await response.body?.cancel(); throw new Error(); }
          const rows = await readJsonResponse(response);
          const found = Array.isArray(rows) ? rows.filter(e => matches(e, saved)) : [];
          if (found.length === 1) {
            put(existing.key, { ...saved, updatedAt: clock().toISOString(), status: "scheduled", remoteId: found[0].id, error: null });
          }
        } finally { clearTimeout(timer); }
      } catch { /* Keep the durable uncertain state and never expose provider details. */ }
      return summary(id)!;
    }
    if (body.verify === true) throw new ValidationError("invalid_request");
    const payload = db.prepare("SELECT payload FROM workout_proposals WHERE id=?").get(id)?.payload;
    if (typeof payload !== "string") throw new ValidationError("invalid_request");
    const p = JSON.parse(payload) as Proposal;
    if (p.date !== body.date || p.date !== today(clock()) || !p.workout || p.duration <= 0)
      throw new ValidationError("stale_proposal");
    const config = trainingConfig(db);
    if (p.config.ftp !== config.ftp || p.duration > config.duration) throw new ValidationError("stale_proposal");
    if (!p.decision?.intent) throw new ValidationError("stale_proposal");
    const intent = validateIntent(p.decision.intent);
    const fresh = selectWorkout(db, await readiness(), clock(), p.requestCommand, false, intent, account);
    const ranks = ["riposo", "recupero", "endurance", "tempo", "sweet spot/soglia", "VO2max"];
    if (intent.mode === "automatic" && (ranks.indexOf(p.recommendation) < 0 || ranks.indexOf(p.recommendation) > ranks.indexOf(fresh.recommendation)))
      throw new ValidationError("stale_proposal");
    let description: string, sport = "Ride";
    if (p.workout.library) {
      const ref = p.workout.library;
      const cached = ref.account === account ? workoutLibraryRepository(db).get(account, ref.id) : null;
      if (!cached?.available || !cached.compatible || !cached.normalized || cached.contentHash !== ref.contentHash ||
        !["Ride", "VirtualRide"].includes(cached.sport)) throw new ValidationError("stale_proposal");
      description = nativeDescription(cached.normalized.steps);
      sport = cached.sport;
    } else {
      if (body.allowStatic !== true) throw new ValidationError("static_confirmation_required");
      description = p.workout.structure;
      if (typeof description !== "string" || description.length > 100000 || templateDuration(description) !== p.duration ||
        !description.split("\n").every(l => !l.trim() || /^\d+x$/.test(l) || /^- .*\d+[ms].*\d+(?:-\d+)?%/.test(l)))
        throw new ValidationError("invalid_workout");
    }
    // Same athlete/date/targets also deduplicates an identical regenerated proposal.
    const hash = createHash("sha256").update(JSON.stringify([account, p.date, sport, description])).digest("hex");
    const key = "calendar_publication:" + hash;
    let saved: Saved = { updatedAt: clock().toISOString(), status: "sending", date: p.date, remoteId: null, retryable: false, error: null,
      externalId: "coachai-" + hash, event: { category: "WORKOUT", start_date_local: p.date + "T00:00:00", type: sport,
        name: p.workout.name, description, external_id: "coachai-" + hash } };
    const reserved = transaction(db, () => {
      put(alias(id), key);
      const old = get(key);
      if (typeof old === "string") {
        const previous = JSON.parse(old) as Saved;
        if (!previous.retryable) return false;
        saved = { ...previous, status: "sending", retryable: false, error: null };
      }
      put(key, { ...saved, updatedAt: clock().toISOString() });
      return true;
    });
    if (!reserved) return summary(id)!;
    active.add(key);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const response = await request(`https://intervals.icu/api/v1/athlete/${account}/events?upsertOnUid=false`,
          { method: "POST", body: JSON.stringify(saved.event), signal: controller.signal });
        if (response.status !== 200) {
          await response.body?.cancel();
          const rejected = [400, 401, 403, 404, 422, 429].includes(response.status);
          return { ...saved, status: rejected ? "error" as const : "unknown" as const,
            retryable: rejected, error: rejected ? "request_rejected" : "ambiguous_result" };
        }
        const event = await readJsonResponse(response);
        if (!matches(event, saved)) throw new Error();
        return { ...saved, status: "scheduled" as const, remoteId: event.id, error: null };
      })();
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs); });
      saved = await Promise.race([operation, timeout]);
    } catch {
      saved = { ...saved, status: "unknown", retryable: false, error: "ambiguous_result" };
    } finally {
      if (timer) clearTimeout(timer);
      active.delete(key);
    }
    put(key, { ...saved, updatedAt: clock().toISOString() });
    return summary(id)!;
  }
  return { enabled, summary, publish };
}
