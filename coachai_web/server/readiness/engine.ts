import { assessIntensity } from "./intensity.js";
import { compareActivities } from "./telemetry.js";
import {
  shift,
  validDate,
  type Input,
  type Result,
  type Factor,
  type Constraint,
  type Recommendation,
} from "./types.js";
export const recommendations: Recommendation[] = [
  "riposo",
  "recupero",
  "endurance",
  "tempo",
  "sweet spot/soglia",
  "VO2max",
];
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
  function limit(
    code: string,
    category: Factor["category"],
    evidence: Factor["evidence"],
    ceiling: number,
    text: string,
  ) {
    const f = factor(
      code,
      category,
      evidence === "missing" || evidence === "inferred"
        ? "uncertain"
        : evidence === "policy"
          ? "neutral"
          : "negative",
      evidence,
      text,
    );
    constraints.push({
      ...f,
      ceiling,
      before: 5,
      after: ceiling,
      applied: false,
      source: "readiness",
    });
  }
  const current = input.wellness.find((w) => w.date === date),
    past = input.wellness.filter(
      (w) => w.date >= shift(date, -28) && w.date < date,
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
    assessments.filter((a) => a.isHard === true).map((a) => a.date),
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
    confidence = 0;
  const add = (score: number, w: number) => {
    sum += score * w;
    weight += w;
  };
  if (tsb !== null) {
    add(tsb < -30 ? 20 : tsb < -20 ? 40 : tsb < -10 ? 60 : 85, 30);
    confidence += 20;
    factor(
      "tsb",
      "physiology",
      tsb < -10 ? "negative" : "positive",
      "measured",
      `CTL ${ctl!.toFixed(1)}, ATL ${atl!.toFixed(1)}, TSB ${tsb.toFixed(1)} (CTL − ATL).`,
    );
    if (tsb < -30)
      limit(
        "tsb_extreme",
        "physiology",
        "measured",
        0,
        "Fatica accumulata molto elevata: riposo.",
      );
    else if (tsb < -20)
      limit(
        "tsb_high",
        "physiology",
        "measured",
        1,
        "TSB sotto −20: recupero.",
      );
    else if (tsb < -10)
      limit(
        "tsb_moderate",
        "physiology",
        "measured",
        2,
        "TSB sotto −10: endurance.",
      );
    if (ctl! > 0 && atl! / ctl! > 1.5)
      limit(
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
    if (value !== null && value > 0 && values.length >= 5) {
      const mean = values.reduce((s, v) => s + v, 0) / values.length,
        ratio = value / mean,
        bad = inverted ? ratio > 1.1 : ratio < 0.8,
        moderate = inverted ? ratio > 1.05 : ratio < 0.9;
      add(bad ? 30 : moderate ? 60 : 90, 20);
      confidence += 15;
      factor(
        key,
        "physiology",
        bad || moderate ? "negative" : "positive",
        "measured",
        `${label}: ${value}, baseline ${mean.toFixed(1)} (${values.length} giorni).`,
      );
      if (bad)
        limit(
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
    confidence += 15;
    factor(
      "sleep",
      "physiology",
      sleep < 50 ? "negative" : sleep >= 80 ? "positive" : "neutral",
      "measured",
      `Qualità del sonno ${sleep}/100.`,
    );
    if (sleep < 50)
      limit(
        "sleep_low",
        "physiology",
        "measured",
        1,
        "Sonno sotto 50/100: recupero.",
      );
  } else missing.push("Sleep score odierno assente.");
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
      `Gambe ${f.legs}/5: ${context === "activity" ? "valutazione retrospettiva della seduta, non recupero attuale" : context === "current" ? "stato di recupero dichiarato" : "significato temporale non verificato"}; ${context === "current" ? "riferimento recupero" : "attività"} ${context === "current" ? (f.sensationDate ?? "non registrato") : f.activityDate}, inserimento/ultima modifica ${f.updatedAt ?? "n/d"}, sensazione ${f.sensationDate ?? "non registrata"}.`,
    );
  }
  const ambiguous = feedbackContext.some(
    (f) =>
      (f.context ?? "ambiguous") === "ambiguous" ||
      (f.context === "current" && !f.sensationDate),
  );
  if (ambiguous)
    missing.push(
      "Feedback ambiguo: non misura del recupero attuale; cautela fino a due giorni dalla data attività.",
    );
  if (!currentFeedback.length)
    missing.push("Feedback sul recupero attuale esplicito assente.");
  const historyReliable =
    input.historyComplete &&
    recent.every((a) => a.load !== null) &&
    assessments.every((a) => a.status === "confermata");
  confidence += historyReliable ? 25 : recent.length ? 10 : 0;
  if (!historyReliable)
    missing.push(
      "Storico attività completo con intensità confermata non disponibile.",
    );
  if (assessments.some((a) => a.status === "non_determinabile")) {
    missing.push(
      "Intensità non determinabile negli ultimi 7 giorni: distribuzione eseguita non disponibile.",
    );
    limit(
      "unknown_intensity",
      "data",
      "missing",
      2,
      "Intensità non determinabile negli ultimi 7 giorni: nessuna seduta considerata facile dalla sola media.",
    );
  }
  if (assessments.some((a) => a.status === "probabile" && a.isHard === false))
    limit(
      "uncertain_nonhard_intensity",
      "data",
      "inferred",
      2,
      "Seduta probabilmente moderata, ma intervalli brevi non esclusi: massimo endurance.",
    );
  if (recent.some((a) => a.load === null))
    limit(
      "activity_load_missing",
      "data",
      "missing",
      2,
      "Carico di una o più attività assente: massimo endurance, carico totale non noto.",
    );
  if (!input.historyComplete)
    limit(
      "history_incomplete",
      "data",
      "missing",
      2,
      "Storico attività non completo: massimo endurance.",
    );
  if (ambiguous) confidence = Math.max(0, confidence - 5);
  if (negativeFeedback)
    limit(
      "negative_legs",
      "feedback",
      "subjective",
      1,
      `Recupero attuale negativo dichiarato per ${negativeFeedback.sensationDate}: recupero prudenziale, valido fino al ${shift(negativeFeedback.sensationDate!, 2)}.`,
    );
  if (
    feedbackContext.some(
      (f) =>
        ((f.context ?? "ambiguous") === "ambiguous" ||
          (f.context === "current" && !f.sensationDate)) &&
        f.legs <= 2,
    )
  )
    limit(
      "ambiguous_feedback",
      "feedback",
      "inferred",
      2,
      "Feedback negativo dal significato incerto: massimo endurance nella finestra di due giorni dell’attività; non prova affaticamento attuale.",
    );
  if (
    feedbackContext.some(
      (f) =>
        f.context === "activity" &&
        f.legs <= 2 &&
        f.activityDate !== null &&
        f.activityDate >= shift(date, -1),
    )
  )
    limit(
      "retrospective_session",
      "plan",
      "subjective",
      2,
      "Seduta oggi/ieri percepita faticosa: pianificare endurance, non interpretare come recupero attuale. Carico misurato invariato; calibrazione soggettiva della seduta da verificare.",
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
      limit(
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
    limit(
      "heavy_day",
      "load",
      "measured",
      1,
      "Lungo o carico >120 oggi/ieri: privilegiare recupero.",
    );
    add(45, 10);
  }
  if (consecutive >= 2) {
    const measured = assessments
      .filter((a) => {
        const end = hard.has(date) ? date : shift(date, -1);
        return (
          a.isHard === true &&
          a.date >= shift(end, 1 - consecutive) &&
          a.date <= end
        );
      })
      .every((a) => a.isHard !== true || a.evidence === "measured");
    limit(
      "consecutive_intensity",
      "activity",
      measured ? "measured" : "inferred",
      1,
      measured
        ? `${consecutive} giornate consecutive con intensità misurata: interrompere la sequenza.`
        : `${consecutive} giornate consecutive con intensità solo probabile: recupero cautelativo per incertezza, non prova di affaticamento attuale.`,
    );
    if (measured) add(35, 10);
    else {
      confidence = Math.max(0, confidence - 5);
      missing.push(
        "Sequenza intensa solo probabile: esecuzione non verificata.",
      );
    }
  } else if (hard.has(date) || hard.has(shift(date, -1)))
    limit(
      "recent_intensity",
      "activity",
      assessments.some(
        (a) =>
          a.isHard === true &&
          a.evidence === "inferred" &&
          a.date >= shift(date, -1),
      )
        ? "inferred"
        : "measured",
      2,
      "Intensità oggi/ieri: evitare un’altra seduta intensa.",
    );
  const objective =
    tsb !== null ||
    (current?.hrv !== null && current?.hrv !== undefined) ||
    sleep !== null;
  const conflict =
    (negativeFeedback &&
      ((tsb !== null && tsb >= -10) || (sleep !== null && sleep >= 80))) ||
    (currentFeedback.some((f) => f.legs >= 4) && tsb !== null && tsb < -20);
  if (conflict) {
    confidence = Math.max(0, confidence - 15);
    factor(
      "conflicting_feedback",
      "feedback",
      "uncertain",
      ambiguous ? "inferred" : "subjective",
      "Dati oggettivi e feedback discordanti: prevale il segnale negativo attuale esplicitamente datato.",
    );
  }
  const score = weight
    ? Math.round(Math.max(0, Math.min(100, sum / weight)))
    : null;
  if (!current) {
    limit(
      "wellness_absent",
      "data",
      "missing",
      1,
      "Wellness odierno assente: nessun dato vecchio usato come dato di oggi.",
    );
    missing.push(
      "Wellness odierno assente: nessun dato vecchio usato come dato di oggi.",
    );
  }
  if (!objective || confidence < 40)
    limit(
      "confidence_low",
      "data",
      "missing",
      1,
      "Confidence sotto 40 o nessun segnale oggettivo: recupero prudenziale.",
    );
  else if (confidence < 75)
    limit(
      "confidence_partial",
      "data",
      "missing",
      2,
      "Confidence sotto 75: massimo endurance.",
    );
  const weekday = new Date(date + "T12:00:00Z").getUTCDay(),
    day =
      weekday === 1 || weekday === 5
        ? "strutturato"
        : weekday >= 2 && weekday <= 4
          ? "commuting"
          : "lungo weekend";
  if (day !== "strutturato")
    limit(
      "weekly_schedule",
      "schedule",
      "policy",
      2,
      `${day}: endurance controllata, se recupero adeguato.`,
    );
  else if (weekday === 1)
    limit(
      "monday_schedule",
      "schedule",
      "policy",
      4,
      "Lunedì: privilegiare sweet spot/soglia per FTP e salita.",
    );
  else
    factor(
      "friday_schedule",
      "schedule",
      "neutral",
      "policy",
      "Venerdì: VO2max solo con recupero e copertura dati sufficienti.",
    );
  let rank =
    score === null
      ? 1
      : score < 35
        ? 0
        : score < 50
          ? 1
          : score < 65
            ? 2
            : score < 75
              ? 3
              : score < 85
                ? 4
                : 5;
  for (const c of constraints) {
    c.before = rank;
    c.after = Math.min(rank, c.ceiling);
    c.applied = c.after < c.before;
    rank = c.after;
  }
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
  const demonstrated = constraints.some(
    (c) =>
      c.ceiling <= 1 &&
      (c.evidence === "measured" || c.evidence === "subjective"),
  );
  const uncertain = constraints.some(
    (c) =>
      c.ceiling < 5 && (c.evidence === "missing" || c.evidence === "inferred"),
  );
  return {
    date,
    score,
    confidence,
    status:
      score === null
        ? "non disponibile"
        : confidence < 75
          ? "valutazione parziale"
          : "valutazione disponibile",
    assessmentState: demonstrated
      ? "insufficient_recovery"
      : score === null || !current || confidence < 40 || uncertain
        ? "missing_data"
        : "available",
    recommendation: recommendations[rank],
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
    profile: { ftp: 220, day },
  };
}
