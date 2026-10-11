import { physiologicalAvailability } from "../readiness/physiology.js";
import { shift, validDate, type AutomaticTrainingDecision, type Constraint, type Factor, type IntensityAssessment, type Recommendation } from "../readiness/types.js";

export const recommendations: Recommendation[] = ["riposo", "recupero", "endurance", "tempo", "sweet spot/soglia", "VO2max"];
export type PlanningContext = {
  wellnessAvailable: boolean;
  wellnessComplete: boolean;
  historyComplete: boolean;
  missingActivityLoad: boolean;
};
type PlannerInput = {
  date: string;
  score: number | null;
  assessments: IntensityAssessment[];
  context: PlanningContext;
  config?: { start: string | null; weeks: number };
  historical?: IntensityAssessment[];
  load48?: number | null;
  physiologyReasons?: string[];
};
/** Pure automatic decision. Confidence and requests deliberately have no input. */
export function planAutomatic(input: PlannerInput): AutomaticTrainingDecision & {
  day: string; week: number | null; phase: string;
} {
  const { date, score, context } = input;
  if (!validDate(date)) throw Error("Invalid planning date");
  const availability = physiologicalAvailability(score);
  let level = availability ?? 1;
  const constraints: Constraint[] = [], reasons: Factor[] = [];
  function reason(code: string, category: Factor["category"], evidence: Factor["evidence"], text: string): Factor {
    const f: Factor = { code, category, evidence, text, polarity: evidence === "missing" || evidence === "inferred" ? "uncertain" : "neutral" };
    reasons.push(f); return f;
  }
  function limit(code: string, category: Factor["category"], evidence: Factor["evidence"], ceiling: number, text: string) {
    const f = reason(code, category, evidence, text), before = level;
    level = Math.min(level, ceiling);
    constraints.push({ ...f, ceiling, before, after: level, applied: level < before, source: "training" });
  }
  if (availability !== null && availability < 5)
    limit("physiological_availability", "physiology", "policy", availability, `Readiness ${score}/100: disponibilità fisiologica massima ${recommendations[availability]}. ${(input.physiologyReasons ?? []).join(" ")}`.trim());
  if (score === null)
    limit("training_assessment_unavailable", "data", "missing", 1, "Readiness non valutabile: recupero come fallback, non prova di affaticamento.");
  if (!context.wellnessAvailable)
    limit("wellness_absent", "data", "missing", 1, "Wellness odierno assente: nessun dato precedente usato come dato di oggi.");
  else if (!context.wellnessComplete)
    limit("wellness_incomplete", "data", "missing", 2, "Wellness o baseline fisiologiche incompleti: proposta automatica prudenziale, nessuna fatica dedotta.");
  if (!context.historyComplete)
    limit("history_incomplete", "data", "missing", 2, "Copertura dello storico non verificata: proposta automatica prudenziale.");
  if (context.missingActivityLoad)
    limit("activity_load_missing", "data", "missing", 2, "Carico di una o più attività assente: carico totale non noto.");
  const recent = input.assessments.filter(a => validDate(a.date) && a.date >= shift(date, -6) && a.date <= date);
  const measured = recent.filter(a => a.isHard === true && a.evidence === "measured" && a.status !== "non_determinabile");
  const hard = new Set(measured.map(a => a.date));
  let consecutive = 0;
  for (let d = hard.has(date) ? date : shift(date, -1); hard.has(d); d = shift(d, -1)) consecutive++;
  if (consecutive >= 2)
    limit("consecutive_intensity", "activity", "measured", 1, `${consecutive} giornate consecutive con intensità eseguita misurata: interrompere la sequenza.`);
  else if (measured.some(a => a.date >= shift(date, -2)))
    limit("training_recent_intensity", "activity", "measured", 2, "Intensità eseguita misurata oggi o nei due giorni precedenti: massimo endurance per distribuire gli stimoli.");
  // This wider window adds a distinct prohibition on VO2 when the 48h rule expires.
  if (measured.some(a => a.highIntensity === true && a.date >= shift(date, -3)))
    limit("high_intensity_72h", "activity", "measured", 4, "Alta intensità eseguita oggi o nei tre giorni precedenti: evitare VO2max.");
  if (recent.some(a => a.status === "non_determinabile"))
    reason("unknown_intensity", "data", "missing", "Intensità recente sconosciuta: non prova una seduta intensa o facile; nessun ceiling di intensità.");
  if (recent.some(a => a.status === "probabile" && a.evidence !== "measured"))
    reason("probable_intensity", "activity", "inferred", "Intensità recente solo probabile senza esecuzione misurata: avviso, non prova di affaticamento e nessun ceiling.");
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const day = weekday === 1 || weekday === 5 ? "strutturato" : weekday >= 2 && weekday <= 4 ? "commuting" : "lungo weekend";
  if (day !== "strutturato") limit("weekly_schedule", "schedule", "policy", 2, `${day}: endurance secondo il piano settimanale.`);
  else if (weekday === 1) limit("monday_schedule", "schedule", "policy", 4, "Lunedì: privilegiare Sweet Spot/soglia per FTP e salita.");
  else reason("friday_schedule", "schedule", "policy", "Venerdì: stimolo VO2max se compatibile con disponibilità fisiologica e storico misurato.");
  const config = input.config;
  const week = config?.start && config.start <= date && validDate(config.start)
    ? Math.min(config.weeks, Math.floor((Date.parse(date) - Date.parse(config.start)) / 604800000) + 1) : null;
  const progress = week !== null && config && config.weeks > 1 ? (week - 1) / (config.weeks - 1) : null;
  const phase = progress === null ? "non determinabile: configurare start_date" : progress < .25 ? "base" : progress < .5 ? "costruzione" : progress < .75 ? "specifica" : week === config?.weeks ? "scarico" : "picco";
  if (config) {
    if (week === null) limit("plan_start_unknown", "plan", "missing", 2, "Inizio piano non configurato: massimo endurance.");
    if (phase === "scarico") limit("taper", "plan", "policy", 2, "Fase scarico: massimo endurance.");
    if (phase === "base" || phase === "costruzione") limit("early_phase", "plan", "policy", 4, "Base/costruzione: massimo Sweet Spot/soglia.");
  }
  if (typeof input.load48 === "number" && Number.isFinite(input.load48) && input.load48 >= 95)
    limit("load48_high", "load", "measured", 2, "Carico osservato oggi/ieri ≥95: massimo endurance.");
  const historical = (input.historical ?? recent).filter(a => validDate(a.date) && a.date >= shift(date, -10) && a.date <= date && a.evidence === "measured" && a.status !== "non_determinabile" && a.isHard === true);
  if (level >= 4 && new Set(historical.filter(a => a.sessionType === "sweet_spot" || a.sessionType === "threshold").map(a => a.date)).size >= 2)
    limit("quality_rotation", "plan", "measured", 3, "Sweet Spot/soglia eseguiti in almeno due giornate negli ultimi dieci giorni: rotazione verso Tempo/forza.");
  return { mode: "automatic", recommendation: recommendations[level], constraints, reasons, day, week, phase };
}
