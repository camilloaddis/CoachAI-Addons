// Preserve the Home Assistant Ingress session prefix for API requests.
export function apiPath(
  path: string,
  pathname = window.location.pathname,
): string {
  const ingress = pathname.match(
    /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+(?:\/|$)/,
  );
  return (ingress ? ingress[0].replace(/\/$/, "") : "") + path;
}
export function apiFetch(path: string, options: RequestInit = {}) {
  return fetch(apiPath(path), {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...options.headers, "X-CoachAI-Request": "1" },
  });
}
export type Tab = "summary" | "training" | "nutrition" | "debug";
