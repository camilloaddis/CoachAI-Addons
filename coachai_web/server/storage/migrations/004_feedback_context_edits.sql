-- Legacy observations stay ambiguous; never infer their meaning from a timestamp.
ALTER TABLE training_feedback ADD COLUMN context TEXT NOT NULL DEFAULT 'ambiguous' CHECK(context IN ('activity','current','ambiguous'));
-- Edit targets survive restart, without changing existing send envelopes.
ALTER TABLE telegram_outbox ADD COLUMN edit_message_id INTEGER;
ALTER TABLE telegram_outbox ADD COLUMN edit_parent_id INTEGER;
ALTER TABLE telegram_message_parts ADD COLUMN edit_message_id INTEGER;
ALTER TABLE telegram_message_parts ADD COLUMN edit_parent_id INTEGER;
-- Current recovery observations do not overwrite retrospective activity feedback.
CREATE TABLE recovery_feedback (
 request_key TEXT PRIMARY KEY,
 activity_id TEXT NOT NULL REFERENCES training_activities(activity_id),
 legs INTEGER NOT NULL CHECK(legs BETWEEN 1 AND 5),
 observation_date TEXT NOT NULL,
 note TEXT,
 updated_at TEXT NOT NULL
);
