import { existsSync, readFileSync } from "node:fs";
// Home Assistant stores add-on options outside the application checkout.
// Never log this object or include credentials in API responses.
export function intervalsConfig(
  env: NodeJS.ProcessEnv = process.env,
  path = env.COACHAI_OPTIONS_FILE ?? "/data/options.json",
): { key?: string; athlete?: string } {
  let options: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value))
        options = value as Record<string, unknown>;
    } catch {
      /* Invalid add-on options mean unconfigured integration; never log raw content. */
    }
  }
  return {
    key:
      env.INTERVALS_API_KEY ??
      (typeof options.intervals_api_key === "string"
        ? options.intervals_api_key
        : undefined),
    athlete:
      env.INTERVALS_ATHLETE_ID ??
      (typeof options.intervals_athlete_id === "string"
        ? options.intervals_athlete_id
        : undefined),
  };
}
