import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { workoutLibraryRepository } from '../storage/workout-library.js';
import { fetchWorkoutLibrary, LibraryError } from './workout-library-client.js';

export function workoutLibrarySync(db: DatabaseSync, settings: { enabled?: boolean; key?: string; athlete?: string },
  fetcher: typeof fetch = fetch, clock = () => new Date()) {
  const account = settings.athlete?.replace(/^i?/, 'i');
  const valid = !!account && /^i[1-9]\d{0,19}$/.test(account);
  const key = `workout_library_status:${account}`, lease = `workout_library:${account}`;
  const repo = workoutLibraryRepository(db, clock);
  let running: Promise<unknown> | null = null;
  const controller = new AbortController();
  const read = (): Record<string, unknown> => {
    const row = db.prepare('SELECT value FROM app_state WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : {};
  };
  const save = (value: unknown) => db.prepare('INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const status = () => {
    const state = valid ? repo.syncState(account!) : null;
    const saved = valid ? read() : {};
    return { enabled: settings.enabled === true, configured: valid && !!settings.key,
      lastAttempt: state?.lastAttemptAt ?? null, lastSuccess: state?.lastSuccessAt ?? null,
      ...saved, countsCurrent: saved.generation === state?.generation && !!state?.lastSuccessAt, state: state?.status ?? 'never' };
  };
  async function run() {
    if (!settings.enabled) throw new LibraryError('disabled', 0);
    if (!valid || !settings.key) throw new LibraryError('not_configured', 0);
    const now = clock().getTime(), saved = read();
    if (Number(saved.cooldownUntil ?? 0) > now) throw new LibraryError('cooldown', 0);
    const owner = randomUUID();
    const acquired = db.prepare('INSERT INTO worker_leases(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE worker_leases.expires_at<=?').run(lease, owner, now + 120000, now);
    if (!acquired.changes) throw new LibraryError('busy', 0);
    try {
      const rows = await fetchWorkoutLibrary({ key: settings.key, athlete: account! }, fetcher, now, controller.signal);
      if (controller.signal.aborted) throw new LibraryError('interrupted');
      const held = db.prepare('SELECT owner,expires_at FROM worker_leases WHERE name=?').get(lease);
      if (held?.owner !== owner || Number(held.expires_at) <= clock().getTime()) throw new LibraryError('lease_expired');
      const before = new Map(repo.list(account!).map(row => [row.workoutId, row]));
      const state = repo.applyEnumeration(account!, rows, { complete: true, expectedCount: rows.length });
      const after = repo.list(account!);
      save({ received: rows.length, compatible: after.filter(row => row.available && row.compatible).length,
        incompatible: after.filter(row => row.available && !row.compatible).length,
        updated: after.filter(row => row.available && (!before.get(row.workoutId)?.available || before.get(row.workoutId)?.contentHash !== row.contentHash)).length,
        unavailable: after.filter(row => !row.available && before.get(row.workoutId)?.available).length,
        generation: state.generation, error: null, cooldownUntil: 0 });
      return status();
    } catch (error) {
      const safe = error instanceof LibraryError ? error : new LibraryError('validation_or_storage_failed');
      repo.recordFailure(account!, safe.code === 'interrupted' ? 'interrupted' : 'provider_unavailable');
      save({ ...read(), error: safe.code, cooldownUntil: clock().getTime() + safe.cooldownMs });
      return status();
    } finally {
      db.prepare('DELETE FROM worker_leases WHERE name=? AND owner=?').run(lease, owner);
    }
  }
  return { status, syncOnce() {
    if (running) return Promise.reject(new LibraryError('busy', 0));
    running = run().finally(() => { running = null; });
    return running;
  }, async stop() { controller.abort(); await running?.catch(() => {}); } };
}
