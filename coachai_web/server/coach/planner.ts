import { physiologicalAvailability } from "../readiness/physiology.js";
import { shift, validDate, type AutomaticTrainingDecision, type Constraint, type Factor, type IntensityAssessment, type Recommendation } from "../readiness/types.js";

export const recommendations: Recommendation[] = ["riposo", "recupero", "endurance", "tempo", "sweet spot/soglia", "VO2max"];
export type PlanningContext = {
  wellnessAvailable: boolean;
  wellnessComplete: boolean;
  historyComplete: boolean;
  missingActivityLoad: boolean;
};
export type DailyLoadTarget = {
  target: number | null; minimum: number | null; maximum: number | null;
  confidence: 'measured' | 'unavailable'; reasons: string[];
  baseline: number | null; observedDays: number; preferBelow: boolean;
};
/** Session-sized target bounded by observed capacity. Rest days stay in the
 * daily average; no remaining weekly budget or missed-session catch-up. */
export function dailyLoadTarget(input: {
  date: string; score: number | null; level: number; phase: string; goal: string;
  duration: number; ctl: number | null; historyComplete: boolean;
  activities: { date: string; load: number | null; duration: number | null }[];
  load48: number | null;
}): DailyLoadTarget {
  const recent = input.activities.filter(a => validDate(a.date) && a.date >= shift(input.date,-14) && a.date < input.date);
  const days = new Map<string, { load: number; duration: number }>();
  const unavailable = (reason: string): DailyLoadTarget => ({target:null,minimum:null,maximum:null,confidence:'unavailable',reasons:[reason],baseline:null,observedDays:days.size,preferBelow:true});
  if (input.level === 0) return {target:0,minimum:0,maximum:0,confidence:'measured',reasons:['Riposo esplicito: carico target 0, nessun workout.'],baseline:null,observedDays:0,preferBelow:true};
  if (input.score === null) return unavailable('Readiness non valutabile: target di carico non determinabile.');
  if (!input.historyComplete || recent.some(a => a.load === null || !Number.isFinite(a.load) || a.load < 0 || a.duration === null || !Number.isFinite(a.duration) || a.duration <= 0))
    return unavailable('Copertura o carichi/durate misurati degli ultimi 14 giorni incompleti: target non determinabile.');
  for (const a of recent) {
    const day=days.get(a.date) ?? {load:0,duration:0};
    day.load+=a.load!;day.duration+=a.duration!;days.set(a.date,day);
  }
  const sessions=[...days.values()].filter(d=>d.load>0);
  if (sessions.length < 3) return unavailable('Servono almeno tre giornate con carico misurato negli ultimi 14 giorni per un target personale.');
  const median = (values: number[]) => {values.sort((a,b)=>a-b); const i=Math.floor(values.length/2);return values.length%2 ? values[i] : (values[i-1]+values[i])/2;};
  const sessionReference=median(sessions.map(d=>d.load/d.duration))*input.duration;
  const dailyReference=[...days.values()].reduce((s,d)=>s+d.load,0)/14;
  // Cap at a normal observed session and at twice the daily average. CTL is
  // capacity only; ATL/TSB already enter readiness and are not multiplied again.
  const baseline=Math.min(sessionReference,median(sessions.map(d=>d.load)),dailyReference*2,
    input.ctl !== null && input.ctl > 0 ? input.ctl*1.5 : Infinity);
  const recovery=[0,.4,.7,.85,1,1][Math.max(0,Math.min(5,input.level))] * Math.min(1,input.score/80);
  const phase=input.phase==='scarico' ? .65 : input.phase==='base' ? .85 : input.phase==='costruzione' ? .95 : 1;
  const goal=input.goal==='endurance' && input.level>=3 ? .95 : 1;
  const recentRecovery=input.load48 !== null && input.load48>=95 ? .8 : 1;
  const target=Math.round(baseline*recovery*phase*goal*recentRecovery*10)/10;
  const maximum=Math.round(Math.min(baseline,target*1.2)*10)/10;
  return {target,minimum:Math.round(target*.8*10)/10,maximum,confidence:'measured',baseline:Math.round(baseline*10)/10,observedDays:sessions.length,
    preferBelow:input.score<60 || input.level<=2,
    reasons:[`Riferimento osservato ${baseline.toFixed(1)}: ${sessions.length} giornate negli ultimi 14, durata selezionata ${input.duration} min; nessun recupero del carico perso.`,
      `Disponibilità e categoria ×${recovery.toFixed(2)}, fase ${input.phase} ×${phase}, obiettivo ${input.goal} ×${goal}, recupero 48h ×${recentRecovery}. Banda 80–120% limitata al riferimento osservato; CTL limita la capacità, ATL/TSB entrano una sola volta nella readiness.`]};
}
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
  const phase = progress === null ? (config?.start ? "non iniziato" : "adattivo") : progress < .25 ? "base" : progress < .5 ? "costruzione" : progress < .75 ? "specifica" : week === config?.weeks ? "scarico" : "picco";
  if (config) {
    if (week === null && config.start) limit("plan_start_unknown", "plan", "policy", 2, "Il piano configurato non è ancora iniziato: massimo endurance.");
    else if (week === null) reason("rolling_plan", "plan", "policy", "Piano adattivo senza data di inizio: recupero, calendario e storico guidano la proposta.");
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
