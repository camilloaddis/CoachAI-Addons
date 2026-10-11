import { object, readJsonResponse } from './http.js';

export class LibraryError extends Error {
  constructor(public readonly code: string, public readonly cooldownMs = 60000) { super(code); }
}
// A complete folders response is the only authoritative enumeration supported here.
export function libraryEnumeration(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10000) throw new LibraryError('invalid_enumeration');
  const folders = new Set<number>(), ids = new Set<number>();
  const rows: unknown[] = [];
  for (const item of value) {
    const folder = object(item);
    if (!Number.isSafeInteger(folder.id) || Number(folder.id) <= 0 || folders.has(Number(folder.id)) ||
      !['FOLDER', 'PLAN'].includes(String(folder.type)) || !Array.isArray(folder.children) ||
      !Number.isSafeInteger(folder.num_workouts) || folder.num_workouts !== folder.children.length)
      throw new LibraryError('incomplete_enumeration');
    folders.add(Number(folder.id));
    for (const child of folder.children) {
      const row = object(child);
      if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || ids.has(Number(row.id)) ||
        (row.folder_id != null && row.folder_id !== folder.id)) throw new LibraryError('invalid_enumeration');
      ids.add(Number(row.id));
      rows.push({ ...row, folder_id: folder.id });
      if (rows.length > 10000) throw new LibraryError('invalid_enumeration');
    }
  }
  return rows;
}
export async function fetchWorkoutLibrary(
  settings: { key: string; athlete: string }, fetcher: typeof fetch = fetch,
  now = Date.now(), signal?: AbortSignal, timeoutMs = 15000,
): Promise<unknown[]> {
  if (!/^i?[1-9]\d{0,19}$/.test(settings.athlete) || !settings.key) throw new LibraryError('not_configured');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(`https://intervals.icu/api/v1/athlete/${settings.athlete}/folders`, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Basic ${Buffer.from(`API_KEY:${settings.key}`).toString('base64')}` },
        });
        if (response.status !== 200) {
          const retry = response.headers.get('Retry-After');
          const delay = retry == null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
          void response.body?.cancel().catch(() => {});
          const status = [401, 403, 429].includes(response.status) ? String(response.status) : response.status >= 500 ? '5xx' : 'status';
          throw new LibraryError(`http_${status}`, Math.max(Number.isFinite(delay) ? delay : 0, response.status === 401 || response.status === 403 ? 3600000 : 60000));
        }
        return libraryEnumeration(await readJsonResponse(response, 16 * 1024 * 1024));
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { abort(); reject(new LibraryError('timeout')); }, timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw new LibraryError(controller.signal.aborted ? 'interrupted' : 'invalid_response_or_transport');
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
