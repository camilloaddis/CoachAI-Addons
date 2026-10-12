import type { DatabaseSync } from "node:sqlite";
import { evaluate } from "./engine.js";
import { readIntervals, readSnapshot } from "./sources.js";
import { today, type Result } from "./types.js";
export function readinessService(
  database: () => DatabaseSync | null,
  config: { key?: string; athlete?: string },
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
  revision: () => string = () => "",
  cachedRemote?: () => Awaited<ReturnType<typeof readIntervals>> | null,
) {
  let cache: { date: string; expires: number; result: Result } | null = null;
  let pending: { date: string; promise: Promise<Result> } | null = null;
  let lastRevision = "";
  return async (): Promise<Result> => {
    const next = revision();
    if (next !== lastRevision) {
      cache = null;
      pending = null;
      lastRevision = next;
    }
    const now = clock(),
      date = today(now);
    if (cache?.date === date && cache.expires > now.getTime())
      return cache.result;
    if (pending?.date === date) return pending.promise;
    const promise = (async () => {
      let db: DatabaseSync | null = null;
      try {
        db = database();
      } catch {
        /* handled as unavailable snapshot */
      }
      const local = readSnapshot(db, date, now);
      let remote: Awaited<ReturnType<typeof readIntervals>>;
      try {
        remote =
          cachedRemote?.() ?? (await readIntervals(date, config, fetcher));
      } catch {
        remote = {
          wellness: [],
          activities: [],
          historyComplete: false,
          issues: [
            "Cache Intervals non valida: esclusa, nessun dato fisiologico sostitutivo.",
          ],
        };
      }
      // Successful remote history is authoritative: no double-counting commuting or rides.
      const activities = remote.historyComplete
        ? remote.activities.map((a) => {
            const snapshot = local.activities.find(
              (s) => s.id === a.id && s.date === a.date,
            );
            return {
              ...a,
              name: a.name ?? snapshot?.name,
              type: a.type ?? snapshot?.type,
              // Successful remote reads are authoritative, including removal.
              rpe: a.rpe,
            };
          })
        : local.activities;
      const result = evaluate({
        date,
        wellness: remote.wellness,
        activities,
        feedback: local.feedback,
        historyComplete: remote.historyComplete,
        issues: [...local.issues, ...remote.issues],
      });
      if (revision() === next)
        cache = { date, expires: now.getTime() + 60000, result };
      return result;
    })();
    pending = { date, promise };
    try {
      return await promise;
    } finally {
      if (pending?.promise === promise) pending = null;
    }
  };
}
