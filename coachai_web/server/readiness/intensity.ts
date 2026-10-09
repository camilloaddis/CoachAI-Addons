import { number, type Activity, type IntensityAssessment } from "./types.js";
// Only fields verified in Node-RED's activity mapping. No speed-based inference.
export function assessIntensity(activity: Activity): IntensityAssessment {
  const result: IntensityAssessment = {
    id: activity.id,
    date: activity.date,
    status: "non_determinabile",
    reasons: [],
  };
  const average = number(activity.intensity, 0, 200);
  if (average !== null && average >= 85) {
    result.status = "confermata";
    result.reasons.push(`Intensità media ${average}% ≥85%.`);
  }
  const name = activity.name ?? "";
  if (
    /\bvo2(?:max)?\b|vo₂|sprint|anaerob|sweet[ -]?spot|soglia|threshold|over[ -]?under|30\s*\/\s*30|40\s*\/\s*20/i.test(
      name,
    )
  ) {
    if (result.status !== "confermata") result.status = "probabile";
    result.reasons.push(
      `Nome attività suggerisce lavoro intenso (${name}); non conferma l’esecuzione degli intervalli.`,
    );
  }
  const rpe = number(activity.rpe, 0, 10);
  if (rpe !== null && rpe >= 7) {
    if (result.status !== "confermata") result.status = "probabile";
    result.reasons.push(`RPE ${rpe}/10: sforzo elevato, indizio soggettivo.`);
  }
  if (result.status === "non_determinabile")
    result.reasons.push(
      "Media bassa/assente e nessun indizio verificabile: gli intervalli brevi non sono esclusi.",
    );
  return result;
}
