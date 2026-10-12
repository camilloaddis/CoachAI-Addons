import { sleepDuration } from "./physiology.js";
import { safeRaw } from "./diagnostics.js";
import { telemetry, compareActivities } from "./telemetry.js";
import type { DatabaseSync } from "node:sqlite";
import {
  number,
  validDate,
  shift,
  feedbackTimestamp,
  type Activity,
  type Feedback,
  type Wellness,
} from "./types.js";
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => {
  if (
    !Array.isArray(value) ||
    value.some((r) => !r || typeof r !== "object" || Array.isArray(r))
  )
    throw new Error("Invalid response");
  return value as Row[];
};
export function normalizeWellness(
  value: unknown,
  acquiredAt: string | null = null,
): Wellness[] {
  const unique = new Map<string, Wellness>();
  for (const r of rows(value)) {
    const date = String(r.id ?? "").slice(0, 10);
    if (!validDate(date)) throw new Error("Invalid wellness date");
    unique.set(date, {
      date,
      acquiredAt,
      diagnosticRaw: Object.fromEntries(
        ["ctl", "atl", "hrv", "restingHR", "sleepScore", "sleepSecs"].map((k) => [
          k,
          safeRaw(r[k]),
        ]),
      ),
      diagnosticState: Object.fromEntries(
        (
          [
            ["ctl", 0, Infinity],
            ["atl", 0, Infinity],
            ["hrv", 1, Infinity],
            ["restingHR", 1, 250],
            ["sleepScore", 0, 100],
            ["sleepSecs", 1, 86400],
          ] as const
        ).map(([k, min, max]) => [
          k,
          r[k] == null
            ? "missing"
            : (k === "sleepSecs" ? sleepDuration(r[k]) : number(r[k], min, max)) === null
              ? "invalid"
              : "present",
        ]),
      ),
      ctl: number(r.ctl),
      atl: number(r.atl),
      hrv: number(r.hrv, 1),
      restingHR: number(r.restingHR, 1, 250),
      sleepScore: number(r.sleepScore, 0, 100),
      sleepSecs: sleepDuration(r.sleepSecs),
    });
  }
  return [...unique.values()];
}
export function normalizeActivities(value: unknown): Activity[] {
  const mapped = rows(value).map((r) => {
    const localDate =
      typeof r.start_date_local === "string"
        ? r.start_date_local.slice(0, 10)
        : "";
    const start = feedbackTimestamp(r.start_date);
    const date = validDate(localDate) ? localDate : (start.updatedDate ?? "");
    if (!validDate(date) || !r.id) throw new Error("Invalid activity");
    const seconds = number(r.moving_time);
    return {
      ...telemetry(r),
      id: String(r.id),
      date,
      load: number(r.icu_training_load),
      intensity: number(r.icu_intensity, 0, 200),
      duration: seconds === null ? null : seconds / 60,
      name: typeof r.name === "string" ? r.name : null,
      type: typeof r.type === "string" ? r.type : null,
      commute: typeof r.commute === "boolean" ? r.commute : null,
      // icu_rpe is the field written by CoachAI. An explicit null/invalid
      // canonical value must not resurrect an older legacy alias.
      rpe: number(
        r.icu_rpe !== undefined
          ? r.icu_rpe
          : r.session_rpe ?? r.perceived_exertion,
        0,
        10,
      ),
    };
  });
  return [...new Map(mapped.map((a) => [a.id, a])).values()].sort(
    compareActivities,
  );
}
export function readSnapshot(
  db: DatabaseSync | null,
  date: string,
  now: Date = new Date(),
): { activities: Activity[]; feedback: Feedback[]; issues: string[] } {
  const issues: string[] = [],
    activities: Activity[] = [],
    feedback: Feedback[] = [];
  if (!db)
    return {
      activities,
      feedback,
      issues: ["Snapshot SQLite non disponibile."],
    };
  const columns = (table: string) =>
    new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name),
    );
  try {
    const a = columns("training_activities");
    if (a.has("activity_id") && a.has("activity_date")) {
      const records = db
        .prepare(
          "SELECT * FROM training_activities WHERE activity_date >= ? AND activity_date <= ?",
        )
        .all(shift(date, -28), date) as Row[];
      const rawColumns = columns("activity_processing");
      const payloads = new Map(
        rawColumns.has("payload")
          ? db
              .prepare("SELECT activity_id,payload FROM activity_processing")
              .all()
              .map((r) => [String(r.activity_id), String(r.payload)])
          : [],
      );
      for (const r of records) {
        const d = String(r.activity_date);
        if (validDate(d)) {
          let raw: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(
              payloads.get(String(r.activity_id)) ?? "{}",
            );
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw Error();
            raw = parsed;
          } catch {
            issues.push(
              "Payload attività non valido: fallback colonne verificate.",
            );
          }
          const measured = telemetry(raw);
          activities.push({
            ...measured,
            averagePower: number(r.avg_power) ?? measured.averagePower,
            averageHR: number(r.avg_hr, 1, 250) ?? measured.averageHR,
            id: String(r.activity_id),
            date: d,
            load: number(r.training_load),
            intensity: number(r.intensity, 0, 200),
            duration: number(r.duration_min),
            name: typeof r.name === "string" ? r.name : null,
            type: typeof r.activity_type === "string" ? r.activity_type : null,
            commute: r.category === "COMMUTING" ? true : null,
            rpe: number(r.rpe, 0, 10),
          });
        }
      }
      for (const c of ["training_load", "intensity", "duration_min"])
        if (!a.has(c))
          issues.push(`SQLite training_activities: colonna ${c} assente.`);
    } else
      issues.push(
        "SQLite: training_activities o chiavi verificate nei flussi assenti.",
      );
    const f = columns("training_feedback");
    if (
      ["activity_id", "legs"].every((c) => f.has(c)) &&
      a.has("activity_id") &&
      a.has("activity_date")
    ) {
      const records = db
        .prepare(
          `SELECT ta.activity_date, tf.legs, ${f.has("context") ? "tf.context" : "'ambiguous'"} AS context, ${f.has("updated_at") ? "tf.updated_at" : "NULL"} AS updated_at, ${f.has("sensation_date") ? "tf.sensation_date" : "NULL"} AS sensation_date FROM training_feedback tf JOIN training_activities ta ON ta.activity_id=tf.activity_id WHERE ta.activity_date <= ? AND (ta.activity_date >= ? ${f.has("sensation_date") ? "OR tf.sensation_date >= ?" : ""})`,
        )
        .all(
          date,
          shift(date, -2),
          ...(f.has("sensation_date") ? [shift(date, -2)] : []),
        ) as Row[];
      if (columns("recovery_feedback").has("observation_date")) {
        const current = db
          .prepare(
            "SELECT a.activity_date,f.legs,f.updated_at,f.observation_date AS sensation_date,'current' AS context FROM recovery_feedback f JOIN training_activities a USING(activity_id) WHERE f.observation_date BETWEEN ? AND ?",
          )
          .all(shift(date, -2), date) as Row[];
        records.push(...current);
      }
      if (columns("recovery_observations").has("observation_date")) {
        records.push(
          ...(db
            .prepare(
              "SELECT NULL AS activity_date,legs,updated_at,observation_date AS sensation_date,'current' AS context FROM recovery_observations WHERE observation_date BETWEEN ? AND ?",
            )
            .all(shift(date, -2), date) as Row[]),
        );
      }
      for (const r of records) {
        const legs = number(r.legs, 1, 5),
          activityDate =
            r.activity_date === null ? null : String(r.activity_date);
        const timestamp = feedbackTimestamp(r.updated_at);
        if (
          legs === null ||
          !Number.isInteger(legs) ||
          (activityDate === null
            ? r.context !== "current"
            : !validDate(activityDate))
        )
          continue;
        if (
          timestamp.updatedAt &&
          (Date.parse(timestamp.updatedAt) > now.getTime() ||
            (activityDate !== null && timestamp.updatedDate! < activityDate) ||
            timestamp.updatedDate! > date)
        ) {
          issues.push(
            "Feedback con timestamp futuro o antecedente all’attività escluso.",
          );
          continue;
        }
        feedback.push({
          context:
            r.context === "activity" || r.context === "current"
              ? r.context
              : "ambiguous",
          activityDate,
          ...timestamp,
          sensationDate:
            typeof r.sensation_date === "string" &&
            validDate(r.sensation_date) &&
            r.sensation_date <= date &&
            timestamp.updatedDate !== null &&
            r.sensation_date <= timestamp.updatedDate
              ? r.sensation_date
              : null,
          legs,
        });
      }
      if (
        feedback.some(
          (f) =>
            f.context === "ambiguous" ||
            (f.context === "current" && f.sensationDate === null),
        )
      )
        issues.push(
          "Feedback legacy/ambiguo: data di inserimento distinta da data della sensazione e recupero attuale.",
        );
      if (!f.has("updated_at"))
        issues.push("Feedback SQLite: timestamp updated_at assente.");
    } else
      issues.push("Feedback SQLite non disponibile: tabella/colonne mancanti.");
  } catch {
    issues.push("Lettura schema/snapshot SQLite fallita.");
  }
  activities.sort(compareActivities);
  return { activities, feedback, issues };
}
export async function readIntervals(
  date: string,
  config: { key?: string; athlete?: string },
  fetcher: typeof fetch = fetch,
): Promise<{
  wellness: Wellness[];
  activities: Activity[];
  historyComplete: boolean;
  issues: string[];
}> {
  if (!config.key || !config.athlete)
    return {
      wellness: [],
      activities: [],
      historyComplete: false,
      issues: [
        "Intervals non configurato: INTERVALS_API_KEY e INTERVALS_ATHLETE_ID necessari.",
      ],
    };
  if (!/^i?\d+$/.test(config.athlete))
    return {
      wellness: [],
      activities: [],
      historyComplete: false,
      issues: ["INTERVALS_ATHLETE_ID non valido."],
    };
  const headers = {
    Authorization:
      "Basic " + Buffer.from("API_KEY:" + config.key).toString("base64"),
    Accept: "application/json",
  };
  const get = async (resource: string) => {
    const url = new URL(
      `https://intervals.icu/api/v1/athlete/${config.athlete}/${resource}`,
    );
    url.searchParams.set("oldest", shift(date, -28));
    url.searchParams.set("newest", date);
    const response = await fetcher(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Intervals unavailable");
    return response.json() as Promise<unknown>;
  };
  const [w, a] = await Promise.allSettled([
    get("wellness").then((value) =>
      normalizeWellness(value, new Date().toISOString()),
    ),
    get("activities").then(normalizeActivities),
  ]);
  const issues: string[] = [];
  if (w.status === "rejected")
    issues.push(
      "Wellness Intervals non disponibile (accesso, rete o risposta non valida).",
    );
  if (a.status === "rejected")
    issues.push(
      "Attività Intervals non disponibili (accesso, rete o risposta non valida).",
    );
  return {
    wellness: w.status === "fulfilled" ? w.value : [],
    activities: a.status === "fulfilled" ? a.value : [],
    historyComplete: a.status === "fulfilled",
    issues,
  };
}
