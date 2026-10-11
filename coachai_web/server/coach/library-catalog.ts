import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { workoutLibraryRepository } from '../storage/workout-library.js';
import { WORKOUT_NORMALIZER_VERSION, type NormalizedWorkout, type WorkoutNode } from './workout-normalizer.js';
import type { TrainingCategory } from '../readiness/types.js';

export type CatalogWorkout = {
  name: string; structure: string; difficulty: number;
  library?: { account: string; id: number; contentHash: string; fingerprint: string; category: TrainingCategory; normalized: NormalizedWorkout; syncedAt: string };
};
/** Planned targets only. Never evidence that an athlete executed these intervals. */
export function plannedCategory(workout: NormalizedWorkout): TrainingCategory | null {
  if (workout.peakPowerPercentFtp <= 55) return 'recovery';
  if (workout.peakPowerPercentFtp <= 75) return 'endurance';
  let vo2 = 0, threshold = 0, sweet = 0, tempo = 0, strength = 0, uncertain = false;
  const visit = (steps: WorkoutNode[], reps: number) => {
    for (const node of steps) {
      if (node.kind === 'repeat') { visit(node.steps, reps * node.repetitions); continue; }
      const power = node.power;
      const low = power.kind === 'constant' ? power.value : Math.min(power.start, power.end);
      const high = power.kind === 'constant' ? power.value : Math.max(power.start, power.end);
      const duration = node.durationSeconds * reps;
      if (high <= 75) continue;
      // A ramp up to Tempo is preparation, not sustained high-intensity work.
      if (power.kind === "ramp" && high <= 85) continue;
      // Ramps crossing zones are not sustained work in a single category.
      if (low >= 106 && high <= 130) vo2 += duration;
      else if (low >= 95 && high <= 105) threshold += duration;
      else if (low >= 88 && high <= 96) sweet += duration;
      else if (low > 75 && high < 88) tempo += duration;
      else uncertain = true;
      const cadence = node.cadence;
      if (cadence && (cadence.kind === 'constant' ? cadence.value : Math.min(cadence.start, cadence.end)) >= 35 && low >= 76 && high <= 100 && (cadence.kind === 'constant' ? cadence.value : Math.max(cadence.start, cadence.end)) <= 65) strength += duration;
    }
  };
  visit(workout.steps, 1);
  if (uncertain) return null;
  if (vo2) return vo2 >= 180 ? 'vo2max' : null;
  if (strength >= 300 && strength === threshold + sweet + tempo) return 'strength';
  if (threshold) return threshold >= 600 ? 'threshold' : null;
  if (sweet) return sweet >= 600 ? 'sweet_spot' : null;
  return tempo >= 600 ? 'tempo' : null;
}
export function structureFingerprint(workout: NormalizedWorkout): string {
  // Canonical executed-order targets, independent of labels and repeat grouping.
  const segments: { duration: number; target: string }[] = [];
  const visit = (steps: WorkoutNode[]) => {
    for (const node of steps) {
      if (node.kind === 'repeat') { for (let i=0;i<node.repetitions;i++) visit(node.steps); continue; }
      const target = JSON.stringify([node.power, node.cadence ?? null]);
      const last = segments.at(-1);
      if (node.power.kind !== 'ramp' && last?.target === target) last.duration += node.durationSeconds;
      else segments.push({ duration: node.durationSeconds, target });
    }
  };
  visit(workout.steps);
  return createHash('sha256').update(JSON.stringify(segments)).digest('hex');
}
function display(steps: WorkoutNode[], indent = ''): string {
  return steps.map(node => {
    if (node.kind === 'repeat') return `${indent}${node.repetitions} ×\n${display(node.steps, indent + '  ')}`;
    const p = node.power, c = node.cadence;
    return `${indent}${node.durationSeconds}s · ${p.kind === 'constant' ? p.value : `${p.start}–${p.end}`} %FTP${p.kind === 'ramp' ? ' (rampa)' : ''}${c ? ` · ${c.kind === 'constant' ? c.value : `${c.start}–${c.end}`} rpm` : ''}${node.label ? ' · ' + node.label : ''}`;
  }).join('\n');
}
export function libraryCandidates(db: DatabaseSync, account?: string): CatalogWorkout[] {
  if (!account || !/^i?[1-9]\d{0,19}$/.test(account)) return [];
  return workoutLibraryRepository(db).list(account, {availableOnly:true,compatibleOnly:true}).flatMap(row => {
    if (!['Ride', 'VirtualRide'].includes(row.sport) || !row.normalized || row.normalizerVersion !== WORKOUT_NORMALIZER_VERSION) return [];
    const category = plannedCategory(row.normalized);
    if (!category) return [];
    return [{ name: row.name, structure: display(row.normalized.steps), difficulty: ['recovery','endurance'].includes(category) ? 1 : ['tempo','strength'].includes(category) ? 2 : 3,
      library: { account: row.accountId, id: row.workoutId, contentHash: row.contentHash, fingerprint: structureFingerprint(row.normalized), category, normalized: row.normalized, syncedAt: row.lastSyncedAt } }];
  });
}
