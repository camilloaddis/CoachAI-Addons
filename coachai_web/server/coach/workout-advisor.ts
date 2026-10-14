import { workoutStillSafe, type WorkoutSelection } from './training.js';
import { librarySelectionNote, type CatalogWorkout } from './library-catalog.js';
import { recommendations } from './planner.js';
import { goalFocus, goalFit, goalLabels, workoutFeatures, type GoalFocus } from './workout-goals.js';
export type AdviceReason = 'compatible' | 'goal_focus' | 'duration_fit' | 'load_fit';
export type AdviceInput = {
  goal: GoalFocus; readiness: number | null; confidence: number;
  load: { ctl: number | null; atl: number | null; tsb: number | null };
  phase?: string; week?: number | null; loadTarget?: WorkoutSelection['loadTarget'];
  mode: 'manual' | 'automatic'; recommended: string;
  candidates: { id: string; category: string; durationSeconds: number; peakPercentFtp: number; sustainedSeconds: number; lowCadenceSeconds: number; trainingLoad?: number | null; loadDifference?: number | null; reasons: AdviceReason[] }[];
};
export type AdviceChoice = { candidateId: string; reason: AdviceReason };
export function validateWorkoutChoice(value: unknown, input: AdviceInput): AdviceChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_workout_advice');
  const v = value as Record<string, unknown>;
  const candidate = input.candidates.find(c => c.id === v.candidateId);
  if (Object.keys(v).length !== 2 || !candidate || !candidate.reasons.includes(v.reason as AdviceReason)) throw Error('invalid_workout_advice');
  return { candidateId: candidate.id, reason: v.reason as AdviceReason };
}
export type WorkoutAdvice = { mode: 'ai' | 'deterministic'; status: 'selected' | 'disabled' | 'single_candidate' | 'no_library' | 'provider_unavailable' | 'context_changed'; explanation: string; goal: GoalFocus; version: 1 };
const reference = (w: CatalogWorkout) => w.library ? `${w.library.account}:${w.library.id}:${w.library.contentHash}` : '';
const context = (p: WorkoutSelection) => JSON.stringify([p.date,p.config,p.readiness,p.confidence,p.metrics,p.decision.intent,p.recommendation,p.constraints,p.loadTarget,p.phase,p.week]);
export type PendingAdvice = { reference: string | null; context: string; status: WorkoutAdvice['status']; reason: AdviceReason };
export async function requestWorkoutAdvice(plan: WorkoutSelection, candidates: CatalogWorkout[], enabled: boolean,
  choose: (input: AdviceInput) => Promise<AdviceChoice>): Promise<PendingAdvice> {
  const base: PendingAdvice = { reference: null, context: context(plan), status: 'disabled', reason: 'compatible' };
  if (!enabled) return base;
  const local = candidates.filter(c => workoutStillSafe(c,plan)).slice(0, 8);
  if (!local.length) return { ...base, status: 'no_library' };
  if (local.length < 2) return { ...base, status: 'single_candidate' };
  const goal = goalFocus(plan.config.goal);
  const input: AdviceInput = { goal, readiness: plan.readiness, confidence: plan.confidence, load: plan.metrics, mode: plan.decision.intent.mode,
    recommended: plan.recommendation, phase:plan.phase, week:plan.week, loadTarget:plan.loadTarget, candidates: local.map((w, index) => ({ id: `candidate-${index + 1}`, category: w.library!.category,
      ...workoutFeatures(w), trainingLoad:w.library!.trainingLoad ?? null, loadDifference:plan.loadTarget?.target == null || w.library!.trainingLoad == null ? null : w.library!.trainingLoad-plan.loadTarget.target, reasons: ['compatible', ...(plan.loadTarget?.target == null ? [] : ['load_fit' as const]), ...(goalFit(w,goal) > 0 ? ['goal_focus' as const] : []),
        ...(Math.abs(w.library!.normalized.durationSeconds / 60 - plan.config.duration) <= 10 ? ['duration_fit' as const] : [])] })) };
  try {
    const choice = validateWorkoutChoice(await choose(input), input);
    const index = input.candidates.findIndex(c => c.id === choice.candidateId);
    return { ...base, reference: reference(local[index]), status: 'selected', reason: choice.reason };
  } catch { return { ...base, status: 'provider_unavailable' }; }
}
/** Revalidate against the current local shortlist inside the persistence transaction. */
export function applyWorkoutAdvice(plan: WorkoutSelection, candidates: CatalogWorkout[], advice: PendingAdvice): WorkoutSelection {
  if (!plan.workout) return plan;
  const goal = goalFocus(plan.config.goal);
  const selected = advice.status === 'selected' && advice.context === context(plan) ? candidates.find(c => reference(c) === advice.reference && workoutStillSafe(c,plan)) : undefined;
  const workout = selected ?? plan.workout;
  const mode = selected ? 'ai' : 'deterministic';
  const status = advice.status === 'selected' && !selected ? 'context_changed' : advice.status;
  const duration = workout.library ? workout.library.normalized.durationSeconds / 60 : plan.duration;
  const reason = selected && advice.reason === 'goal_focus' ? `Fra le opzioni compatibili, questa struttura sostiene l’obiettivo: ${goalLabels[goal]}.` :
    selected && advice.reason === 'load_fit' ? 'Carico Intervals vicino al riferimento giornaliero fra i candidati validati, coerente con la modalità scelta.' :
    selected && advice.reason === 'duration_fit' ? 'La durata è vicina al tempo impostato, rispettando i vincoli della proposta.' :
    `Seduta ${workout.library?.category ?? plan.recommendation}, ${plan.decision.intent.mode === 'manual' ? 'richiesta esplicitamente' : 'entro i limiti del Planner'}.`;
  const manualNote = plan.decision.exceedsRecommendation ? ` La richiesta supera il consiglio automatico ${plan.decision.automaticRecommendation}: restano validi gli avvisi della proposta.` : "";
  const fallback = status === 'provider_unavailable' ? ' AI non disponibile o risposta non valida: scelta locale.' : status === 'context_changed' ? ' Dati o candidati aggiornati durante la scelta: proposta locale rivalutata.' : '';
  return { ...plan, workout, duration, catalogNote: selected ? librarySelectionNote(workout,plan.config.duration,recommendations.indexOf(plan.recommendation)) : plan.catalogNote, proposedCategory: workout.library?.category ?? null, advisor: { mode, status, explanation: `${reason} Durata ${Math.round(duration * 10) / 10} minuti.${fallback}${manualNote}`, goal, version: 1 } };
}
