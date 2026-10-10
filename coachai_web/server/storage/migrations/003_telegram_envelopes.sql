-- Additive upgrade; old plain-text outbox rows retain their original meaning.
ALTER TABLE telegram_outbox ADD COLUMN format TEXT NOT NULL DEFAULT 'plain' CHECK(format IN ('plain','HTML'));
ALTER TABLE telegram_outbox ADD COLUMN markup TEXT;
CREATE TABLE telegram_message_parts (
  update_id INTEGER NOT NULL REFERENCES telegram_updates(update_id),
  part INTEGER NOT NULL CHECK(part>0),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','unknown')),
  message_id INTEGER,
  format TEXT NOT NULL DEFAULT 'HTML' CHECK(format IN ('plain','HTML')),
  markup TEXT,
  PRIMARY KEY(update_id,part)
);
CREATE TABLE telegram_callback_receipts (callback_key TEXT PRIMARY KEY, update_id INTEGER NOT NULL REFERENCES telegram_updates(update_id), created_at TEXT NOT NULL);
