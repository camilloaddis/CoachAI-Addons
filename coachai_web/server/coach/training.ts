import { goalFit, goalFocus } from "./workout-goals.js";
import type { WorkoutAdvice } from "./workout-advisor.js";
import { libraryCandidates, librarySelectionNote, plannedCategory, plannedIntensitySafety, type CatalogWorkout } from "./library-catalog.js";
import { categoryLevel, categoryLabels, validateIntent } from "./intent.js";
import { dailyLoadTarget, planAutomatic, recommendations } from "./planner.js";
import { physiologicalAvailability } from "../readiness/physiology.js";
import { readSnapshot } from "../readiness/sources.js";
import { assessIntensity } from "../readiness/intensity.js";
import type { DatabaseSync } from "node:sqlite";
import { workoutLibraryRepository } from "../storage/workout-library.js";
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
  status: "ready" | "rest" | "no_compatible_workout";
  workout: CatalogWorkout | null;
  plannerRecommendation: Recommendation;
  proposedCategory: import("../readiness/types.js").TrainingCategory | null;
  substitutionReason: string | null;
  noWorkoutReason: string | null;
  selectionDiagnostics: { available: number; compatible: number; classified: number; excluded: { normalization: number; classificationOrSport: number; category: number; duration: number; intensity: number; phase: number; duplicate: number; previous: number; loadMissing: number; loadBand: number }; eligible: number; shortlist: number; syncState: string; reasons: string[] };
  loadTarget: import("./planner.js").DailyLoadTarget;
  advisor?: WorkoutAdvice;
  catalogSource: "intervals" | "none";
  catalogNote: string;
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
  libraryAccount?: string,
  previousWorkout?: CatalogWorkout,
  collectCandidates?: (candidates: CatalogWorkout[]) => void,
): WorkoutSelection {
  intent = validateIntent(intent);
  const manual = intent.mode === "manual";
  if (intent.mode === "automatic" && intent.preference !== "recommended")
    request = intent.preference === "lighter" ? "leggero" : "intenso";
  const config = trainingConfig(db),
    date = today(now);
  const snapshot = readSnapshot(db, date, now);
  const historical = snapshot.activities.map(assessIntensity);
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
  const remote = libraryCandidates(db, libraryAccount);
  const repo = workoutLibraryRepository(db);
  const validAccount = !!libraryAccount && /^i?[1-9]\d{0,19}$/.test(libraryAccount);
  const inventory = validAccount ? repo.list(libraryAccount!, { availableOnly: true }) : [];
  const sync = validAccount ? repo.syncState(libraryAccount!) : null;
  const excluded = { normalization: inventory.filter(w => !w.compatible).length,
    classificationOrSport: inventory.filter(w => w.compatible).length - remote.length,
    category: 0, duration: 0, intensity: 0, phase: 0, duplicate: 0, previous: 0, loadMissing: 0, loadBand: 0 };
  const minutes = (w: CatalogWorkout) => w.library!.normalized.durationSeconds / 60;
  const targetDuration = config.duration;
  const coverage14 = db.prepare('SELECT COUNT(*) n FROM activity_coverage WHERE date BETWEEN ? AND ? AND complete=1').get(shift(date,-14),shift(date,-1));
  const loadTarget = dailyLoadTarget({date, score:result.score,
    level:Math.min(level, physiologicalAvailability(result.score) ?? 1),phase,goal:goalFocus(config.goal),duration:config.duration,
    ctl:result.metrics.ctl,historyComplete:result.planningContext?.historyComplete === true && !result.planningContext.missingActivityLoad && coverage14?.n === 14,
    activities:snapshot.activities,load48:typeof load48==='number' ? load48 : null});
  const distance = (w:CatalogWorkout) => loadTarget.target === null ? 0 : Math.abs(w.library!.trainingLoad! - loadTarget.target);
  const above = (w:CatalogWorkout) => Number(loadTarget.target !== null && loadTarget.preferBelow && w.library!.trainingLoad! > loadTarget.target);
  const preferred = (w: CatalogWorkout) => intent.mode === "manual" ? w.library!.category === intent.category :
    categoryLevel[w.library!.category] > 0 && categoryLevel[w.library!.category] <= level;
  const categoryCandidates = remote.filter(preferred);
  excluded.category = remote.length - categoryCandidates.length;
  let candidates = categoryCandidates.filter(w => {
    if (!workoutWithinDuration(w,config.duration)) { excluded.duration++; return false; }
    if (!plannedIntensitySafety(w.library!.normalized,level).allowed) { excluded.intensity++; return false; }
    if (!manual && phase === "base" && w.difficulty > 2) { excluded.phase++; return false; }
    if (w.library!.trainingLoad == null) { excluded.loadMissing++; return false; }
    // A manual category is explicit: automatic load guidance must not veto it.
    // The ideal +/-20% band ranks work; observed capacity remains the hard cap.
    if (physiologicalAvailability(result.score) === 0 || (!manual && (loadTarget.target === null || loadTarget.target === 0 || w.library!.trainingLoad > (loadTarget.baseline ?? loadTarget.maximum)!))) { excluded.loadBand++; return false; }
    return true;
  });
  // Preserve the planned stimulus when its category has safe available work.
  // Lower categories remain real alternatives only when that category is empty.
  if (!manual && candidates.some(w => categoryLevel[w.library!.category] === level)) {
    const primary=candidates.filter(w => categoryLevel[w.library!.category] === level);
    excluded.category += candidates.length-primary.length;
    candidates=primary;
  }
  const beforeDedup = candidates.length;
  // Stable identity independent of provider enumeration order and display name.
  candidates.sort((a,b) => above(b)-above(a) || distance(b)-distance(a) || b.library!.id-a.library!.id);
  candidates = [...new Map(candidates.map(w => [w.library!.fingerprint,w])).values()];
  excluded.duplicate = beforeDedup-candidates.length;
  const identity = (w: CatalogWorkout) => w.library ? `${w.library.account}:${w.library.fingerprint}` : w.name;
  const histories = db
    .prepare(
      "SELECT payload,created_at FROM workout_proposals WHERE created_at>=? ORDER BY created_at DESC,rowid DESC",
    )
    .all(new Date(now.getTime() - 14 * 86400000).toISOString());
  const used = new Map<string, number>();
  for (const [index, h] of histories.entries()) {
    const w = JSON.parse(String(h.payload)).workout as CatalogWorkout;
    if (w && !used.has(identity(w))) used.set(identity(w), histories.length - index);
  }
  const activities = db
    .prepare(
      "SELECT name,activity_date FROM training_activities WHERE activity_date>=? ORDER BY activity_date DESC",
    )
    .all(shift(date, -14));
  for (const a of activities)
    if (typeof a.name === "string" && !used.has(a.name))
      used.set(a.name, 0);
  candidates.sort(
    (a, b) =>
      above(a)-above(b) || distance(a)-distance(b) ||
      (manual ? 0 : categoryLevel[b.library!.category]-categoryLevel[a.library!.category]) ||
      goalFit(b, goalFocus(config.goal)) - goalFit(a, goalFocus(config.goal)) ||
      Number(used.has(identity(a))) - Number(used.has(identity(b))) ||
      (used.get(identity(a)) ?? 0) - (used.get(identity(b)) ?? 0) ||
      Math.abs(minutes(a) - targetDuration) -
        Math.abs(minutes(b) - targetDuration) ||
      a.name.localeCompare(b.name),
  );
  const alternativeCount = candidates.length;
  if (regenerate && candidates.length > 1 && (previousWorkout || histories.length)) {
    const previous = previousWorkout ?? JSON.parse(String(histories[0].payload)).workout as CatalogWorkout;
    if (previous) { const before=candidates.length; candidates = candidates.filter(w => identity(w) !== identity(previous)); excluded.previous=before-candidates.length; }
  }
  // AI may optimize goal/phase only within the nearest load neighbourhood.
  const policyCandidates = candidates.filter(w => above(w) === (candidates[0] ? above(candidates[0]) : 0) &&
    distance(w) <= (candidates[0] ? distance(candidates[0]) : 0) + Math.max(2,(loadTarget.target ?? 0)*.05));
  const unused = policyCandidates.filter(w => !used.has(identity(w)));
  const eligible = unused.length ? unused : policyCandidates.slice(0, 1);
  const shortlist = representativeShortlist(eligible);
  collectCandidates?.(shortlist);
  for (const c of constraints)
    c.blocksRequested = request !== "leggero" && c.ceiling === level && c.ceiling < requested;
  const workout = eligible[0] ?? null;
  const failureReasons: string[] = [];
  if (!workout && level !== 0) {
    if (!manual && loadTarget.target === null) failureReasons.push("load_target_unavailable");
    if (!validAccount) failureReasons.push("library_not_configured");
    else if (!inventory.length) failureReasons.push(sync && sync.status !== 'complete' ? "sync_failed" : "library_empty");
    else if (!remote.length) failureReasons.push("no_classifiable_workouts");
    else if (!categoryCandidates.length) failureReasons.push("category_absent");
    else {
      if (excluded.duration) failureReasons.push("duration_limit");
      if (excluded.intensity) failureReasons.push("intensity_limit");
      if (excluded.phase) failureReasons.push("plan_phase");
      if (excluded.loadMissing) failureReasons.push("workout_load_missing");
      if (excluded.loadBand && loadTarget.target !== null) failureReasons.push("load_band");
    }
    if (!manual && constraints.some(c => c.applied && c.ceiling < requested)) failureReasons.push("physiological_or_planner_limits");
  }
  const messages: Record<string,string> = {
    library_not_configured:"Collega Intervals e sincronizza la libreria nelle Impostazioni.",
    library_empty:"La libreria locale è vuota: sincronizza i workout dalle Impostazioni.",
    sync_failed:"Sincronizzazione incompleta o fallita, senza workout disponibili: riprova dalle Impostazioni.",
    no_classifiable_workouts:"Nessun workout locale ha una struttura ciclistica classificabile.",
    category_absent:"La categoria compatibile con questa richiesta non è presente nella libreria.",
    load_target_unavailable:loadTarget.reasons.join(" "),
    workout_load_missing:"I workout non hanno un icu_training_load valido: sincronizza la libreria; nessun carico stimato.",
    load_band:"Nessun workout rispetta il limite superiore di carico automatico o il limite fisiologico di riposo.",
    duration_limit:"I workout della categoria non sono entro ±10 minuti dalla durata selezionata; nessuno step viene tagliato.",
    intensity_limit:"I target dei workout superano i limiti di intensità ammessi, inclusi durata e ampiezza dei picchi.",
    plan_phase:"I workout non sono compatibili con la fase del piano.",
    physiological_or_planner_limits:"Recupero o programmazione limitano la categoria consigliata: consulta le regole applicate.",
  };
  const noWorkoutReason = level === 0 ? "Riposo consigliato: nessun workout da generare o pubblicare." : workout ? null : failureReasons.map(r=>messages[r]).join(" ");
  // Compare against the complete automatic selection, including catalog and
  // duration fallbacks. Reuse the same code; the automatic call never recurses.
  const automatic: { recommendation: Recommendation; constraints: Constraint[] } | null = manual ? selectWorkout(db, result, now, "allenamento", false,
    { mode: "automatic", preference: "recommended" }, libraryAccount) : null;
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
    status: level === 0 ? "rest" : workout ? "ready" : "no_compatible_workout",
    plannerRecommendation: plan.recommendation,
    proposedCategory: workout?.library?.category ?? null,
    substitutionReason: rank[level] !== plan.recommendation ? (manual ? "explicit_request" : "request_or_safety_limit") : null,
    noWorkoutReason,
    selectionDiagnostics: { available:inventory.length, compatible:inventory.length-excluded.normalization, classified:remote.length, excluded, eligible:candidates.length, shortlist:shortlist.length, syncState:sync?.status ?? "never_synced", reasons:failureReasons },
    workout,
    loadTarget,
    catalogSource: workout ? "intervals" : "none",
    catalogNote: workout ? librarySelectionNote(workout,config.duration,level) + (manual ? " Scelta manuale: il target di carico del Coach è indicativo; categoria richiesta, durata e controlli dei picchi sono verificati." : workout.library!.trainingLoad! < loadTarget.minimum! || workout.library!.trainingLoad! > loadTarget.maximum! ? " Carico fuori dalla banda ideale: scelto il workout reale sicuro più vicino disponibile, entro la capacità osservata e senza modificare la struttura." : "") + (regenerate && alternativeCount <= 1 ? " Nessuna alternativa compatibile: mantenuto l'unico workout disponibile." : "") : noWorkoutReason!,
    requestCommand: request,
    requestSatisfied: !workout ? level === 0 && requested === 0 : manual ? true :
      request === "leggero"
        ? level <= 2
        : ["allenamento", "pianifica"].includes(request)
          ? true
          : level === requested,
    requested: rank[requested],
    constraints,
    limitingFactors: constraints.filter((c) => c.blocksRequested),
    duration: workout ? minutes(workout) : 0,
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

/** Shared by generation, acceptance and calendar publication; never trims steps. */
export function workoutWithinDuration(w: CatalogWorkout, configured: number) {
  return !!w.library && Math.abs(w.library.normalized.durationSeconds / 60 - configured) <= 10;
}
/** Preserve the first deterministic choice and sample duration/interval-shape strata.
 * Only already-safe, distinct, rotation-eligible candidates enter this function. */
export function representativeShortlist(candidates: CatalogWorkout[], max = 8): CatalogWorkout[] {
  const groups = new Map<string,CatalogWorkout[]>();
  for (const w of candidates) {
    const n=w.library!.normalized;
    const key=`${w.library!.category}:${Math.floor(n.durationSeconds/900)}:${n.expandedSegments <= 12 ? 'sustained' : 'repeated'}`;
    groups.set(key,[...(groups.get(key)??[]),w]);
  }
  const out: CatalogWorkout[]=[];
  while(out.length<max && [...groups.values()].some(g=>g.length)) for(const group of groups.values()) {
    if(group.length && out.length<max) out.push(group.shift()!);
  }
  return out;
}

export function workoutStillSafe(w: CatalogWorkout, selection: WorkoutSelection) {
  if (!w.library || !workoutWithinDuration(w,selection.config.duration)) return false;
  const load=w.library.trainingLoad;
  const manual=selection.decision.intent.mode === 'manual';
  if (physiologicalAvailability(selection.readiness) === 0 || load == null || !Number.isFinite(load) || (!manual && (selection.loadTarget?.target == null || selection.loadTarget.target === 0 || load > (selection.loadTarget.baseline ?? selection.loadTarget.maximum)!))) return false;
  const category=plannedCategory(w.library.normalized);
  return category === w.library.category && (!manual || category === selection.decision.intent.category) && plannedIntensitySafety(w.library.normalized,recommendations.indexOf(selection.recommendation)).allowed;
}
