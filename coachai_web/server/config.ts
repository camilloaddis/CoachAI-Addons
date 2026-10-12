import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
export type RuntimeConfig = {
  lanEnabled?: boolean;
  lanAuthRequired?: boolean;
  lanWebPassword?: string;
  lanWebOrigin?: string;
  groqEnabled?: boolean;
  groqKey?: string;
  groqModel?: string;
  intervalsCalendarWriteEnabled?: boolean;
  intervalsLibrarySyncEnabled?: boolean;
  intervalsSyncEnabled?: boolean;
  intervalsDetailsEnabled?: boolean;
  intervalsPollSeconds?: number;
  nodeRedStopped: boolean;
  adminToken: string;
  dataSource: "snapshot" | "local";
};
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  path = env.COACHAI_OPTIONS_FILE ?? "/data/options.json",
): RuntimeConfig {
  let options: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        options = parsed;
    }
  } catch {
    /* Never log raw options. */
  }
  const string = (key: string, variable: string) =>
    env[variable] ??
    (typeof options[key] === "string" ? (options[key] as string) : "");
  const bool = (key: string, variable: string) =>
    env[variable] === undefined
      ? options[key] === true
      : env[variable] === "true";
  return {
    lanEnabled: bool("lan_enabled", "COACHAI_LAN_ENABLED"),
    lanAuthRequired: bool("lan_auth_required", "COACHAI_LAN_AUTH_REQUIRED"),
    lanWebPassword: string("lan_web_password", "COACHAI_LAN_WEB_PASSWORD"),
    lanWebOrigin: string("lan_web_origin", "COACHAI_LAN_WEB_ORIGIN"),
    groqEnabled: bool("groq_enabled", "GROQ_ENABLED"),
    groqKey: string("groq_api_key", "GROQ_API_KEY"),
    groqModel: string("groq_model", "GROQ_MODEL") || "openai/gpt-oss-120b",
    intervalsCalendarWriteEnabled: bool("intervals_calendar_write_enabled", "INTERVALS_CALENDAR_WRITE_ENABLED"),
    intervalsLibrarySyncEnabled: bool("intervals_library_sync_enabled", "INTERVALS_LIBRARY_SYNC_ENABLED"),
    intervalsSyncEnabled: bool(
      "intervals_sync_enabled",
      "INTERVALS_SYNC_ENABLED",
    ),
    intervalsDetailsEnabled: bool(
      "intervals_details_enabled",
      "INTERVALS_DETAILS_ENABLED",
    ),
    intervalsPollSeconds: Math.max(
      60,
      Math.min(
        86400,
        Number(env.INTERVALS_POLL_SECONDS ?? options.intervals_poll_seconds) ||
          900,
      ),
    ),
    nodeRedStopped:
      env.COACHAI_NODE_RED_STOPPED === undefined
        ? options.node_red_stopped === true
        : env.COACHAI_NODE_RED_STOPPED === "true",
    adminToken: string("admin_api_token", "COACHAI_ADMIN_TOKEN"),
    dataSource:
      string("data_source", "COACHAI_DATA_SOURCE") === "local"
        ? "local"
        : "snapshot",
  };
}

// Binding is independent of authentication. A wide bind must be an explicit
// operator choice (the HA container sets it for Supervisor Ingress).
export function listenConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.COACHAI_HOST ?? "127.0.0.1";
  const rawPort = env.COACHAI_PORT ?? env.PORT ?? "8099";
  const port = Number(rawPort);
  if (!isIP(host) || !/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid CoachAI listen configuration");
  return { host, port };
}
