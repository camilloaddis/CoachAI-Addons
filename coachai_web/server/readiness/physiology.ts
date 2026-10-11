/** Physiological capacity only: no calendar, confidence or workout request. */
export function physiologicalAvailability(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  return score < 35 ? 0 : score < 50 ? 1 : score < 60 ? 2 : score < 80 ? 4 : 5;
}

/** OpenAPI Wellness.sleepSecs is int32. Zero is not evidence of zero sleep. */
export function sleepDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 86400
    ? value : null;
}
export type ScoreAdjustment = {
  code: string;
  maximum: number;
  reason: string;
  before: number | null;
  after: number | null;
  applied: boolean;
};
/** Apply measured/current safety signals to the score itself, with a trace.
 * Missing values never create a signal or a synthetic readiness score.
 */
export function applyScoreAdjustments(
  rawScore: number | null,
  signals: Pick<ScoreAdjustment, "code" | "maximum" | "reason">[],
): { score: number | null; adjustments: ScoreAdjustment[] } {
  let score = rawScore;
  const adjustments = signals.map((signal) => {
    const before = score;
    score = score === null ? null : Math.min(score, signal.maximum);
    return { ...signal, before, after: score, applied: before !== score };
  });
  return { score, adjustments };
}
