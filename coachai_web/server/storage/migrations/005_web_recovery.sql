-- Standalone recovery does not require or fabricate a training activity.
-- All legacy Telegram and feedback tables/rows remain unchanged.
CREATE TABLE recovery_observations (
 request_key TEXT PRIMARY KEY,
 legs INTEGER NOT NULL CHECK(legs BETWEEN 1 AND 5),
 observation_date TEXT NOT NULL,
 note TEXT,
 updated_at TEXT NOT NULL
);
