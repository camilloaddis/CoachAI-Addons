import type { DatabaseSync } from "node:sqlite";
import { normalizeActivities, readSnapshot } from "../readiness/sources.js";
import { assessIntensity } from "../readiness/intensity.js";
import { shift, today } from "../readiness/types.js";
// Only closed field names and aggregated counts. Never emits raw values, names, IDs or dates.
const fields = {
  moving_time: "duration",
  icu_average_watts: "averagePower",
  icu_weighted_avg_watts: "normalizedPower",
  icu_ftp: "ftp",
  icu_intensity: "intensity",
  icu_training_load: "load",
  average_heartrate: "averageHR",
  icu_zone_times: "powerZones",
  icu_power_zones: "powerZones",
  icu_intervals: "executedIntervals",
  streams: "unconsumedStreams",
} as const;
export function telemetryDiagnostics(db: DatabaseSync, now: Date) {
  const date = today(now);
  const hasRaw = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='activity_processing'",
    )
    .get();
  const stored = readSnapshot(db, date, now).activities;
  const rows = db
    .prepare(
      `SELECT a.activity_id,${hasRaw ? "p.payload" : "NULL AS payload"} FROM training_activities a ${hasRaw ? "LEFT JOIN activity_processing p USING(activity_id)" : ""} WHERE a.activity_date BETWEEN ? AND ?`,
    )
    .all(shift(date, -28), date);
  const counts = Object.fromEntries(
    Object.keys(fields).map((k) => [
      k,
      {
        present: 0,
        absent: 0,
        types: {} as Record<string, number>,
        accepted: 0,
        storedUsable: 0,
        normalizationMismatch: 0,
      },
    ]),
  );
  const classification = {
    confirmedHard: 0,
    confirmedNonHard: 0,
    probableHard: 0,
    probableNonHard: 0,
    unknown: 0,
  };
  let rawAvailable = 0,
    rawUnavailable = 0,
    invalidPayload = 0,
    normalizationFailures = 0;
  for (const row of rows) {
    let raw: Record<string, unknown> = {};
    if (row.payload === null || row.payload === undefined) rawUnavailable++;
    else {
      try {
        const p = JSON.parse(String(row.payload));
        if (!p || typeof p !== "object" || Array.isArray(p)) throw Error();
        raw = p;
        rawAvailable++;
      } catch {
        invalidPayload++;
      }
    }
    let normalized: ReturnType<typeof normalizeActivities>[number] | undefined;
    if (Object.keys(raw).length)
      try {
        normalized = normalizeActivities([raw])[0];
      } catch {
        normalizationFailures++;
      }
    const used = stored.find((a) => a.id === String(row.activity_id));
    for (const [field, property] of Object.entries(fields)) {
      const c = counts[field],
        present = Object.hasOwn(raw, field);
      c[present ? "present" : "absent"]++;
      if (present) {
        const value = raw[field],
          type =
            value === null
              ? "null"
              : Array.isArray(value)
                ? "array"
                : typeof value;
        c.types[type] = (c.types[type] ?? 0) + 1;
      }
      const accepted = normalized?.[property as keyof typeof normalized];
      const actual = used?.[property as keyof typeof used];
      const usable = (v: unknown) =>
        v !== null && v !== undefined && (!Array.isArray(v) || v.length > 0);
      if (usable(accepted)) c.accepted++;
      if (usable(actual)) c.storedUsable++;
      if (usable(accepted) && !usable(actual)) c.normalizationMismatch++;
    }
    if (used) {
      const a = assessIntensity(used);
      const k =
        a.status === "confermata"
          ? a.isHard
            ? "confirmedHard"
            : "confirmedNonHard"
          : a.status === "probabile"
            ? a.isHard
              ? "probableHard"
              : "probableNonHard"
            : "unknown";
      classification[k]++;
    }
  }
  return {
    windowDays: 29,
    activities: rows.length,
    rawAvailable,
    rawUnavailable,
    invalidPayload,
    normalizationFailures,
    fields: counts,
    classification,
    requests: {
      activities: "GET /api/v1/athlete/{athlete}/activities?oldest=…&newest=…",
      wellness: "GET /api/v1/athlete/{athlete}/wellness?oldest=…&newest=…",
      fieldFilter: null,
      details: false,
      intervalDetails: false,
      streams: false,
    },
    limits: [
      "Raw unavailable means no captured API payload, not proof that the provider omitted a field.",
      "Present but unaccepted may be null, invalid, custom zones or an unsupported shape.",
      "No series or planned targets are used; executed telemetry must be present and valid.",
      "No personal values are included.",
    ],
  };
}
