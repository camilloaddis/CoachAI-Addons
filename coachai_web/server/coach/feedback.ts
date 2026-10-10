import { escapeHtml } from "../telegram/presentation.js";
import type { DatabaseSync } from "node:sqlite";
import { diagnostic, transaction } from "../storage/database.js";
import { shift, today } from "../readiness/types.js";
export class TelegramDeliveryRejected extends Error {
  constructor(
    public readonly retrySeconds: number | null = null,
    public readonly reason:
      | "rejected"
      | "not_modified"
      | "cannot_edit" = "rejected",
  ) {
    super("telegram_delivery_rejected");
  }
}
export function reconcileFeedback(db: DatabaseSync, now: Date) {
  // Recover eligible missing requests independently of paired_event_id, including VirtualRide.
  // Historical imported flags were set before sending: their delivery is unknowable.
  const rows = db
    .prepare(
      `SELECT a.*,f.activity_id AS answered FROM training_activities a LEFT JOIN training_feedback f USING(activity_id) WHERE activity_date BETWEEN ? AND ? AND category IS NOT 'COMMUTING' AND activity_type IN ('Ride','VirtualRide')`,
    )
    .all(shift(today(now), -7), today(now));
  for (const a of rows) {
    const status = a.answered
      ? "received"
      : a.feedback_requested === 1
        ? "legacy_unknown"
        : "pending";
    const changed = db
      .prepare(
        "INSERT OR IGNORE INTO feedback_requests(activity_id,status,created_at) VALUES(?,?,?)",
      )
      .run(a.activity_id, status, now.toISOString()).changes;
    if (changed && status === "pending")
      diagnostic(db, "feedback_scheduled", "eligible_cycling");
    if (a.answered)
      db.prepare(
        "UPDATE feedback_requests SET status='received' WHERE activity_id=?",
      ).run(a.activity_id);
    // An edited commute is no longer eligible; an existing confirmed send remains recorded.
  }
}
export async function flushFeedback(
  db: DatabaseSync,
  now: Date,
  owns: () => boolean,
  api: (method: string, body: unknown) => Promise<unknown>,
  chatId: string,
) {
  transaction(db, () => {
    if (!owns()) throw new Error("lease_lost");
    reconcileFeedback(db, now);
    db.prepare(
      "UPDATE feedback_requests SET status='pending' WHERE status='failed' AND attempts<3 AND retry_at<=?",
    ).run(now.toISOString());
    if (
      db
        .prepare(
          "UPDATE feedback_requests SET status='unknown' WHERE status='sending'",
        )
        .run().changes
    )
      diagnostic(db, "error", "feedback_interrupted_send_unknown");
  });
  const rows = db
    .prepare(
      `SELECT r.id,r.activity_id,a.name,a.activity_date FROM feedback_requests r JOIN training_activities a USING(activity_id) WHERE r.status='pending' AND a.category IS NOT 'COMMUTING' AND a.activity_type IN ('Ride','VirtualRide') AND a.activity_date>=? ORDER BY r.id LIMIT 10`,
    )
    .all(shift(today(now), -7));
  for (const row of rows) {
    if (!owns()) throw new Error("lease_lost");
    db.prepare(
      "UPDATE feedback_requests SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'",
    ).run(row.id);
    try {
      const result = (await api("sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `<b>Feedback gambe</b>\n\nAttività ${escapeHtml(String(row.activity_date))}: ${escapeHtml(String(row.name || row.activity_id).slice(0, 500))}.\n\nCome erano le gambe durante questa attività?\n<i>Risposta retrospettiva, non misura del recupero odierno.</i>`,
        reply_markup: {
          inline_keyboard: [
            [1, 2, 3, 4, 5].map((n) => ({
              text: String(n),
              callback_data: `legs|${row.id}|${n}`,
            })),
          ],
        },
      })) as { message_id?: number };
      if (!Number.isSafeInteger(result?.message_id))
        throw new Error("invalid_send");
      transaction(db, () => {
        if (!owns()) throw new Error("lease_lost");
        db.prepare(
          "UPDATE feedback_requests SET status=CASE WHEN status='received' THEN 'received' ELSE 'sent' END,message_id=? WHERE id=?",
        ).run(result.message_id!, row.id);
        db.prepare(
          "UPDATE training_activities SET feedback_requested=1 WHERE activity_id=?",
        ).run(row.activity_id);
        diagnostic(db, "telegram_sent", "feedback_confirmed");
      });
    } catch (error) {
      if (owns() && error instanceof TelegramDeliveryRejected) {
        db.prepare(
          "UPDATE feedback_requests SET status='failed',retry_at=? WHERE id=? AND status!='received'",
        ).run(
          error.retrySeconds === null
            ? null
            : new Date(now.getTime() + error.retrySeconds * 1000).toISOString(),
          row.id,
        );
        diagnostic(db, "error", "feedback_delivery_rejected");
      } else if (owns()) {
        db.prepare(
          "UPDATE feedback_requests SET status='unknown' WHERE id=? AND status!='received'",
        ).run(row.id);
        diagnostic(db, "error", "feedback_send_unknown");
      }
      return;
    }
  }
}
