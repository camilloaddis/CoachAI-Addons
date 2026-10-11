import { planAutomatic } from "../coach/planner.js";
export { recommendations } from "../coach/planner.js";
import {
  physiologicalAvailability,
  sleepDuration,
  applyScoreAdjustments,
} from "./physiology.js";
import { wellnessDiagnostics, derivedMetric } from "./diagnostics.js";
import { assessDataQuality } from "./confidence.js";
import { assessIntensity } from "./intensity.js";
import { compareActivities } from "./telemetry.js";
import {
  shift,
  validDate,
  type Input,
  type Result,
  type Factor,
  type Constraint,
} from "./types.js";
export function evaluate(input: Input): Result {
  const { date } = input;
  if (!validDate(date)) throw new Error("Invalid evaluation date");
  const factors: Factor[] = [],
    constraints: Constraint[] = [],
    missing = [...input.issues];
  function factor(
    code: string,
    category: Factor["category"],
    polarity: Factor["polarity"],
    evidence: Factor["evidence"],
    text: string,
  ) {
    const f = { code, category, polarity, evidence, text };
    factors.push(f);
    return f;
  }
  const physiologicalSignals: {
    code: string;
    maximum: number;
    reason: string;
  }[] = [];
  function physiologyLimit(
    code: string,
    category: Factor["category"],
    evidence: Factor["evidence"],
    legacyLevel: number,
    text: string,
  ) {
    // These measured/current signals affect the visible score, not a second
    // intensity ceiling. The previous physiological safety severity is retained.
    const maximum = legacyLevel === 0 ? 34 : legacyLevel === 1 ? 49 : 59;
    factor(
      code, category, "negative", evidence,
      `${text} Readiness fisiologica massima ${maximum}/100.`,
    );
    physiologicalSignals.push({ code, maximum, reason: text });
  }
  const metricDiagnostics = wellnessDiagnostics(input.wellness, date);
  const current = input.wellness.find((w) => w.date === date),
    past = input.wellness.filter(
      (w) => w.date >= shift(date, -28) && w.date < date,
    );
  const baselineComplete = (["hrv", "restingHR"] as const).every(
    (key) => past.filter((w) => w[key] !== null && w[key]! > 0).length >= 5,
  );
  const wellnessComplete = Boolean(
    current &&
      baselineComplete &&
      [
        current.ctl,
        current.atl,
        current.hrv,
        current.restingHR,
        current.sleepScore,
      ].every((v) => v != null),
  );
  const ctl = current?.ctl ?? null,
    atl = current?.atl ?? null,
    tsb = ctl !== null && atl !== null ? ctl - atl : null;
  const recent = input.activities
    .filter(
      (a) => validDate(a.date) && a.date >= shift(date, -6) && a.date <= date,
    )
    .sort(compareActivities);
  const load7 =
    (recent.length || input.historyComplete) &&
    recent.every((a) => a.load !== null)
      ? recent.reduce((s, a) => s + a.load!, 0)
      : null;
  const assessments = recent.map(assessIntensity);
  const hard = new Set(
    assessments.filter((a) => a.isHard === true && a.evidence === "measured").map((a) => a.date),
  );
  for (const a of assessments)
    factor(
      `activity:${a.id}`,
      "activity",
      a.isHard === true
        ? a.evidence === "measured"
          ? "negative"
          : "uncertain"
        : a.isHard === false
          ? "neutral"
          : "uncertain",
      a.evidence ?? "missing",
      `Attività ${a.id} del ${a.date}: intensità ${a.status}${a.isHard === false ? " non intensa" : ""}. ${a.reasons.join(" ")}`,
    );
  let consecutive = 0;
  for (
    let d = hard.has(date) ? date : shift(date, -1);
    hard.has(d);
    d = shift(d, -1)
  )
    consecutive++;
  let sum = 0,
    weight = 0,
    probableIntensitySequence = false;
  const add = (score: number, w: number) => {
    sum += score * w;
    weight += w;
  };
  if (tsb !== null) {
    add(tsb < -30 ? 20 : tsb < -20 ? 40 : tsb < -10 ? 60 : 85, 30);
    factor(
      "tsb",
      "physiology",
      tsb < -10 ? "negative" : "positive",
      "measured",
      `CTL ${ctl!.toFixed(1)}, ATL ${atl!.toFixed(1)}, TSB ${tsb.toFixed(1)} (CTL − ATL).`,
    );
    if (tsb < -30)
      physiologyLimit(
        "tsb_extreme",
        "physiology",
        "measured",
        0,
        "Fatica accumulata molto elevata: riposo.",
      );
    else if (tsb < -20)
      physiologyLimit(
        "tsb_high",
        "physiology",
        "measured",
        1,
        "TSB sotto −20: recupero.",
      );
    else if (tsb < -10)
      physiologyLimit(
        "tsb_moderate",
        "physiology",
        "measured",
        2,
        "TSB sotto −10: endurance.",
      );
    if (ctl! > 0 && atl! / ctl! > 1.5)
      physiologyLimit(
        "atl_ratio",
        "load",
        "measured",
        1,
        "ATL superiore al 150% del CTL.",
      );
  } else missing.push("CTL/ATL odierni assenti; TSB non calcolabile.");
  for (const [key, label, inverted] of [
    ["hrv", "HRV", false],
    ["restingHR", "FC a riposo", true],
  ] as const) {
    const value = current?.[key] ?? null,
      values = past
        .map((w) => w[key])
        .filter((v): v is number => v !== null && v > 0);
    const diagnostic = metricDiagnostics.find((m) => m.key === key)!;
    diagnostic.scoreEligible =
      value !== null && value > 0 && values.length >= 5;
    diagnostic.baseline = { value: null, samples: values.length };
    if (!diagnostic.scoreEligible)
      diagnostic.reason +=
        " Esclusa dal punteggio: valore odierno valido e baseline di almeno cinque giorni entrambi necessari.";
    if (value !== null && value > 0 && values.length >= 5) {
      const mean = values.reduce((s, v) => s + v, 0) / values.length,
        ratio = value / mean,
        bad = inverted ? ratio > 1.1 : ratio < 0.8,
        moderate = inverted ? ratio > 1.05 : ratio < 0.9;
      diagnostic.baseline.value = mean;
      add(bad ? 30 : moderate ? 60 : 90, 20);
      factor(
        key,
        "physiology",
        bad || moderate ? "negative" : "positive",
        "measured",
        `${label}: ${value}, baseline ${mean.toFixed(1)} (${values.length} giorni).`,
      );
      if (bad)
        physiologyLimit(
          `${key}_low_recovery`,
          "physiology",
          "measured",
          1,
          `${label} distante dalla baseline: evitare intensità.`,
        );
    } else
      missing.push(
        `${label} odierna o baseline di almeno 5 giorni negli ultimi 28 assente.`,
      );
  }
  const sleep = current?.sleepScore ?? null;
  if (sleep !== null) {
    add(sleep, 15);
    factor(
      "sleep",
      "physiology",
      sleep < 50 ? "negative" : sleep >= 80 ? "positive" : "neutral",
      "measured",
      `Qualità del sonno ${sleep}/100.`,
    );
    if (sleep < 50)
      physiologyLimit(
        "sleep_low",
        "physiology",
        "measured",
        1,
        "Sonno sotto 50/100: recupero.",
      );
  } else missing.push("Sleep score odierno assente.");
  const sleepSecs = sleepDuration(current?.sleepSecs);
  if (sleepSecs !== null) {
    factor("sleep_duration", "physiology", sleepSecs < 5 * 3600 ? "negative" : "neutral", "measured",
      `Durata sonno odierna ${(sleepSecs / 3600).toFixed(1)} ore (sleepSecs).`);
    if (sleepSecs < 5 * 3600)
      physiologyLimit("sleep_short", "physiology", "measured", 2,
        "Sonno effettivo inferiore a 5 ore: disponibilità fisiologica limitata a endurance.");
  } else {
    missing.push("Durata sonno odierna non disponibile o non valida: non stimata dal Sleep Score.");
  }
  const feedbackContext = input.feedback.filter(
    (f) =>
      (f.activityDate !== null
        ? validDate(f.activityDate) && f.activityDate <= date
        : f.context === "current") &&
      ((f.sensationDate !== null &&
        validDate(f.sensationDate) &&
        f.sensationDate >= shift(date, -2) &&
        f.sensationDate <= date) ||
        (f.sensationDate === null &&
          f.activityDate !== null &&
          f.activityDate >= shift(date, -2))) &&
      Number.isInteger(f.legs) &&
      f.legs >= 1 &&
      f.legs <= 5 &&
      (!f.updatedDate || f.updatedDate <= date),
  );
  const currentFeedback = feedbackContext.filter(
    (f) => f.context === "current" && f.sensationDate !== null,
  );
  const negativeFeedback = currentFeedback
    .filter((f) => f.legs <= 2)
    .sort((a, b) => b.sensationDate!.localeCompare(a.sensationDate!))[0];
  for (const f of feedbackContext) {
    // Historical and undated observations remain diagnostic only. They must
    // not change confidence and indirectly activate intensity ceilings.
    const context =
      f.context === "activity"
        ? "activity"
        : f.context === "current" && f.sensationDate
          ? "current"
          : "ambiguous";
    factor(
      "legs_" + context,
      "feedback",
      context === "ambiguous"
        ? "uncertain"
        : f.legs <= 2
          ? "negative"
          : f.legs >= 4
            ? "positive"
            : "neutral",
      context === "ambiguous" ? "inferred" : "subjective",
      `Gambe ${f.legs}/5: ${context === "activity" ? "feedback storico della seduta, escluso dai limiti del recupero attuale" : context === "current" ? "recupero attuale esplicitamente datato" : "feedback ambiguo: significato temporale non verificato, escluso dai limiti del recupero attuale"}; ${context === "current" ? "riferimento recupero" : "attività"} ${context === "current" ? (f.sensationDate ?? "non registrato") : f.activityDate}, inserimento/ultima modifica ${f.updatedAt ?? "n/d"}, sensazione ${f.sensationDate ?? "non registrata"}.`,
    );
  }
  if (!currentFeedback.length)
    missing.push("Feedback sul recupero attuale esplicito assente.");
  const historyReliable =
    input.historyComplete &&
    recent.every((a) => a.load !== null) &&
    assessments.every((a) => a.status === "confermata");
  if (!historyReliable)
    missing.push(
      "Storico attività completo con intensità confermata non disponibile.",
    );
  if (assessments.some((a) => a.status === "non_determinabile")) {
    missing.push(
      "Intensità non determinabile negli ultimi 7 giorni: distribuzione eseguita non disponibile.",
    );
  }
  if (negativeFeedback)
    physiologyLimit(
      "negative_legs",
      "feedback",
      "subjective",
      1,
      `Recupero attuale negativo dichiarato per ${negativeFeedback.sensationDate}: recupero prudenziale, valido fino al ${shift(negativeFeedback.sensationDate!, 2)}.`,
    );
  if (load7 !== null) {
    factor(
      "load7",
      "load",
      "neutral",
      "measured",
      `Carico osservato ultimi 7 giorni: ${Math.round(load7)}${input.historyComplete ? "" : " (copertura non verificata)"}.`,
    );
    if (ctl !== null && ctl > 0 && load7 > ctl * 7 * 1.5) {
      physiologyLimit(
        "load7_high",
        "load",
        "measured",
        1,
        "Carico recente oltre il 150% del riferimento CTL × 7.",
      );
      add(35, 15);
    }
  } else missing.push("Carico recente non quantificabile.");
  const heavyDay = [date, shift(date, -1)].some((d) => {
    const rides = recent.filter((a) => a.date === d);
    return (
      rides.reduce((s, a) => s + (a.load ?? 0), 0) > 120 ||
      rides.reduce((s, a) => s + (a.duration ?? 0), 0) >= 150
    );
  });
  if (heavyDay) {
    physiologyLimit(
      "heavy_day",
      "load",
      "measured",
      1,
      "Lungo o carico >120 oggi/ieri: privilegiare recupero.",
    );
    add(45, 10);
  }
  const possibleHard = new Set(assessments.filter(a => a.isHard === true).map(a => a.date));
  let possibleSequence = 0;
  const end = possibleHard.has(date) ? date : shift(date, -1);
  for (let d = end; possibleHard.has(d); d = shift(d, -1)) possibleSequence++;
  probableIntensitySequence = possibleSequence >= 2 && assessments.some(a =>
    a.isHard === true && a.evidence !== "measured" && a.date >= shift(end, 1 - possibleSequence) && a.date <= end);
  if (probableIntensitySequence) missing.push("Sequenza intensa solo probabile: esecuzione non verificata.");
  const conflict =
    (negativeFeedback &&
      ((tsb !== null && tsb >= -10) || (sleep !== null && sleep >= 80))) ||
    (currentFeedback.some((f) => f.legs >= 4) && tsb !== null && tsb < -20);
  if (conflict) {
    factor(
      "conflicting_feedback",
      "feedback",
      "uncertain",
      "subjective",
      "Dati oggettivi e feedback discordanti: prevale il segnale negativo attuale esplicitamente datato.",
    );
  }
  const rawScore = weight
    ? Math.round(Math.max(0, Math.min(100, sum / weight)))
    : null;
  const { score, adjustments } = applyScoreAdjustments(rawScore, physiologicalSignals);
  const quality = assessDataQuality({
    loadAvailable: tsb !== null,
    hrvEligible: metricDiagnostics.find((m) => m.key === "hrv")!.scoreEligible === true,
    restingHREligible: metricDiagnostics.find((m) => m.key === "restingHR")!.scoreEligible === true,
    sleepAvailable: sleep !== null,
    historyReliable,
    hasRecentActivities: recent.length > 0,
    probableIntensitySequence,
    conflictingRecovery: Boolean(conflict),
  });
  const { confidence } = quality;
  factors.push(...quality.reasons);
  const planningContext = {
    wellnessAvailable: Boolean(current),
    wellnessComplete,
    historyComplete: input.historyComplete,
    missingActivityLoad: recent.some((a) => a.load === null),
  };
  const plan = planAutomatic({ date, score, assessments, context: planningContext,
    physiologyReasons: adjustments.filter(a => a.applied).map(a => a.reason) });
  constraints.push(...plan.constraints);
  factors.push(...plan.reasons);
  if (!current) missing.push("Wellness odierno assente: nessun dato vecchio usato come dato di oggi.");
  for (const [i, text] of [...new Set(missing)].entries())
    factor(`missing:${i}`, "data", "uncertain", "missing", text);
  if (score === null)
    factor(
      "no_score",
      "data",
      "uncertain",
      "missing",
      "Nessun segnale valutabile: readiness non disponibile, raccomandazione prudente.",
    );
  const demonstrated = physiologicalSignals.some((s) => s.maximum <= 49);
  const completeness =
    score === null
      ? "unavailable"
      : !current ||
          confidence < 75 ||
          !baselineComplete ||
          sleepSecs === null ||
          [
            current.ctl,
            current.atl,
            current.hrv,
            current.restingHR,
            current.sleepScore,
          ].some((v) => v == null)
        ? "provisional"
        : "complete";
  return {
    date,
    score,
    physiology: {
      rawScore,
      availability: physiologicalAvailability(score),
      adjustments,
    },
    confidence,
    completeness,
    status:
      completeness === "unavailable"
        ? "non disponibile"
        : completeness === "provisional"
          ? "valutazione parziale"
          : "valutazione disponibile",
    metricDiagnostics: [
      ...metricDiagnostics.map((m) => ({
        ...m,
        scoreEligible:
          m.key === "ctl" || m.key === "atl"
            ? tsb !== null
            : m.key === "sleepSecs"
              ? sleepSecs !== null
            : m.key === "sleepScore"
              ? sleep !== null
              : m.scoreEligible,
      })),
      derivedMetric("tsb", "TSB", "Coach AI: CTL − ATL odierni", tsb, date),
      derivedMetric(
        "load7",
        "Carico 7 giorni",
        "Carichi attività eseguite, ultimi 7 giorni",
        load7,
        date,
      ),
    ],
    assessmentState: demonstrated
      ? "insufficient_recovery"
      : score === null || !current || !wellnessComplete
        ? "missing_data"
        : "available",
    recommendation: plan.recommendation,
    factors,
    constraints,
    reasons: factors.filter((f) => f.evidence !== "missing").map((f) => f.text),
    missing: [...new Set(missing)],
    metrics: {
      ctl,
      atl,
      tsb,
      load7,
      consecutiveIntensityDays: consecutive,
      intensityAssessments: assessments,
      feedback: feedbackContext,
    },
    planningContext,
    profile: { ftp: 220, day: plan.day },
  };
}
