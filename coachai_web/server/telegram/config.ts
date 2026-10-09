import { existsSync, readFileSync } from "node:fs";
export type RuntimeConfig = {
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
  return {
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
