import { categoryLevel, categoryLabels, validateIntent } from "./intent.js";
import { planAutomatic, recommendations } from "./planner.js";
import { physiologicalAvailability } from "../readiness/physiology.js";
import { readSnapshot } from "../readiness/sources.js";
import { assessIntensity } from "../readiness/intensity.js";
import type { DatabaseSync } from "node:sqlite";
import { catalog } from "./catalog.js";
import {
  validDate,
  today,
  shift,
  type Result,
  type Constraint,
  type TrainingIntent,
  type Factor,
  type Recommendation,
} from "../readiness/types.js";
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
export type WorkoutSelection = {
  decision: {
    intent: TrainingIntent;
    automaticRecommendation: Recommendation;
    exceedsRecommendation: boolean;
    warnings: Factor[];
    advisoryConstraints: Constraint[];
  };
  workout: { name: string; structure: string; difficulty: number };
  requestCommand: string;
  requestSatisfied: boolean;
  requested: Recommendation;
  constraints: Constraint[];
  limitingFactors: Constraint[];
  duration: number;
  config: ReturnType<typeof trainingConfig>;
  week: number | null;
  phase: string;
  recommendation: Recommendation;
  readiness: number | null;
  confidence: number;
  reasons: string[];
  metrics: { ctl: number | null; atl: number | null; tsb: number | null };
  date: string;
};
export function selectWorkout(
  db: DatabaseSync,
  result: Result,
  now: Date,
  request = "allenamento",
  regenerate = false,
  intent: TrainingIntent = { mode: "automatic", preference: request === "leggero" ? "lighter" : request === "intenso" ? "harder" : "recommended" },
): WorkoutSelection {
  intent = validateIntent(intent);
  const manual = intent.mode === "manual";
  if (intent.mode === "automatic" && intent.preference !== "recommended")
    request = intent.preference === "lighter" ? "leggero" : "intenso";
  const config = trainingConfig(db),
    date = today(now);
  const historical = readSnapshot(db, date, now).activities.map(assessIntensity);
  const load48 = db.prepare(
    "SELECT SUM(training_load) total FROM training_activities WHERE activity_date BETWEEN ? AND ?",
  ).get(shift(date, -1), date)?.total;
  const plan = planAutomatic({
    date, score: result.score,
    assessments: result.metrics.intensityAssessments,
    context: result.planningContext ?? {
      wellnessAvailable: result.score !== null,
      wellnessComplete: !result.constraints.some(c => c.code === "wellness_incomplete"),
      historyComplete: !result.constraints.some(c => c.code === "history_incomplete"),
      missingActivityLoad: result.constraints.some(c => c.code === "activity_load_missing"),
    },
    config, historical,
    physiologyReasons: result.physiology?.adjustments.filter(a => a.applied).map(a => a.reason),
    load48: typeof load48 === "number" ? load48 : null,
  });
  const { week, phase } = plan;
  const rank = recommendations;
  let level = intent.mode === "manual" ? categoryLevel[intent.category] : rank.indexOf(plan.recommendation);
  const constraints: Constraint[] = (manual ? [] : plan.constraints).map((c) => ({
    ...c,
  }));
  function limit(
    code: string,
    category: Constraint["category"],
    evidence: Constraint["evidence"],
    ceiling: number,
    text: string,
  ) {
    const before = level;
    level = Math.min(level, ceiling);
    constraints.push({
      code,
      category,
      evidence,
      ceiling,
      text,
      polarity:
        evidence === "missing" || evidence === "inferred"
          ? "uncertain"
          : evidence === "measured"
            ? "negative"
            : "neutral",
      before,
      after: level,
      applied: level < before,
      source: "training",
    });
  }
  if (!manual && request === "leggero")
    limit(
      "lighter_request",
      "request",
      "policy",
      2,
      "Richiesta leggero: massimo endurance.",
    );
  const requested = intent.mode === "manual" ? categoryLevel[intent.category] :
    request === "leggero"
      ? 2
      : /vo2/i.test(request)
        ? 5
        : /\b(ss|soglia|sweet spot)\b/i.test(request)
          ? 4
          : /tempo|forza/i.test(request)
            ? 3
            : /recupero/i.test(request)
              ? 1
              : /endurance/i.test(request)
                ? 2
                : request === "intenso"
                  ? 5
                  : (physiologicalAvailability(result.score) ?? 1);
  if (!manual) limit(
    "request_ceiling",
    "request",
    "policy",
    requested,
    "La richiesta può ridurre il carico, non superare i vincoli di recupero.",
  );
  const ceiling = [0, 60, 75, 100, 105, 130][level];
  const recoveryVariants = [20, 30, 45].map((minutes) => ({
    name: `Recovery ${minutes} controllato`,
    structure: `- ${minutes}m 45-55% power=3s`,
    difficulty: 1,
  }));
  const pool = level === 1 ? recoveryVariants : catalog;
  const targetDuration =
    request === "leggero" ? Math.min(30, config.duration) : config.duration;
  let candidates = pool.filter((w) =>
    level === 0
      ? w.difficulty === 0
      : w.difficulty > 0 &&
        templateDuration(w.structure) <= config.duration &&
        peakPower(w.structure) <= ceiling &&
        (manual || phase !== "base" || w.difficulty <= 2),
  );
  const preferred = (w: (typeof catalog)[number]) => {
    if (intent.mode === "manual") {
      const patterns = {
        rest: /^Riposo/, recovery: /^Recovery/, endurance: /^Endurance/,
        tempo: /^Tempo/, sweet_spot: /^Sweet Spot/, threshold: /^Threshold(?!.*SFR)/,
        vo2max: /^VO2Max/, strength: /^Threshold & SFR/,
      };
      return patterns[intent.category].test(w.name);
    }
    return level === 1
      ? /^Recovery/.test(w.name)
      : level === 2
        ? /^Endurance/.test(w.name)
        : level === 3
          ? request === "forza"
            ? /^Threshold & SFR/.test(w.name)
            : /^(Tempo|Threshold & SFR)/.test(w.name)
          : level === 4
            ? /^(Sweet Spot|Threshold)/.test(w.name)
            : /^VO2Max/.test(w.name);
  };
  const matching = candidates.filter(preferred);
  if (matching.length || manual) candidates = matching;
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
      (request === "leggero" && !regenerate
        ? Math.abs(templateDuration(a.structure) - targetDuration) -
          Math.abs(templateDuration(b.structure) - targetDuration)
        : 0) ||
      Number(used.has(a.name)) - Number(used.has(b.name)) ||
      String(used.get(a.name) || "").localeCompare(
        String(used.get(b.name) || ""),
      ) ||
      Math.abs(templateDuration(a.structure) - targetDuration) -
        Math.abs(templateDuration(b.structure) - targetDuration) ||
      a.name.localeCompare(b.name),
  );
  if (!manual && level > 2 && !matching.length) {
    limit(
      "catalog_unavailable",
      "plan",
      "policy",
      2,
      "Nessuna struttura della categoria richiesta compatibile con durata e picco: endurance controllata.",
    );
    candidates = catalog.filter(
      (w) =>
        /^Endurance/.test(w.name) &&
        templateDuration(w.structure) <= config.duration &&
        peakPower(w.structure) <= 75,
    );
  }
  for (const c of constraints)
    c.blocksRequested = request !== "leggero" && c.ceiling === level && c.ceiling < requested;
  const manualFallback = intent.mode === "manual" ? {
    name: `${categoryLabels[intent.category]} — proposta breve manuale`,
    difficulty: intent.category === "rest" ? 0 : 1,
    structure: intent.category === "rest" ? "- Rest 1d" : intent.category === "vo2max"
      ? "- Warm up 3m 50-65% power=3s\n\n3x\n- 1m 115% power=3s\n- 2m 50-55% power=3s\n\n- Cooldown 3m 50-45% power=3s"
      : `- Warm up 3m 45-55% power=3s\n- ${config.duration - 6}m ${{ recovery: "45-55", endurance: "60-70", tempo: "76-85", sweet_spot: "88-94", threshold: "95-100", strength: "75-85" }[intent.category]}% ${intent.category === "strength" ? "50-60rpm " : ""}power=3s\n- Cooldown 3m 50-45% power=3s`,
  } : null;
  const workout = candidates[0] || manualFallback || {
    name:
      level <= 1 ? "Recupero breve controllato" : "Endurance breve controllata",
    structure: `- ${config.duration}m ${level <= 1 ? "45-55" : "55-65"}% power=3s`,
    difficulty: 1,
  };
  // Compare against the complete automatic selection, including catalog and
  // duration fallbacks. Reuse the same code; the automatic call never recurses.
  const automatic: { recommendation: Recommendation; constraints: Constraint[] } | null = manual ? selectWorkout(db, result, now, "allenamento", false,
    { mode: "automatic", preference: "recommended" }) : null;
  const automaticRecommendation = automatic?.recommendation ?? rank[level];
  const advisoryConstraints = automatic?.constraints ?? plan.constraints;
  const recommendedLevel = rank.indexOf(automaticRecommendation);
  const warnings: Factor[] = manual ? [
    ...result.factors.filter(f => (f.polarity === "negative" || f.polarity === "uncertain") &&
      (f.category !== "feedback" || ["legs_current", "negative_legs", "conflicting_feedback"].includes(f.code))),
    ...advisoryConstraints.filter(c => c.ceiling < requested && c.code !== "request_ceiling"),
    ...(requested > recommendedLevel ? [{
      code: "manual_exceeds_recommendation", category: "request" as const,
      polarity: "negative" as const, evidence: "policy" as const,
      text: `Richiesta manuale ${intent.mode === "manual" ? categoryLabels[intent.category] : ""} superiore al consiglio automatico ${automaticRecommendation}. Readiness ${result.score ?? "non valutabile"}/100, Confidence ${result.confidence}/100: recupero e carico richiedono attenzione.`,
    }] : []),
  ] : [];
  return {
    decision: {
      intent,
      automaticRecommendation,
      exceedsRecommendation: manual && requested > recommendedLevel,
      warnings: [...new Map(warnings.map(w => [w.code, w])).values()],
      advisoryConstraints: manual ? advisoryConstraints : [],
    },
    workout,
    requestCommand: request,
    requestSatisfied: manual ? true :
      request === "leggero"
        ? level <= 2
        : ["allenamento", "pianifica"].includes(request)
          ? true
          : level === requested,
    requested: rank[requested],
    constraints,
    limitingFactors: constraints.filter((c) => c.blocksRequested),
    duration: templateDuration(workout.structure),
    config,
    week,
    phase,
    recommendation: rank[level],
    readiness: result.score,
    confidence: result.confidence,
    reasons: [...new Set([...result.factors.filter(f => !result.constraints.some(c => c.code === f.code)).map(f => f.text), ...plan.reasons.map(f => f.text)])],
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
