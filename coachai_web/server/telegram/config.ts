import { existsSync, readFileSync } from "node:fs";
export type RuntimeConfig = {
  groqEnabled?: boolean;
  groqKey?: string;
  groqModel?: string;
  intervalsSyncEnabled?: boolean;
  intervalsWriteEnabled?: boolean;
  intervalsPollSeconds?: number;
  telegramEnabled: boolean;
  nodeRedStopped: boolean;
  token: string;
  chatId: string;
  adminToken: string;
  dataSource: "snapshot" | "local";
};
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  path = "/data/options.json",
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
    groqEnabled: bool("groq_enabled", "GROQ_ENABLED"),
    groqKey: string("groq_api_key", "GROQ_API_KEY"),
    groqModel: string("groq_model", "GROQ_MODEL") || "openai/gpt-oss-120b",
    intervalsSyncEnabled: bool(
      "intervals_sync_enabled",
      "INTERVALS_SYNC_ENABLED",
    ),
    intervalsWriteEnabled: bool(
      "intervals_write_enabled",
      "INTERVALS_WRITE_ENABLED",
    ),
    intervalsPollSeconds: Math.max(
      60,
      Math.min(
        86400,
        Number(env.INTERVALS_POLL_SECONDS ?? options.intervals_poll_seconds) ||
          900,
      ),
    ),
    telegramEnabled:
      env.TELEGRAM_ENABLED === undefined
        ? options.telegram_enabled === true
        : env.TELEGRAM_ENABLED === "true",
    nodeRedStopped:
      env.COACHAI_NODE_RED_STOPPED === undefined
        ? options.node_red_stopped === true
        : env.COACHAI_NODE_RED_STOPPED === "true",
    token: string("telegram_bot_token", "TELEGRAM_BOT_TOKEN"),
    chatId: string("telegram_chat_id", "TELEGRAM_CHAT_ID"),
    adminToken: string("admin_api_token", "COACHAI_ADMIN_TOKEN"),
    dataSource:
      string("data_source", "COACHAI_DATA_SOURCE") === "local"
        ? "local"
        : "snapshot",
  };
}
