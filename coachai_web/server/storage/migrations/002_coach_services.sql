CREATE TABLE nutrition_drafts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE ai_preparations (update_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE nutrition_items (meal_id INTEGER PRIMARY KEY REFERENCES meals(id) ON DELETE CASCADE, payload TEXT NOT NULL);
CREATE TABLE activity_processing (activity_id TEXT PRIMARY KEY REFERENCES training_activities(activity_id), payload TEXT NOT NULL, fingerprint TEXT NOT NULL, seen_at TEXT NOT NULL);
CREATE TABLE wellness_cache (date TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE activity_coverage (date TEXT PRIMARY KEY, refreshed_at TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 1 CHECK(complete IN (0,1)));
CREATE TABLE feedback_requests (id INTEGER PRIMARY KEY, activity_id TEXT UNIQUE NOT NULL REFERENCES training_activities(activity_id), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','received','unknown','legacy_unknown','failed')), message_id INTEGER, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT);
CREATE TABLE workout_proposals (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','sending','sent','unknown')), event_id TEXT);
