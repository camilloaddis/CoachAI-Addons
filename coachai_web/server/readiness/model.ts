/** Bump when score, confidence or interpretation of recorded recommendations changes. */
export const READINESS_MODEL_VERSION = "readiness-v4";

export type HistoryEntry = {
  date: string;
  observed_at: string;
  score: number | null;
  confidence: number;
  recommendation: string;
  model_version: string;
};
