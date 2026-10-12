import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { workoutLibraryRepository } from '../storage/workout-library.js';
import { WORKOUT_NORMALIZER_VERSION, type NormalizedWorkout, type WorkoutNode } from './workout-normalizer.js';
import type { TrainingCategory } from '../readiness/types.js';

export type CatalogWorkout = {
  name: string; structure: string; difficulty: number;
  library?: { account: string; id: number; contentHash: string; fingerprint: string; category: TrainingCategory; normalized: NormalizedWorkout; syncedAt: string };
};
/** Distribution of planned targets, never evidence of completed work.
 * Linear ramps contribute proportional time. A narrow non-ramp range uses its
 * lower bound for classification, its upper bound for safety (not an average).
 */
export function plannedProfile(workout: NormalizedWorkout) {
  const seconds = { recovery: 0, endurance: 0, tempo: 0, sweet_spot: 0, threshold: 0, vo2max: 0, supra: 0 };
  const boundaries = [55, 75, 88, 95, 105, 130, Infinity];
  const keys = Object.keys(seconds) as (keyof typeof seconds)[];
  let ambiguousSeconds = 0, strengthSeconds = 0;
  const visit = (steps: WorkoutNode[], reps: number) => {
    for (const node of steps) {
      if (node.kind === 'repeat') { visit(node.steps, reps * node.repetitions); continue; }
      const p = node.power, d = node.durationSeconds * reps;
      const low = p.kind === 'constant' ? p.value : Math.min(p.start, p.end);
      const high = p.kind === 'constant' ? p.value : Math.max(p.start, p.end);
      const zone = (v: number) => v <= 55 ? 0 : v <= 75 ? 1 : v < 88 ? 2 : v < 95 ? 3 : v <= 105 ? 4 : v <= 130 ? 5 : 6;
      if (p.kind === 'ramp' && high > low) {
        for (let i = 0; i < keys.length; i++) seconds[keys[i]] += d * Math.max(0, Math.min(high, boundaries[i]) - Math.max(low, i ? boundaries[i-1] : 0)) / (high - low);
      } else if (zone(low) === zone(high) || high - low <= 10) seconds[keys[zone(low)]] += d;
      else ambiguousSeconds += d;
      const c = node.cadence;
      if (c && low >= 76 && high <= 100 && (c.kind === 'constant' ? c.value : Math.min(c.start,c.end)) >= 35 && (c.kind === 'constant' ? c.value : Math.max(c.start,c.end)) <= 65) strengthSeconds += d;
    }
  };
  visit(workout.steps, 1);
  const active = seconds.tempo + seconds.sweet_spot + seconds.threshold + seconds.vo2max;
  let category: TrainingCategory | null = null, reason = 'insufficient_sustained_work';
  if (ambiguousSeconds > 0) reason = 'ambiguous_power_range';
  else if ((seconds.supra >= 180 && seconds.supra >= .4 * active) || (workout.peakPowerPercentFtp > 200 && seconds.supra >= 90)) reason = 'anaerobic_or_sprint_dominant';
  else if (workout.peakPowerPercentFtp <= 55) category = 'recovery';
  else if (workout.peakPowerPercentFtp <= 75) category = 'endurance';
  else if (strengthSeconds >= 300 && strengthSeconds >= .5 * active && seconds.vo2max < 180) category = 'strength';
  else {
    const qualifying = ([['vo2max',180],['threshold',600],['sweet_spot',600],['tempo',600]] as const).filter(([key,min]) => seconds[key] >= min && (key !== "vo2max" || seconds.vo2max >= .4 * active));
    // Brief spikes do not outrank the main block. Prefer the highest zone only
    // when it accounts for at least 40% of purposeful work above endurance.
    category = qualifying.find(([key]) => seconds[key] >= .4 * active)?.[0] ?? qualifying.sort((a,b) => seconds[b[0]]-seconds[a[0]])[0]?.[0] ?? null;
    if (!category && seconds.recovery + seconds.endurance >= .7 * workout.durationSeconds && seconds.vo2max < 180 && seconds.supra === 0) category = 'endurance';
  }
  return { category, reason: category ? 'planned_distribution' : reason, seconds, ambiguousSeconds, strengthSeconds };
}
export function plannedCategory(workout: NormalizedWorkout): TrainingCategory | null { return plannedProfile(workout).category; }

/** Upper-envelope safety, independent of the descriptive main category.
 * No spike tolerance on rest/recovery/endurance days. Quality sessions may
 * contain <=30s excursions, <=90s total and <=3% of duration, with a hard cap.
 */
export function plannedIntensitySafety(workout: NormalizedWorkout, level: number) {
  const ceiling = [0,60,75,100,105,130][level] ?? 0;
  let excessSeconds = 0, longest = 0, running = 0;
  function visit(steps: WorkoutNode[]) {
    for (const node of steps) {
      if (node.kind === 'repeat') { for (let i=0;i<node.repetitions;i++) visit(node.steps); continue; }
      const p=node.power, low=p.kind==='constant'?p.value:Math.min(p.start,p.end), high=p.kind==='constant'?p.value:Math.max(p.start,p.end);
      const excess = high <= ceiling ? 0 : p.kind==='ramp' && low < ceiling ? node.durationSeconds*(high-ceiling)/(high-low) : node.durationSeconds;
      if (p.kind==='ramp' && p.end > p.start && low < ceiling) running=0;
      running = excess ? running + excess : 0;
      excessSeconds += excess; longest=Math.max(longest,running);
      if (p.kind==='ramp' && p.end < p.start && low < ceiling) running=0;
    }
  }
  visit(workout.steps);
  const cap = level === 5 ? 180 : Math.min(130,ceiling*1.25);
  const allowed = workout.peakPowerPercentFtp <= ceiling || (level >= 3 && workout.peakPowerPercentFtp <= cap && excessSeconds <= Math.min(90,.03*workout.durationSeconds) && longest <= 30);
  return { allowed, ceiling, peak: workout.peakPowerPercentFtp, excessSeconds, longestExcessSeconds:longest, briefExcursion:allowed && excessSeconds>0 };
}
export function libraryDurationLimit(configured: number, category?: TrainingCategory) {
  return configured + (category && !['rest','recovery'].includes(category) ? Math.min(5,configured*.1) : 0);
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

export function librarySelectionNote(workout: CatalogWorkout, configured: number, level: number) {
  if (!workout.library) return 'Proposta storica: nessun workout Intervals valido.';
  const duration=workout.library.normalized.durationSeconds/60;
  return 'Workout reale dalla cache Intervals, struttura integrale.' + (duration>configured ? ` Durata ${duration} min: entro la tolleranza rispetto ai ${configured} min configurati.` : '') + (plannedIntensitySafety(workout.library.normalized,level).briefExcursion ? ' Brevi picchi verificati entro il margine consentito per una seduta di qualità.' : '');
}
