import { callbackAction, type Envelope } from "./presentation.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { diagnostic, transaction } from "../storage/database.js";
import {
  recordServices,
  ValidationError,
  type MealInput,
} from "../services/records.js";
import { ProviderError, readJsonResponse } from "../coach/http.js";
import { flushFeedback, TelegramDeliveryRejected } from "../coach/feedback.js";
import type { CoachHandler } from "../coach/commands.js";
import type { RuntimeConfig } from "./config.js";

export function telegramWorker(
  db: DatabaseSync,
  config: RuntimeConfig,
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
  handler?: CoachHandler,
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
    const parsed = (await readJsonResponse(response)) as {
      ok: boolean;
      result: unknown;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (parsed.ok === false && [400, 403, 429].includes(parsed.error_code || 0))
      throw new TelegramDeliveryRejected(
        parsed.error_code === 429
          ? Math.max(
              60,
              Math.min(86400, Number(parsed.parameters?.retry_after) || 60),
            )
          : null,
        method.startsWith("editMessage") &&
        parsed.error_code === 400 &&
        typeof parsed.description === "string"
          ? parsed.description.includes("message is not modified")
            ? "not_modified"
            : /message (?:to edit not found|can.t be edited)/.test(
                  parsed.description,
                )
              ? "cannot_edit"
              : "rejected"
          : "rejected",
      );
    if (!response.ok || parsed.ok !== true)
      throw new Error("Telegram API failed");
    return parsed.result;
  }
  async function process(update: Record<string, unknown>) {
    const id = Number(update.update_id);
    if (
      id <= cursor() ||
      db
        .prepare("SELECT update_id FROM telegram_updates WHERE update_id=?")
        .get(id)
    )
      return;
    const callback = update.callback_query as
      | {
          id?: string;
          data?: string;
          message?: {
            chat?: { id?: number; type?: string };
            message_id?: number;
          };
          from?: { id?: number };
        }
      | undefined;
    const input = (
      callback
        ? { chat: callback.message?.chat, text: callback.data }
        : update.message
    ) as { chat?: { id?: number; type?: string }; text?: string } | undefined;
    const aliases: Record<string, string> = {
      action_training: "allenamento",
      action_plan: "pianifica",
      action_meal: "pasto",
      action_meals: "pasti",
      action_today: "oggi",
      action_yesterday: "ieri",
      action_week: "settimana",
      action_weight: "peso",
      action_day: "giorno",
      action_settings: "impostazioni",
      action_close_day: "chiudi giornata",
      action_reopen_day: "riapri giornata",
      workout_intense: "intenso",
      workout_easy: "leggero",
    };
    if (input?.text && aliases[input.text]) input.text = aliases[input.text];
    const callbackAuthorized =
      String(callback?.message?.chat?.id) === config.chatId &&
      callback?.message?.chat?.type === "private" &&
      Number.isSafeInteger(callback?.message?.message_id) &&
      Number(callback?.message?.message_id) > 0 &&
      String(callback?.from?.id) === config.chatId;
    let editParent: number | null = null;
    let callbackKey: string | null = null,
      obsolete = false,
      duplicateCallback = false;
    if (callback) {
      const action = callbackAction(callback.data);
      if (!callbackAuthorized || typeof callback.id !== "string") {
        if (input) input.text = undefined;
      } else if (
        typeof callback.data === "string" &&
        /^legs\|(0|[1-9]\d*)\|[1-5]$/.test(callback.data)
      ) {
        const request = db
          .prepare("SELECT message_id,status FROM feedback_requests WHERE id=?")
          .get(Number(callback.data.split("|")[1]));
        obsolete =
          !request ||
          request.message_id !== callback.message?.message_id ||
          request.status === "received";
      } else if (action) {
        const parent = db
          .prepare(
            "SELECT markup,message_id FROM telegram_outbox WHERE update_id=? AND message_id=? AND status='sent'",
          )
          .get(action.id, callback.message?.message_id ?? -1);
        const part = db
          .prepare(
            "SELECT markup,message_id FROM telegram_message_parts WHERE update_id=? AND message_id=? AND status='sent'",
          )
          .get(action.id, callback.message?.message_id ?? -1);
        const envelope = parent ?? part;
        const buttons = envelope?.markup
          ? JSON.parse(String(envelope.markup)).inline_keyboard.flat()
          : [];
        obsolete = !buttons.some(
          (b: { callback_data?: string }) => b.callback_data === callback.data,
        );
        if (
          [
            "accept",
            "regen",
            "light",
            "hard",
            "ss",
            "vo2",
            "endurance",
            "force",
          ].includes(action.action)
        )
          obsolete =
            obsolete ||
            db
              .prepare(
                "SELECT id FROM workout_proposals ORDER BY created_at DESC,rowid DESC LIMIT 1",
              )
              .get()?.id !== String(action.id);
        if (["confirm", "edit", "cancel"].includes(action.action)) {
          const draft = db
            .prepare("SELECT payload FROM nutrition_drafts WHERE id='active'")
            .get();
          obsolete =
            obsolete ||
            !draft ||
            JSON.parse(String(draft.payload)).requestId !== action.id;
        }
        if (
          [
            "accept",
            "regen",
            "light",
            "hard",
            "ss",
            "vo2",
            "endurance",
            "force",
          ].includes(action.action)
        )
          editParent = action.id;
        if (input) input.text = action.command;
      } else obsolete = true;
      if (callbackAuthorized && typeof callback.id === "string") {
        callbackKey = `${callback.message?.message_id}:${callback.data}`;
        duplicateCallback = !!db
          .prepare(
            "SELECT update_id FROM telegram_callback_receipts WHERE callback_key=?",
          )
          .get(callbackKey);
        if (obsolete || duplicateCallback) {
          if (input) input.text = undefined;
        }
        try {
          await api("answerCallbackQuery", {
            callback_query_id: callback.id,
            text: duplicateCallback
              ? "Già elaborato."
              : obsolete
                ? "Messaggio obsoleto. Apri il menu con /home."
                : "Elaborazione…",
          });
        } catch {
          diagnostic(db, "error", "telegram_callback_ack_failed");
        }
      }
    }
    const authorized =
      String(input?.chat?.id) === config.chatId &&
      input?.chat?.type === "private" &&
      typeof input?.text === "string" &&
      (!callback || callbackAuthorized);
    const prepared =
      handler && authorized ? await handler.prepare(input!.text!, id) : null;
    if (!owns() || !acquire()) throw new Error("Telegram lease lost");
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
      const message = input as
        | { chat?: { id?: number; type?: string }; text?: string }
        | undefined;
      let outcome = duplicateCallback
          ? "duplicate_callback"
          : obsolete
            ? "obsolete_callback"
            : "ignored",
        reply: string | null = null;
      let messages: Envelope[] | undefined;
      if (
        String(message?.chat?.id) === config.chatId &&
        message?.chat?.type === "private" &&
        typeof message.text === "string"
      ) {
        const records = recordServices(db, clock);
        try {
          db.exec("SAVEPOINT command_effects");
          if (handler && prepared) {
            const applied = handler.apply(prepared, id);
            outcome = applied.outcome;
            reply = applied.reply;
            messages = applied.messages;
          } else if (message.text.startsWith("/pasto ")) {
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
          db.exec("RELEASE command_effects");
        } catch (error) {
          db.exec("ROLLBACK TO command_effects; RELEASE command_effects");
          if (
            !(
              error instanceof ProviderError ||
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
      if (reply) {
        const envelopes: Envelope[] = messages?.length
          ? [...messages]
          : [{ text: reply, parse_mode: "HTML" }];
        const targets =
          editParent === null
            ? []
            : [
                ...db
                  .prepare(
                    "SELECT message_id,0 AS part FROM telegram_outbox WHERE update_id=? AND status='sent'",
                  )
                  .all(editParent),
                ...db
                  .prepare(
                    "SELECT message_id,part FROM telegram_message_parts WHERE update_id=? AND status='sent' ORDER BY part",
                  )
                  .all(editParent),
              ];
        // Retire surplus old fragments so no obsolete workout/keyboard remains visible.
        while (envelopes.length < targets.length)
          envelopes.push({
            text: "<i>Proposta sostituita.</i>",
            parse_mode: "HTML",
          });
        for (const [index, part] of envelopes.entries()) {
          const values = [
            part.text,
            part.parse_mode,
            part.reply_markup ? JSON.stringify(part.reply_markup) : null,
            targets[index]?.message_id ?? null,
            editParent,
          ];
          if (index === 0)
            db.prepare(
              "INSERT INTO telegram_outbox(update_id,content,status,format,markup,edit_message_id,edit_parent_id) VALUES(?,?,'pending',?,?,?,?)",
            ).run(id, ...values);
          else
            db.prepare(
              "INSERT INTO telegram_message_parts(update_id,part,content,status,format,markup,edit_message_id,edit_parent_id) VALUES(?,?,?,'pending',?,?,?,?)",
            ).run(id, index, ...values);
        }
      }
      if (callbackKey && !obsolete && !duplicateCallback && authorized)
        db.prepare("INSERT INTO telegram_callback_receipts VALUES(?,?,?)").run(
          callbackKey,
          id,
          clock().toISOString(),
        );
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
      db.prepare(
        "UPDATE telegram_message_parts SET status='unknown' WHERE status='pending' AND update_id IN (SELECT update_id FROM telegram_outbox WHERE status='unknown' UNION SELECT update_id FROM telegram_message_parts WHERE status='sending' OR status='unknown')",
      ).run();
      const extra = db
        .prepare(
          "UPDATE telegram_message_parts SET status='unknown' WHERE status='sending'",
        )
        .run().changes;
      if (Number(changed) + Number(extra) > 0)
        diagnostic(db, "error", "telegram_interrupted_send_unknown");
    });
    const pending = [
      ...db
        .prepare(
          "SELECT update_id,0 AS part,content,format,markup,edit_message_id,edit_parent_id FROM telegram_outbox WHERE status='pending'",
        )
        .all(),
      ...db
        .prepare(
          "SELECT update_id,part,content,format,markup,edit_message_id,edit_parent_id FROM telegram_message_parts WHERE status='pending'",
        )
        .all(),
    ].sort(
      (a, b) =>
        Number(a.update_id) - Number(b.update_id) ||
        Number(a.part) - Number(b.part),
    );
    for (const row of pending) {
      const table =
        Number(row.part) === 0 ? "telegram_outbox" : "telegram_message_parts";
      const where =
        Number(row.part) === 0 ? "update_id=?" : "update_id=? AND part=?";
      const keys =
        Number(row.part) === 0 ? [row.update_id] : [row.update_id, row.part];
      transaction(db, () => {
        if (!owns()) throw new Error("Telegram lease lost");
        db.prepare(
          `UPDATE ${table} SET status='sending' WHERE ${where} AND status='pending'`,
        ).run(...keys);
      });
      try {
        const body = {
          chat_id: config.chatId,
          text: row.content,
          ...(row.format === "HTML" ? { parse_mode: "HTML" } : {}),
          reply_markup: row.markup
            ? JSON.parse(String(row.markup))
            : { inline_keyboard: [] },
        };
        let messageId: number;
        if (row.edit_message_id) {
          const old = db
            .prepare(
              "SELECT content,markup,format,update_id FROM telegram_outbox WHERE message_id=? AND update_id<? AND status='sent' UNION ALL SELECT content,markup,format,update_id FROM telegram_message_parts WHERE message_id=? AND update_id<? AND status='sent' ORDER BY update_id DESC LIMIT 1",
            )
            .get(
              row.edit_message_id,
              row.update_id,
              row.edit_message_id,
              row.update_id,
            );
          try {
            if (
              old?.content === row.content &&
              old?.markup === row.markup &&
              old?.format === row.format
            ) {
              diagnostic(db, "telegram_edited", "unchanged");
            } else if (
              old?.content === row.content &&
              old?.format === row.format
            ) {
              await api("editMessageReplyMarkup", {
                chat_id: config.chatId,
                message_id: row.edit_message_id,
                reply_markup: body.reply_markup,
              });
            } else
              await api("editMessageText", {
                ...body,
                message_id: row.edit_message_id,
              });
            messageId = Number(row.edit_message_id);
          } catch (error) {
            if (
              error instanceof TelegramDeliveryRejected &&
              error.reason === "not_modified"
            )
              messageId = Number(row.edit_message_id);
            else if (
              error instanceof TelegramDeliveryRejected &&
              error.reason === "cannot_edit"
            ) {
              const sent = (await api("sendMessage", body)) as {
                message_id?: number;
              };
              messageId = Number(sent?.message_id);
              diagnostic(db, "telegram_sent", "edit_rejected_fallback");
            } else throw error;
          }
        } else {
          const result = (await api("sendMessage", body)) as {
            message_id?: number;
          };
          messageId = Number(result?.message_id);
        }
        if (!Number.isSafeInteger(messageId) || messageId <= 0)
          throw new Error("Telegram response invalid");
        transaction(db, () => {
          if (!owns()) throw new Error("Telegram lease lost");
          db.prepare(
            `UPDATE ${table} SET status='sent',message_id=? WHERE ${where}`,
          ).run(messageId, ...keys);
          diagnostic(
            db,
            row.edit_message_id ? "telegram_edited" : "telegram_sent",
            "confirmed",
          );
        });
      } catch {
        if (owns())
          transaction(db, () => {
            db.prepare(
              `UPDATE ${table} SET status='unknown' WHERE ${where}`,
            ).run(...keys);
            db.prepare(
              "UPDATE telegram_message_parts SET status='unknown' WHERE update_id=? AND part>? AND status='pending'",
            ).run(row.update_id, row.part);
            diagnostic(
              db,
              "error",
              row.edit_message_id
                ? "telegram_edit_unknown"
                : "telegram_send_unknown",
            );
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
    if (handler) await flushFeedback(db, clock(), owns, api, config.chatId);
    const result = await api("getUpdates", {
      offset: cursor() + 1,
      timeout: 25,
      allowed_updates: handler ? ["message", "callback_query"] : ["message"],
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
      await process(update);
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
