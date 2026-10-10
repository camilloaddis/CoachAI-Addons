import { number, validDate, type Activity } from "./types.js";
// Executed list/detail telemetry only; planned targets are never substituted.
export function telemetry(r: Record<string, unknown>): Partial<Activity> {
  const ftp = number(r.icu_ftp, 50, 600),
    np = number(r.icu_weighted_avg_watts, 0, 2000);
  let zones: Activity["powerZones"] = null,
    intervals: Activity["executedIntervals"] = null;
  const bounds = r.icu_power_zones;
  const validBounds =
    Array.isArray(bounds) &&
    bounds.length >= 1 &&
    bounds.length <= 32 &&
    bounds.every(
      (v, i) =>
        typeof v === "number" &&
        Number.isSafeInteger(v) &&
        v > 0 &&
        (i === 0 || v > bounds[i - 1]),
    );
  const standard =
    Array.isArray(bounds) &&
    (bounds.length === 6 || bounds.length === 7) &&
    [55, 75, 90, 105, 120, 150].every((n, i) => bounds[i] === n);
  if (
    validBounds &&
    Array.isArray(r.icu_zone_times) &&
    r.icu_zone_times.length >= 1 &&
    r.icu_zone_times.length <= 7
  ) {
    const parsed = r.icu_zone_times.map((z) => {
      if (!z || typeof z !== "object") return null;
      const row = z as Record<string, unknown>,
        m = /^Z([1-7])$/.exec(String(row.id));
      const seconds = number(row.secs, 0, 604800);
      return m &&
        typeof row.secs === "number" &&
        Number.isSafeInteger(row.secs) &&
        seconds !== null
        ? { zone: Number(m[1]), seconds }
        : null;
    });
    if (
      parsed.every((z) => z !== null) &&
      new Set(parsed.map((z) => z!.zone)).size === parsed.length
    )
      zones = parsed as NonNullable<Activity["powerZones"]>;
  }
  // icu_intervals is accepted only as executed average_watts + elapsed_time, not target percentages.
  if (
    Array.isArray(r.icu_intervals) &&
    r.icu_intervals.length > 0 &&
    r.icu_intervals.length <= 1000
  ) {
    const parsed = r.icu_intervals.map((i) => {
      if (!i || typeof i !== "object") return null;
      const row = i as Record<string, unknown>,
        seconds = number(row.elapsed_time, 1, 604800),
        power = number(row.average_watts, 0, 2000);
      return seconds !== null && power !== null
        ? {
            seconds,
            averagePower: power,
            ...(row.type === "WORK" || row.type === "RECOVERY"
              ? { type: row.type }
              : {}),
            ...(typeof row.group_id === "string" && row.group_id.length <= 200
              ? { group: row.group_id }
              : {}),
          }
        : null;
    });
    const indices = r.icu_intervals.map((i) =>
      i && typeof i === "object" ? (i as Record<string, unknown>) : {},
    );
    const indexed = indices.filter(
      (i) => i.start_index !== undefined || i.end_index !== undefined,
    );
    const validIndexRanges = indexed.every(
      (i) =>
        typeof i.start_index === "number" &&
        Number.isSafeInteger(i.start_index) &&
        Number(i.start_index) >= 0 &&
        typeof i.end_index === "number" &&
        Number.isSafeInteger(i.end_index) &&
        Number(i.end_index) >= Number(i.start_index),
    );
    const ordered = [...indexed].sort(
      (a, b) => Number(a.start_index) - Number(b.start_index),
    );
    const noOverlap = ordered.every(
      (i, n) =>
        n === 0 || Number(i.start_index) >= Number(ordered[n - 1].end_index),
    );
    if (parsed.every((i) => i !== null) && validIndexRanges && noOverlap)
      intervals = parsed as NonNullable<Activity["executedIntervals"]>;
  }
  const start =
    typeof r.start_date_local === "string" &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(
      r.start_date_local,
    ) &&
    validDate(r.start_date_local.slice(0, 10))
      ? r.start_date_local
      : null;
  return {
    ftp,
    normalizedPower: np,
    intensityFactor:
      np !== null && ftp !== null
        ? np / ftp
        : number(r.icu_intensity, 0, 200) === null
          ? null
          : number(r.icu_intensity, 0, 200)! / 100,
    averagePower: number(r.icu_average_watts, 0, 2000),
    averageHR: number(r.average_heartrate, 1, 250),
    powerZones: zones,
    powerZoneBounds: validBounds ? [...(bounds as number[])] : null,
    powerZoneMapping: zones
      ? standard
        ? "legacy_standard"
        : "unverified_custom"
      : null,
    executedIntervals: intervals,
    startLocal: start,
  };
}
export function compareActivities(
  a: Pick<Activity, "date" | "id" | "startLocal">,
  b: Pick<Activity, "date" | "id" | "startLocal">,
) {
  return (
    b.date.localeCompare(a.date) ||
    (b.startLocal ?? "").localeCompare(a.startLocal ?? "") ||
    b.id.localeCompare(a.id, "en", { numeric: true }) ||
    b.id.localeCompare(a.id, "en")
  );
}
