import type { DatabaseSync } from "node:sqlite";
import { catalog } from "./catalog.js";
import { validDate, today, shift, type Result } from "../readiness/types.js";
import { ProviderError } from "./http.js";
export function trainingConfig(db: DatabaseSync) {
  const row = db.prepare("SELECT * FROM training_config WHERE id=1").get();
  return {
    ftp:
      typeof row?.ftp === "number" && row.ftp >= 50 && row.ftp <= 600
        ? row.ftp
        : 220,
    goal:
      typeof row?.goal === "string"
        ? row.goal
        : "Miglioramento FTP e prestazione in salita",
    duration:
      typeof row?.workout_duration_min === "number"
        ? row.workout_duration_min
        : 60,
    weeks: typeof row?.plan_weeks === "number" ? row.plan_weeks : 8,
    start:
      typeof row?.start_date === "string" && validDate(row.start_date)
        ? row.start_date
        : null,
    targetWeight: row?.target_weight ?? null,
  };
}
export function updateTrainingConfig(
  db: DatabaseSync,
  args: string,
  now: Date,
) {
  const match =
    /^(ftp|target_weight|workout_duration_min|plan_weeks|start_date|goal)\s+(.+)$/i.exec(
      args,
    );
  if (!match) throw new ProviderError("settings");
  const key = match[1].toLowerCase();
  let value: string | number = match[2].trim();
  const bounds: Record<string, [number, number]> = {
    ftp: [50, 600],
    target_weight: [30, 250],
    workout_duration_min: [15, 300],
    plan_weeks: [2, 52],
  };
  if (bounds[key]) {
    value = Number(value.replace(",", "."));
    if (
      !Number.isFinite(value) ||
      value < bounds[key][0] ||
      value > bounds[key][1] ||
      (key !== "target_weight" && !Number.isInteger(value))
    )
      throw new ProviderError("settings");
  } else if (key === "start_date") {
    const m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(value);
    if (m) value = `${m[3]}-${m[2]}-${m[1]}`;
    if (!validDate(value)) throw new ProviderError("settings");
  } else if (value.length > 500) throw new ProviderError("settings");
  // key is selected exclusively from the closed enumeration above.
  db.prepare("INSERT OR IGNORE INTO training_config(id) VALUES(1)").run();
  db.prepare(`UPDATE training_config SET ${key}=?,updated_at=? WHERE id=1`).run(
    value,
    now.toISOString(),
  );
}
export function templateDuration(structure: string) {
  if (structure.includes("Rest 1d")) return 0;
  let sum = 0,
    block = 0,
    multiple = 1;
  for (const line of (structure + "\n").split("\n")) {
    if (!line.trim()) {
      sum += block * multiple;
      block = 0;
      multiple = 1;
      continue;
    }
    const repeat = /^(\d+)x$/.exec(line.trim());
    if (repeat) {
      sum += block * multiple;
      block = 0;
      multiple = Number(repeat[1]);
      continue;
    }
    const duration =
      /^- (?:Warm up |Cooldown )?((?:\d+(?:\.\d+)?[hms]\s*)+)/.exec(line);
    if (duration)
      for (const m of duration[1].matchAll(/(\d+(?:\.\d+)?)([hms])/g))
        block += Number(m[1]) * ({ h: 60, m: 1, s: 1 / 60 }[m[2]] || 0);
  }
  return Math.round(sum * 100) / 100;
}
export function peakPower(structure: string) {
  const values = [...structure.matchAll(/(\d+)(?:-(\d+))?%/g)].flatMap((m) => [
    Number(m[1]),
    Number(m[2] || m[1]),
  ]);
  return Math.max(0, ...values);
}
export function selectWorkout(
  db: DatabaseSync,
  result: Result,
  now: Date,
  request = "allenamento",
) {
  const config = trainingConfig(db),
    date = today(now);
  const week =
    config.start && config.start <= date
      ? Math.min(
          config.weeks,
          Math.floor(
            (Date.parse(date) - Date.parse(config.start)) / 604800000,
          ) + 1,
        )
      : null;
  const progress = week === null ? null : (week - 1) / (config.weeks - 1),
    phase =
      progress === null
        ? "non determinabile: configurare start_date"
        : progress < 0.25
          ? "base"
          : progress < 0.5
            ? "costruzione"
            : progress < 0.75
              ? "specifica"
              : week === config.weeks
                ? "scarico"
                : "picco";
  const rank = [
    "riposo",
    "recupero",
    "endurance",
    "tempo",
    "sweet spot/soglia",
    "VO2max",
  ];
  let level = rank.indexOf(result.recommendation);
  if (result.score === null || result.confidence < 75 || week === null)
    level = Math.min(level, 2);
  if (phase === "scarico") level = Math.min(level, 2);
  if (phase === "base" || phase === "costruzione") level = Math.min(level, 4);
  const recent = result.metrics.intensityAssessments.filter(
    (a) => a.date >= shift(date, -2) && a.status !== "non_determinabile",
  );
  if (recent.length) level = Math.min(level, 2);
  const high = result.metrics.intensityAssessments.some(
    (a) =>
      a.date >= shift(date, -3) &&
      a.reasons.some((r) => /vo2|sprint|anaerob/i.test(r)),
  );
  if (high) level = Math.min(level, 4);
  const load48 = db
    .prepare(
      "SELECT COUNT(*) n,SUM(training_load) total FROM training_activities WHERE activity_date BETWEEN ? AND ?",
    )
    .get(shift(date, -1), date)!;
  if (Number(load48.total) >= 95) level = Math.min(level, 2);
  const names = db
    .prepare("SELECT name FROM training_activities WHERE activity_date>=?")
    .all(shift(date, -10))
    .map((r) => String(r.name || ""));
  if (
    level >= 4 &&
    names.filter((n) => /sweet spot|threshold|soglia/i.test(n)).length >= 2 &&
    !names.some((n) => /tempo|sfr/i.test(n))
  )
    level = 3;
  if (request === "leggero") level = Math.min(level, 2);
  const requested = /vo2/i.test(request)
    ? 5
    : /\b(ss|soglia|sweet spot)\b/i.test(request)
      ? 4
      : /tempo|forza/i.test(request)
        ? 3
        : /recupero/i.test(request)
          ? 1
          : /endurance/i.test(request)
            ? 2
            : level;
  level = Math.min(level, requested); // Requests can lower the ceiling; never override recovery.
  const ceiling = [0, 60, 75, 100, 105, 130][level];
  let candidates = catalog.filter((w) =>
    level === 0
      ? w.difficulty === 0
      : w.difficulty > 0 &&
        templateDuration(w.structure) <= config.duration &&
        peakPower(w.structure) <= ceiling &&
        (phase !== "base" || w.difficulty <= 2),
  );
  const preferred = (w: (typeof catalog)[number]) =>
    level === 1
      ? /^Recovery/.test(w.name)
      : level === 2
        ? /^Endurance/.test(w.name)
        : level === 3
          ? /^(Tempo|Threshold & SFR)/.test(w.name)
          : level === 4
            ? /^(Sweet Spot|Threshold)/.test(w.name)
            : /^VO2Max/.test(w.name);
  const matching = candidates.filter(preferred);
  if (matching.length) candidates = matching;
  const histories = db
    .prepare(
      "SELECT payload,created_at FROM workout_proposals WHERE created_at>=? ORDER BY created_at DESC",
    )
    .all(new Date(now.getTime() - 14 * 86400000).toISOString());
  const used = new Map(
    histories.map((h) => [
      JSON.parse(String(h.payload)).workout.name as string,
      String(h.created_at),
    ]),
  );
  const activities = db
    .prepare(
      "SELECT name,activity_date FROM training_activities WHERE activity_date>=? ORDER BY activity_date DESC",
    )
    .all(shift(date, -14));
  for (const a of activities)
    if (typeof a.name === "string" && !used.has(a.name))
      used.set(a.name, String(a.activity_date));
  candidates.sort(
    (a, b) =>
      Number(used.has(a.name)) - Number(used.has(b.name)) ||
      String(used.get(a.name) || "").localeCompare(
        String(used.get(b.name) || ""),
      ) ||
      Math.abs(templateDuration(a.structure) - config.duration) -
        Math.abs(templateDuration(b.structure) - config.duration) ||
      a.name.localeCompare(b.name),
  );
  const workout = candidates[0] || {
    name:
      level <= 1 ? "Recupero breve controllato" : "Endurance breve controllata",
    structure: `- ${config.duration}m ${level <= 1 ? "45-55" : "55-65"}% power=3s`,
    difficulty: 1,
  };
  return {
    workout,
    duration: templateDuration(workout.structure),
    config,
    week,
    phase,
    recommendation: rank[level],
    readiness: result.score,
    confidence: result.confidence,
    reasons: result.reasons,
    metrics: {
      ctl: result.metrics.ctl,
      atl: result.metrics.atl,
      tsb: result.metrics.tsb,
    },
    date,
  };
}
export type Proposal = ReturnType<typeof selectWorkout> & {
  explanation?: string;
};
export function renderWorkout(p: Proposal, id: string) {
  return `Nome: ${p.workout.name}\nDurata Stimata: ${p.duration} min · FTP ${p.config.ftp} W\nPiano: ${p.week === null ? "inizio non configurato" : `${p.week}/${p.config.weeks}`} (${p.phase}). Obiettivo: ${p.config.goal}\nReadiness ${p.readiness ?? "n/d"}, confidence ${p.confidence}/100; CTL ${p.metrics.ctl ?? "n/d"}, ATL ${p.metrics.atl ?? "n/d"}, TSB ${p.metrics.tsb ?? "n/d"}.\n${p.reasons.slice(0, 3).join(" ")}${p.explanation ? `\nCommento AI: ${p.explanation}` : ""}\n[WORKOUT_START]\n${p.workout.structure}\n[WORKOUT_END]\nProposta ${id}. “accetta” carica su Intervals soltanto se la scrittura è abilitata. “leggero” riduce il carico.`;
}
