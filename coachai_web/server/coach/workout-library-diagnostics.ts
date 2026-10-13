import type { DatabaseSync } from 'node:sqlite';
import { workoutLibraryRepository } from '../storage/workout-library.js';
import { libraryCandidates } from './library-catalog.js';
import { fetchWorkoutLibrary, LibraryError } from './workout-library-client.js';
import { normalizeLibraryWorkout, WORKOUT_NORMALIZER_VERSION, type NormalizationIssue } from './workout-normalizer.js';

const codes: NormalizationIssue['code'][] = ['missing_data', 'invalid_value', 'unsupported_format', 'duration_mismatch', 'complexity_limit'];
export function diagnosticWorkoutId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null;
}

/** Only saved normalization results; never recompute from the lossy original_json. */
export function libraryDiagnostics(db: DatabaseSync, account?: string, selectedId?: number) {
  if (!account || !/^i?[1-9]\d{0,19}$/.test(account)) throw new LibraryError('not_configured');
  const repo = workoutLibraryRepository(db), rows = repo.list(account, { availableOnly: true });
  const workouts = rows.map(row => ({ workoutId: row.workoutId, name: row.name,
    compatible: row.compatible, normalizerVersion: row.normalizerVersion,
    issues: row.exclusionReasons, cachedOriginalComplete: row.originalComplete }));
  const incompatible = workouts.filter(w => !w.compatible);
  const groups = codes.map(code => {
    const affected = incompatible.filter(w => w.issues.some(i => i.code === code));
    const paths = [...new Set(affected.flatMap(w => w.issues.filter(i => i.code === code).map(i => i.path)))].sort();
    return { code, workouts: affected.length,
      occurrences: affected.reduce((sum, w) => sum + w.issues.filter(i => i.code === code).length, 0),
      paths: paths.map(path => ({ path, workouts: affected.filter(w => w.issues.some(i => i.code === code && i.path === path)).length })),
      sample: affected[0] ?? null };
  });
  const selected = selectedId === undefined ? null : workouts.find(w => w.workoutId === selectedId);
  if (selected === undefined) throw new LibraryError('workout_not_found');
  const state = repo.syncState(account);
  return { source: 'saved_normalization', available: rows.length, compatible: rows.length - incompatible.length,
    incompatible: incompatible.length, classifiable: libraryCandidates(db, account).length,
    syncState: state?.status ?? 'never_synced', lastSuccess: state?.lastSuccessAt ?? null,
    currentNormalizerVersion: WORKOUT_NORMALIZER_VERSION, groups, selected, workouts,
    limitation: 'Sono i rifiuti osservati: il normalizzatore può fermarsi al primo errore. La copia original_json è sanitizzata e può essere incompleta; non è il payload grezzo.' };
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const units = new Set(['%ftp', 'rpm', 'w', 'watts', '%hr', '%lthr', '%max_hr', 'bpm', 'pace', '%pace', 'm/s', 's/km']);
const targets = new Set(['AUTO', 'POWER', 'HR', 'PACE']);

/** Preserve operative fields and rejection types, never arbitrary names or strings.
 * Unknown operative field names are replaced, not dropped (dropping them could
 * turn an unsupported structure into a compatible fixture).
 */
export function redactLibraryPayload(input: unknown) {
  let nodes = 0, truncated = false;
  const bound = (depth: number) => {
    if (++nodes > 6000 || depth > 20) { truncated = true; return false; }
    return true;
  };
  const shape = (v: unknown): unknown => v === null ? null : Array.isArray(v) ? [] : object(v) ? {} :
    typeof v === 'number' ? 0 : typeof v === 'boolean' ? v : '[redacted]';
  const scalar = (v: unknown): unknown => typeof v === 'number' || typeof v === 'boolean' || v === null ? v : shape(v);
  const enumeration = (v: unknown, allowed: Set<string>) => typeof v === 'string' && allowed.has(v) ? v : shape(v);
  function target(v: unknown, depth: number): unknown {
    if (!bound(depth)) return null;
    if (!object(v)) return shape(v);
    const out: Record<string, unknown> = {}; let extra = 0;
    for (const [key, value] of Object.entries(v)) {
      if (['value', 'start', 'end'].includes(key)) out[key] = scalar(value);
      else if (key === 'units') out.units = enumeration(value, units);
      else out[`unsupported_field_${++extra}`] = shape(value);
    }
    return out;
  }
  function steps(v: unknown, depth: number): unknown {
    if (!bound(depth)) return null;
    if (!Array.isArray(v)) return shape(v);
    if (v.length > 2001) truncated = true;
    return v.slice(0, 2001).map(value => {
      if (!bound(depth + 1)) return null;
      if (!object(value)) return shape(value);
      const out: Record<string, unknown> = {}; let extra = 0;
      for (const [key, child] of Object.entries(value)) {
        if (['duration', 'distance', 'reps', 'ramp'].includes(key)) out[key] = scalar(child);
        else if (key === 'steps') out.steps = steps(child, depth + 1);
        else if (key === 'power' || key === 'cadence') out[key] = target(child, depth + 1);
        else if (key === 'text') out.text = typeof child === 'string' ?
          (child.length > 2000 ? 'x'.repeat(2001) : child.length ? '[redacted]' : '') : shape(child);
        // Known technical extra field from the uploaded export; never its values.
        else out[key === '_power' ? '_power' : `unsupported_field_${++extra}`] = shape(child);
      }
      return out;
    });
  }
  function doc(v: unknown): unknown {
    if (!object(v)) return shape(v);
    const out: Record<string, unknown> = {};
    for (const key of ['duration', 'distance']) if (Object.hasOwn(v, key)) out[key] = scalar(v[key]);
    if (Object.hasOwn(v, 'steps')) out.steps = steps(v.steps, 0);
    if (Object.hasOwn(v, 'options')) out.options = object(v.options) && Object.keys(v.options).length ? { unsupported_option: null } : shape(v.options);
    return out;
  }
  const payload: Record<string, unknown> = {};
  if (object(input)) {
    if (Object.hasOwn(input, 'target')) payload.target = enumeration(input.target, targets);
    if (Object.hasOwn(input, 'targets')) {
      if (Array.isArray(input.targets) && input.targets.length > 2001) truncated = true;
      payload.targets = Array.isArray(input.targets) ? input.targets.slice(0, 2001).map(v => enumeration(v, targets)) : shape(input.targets);
    }
    if (Object.hasOwn(input, 'moving_time')) payload.moving_time = scalar(input.moving_time);
    if (Object.hasOwn(input, 'workout_doc')) payload.workout_doc = doc(input.workout_doc);
  }
  return { payload, truncated };
}

/** Explicit GET only. No sync, leases, raw-cache writes, or raw logging. */
export function workoutLibraryDiagnostics(db: DatabaseSync, settings: { key?: string; athlete?: string },
  fetcher: typeof fetch = fetch, clock = () => new Date()) {
  let busy = false, nextRead = 0;
  return {
    summary: (id?: number) => libraryDiagnostics(db, settings.athlete, id),
    async exportWorkout(workoutId: number) {
      if (!diagnosticWorkoutId(workoutId)) throw new LibraryError('invalid_workout_id');
      if (!settings.athlete || !/^i?[1-9]\d{0,19}$/.test(settings.athlete) || !settings.key) throw new LibraryError('not_configured');
      const cached = workoutLibraryRepository(db).get(settings.athlete, workoutId);
      if (!cached?.available) throw new LibraryError('workout_not_found');
      if (busy) throw new LibraryError('busy');
      if (clock().getTime() < nextRead) throw new LibraryError('cooldown');
      busy = true;
      nextRead = clock().getTime() + 60_000;
      try {
        const rows = await fetchWorkoutLibrary({ athlete: settings.athlete, key: settings.key }, fetcher, clock().getTime());
        const raw = rows.find(row => object(row) && row.id === workoutId);
        if (!raw) throw new LibraryError('workout_not_found');
        if (Buffer.byteLength(JSON.stringify(raw)) > 1_048_576) throw new LibraryError('diagnostic_output_limit');
        const observed = normalizeLibraryWorkout(raw);
        const { payload, truncated } = redactLibraryPayload(raw);
        const redacted = normalizeLibraryWorkout(payload);
        const kind = (value: unknown) => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        const structuralFields = Object.fromEntries(['target', 'targets', 'moving_time', 'workout_doc', 'steps', 'duration', 'description'].map(field => [field, kind(object(raw) ? raw[field] : undefined)]));
        const result = { source: 'explicit_live_folders_get', workoutId, normalizerVersion: WORKOUT_NORMALIZER_VERSION,
          cached: { normalizerVersion: cached.normalizerVersion, compatible: cached.compatible, issues: cached.exclusionReasons },
          observed: { status: observed.status, issues: observed.issues },
          redacted: { status: redacted.status, issues: redacted.issues }, structuralFields, payload,
          redaction: { truncated, reproducesIssues: !truncated && observed.status === redacted.status && JSON.stringify(observed.issues) === JSON.stringify(redacted.issues),
            personalMetadataRemoved: true, freeTextMasked: true, unknownFieldNamesMasked: true },
          limitation: 'Esportato un solo workout dalla nuova GET; raw non persistito. Nomi e valori non strutturali sono mascherati. La cache e la classificazione non sono state modificate.' };
        if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) throw new LibraryError('diagnostic_output_limit');
        return result;
      } catch (error) {
        const safe = error instanceof LibraryError ? error : new LibraryError('diagnostic_failed');
        nextRead = clock().getTime() + Math.max(60_000, safe.cooldownMs);
        throw safe;
      } finally { busy = false; }
    },
  };
}
