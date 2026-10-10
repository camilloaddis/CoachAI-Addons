// Errors are deliberately generic: provider responses may contain personal data.
export class ProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export async function jsonRequest(
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit,
  timeout = 8000,
  limit = 1048576,
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(timeout),
      ...(init.signal ? [init.signal] : []),
    ]),
  }).catch(() => {
    throw new ProviderError("provider_transport");
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError("provider_status");
  }
  return readJsonResponse(response, limit);
}
export async function readJsonResponse(
  response: Response,
  limit = 1048576,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("provider_empty");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ProviderError("provider_output_limit");
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new ProviderError("provider_json");
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError("invalid_object");
  return value as Record<string, unknown>;
}
