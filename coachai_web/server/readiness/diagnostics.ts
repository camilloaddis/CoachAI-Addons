import { sleepDuration } from "./physiology.js";
import {
  feedbackTimestamp,
  number,
  shift,
  validDate,
  type Wellness,
} from "./types.js";
const definitions = [
  ["ctl", "CTL", 0, Infinity],
  ["atl", "ATL", 0, Infinity],
  ["hrv", "HRV", 1, Infinity],
  ["restingHR", "FC a riposo", 1, 250],
  ["sleepScore", "Qualità sonno", 0, 100],
  ["sleepSecs", "Durata sonno (secondi)", 1, 86400],
] as const;
export type MetricDiagnostic = {
  scoreEligible?: boolean;
  baseline?: { value: number | null; samples: number };
  key: string;
  label: string;
  source: string;
  sourceDate: string | null;
  sourceTimestamp: string | null;
  acquiredAt: string | null;
  raw: number | string | null;
  normalized: number | null;
  state: "usable" | "missing" | "invalid" | "stale";
  fallback: { value: number; date: string; use: "display_only" } | null;
  reason: string;
};
export function safeRaw(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.length <= 32 &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) &&
    Number.isFinite(Number(value))
  )
    return value;
  return null;
}
export function wellnessDiagnostics(
  wellness: Wellness[],
  date: string,
): MetricDiagnostic[] {
  const current = wellness.find((w) => w.date === date);
  return definitions.map(([key, label, min, max]) => {
    const valid = (value: unknown) =>
      key === "sleepSecs"
        ? sleepDuration(value)
        : number(value, min, max);
    const normalized = valid(current?.[key]);
    const rawKnown = Boolean(
      current?.diagnosticRaw && Object.hasOwn(current.diagnosticRaw, key),
    );
    const raw = rawKnown ? safeRaw(current?.diagnosticRaw?.[key]) : null;
    const fallback = wellness
      .filter(
        (w) =>
          validDate(w.date) &&
          w.date < date &&
          w.date >= shift(date, -28) &&
          valid(w[key]) !== null,
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const invalid = Boolean(
      current &&
        normalized === null &&
        (raw !== null || current.diagnosticState?.[key] === "invalid"),
    );
    const state =
      normalized !== null
        ? "usable"
        : invalid
          ? "invalid"
          : fallback
            ? "stale"
            : "missing";
    return {
      key,
      label,
      source: "Intervals.icu /wellness",
      sourceDate: current?.date ?? fallback?.date ?? null,
      sourceTimestamp: null, // The provider measurement instant is not captured: a date is not an instant.
      acquiredAt: feedbackTimestamp(current?.acquiredAt ?? fallback?.acquiredAt)
        .updatedAt,
      raw,
      normalized,
      state,
      fallback:
        normalized === null && fallback
          ? {
              value: valid(fallback[key])!,
              date: fallback.date,
              use: "display_only",
            }
          : null,
      reason:
        normalized !== null
          ? rawKnown
            ? "Dato odierno valido; istante originale di misurazione non disponibile."
            : "Dato odierno normalizzato; valore grezzo non conservato nella cache precedente."
          : invalid
            ? "Formato non valido o valore fuori dai limiti: escluso dal punteggio."
            : fallback
              ? "Dato odierno mancante. Ultima osservazione mostrata solo come riferimento: esclusa dal punteggio di oggi."
              : "Dato odierno assente o non valido; nessuno zero sostitutivo.",
    };
  });
}

export function derivedMetric(
  key: string,
  label: string,
  source: string,
  value: number | null,
  date: string | null,
): MetricDiagnostic {
  return {
    key,
    label,
    source,
    sourceDate: date,
    sourceTimestamp: null,
    acquiredAt: null,
    raw: null,
    normalized: value,
    state: value === null ? "missing" : "usable",
    fallback: null,
    reason:
      value === null
        ? "Input insufficienti; nessun valore sostitutivo."
        : "Valore derivato o configurato, non una misura fisiologica autonoma.",
  };
}
