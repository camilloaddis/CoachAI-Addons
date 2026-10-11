CREATE TABLE workout_library (
 account_id TEXT NOT NULL,
 workout_id INTEGER NOT NULL CHECK(workout_id > 0),
 folder_id INTEGER,
 name TEXT NOT NULL,
 sport TEXT NOT NULL,
 metadata_json TEXT NOT NULL,
 original_json TEXT NOT NULL,
 original_complete INTEGER NOT NULL CHECK(original_complete IN (0,1)),
 normalized_json TEXT,
 duration_seconds INTEGER,
 peak_power_percent_ftp REAL,
 normalizer_version TEXT NOT NULL,
 compatible INTEGER NOT NULL CHECK(compatible IN (0,1)),
 exclusion_reasons_json TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 source_updated_at TEXT,
 last_synced_at TEXT NOT NULL,
 available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)),
 PRIMARY KEY(account_id, workout_id),
 CHECK((compatible=1 AND normalized_json IS NOT NULL AND duration_seconds IS NOT NULL AND duration_seconds>0
    AND peak_power_percent_ftp IS NOT NULL AND peak_power_percent_ftp>=0)
    OR (compatible=0 AND normalized_json IS NULL AND duration_seconds IS NULL AND peak_power_percent_ftp IS NULL))
);
CREATE INDEX workout_library_available ON workout_library(account_id, available, compatible);
CREATE TABLE workout_library_sync (
 account_id TEXT PRIMARY KEY,
 last_attempt_at TEXT NOT NULL,
 last_success_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('complete','incomplete','error')),
 last_error_code TEXT CHECK(last_error_code IN ('incomplete_enumeration','validation_failed','database_failed','interrupted','provider_unavailable')),
 last_complete_count INTEGER CHECK(last_complete_count>=0),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0)
);
