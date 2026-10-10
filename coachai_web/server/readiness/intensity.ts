import { number, type Activity, type IntensityAssessment } from "./types.js";
export function assessIntensity(a: Activity): IntensityAssessment {
  const result: IntensityAssessment = {
    id: a.id,
    date: a.date,
    status: "non_determinabile",
    isHard: null,
    highIntensity: false,
    evidence: "missing",
    reasons: [],
    sessionType: null,
    measurements: {
      duration: a.duration,
      load: a.load,
      averagePower: a.averagePower ?? null,
      normalizedPower: a.normalizedPower ?? null,
      ftp: a.ftp ?? null,
      intensityFactor: a.intensityFactor ?? null,
      averageHR: a.averageHR ?? null,
      zoneCount: a.powerZones?.length ?? 0,
      intervalCount: a.executedIntervals?.length ?? 0,
    },
  };
  const intensity = number(a.intensity, 0, 200),
    ftp = number(a.ftp, 50, 600),
    np = number(a.normalizedPower, 0, 2000);
  const confirm = (hard: boolean, reason: string, high = false) => {
    result.status = "confermata";
    result.isHard = hard;
    result.highIntensity = hard ? result.highIntensity || high : false;
    result.evidence = "measured";
    result.reasons.push(reason);
  };
  // Work averages establish sustained measured efforts, never absence of brief efforts.
  if (
    ftp !== null &&
    a.executedIntervals &&
    a.duration !== null &&
    a.executedIntervals.reduce((s, i) => s + i.seconds, 0) <=
      a.duration * 60 * 1.05
  ) {
    const work = a.executedIntervals.filter((i) => i.type === "WORK");
    const seconds = (low: number, high: number, min: number) =>
      work
        .filter(
          (i) =>
            i.averagePower / ftp >= low &&
            i.averagePower / ftp < high &&
            i.seconds >= min,
        )
        .reduce((s, i) => s + i.seconds, 0);
    if (seconds(1.1, 1.3, 60) >= 180) {
      result.sessionType = "VO2max";
      confirm(
        true,
        "Blocchi WORK eseguiti ≥110% FTP: stimolo compatibile con VO2max, non misura del consumo di ossigeno.",
        true,
      );
    } else if (seconds(0.95, 1.1, 120) >= 300) {
      result.sessionType = "threshold";
      confirm(true, "Blocchi WORK eseguiti ≥95% FTP: lavoro di soglia.");
    } else if (seconds(0.88, 0.95, 300) >= 600) {
      result.sessionType = "sweet_spot";
      confirm(true, "Blocchi WORK eseguiti 88–95% FTP: Sweet Spot sostenuto.");
    }
  }
  if (intensity !== null && intensity >= 85)
    confirm(true, `Intensità media ${intensity}% ≥85%.`, intensity >= 105);
  if (ftp !== null && np !== null && np / ftp >= 0.85)
    confirm(
      true,
      `IF misurato NP/FTP ${(np / ftp).toFixed(2)} (FTP dell’attività).`,
      np / ftp >= 1.05,
    );
  const avg = number(a.averagePower, 0, 2000);
  if (
    ftp !== null &&
    avg !== null &&
    a.duration !== null &&
    a.duration >= 5 &&
    avg / ftp >= 0.85
  )
    confirm(
      true,
      `Potenza media eseguita ${avg} W ≥85% della FTP dell’attività.`,
      avg / ftp >= 1.05,
    );
  if (a.powerZones && a.powerZoneMapping === "unverified_custom")
    result.reasons.push(
      "Tempi zona riconosciuti, ma confini personalizzati senza unità/mappatura verificata: nessuna conferma di intensità dalle etichette Z.",
    );
  const totalSeconds = a.duration === null ? null : a.duration * 60;
  const zones = a.powerZones;
  if (
    zones &&
    a.powerZoneMapping !== "unverified_custom" &&
    zones.length === 7 &&
    new Set(zones.map((z) => z.zone)).size === 7 &&
    totalSeconds !== null &&
    totalSeconds > 0
  ) {
    const total = zones.reduce((s, z) => s + z.seconds, 0),
      hard = zones
        .filter((z) => z.zone >= 4)
        .reduce((s, z) => s + z.seconds, 0),
      high = zones
        .filter((z) => z.zone >= 5)
        .reduce((s, z) => s + z.seconds, 0);
    // Partial/overlapping/unrelated (e.g. HR) zone sets cannot establish a low-intensity ride.
    if (Math.abs(total - totalSeconds) <= Math.max(5, totalSeconds * 0.05)) {
      if (hard >= 300 || high >= 60)
        confirm(
          true,
          `Zone potenza eseguite: ${Math.round(hard)} s Z4+, ${Math.round(high)} s Z5+.`,
          high >= 60,
        );
      else if (
        result.isHard !== true &&
        (intensity === null || intensity < 85) &&
        (np === null || ftp === null || np / ftp < 0.85)
      )
        confirm(
          false,
          "Distribuzione potenza completa: nessun accumulo significativo in Z4+/Z5+.",
        );
    }
  }
  if (a.executedIntervals && ftp !== null && totalSeconds !== null) {
    const seconds = a.executedIntervals.reduce((sum, i) => sum + i.seconds, 0);
    if (seconds <= totalSeconds * 1.05) {
      const hard = a.executedIntervals
          .filter((i) => i.averagePower / ftp >= 0.95)
          .reduce((sum, i) => sum + i.seconds, 0),
        high = a.executedIntervals
          .filter((i) => i.averagePower / ftp >= 1.1)
          .reduce((sum, i) => sum + i.seconds, 0);
      if (hard >= 300 || high >= 60)
        confirm(
          true,
          `Intervalli eseguiti: ${Math.round(hard)} s ≥95% FTP, ${Math.round(high)} s ≥110% FTP.`,
          high >= 60,
        );
    }
  }
  if (
    result.status !== "confermata" &&
    ftp !== null &&
    a.executedIntervals &&
    a.duration !== null &&
    a.duration >= 20 &&
    a.load !== null &&
    a.executedIntervals.every(
      (i) => i.type !== undefined && i.averagePower / ftp <= 0.75,
    ) &&
    Math.abs(
      a.executedIntervals.reduce((s, i) => s + i.seconds, 0) - a.duration * 60,
    ) <= Math.max(5, a.duration * 3)
  ) {
    result.status = "probabile";
    result.isHard = false;
    result.evidence = "inferred";
    result.sessionType = a.executedIntervals.every(
      (i) => i.averagePower / ftp <= 0.55,
    )
      ? "recovery"
      : "endurance";
    result.reasons.push(
      "Segmenti eseguiti completi compatibili con recupero/endurance; le medie dei segmenti non escludono picchi brevi.",
    );
    return result;
  }
  if (
    result.status !== "confermata" &&
    ftp !== null &&
    np !== null &&
    avg !== null &&
    avg > 0 &&
    a.duration !== null &&
    a.duration >= 20 &&
    np / ftp <= 0.75 &&
    np >= avg &&
    np / avg <= 1.08 &&
    a.load !== null
  ) {
    result.status = "probabile";
    result.isHard = false;
    result.evidence = "inferred";
    result.reasons.push(
      "NP, potenza media e durata compatibili con lavoro prevalentemente moderato; intervalli brevi non esclusi senza distribuzione completa.",
    );
    return result;
  }
  if (result.status !== "confermata") {
    const name =
      /\bvo2(?:max)?\b|vo₂|sprint|anaerob|sweet[ -]?spot|soglia|threshold|over[ -]?under|30\s*\/\s*30|40\s*\/\s*20/i.test(
        a.name ?? "",
      );
    const rpe = number(a.rpe, 0, 10);
    if (name || (rpe !== null && rpe >= 7)) {
      result.status = "probabile";
      result.isHard = true;
      result.evidence = "inferred";
      result.highIntensity = /vo2|vo₂|sprint|anaerob/i.test(a.name ?? "");
      result.reasons.push(
        name
          ? "Nome attività suggerisce lavoro intenso; non conferma l’esecuzione degli intervalli."
          : `RPE ${rpe}/10: sforzo elevato, indizio soggettivo.`,
      );
    } else
      result.reasons.push(
        "Media bassa/assente: gli intervalli brevi non sono esclusi; distribuzione eseguita non disponibile.",
      );
  }
  return result;
}
