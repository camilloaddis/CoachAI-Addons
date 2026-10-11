import type { DataQualityAssessment, Factor } from "./types.js";

/** Evidence availability/reliability only: no readiness score, request or ceiling. */
export type ConfidenceInput = {
  loadAvailable: boolean;
  hrvEligible: boolean;
  restingHREligible: boolean;
  sleepAvailable: boolean;
  historyReliable: boolean;
  hasRecentActivities: boolean;
  probableIntensitySequence: boolean;
  conflictingRecovery: boolean;
};

/** Preserve the existing weights (ordinary maximum 90); no policy thresholds. */
export function assessDataQuality(input: ConfidenceInput): DataQualityAssessment {
  let confidence = 0;
  const reasons: Factor[] = [];
  const uncertain = (code: string, evidence: Factor["evidence"], text: string) => {
    reasons.push({ code, category: "data", polarity: "uncertain", evidence, text });
  };
  for (const [available, weight, code, text] of [
    [input.loadAvailable, 20, "load", "CTL/ATL odierni non disponibili: contributo confidence 0/20."],
    [input.hrvEligible, 15, "hrv", "HRV odierna o baseline valida assente: contributo confidence 0/15."],
    [input.restingHREligible, 15, "resting_hr", "FC riposo odierna o baseline valida assente: contributo confidence 0/15."],
    [input.sleepAvailable, 15, "sleep", "Sleep Score odierno non disponibile: contributo confidence 0/15."],
  ] as const) {
    if (available) confidence += weight;
    else uncertain(`confidence_${code}_missing`, "missing", text);
  }
  confidence += input.historyReliable ? 25 : input.hasRecentActivities ? 10 : 0;
  if (!input.historyReliable)
    uncertain(
      "confidence_history_partial",
      input.hasRecentActivities ? "inferred" : "missing",
      `Copertura/carichi/classificazioni dello storico non verificati: contributo confidence ${input.hasRecentActivities ? 10 : 0}/25.`,
    );
  if (input.probableIntensitySequence) {
    confidence -= 5;
    uncertain("confidence_sequence_unverified", "inferred", "Sequenza intensa con evidenza solo probabile: confidence −5, nessuna penalità allo score.");
  }
  if (input.conflictingRecovery) {
    confidence -= 15;
    uncertain("confidence_conflicting_signals", "subjective", "Recupero attuale e segnali oggettivi discordanti: confidence −15 per affidabilità della valutazione.");
  }
  return {
    confidence: Math.max(0, Math.min(100, confidence)),
    reasons,
    missing: reasons.filter((r) => r.evidence === "missing").map((r) => r.text),
  };
}
