import type { TrainingCategory, TrainingIntent } from "../readiness/types.js";
export const categories: TrainingCategory[] = ["rest", "recovery", "endurance", "tempo", "sweet_spot", "threshold", "vo2max", "strength"];
export function validateIntent(value: unknown): TrainingIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw TypeError("invalid_training_intent");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2) throw TypeError("invalid_training_intent");
  if (v.mode === "manual" && Object.hasOwn(v, "mode") && Object.hasOwn(v, "category") && typeof v.category === "string" && categories.includes(v.category as TrainingCategory))
    return { mode: "manual", category: v.category as TrainingCategory };
  if (v.mode === "automatic" && Object.hasOwn(v, "mode") && Object.hasOwn(v, "preference") && typeof v.preference === "string" && ["recommended", "lighter", "harder"].includes(String(v.preference)))
    return { mode: "automatic", preference: v.preference as "recommended" | "lighter" | "harder" };
  throw TypeError("invalid_training_intent");
}
/** Only closed, named category commands opt into manual selection. */
export function intentForRequest(request: string): TrainingIntent {
  const explicit: Record<string, TrainingCategory> = {
    ss: "sweet_spot", soglia: "threshold", vo2max: "vo2max", tempo: "tempo",
    endurance: "endurance", forza: "strength", recupero: "recovery", riposo: "rest",
  };
  return Object.hasOwn(explicit, request)
    ? { mode: "manual", category: explicit[request] }
    : { mode: "automatic", preference: request === "leggero" ? "lighter" : request === "intenso" ? "harder" : "recommended" };
}
export const categoryLevel: Record<TrainingCategory, number> = {
  rest: 0, recovery: 1, endurance: 2, tempo: 3, strength: 3,
  sweet_spot: 4, threshold: 4, vo2max: 5,
};

export const categoryLabels: Record<TrainingCategory, string> = {
  rest: "Riposo", recovery: "Recupero", endurance: "Endurance", tempo: "Tempo",
  sweet_spot: "Sweet Spot", threshold: "Soglia", vo2max: "VO2max", strength: "Forza",
};
