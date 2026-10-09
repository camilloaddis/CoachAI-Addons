CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE training_activities (
 activity_id TEXT PRIMARY KEY, activity_date TEXT NOT NULL, category TEXT, name TEXT,
 activity_type TEXT, duration_min REAL, training_load REAL, intensity REAL,
 avg_power REAL, avg_hr REAL, paired_event_id TEXT, compliance REAL, rpe REAL,
 feel REAL, feedback_requested INTEGER, created_at TEXT
);
CREATE TABLE meals (
 id INTEGER PRIMARY KEY, date TEXT NOT NULL, time TEXT, meal_type TEXT, description TEXT,
 calories REAL, protein_g REAL, carbs_g REAL, fat_g REAL, confidence REAL,
 request_key TEXT UNIQUE, request_hash TEXT, recorded_at TEXT, origin TEXT NOT NULL
);
CREATE TABLE training_feedback (
 activity_id TEXT PRIMARY KEY REFERENCES training_activities(activity_id),
 legs INTEGER CHECK(legs BETWEEN 1 AND 5), note TEXT, updated_at TEXT,
 sensation_date TEXT, request_key TEXT UNIQUE, request_hash TEXT, origin TEXT NOT NULL
);
CREATE TABLE daily_summary (
 date TEXT PRIMARY KEY, weight REAL, calories_in REAL, protein_g REAL, carbs_g REAL,
 fat_g REAL, exercise_kcal REAL, activity_duration_sec REAL, training_load REAL,
 estimated_tdee REAL, estimated_balance REAL, food_complete INTEGER
);
CREATE TABLE training_config (
 id INTEGER PRIMARY KEY, start_date TEXT, goal TEXT, ftp REAL, target_weight REAL,
 workout_duration_min REAL, plan_weeks INTEGER, updated_at TEXT
);
CREATE TABLE source_archive (
 table_name TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(table_name, ordinal)
);
CREATE TABLE import_runs (
 id INTEGER PRIMARY KEY, mode TEXT NOT NULL, imported_at TEXT NOT NULL,
 schema_hash TEXT NOT NULL, counts_json TEXT NOT NULL, schema_json TEXT NOT NULL
);
CREATE TABLE diagnostics (
 id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, category TEXT NOT NULL,
 code TEXT NOT NULL
);
CREATE TABLE service_requests (
 request_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE telegram_updates (
 update_id INTEGER PRIMARY KEY, processed_at TEXT NOT NULL, outcome TEXT NOT NULL
);
CREATE TABLE telegram_outbox (
 update_id INTEGER PRIMARY KEY REFERENCES telegram_updates(update_id),
 content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','unknown')),
 message_id INTEGER
);
CREATE TABLE worker_leases (
 name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
);
