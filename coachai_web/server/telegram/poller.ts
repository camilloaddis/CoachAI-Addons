import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { diagnostic, transaction } from "../storage/database.js";
import {
  recordServices,
  ValidationError,
  type MealInput,
} from "../services/records.js";
import type { RuntimeConfig } from "./config.js";

export function telegramWorker(
  db: DatabaseSync,
  config: RuntimeConfig,
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
) {
  const owner = randomUUID(),
    abort = new AbortController();
  let task: Promise<void> | null = null;
  const state = (key: string) =>
    db.prepare("SELECT value FROM app_state WHERE key=?").get(key)?.value;
  function cursor() {
    const value = String(state("telegram_last_update_id") ?? "");
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error("Telegram cursor invalid");
    return Number(value);
  }
  const enabled = config.telegramEnabled;
  function checkEnabled() {
    if (!enabled) return false;
    if (
      !config.nodeRedStopped ||
      config.dataSource !== "local" ||
      state("import_mode") !== "final" ||
      state("telegram_last_update_id") === undefined ||
      !/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.token) ||
      !/^-?\d+$/.test(config.chatId)
    )
      throw new Error("Telegram prerequisites not satisfied");
    cursor();
    return true;
  }
  function owns() {
    const lease = db
      .prepare(
        "SELECT owner,expires_at FROM worker_leases WHERE name='telegram'",
      )
      .get();
    return (
      lease?.owner === owner && Number(lease.expires_at) > clock().getTime()
    );
  }
  function acquire() {
    return transaction(db, () => {
      db.prepare(
        "INSERT INTO worker_leases VALUES('telegram',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE worker_leases.owner=excluded.owner OR worker_leases.expires_at<=?",
      ).run(owner, clock().getTime() + 90000, clock().getTime());
      return owns();
    });
  }
  async function api(method: string, body: unknown) {
    if (!acquire()) throw new Error("Telegram lease lost");
    const response = await fetcher(
      `https://api.telegram.org/bot${config.token}/${method}`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]),
      },
    );
    if (!response.ok) throw new Error("Telegram transport failed");
    const parsed = (await response.json()) as { ok: boolean; result: unknown };
    if (parsed.ok !== true) throw new Error("Telegram API failed");
    return parsed.result;
  }
  function process(update: Record<string, unknown>) {
    transaction(db, () => {
      if (!owns()) throw new Error("Telegram lease lost");
      const id = Number(update.update_id);
      if (
        id <= cursor() ||
        db
          .prepare("SELECT update_id FROM telegram_updates WHERE update_id=?")
          .get(id)
      )
        return;
      const message = update.message as
        | { chat?: { id?: number; type?: string }; text?: string }
        | undefined;
      let outcome = "ignored",
        reply: string | null = null;
      if (
        String(message?.chat?.id) === config.chatId &&
        message?.chat?.type === "private" &&
        typeof message.text === "string"
      ) {
        const records = recordServices(db, clock);
        try {
          if (message.text.startsWith("/pasto ")) {
            const raw = JSON.parse(message.text.slice(7));
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              throw new ValidationError();
            records.meal(raw as MealInput, `telegram:${id}`, true);
            outcome = "meal";
            reply = "Pasto registrato.";
          } else if (message.text.startsWith("/gambe ")) {
            const parts = message.text.trim().split(/\s+/);
            if (parts.length < 3 || parts.length > 4)
              throw new ValidationError();
            records.feedback(
              {
                activity_id: parts[1],
                legs: Number(parts[2]),
                sensation_date: parts[3],
              },
              `telegram:${id}`,
              true,
            );
            outcome = "feedback";
            reply = "Feedback registrato.";
          } else {
            outcome = "unsupported";
            reply =
              "Comandi disponibili: /pasto JSON oppure /gambe activity_id 1-5 [YYYY-MM-DD].";
          }
        } catch (error) {
          if (
            !(
              error instanceof ValidationError ||
              error instanceof SyntaxError ||
              error instanceof TypeError
            )
          )
            throw error;
          outcome = "invalid";
          reply = "Dati non validi. Nessun record salvato.";
        }
      }
      db.prepare("INSERT INTO telegram_updates VALUES(?,?,?)").run(
        id,
        clock().toISOString(),
        outcome,
      );
      db.prepare(
        "INSERT INTO app_state VALUES('telegram_last_update_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(id));
      if (reply)
        db.prepare(
          "INSERT INTO telegram_outbox(update_id,content,status) VALUES(?,?,'pending')",
        ).run(id, reply);
      diagnostic(db, "telegram_received", outcome);
      if (outcome === "invalid")
        diagnostic(db, "error", "telegram_input_invalid");
    });
  }
  async function flush() {
    // Interrupted sends cannot be safely retried: Telegram sendMessage has no idempotency key.
    transaction(db, () => {
      if (!owns()) throw new Error("Telegram lease lost");
      const changed = db
        .prepare(
          "UPDATE telegram_outbox SET status='unknown' WHERE status='sending'",
        )
        .run().changes;
      if (Number(changed) > 0)
        diagnostic(db, "error", "telegram_interrupted_send_unknown");
    });
    const pending = db
      .prepare(
        "SELECT update_id,content FROM telegram_outbox WHERE status='pending' ORDER BY update_id",
      )
      .all();
    for (const row of pending) {
      transaction(db, () => {
        if (!owns()) throw new Error("Telegram lease lost");
        db.prepare(
          "UPDATE telegram_outbox SET status='sending' WHERE update_id=? AND status='pending'",
        ).run(row.update_id);
      });
      try {
        const result = (await api("sendMessage", {
          chat_id: config.chatId,
          text: row.content,
        })) as { message_id?: number };
        if (!Number.isSafeInteger(result?.message_id))
          throw new Error("Telegram response invalid");
        transaction(db, () => {
          if (!owns()) throw new Error("Telegram lease lost");
          db.prepare(
            "UPDATE telegram_outbox SET status='sent',message_id=? WHERE update_id=?",
          ).run(result.message_id!, row.update_id);
          diagnostic(db, "telegram_sent", "confirmed");
        });
      } catch {
        if (owns())
          transaction(db, () => {
            db.prepare(
              "UPDATE telegram_outbox SET status='unknown' WHERE update_id=?",
            ).run(row.update_id);
            diagnostic(db, "error", "telegram_send_unknown");
          });
        return;
      }
    }
  }
  let polling = false;
  async function processPoll() {
    if (!checkEnabled()) return "disabled";
    if (!acquire()) return "busy";
    await flush();
    const result = await api("getUpdates", {
      offset: cursor() + 1,
      timeout: 25,
      allowed_updates: ["message"],
    });
    if (
      !Array.isArray(result) ||
      !result.every(
        (u) => u && Number.isSafeInteger(u.update_id) && u.update_id >= 0,
      )
    )
      throw new Error("Invalid Telegram updates");
    if (!owns()) throw new Error("Telegram lease lost");
    for (const update of result.sort((a, b) => a.update_id - b.update_id))
      process(update);
    if (!acquire()) throw new Error("Telegram lease lost");
    await flush();
    return "processed";
  }
  async function pollOnce() {
    if (polling) return "busy";
    polling = true;
    try {
      return await processPoll();
    } finally {
      polling = false;
    }
  }
  return {
    enabled,
    pollOnce,
    start() {
      if (!checkEnabled() || task) return;
      task = (async () => {
        let backoff = 1000;
        while (!abort.signal.aborted) {
          try {
            await pollOnce();
            backoff = 1000;
          } catch {
            if (!abort.signal.aborted) {
              try {
                diagnostic(db, "error", "telegram_poll_failed");
              } catch {
                break;
              }
              backoff = Math.min(60000, backoff * 2);
            }
          }
          try {
            await delay(backoff, undefined, { signal: abort.signal });
          } catch {
            break;
          }
        }
      })();
    },
    async stop() {
      abort.abort();
      await task;
      db.prepare(
        "DELETE FROM worker_leases WHERE name='telegram' AND owner=?",
      ).run(owner);
    },
  };
}
