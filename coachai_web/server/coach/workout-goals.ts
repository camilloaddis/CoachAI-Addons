import type { CatalogWorkout } from './library-catalog.js';
import type { WorkoutNode } from './workout-normalizer.js';
export type GoalFocus = 'ftp' | 'climbing' | 'endurance' | 'balanced';
export const goalLabels: Record<GoalFocus, string> = { ftp: 'miglioramento FTP', climbing: 'prestazioni in salita', endurance: 'resistenza sulle uscite lunghe', balanced: 'allenamento equilibrato' };
/** Interpret existing settings locally; free text is never sent to the provider. */
export function goalFocus(text: string): GoalFocus {
  const goal = text.toLowerCase();
  if (/salit|climb|dislivello/.test(goal)) return 'climbing';
  if (/ftp|soglia|threshold/.test(goal)) return 'ftp';
  if (/endurance|resistenza|lunghe|lungo|80.?100/.test(goal)) return 'endurance';
  return 'balanced';
}
export function workoutFeatures(workout: CatalogWorkout) {
  const result = { durationSeconds: workout.library?.normalized.durationSeconds ?? 0, peakPercentFtp: workout.library?.normalized.peakPowerPercentFtp ?? 0, sustainedSeconds: 0, lowCadenceSeconds: 0 };
  function visit(steps: WorkoutNode[], repeats: number) {
    for (const step of steps) {
      if (step.kind === 'repeat') { visit(step.steps, repeats * step.repetitions); continue; }
      const low = step.power.kind === 'constant' ? step.power.value : Math.min(step.power.start, step.power.end);
      const high = step.power.kind === 'constant' ? step.power.value : Math.max(step.power.start, step.power.end);
      const seconds = step.durationSeconds * repeats;
      if (low >= 88 && high <= 105) result.sustainedSeconds += seconds;
      const cadence = step.cadence;
      if (cadence && low >= 76 && (cadence.kind === 'constant' ? cadence.value : Math.min(cadence.start, cadence.end)) >= 35 &&
        (cadence.kind === 'constant' ? cadence.value : Math.max(cadence.start, cadence.end)) <= 70) result.lowCadenceSeconds += seconds;
    }
  }
  if (workout.library) visit(workout.library.normalized.steps, 1);
  return result;
}
export function goalFit(workout: CatalogWorkout, goal: GoalFocus): number {
  const f = workoutFeatures(workout);
  if (!f.durationSeconds) return 0;
  return goal === 'endurance' ? f.durationSeconds : goal === 'ftp' ? f.sustainedSeconds / f.durationSeconds :
    goal === 'climbing' ? (f.sustainedSeconds + 2 * f.lowCadenceSeconds) / f.durationSeconds : 0;
}
