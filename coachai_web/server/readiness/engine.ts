import { assessIntensity } from "./intensity.js";
import {
  shift,
  validDate,
  type Input,
  type Recommendation,
  type Result,
} from "./types.js";
// Explicit conservative v1 heuristics, not a clinical or trained predictive model.
export function evaluate(input: Input): Result {
  if (!validDate(input.date)) throw new Error("Invalid evaluation date");
  const { date } = input;
  const reasons: string[] = [],
    missing = [...input.issues];
  const current = input.wellness.find((w) => w.date === date);
  const past = input.wellness.filter(
    (w) => w.date >= shift(date, -28) && w.date < date,
  );
  const ctl = current?.ctl ?? null,
    atl = current?.atl ?? null;
  const tsb = ctl !== null && atl !== null ? ctl - atl : null;
  const observed = input.activities.filter(
    (a) => validDate(a.date) && a.date >= shift(date, -28) && a.date <= date,
  );
  const recent = observed.filter((a) => a.date >= shift(date, -6));
  const load7 =
    (recent.length > 0 || input.historyComplete) &&
    recent.every((a) => a.load !== null)
      ? recent.reduce((s, a) => s + a.load!, 0)
      : null;
  const assessments = recent.map(assessIntensity);
  const hard = new Set(
    assessments
      .filter((a) => a.status !== "non_determinabile")
      .map((a) => a.date),
  );
  for (const a of assessments)
    reasons.push(
      `Attività ${a.id} del ${a.date}: intensità ${a.status}. ${a.reasons.join(" ")}`,
    );
  let consecutive = 0;
  for (
    let d = hard.has(date) ? date : shift(date, -1);
    hard.has(d);
    d = shift(d, -1)
  )
    consecutive++;
  let weight = 0,
    sum = 0,
    confidence = 0,
    cap = 5;
  const add = (score: number, w: number) => {
    sum += score * w;
    weight += w;
  };
  if (tsb !== null) {
    add(tsb < -30 ? 20 : tsb < -20 ? 40 : tsb < -10 ? 60 : 85, 30);
    confidence += 20;
    reasons.push(
      `CTL ${ctl}, ATL ${atl}, TSB ${Math.round(tsb * 10) / 10} (CTL − ATL).`,
    );
    if (tsb < -30) {
      cap = 0;
      reasons.push("Fatica accumulata molto elevata: riposo.");
    } else if (tsb < -20) cap = Math.min(cap, 1);
    else if (tsb < -10) cap = Math.min(cap, 2);
    if (ctl! > 0 && atl! / ctl! > 1.5) {
      cap = Math.min(cap, 1);
      reasons.push("ATL superiore al 150% del CTL.");
    }
  } else missing.push("CTL/ATL odierni assenti; TSB non calcolabile.");
  for (const [key, label, inverted] of [
    ["hrv", "HRV", false],
    ["restingHR", "FC a riposo", true],
  ] as const) {
    const value = current?.[key] ?? null;
    const values = past
      .map((w) => w[key])
      .filter((v): v is number => v !== null && v > 0);
    if (value !== null && value > 0 && values.length >= 5) {
      const mean = values.reduce((s, v) => s + v, 0) / values.length,
        ratio = value / mean;
      const bad = inverted ? ratio > 1.1 : ratio < 0.8;
      const moderate = inverted ? ratio > 1.05 : ratio < 0.9;
      add(bad ? 30 : moderate ? 60 : 90, 20);
      confidence += 15;
      reasons.push(
        `${label}: ${value}, baseline ${Math.round(mean * 10) / 10} (${values.length} giorni).`,
      );
      if (bad) {
        cap = Math.min(cap, 1);
        reasons.push(`${label} distante dalla baseline: evitare intensità.`);
      }
    } else
      missing.push(
        `${label} odierna o baseline di almeno 5 giorni negli ultimi 28 assente.`,
      );
  }
  const sleep = current?.sleepScore ?? null;
  if (sleep !== null) {
    add(sleep, 15);
    confidence += 15;
    reasons.push(`Qualità del sonno ${sleep}/100.`);
    if (sleep < 50) cap = Math.min(cap, 1);
  } else missing.push("Sleep score odierno assente.");
  const feedbackContext = input.feedback.filter(
    (f) =>
      validDate(f.activityDate) &&
      f.activityDate >= shift(date, -2) &&
      f.activityDate <= date &&
      Number.isInteger(f.legs) &&
      f.legs >= 1 &&
      f.legs <= 5 &&
      (!f.updatedDate || f.updatedDate <= date),
  );
  // The Telegram prompt refers retrospectively to the ride. It stores no observation date.
  // Ambiguous positive feedback must never raise readiness or supply confidence points.
  const negativeFeedback = feedbackContext.find((f) => f.legs <= 2);
  if (feedbackContext.length) {
    for (const f of feedbackContext)
      reasons.push(
        `Gambe ${f.legs}/5: attività ${f.activityDate}, ultima modifica ${f.updatedAt ? new Date(f.updatedAt).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) + " (Europe/Rome)" : "non disponibile"}, giorno della sensazione non determinabile.`,
      );
    missing.push(
      "Data della sensazione non memorizzata: feedback non utilizzabile come misurazione giornaliera.",
    );
  } else missing.push("Feedback recente disponibile assente.");
  const historyReliable =
    input.historyComplete &&
    recent.every((a) => a.load !== null) &&
    assessments.every((a) => a.status === "confermata");
  if (historyReliable) confidence += 25;
  else {
    confidence += recent.length ? 10 : 0;
    missing.push(
      "Storico attività completo con intensità confermata non disponibile.",
    );
  }
  if (assessments.some((a) => a.status === "non_determinabile")) {
    cap = Math.min(cap, 2);
    missing.push(
      "Intensità non determinabile negli ultimi 7 giorni: nessuna seduta considerata facile dalla sola media.",
    );
  }
  if (!input.historyComplete) cap = Math.min(cap, 2);
  if (feedbackContext.length) confidence = Math.max(0, confidence - 5);
  if (negativeFeedback) {
    cap = Math.min(cap, 1);
    reasons.push(
      "Feedback negativo con data della sensazione incerta: recupero prudenziale, senza attribuirlo al giorno dell’attività.",
    );
  }
  if (load7 !== null) {
    reasons.push(
      `Carico osservato ultimi 7 giorni: ${Math.round(load7)}${input.historyComplete ? "" : " (copertura non verificata)"}.`,
    );
    if (ctl !== null && ctl > 0 && load7 > ctl * 7 * 1.5) {
      cap = Math.min(cap, 1);
      add(35, 15);
      reasons.push("Carico recente oltre il 150% del riferimento CTL × 7.");
    }
  } else missing.push("Carico recente non quantificabile.");
  const heavyDay = [date, shift(date, -1)].some((d) => {
    const rides = recent.filter((a) => a.date === d);
    const knownLoad = rides.reduce((sum, a) => sum + (a.load ?? 0), 0);
    const knownMinutes = rides.reduce((sum, a) => sum + (a.duration ?? 0), 0);
    // Partial sums are lower bounds used only to detect fatigue, never to claim freshness.
    return knownLoad > 120 || knownMinutes >= 150;
  });
  if (heavyDay) {
    cap = Math.min(cap, 1);
    add(45, 10);
    reasons.push("Lungo o carico >120 oggi/ieri: privilegiare recupero.");
  }
  if (consecutive >= 2) {
    cap = Math.min(cap, 1);
    add(35, 10);
    reasons.push(
      `${consecutive} giornate consecutive con intensità confermata/probabile: interrompere la sequenza.`,
    );
  } else if (hard.has(date) || hard.has(shift(date, -1))) {
    cap = Math.min(cap, 2);
    reasons.push("Intensità oggi/ieri: evitare un’altra seduta intensa.");
  }
  const objective =
    tsb !== null ||
    (current?.hrv !== null && current?.hrv !== undefined) ||
    sleep !== null;
  const conflict =
    (negativeFeedback &&
      ((tsb !== null && tsb >= -10) || (sleep !== null && sleep >= 80))) ||
    (feedbackContext.some((f) => f.legs >= 4) && tsb !== null && tsb < -20);
  if (conflict) {
    confidence = Math.max(0, confidence - 15);
    reasons.push(
      "Dati oggettivi e feedback discordanti, con semantica temporale incerta: prevale il segnale di fatica.",
    );
  }
  const score = weight
    ? Math.round(Math.max(0, Math.min(100, sum / weight)))
    : null;
  if (!current) {
    cap = Math.min(cap, 1);
    missing.push(
      "Wellness odierno assente: nessun dato vecchio usato come dato di oggi.",
    );
  }
  if (!objective || confidence < 40) cap = Math.min(cap, 1);
  else if (confidence < 75) cap = Math.min(cap, 2);
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const day =
    weekday === 1 || weekday === 5
      ? "strutturato"
      : weekday >= 2 && weekday <= 4
        ? "commuting"
        : "lungo weekend";
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
  if (day !== "strutturato") {
    rank = Math.min(rank, 2);
    reasons.push(`${day}: endurance controllata, se recupero adeguato.`);
  } else if (weekday === 1) {
    rank = Math.min(rank, 4);
    reasons.push("Lunedì: privilegiare sweet spot/soglia per FTP e salita.");
  } else
    reasons.push(
      "Venerdì: VO2max solo con recupero e copertura dati sufficienti.",
    );
  rank = Math.min(rank, cap);
  const options: Recommendation[] = [
    "riposo",
    "recupero",
    "endurance",
    "tempo",
    "sweet spot/soglia",
    "VO2max",
  ];
  if (score === null)
    reasons.push(
      "Nessun segnale valutabile: readiness non disponibile, raccomandazione prudente.",
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
    recommendation: options[rank],
    reasons,
    missing,
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
