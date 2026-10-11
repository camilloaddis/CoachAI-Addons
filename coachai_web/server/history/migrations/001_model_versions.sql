-- Separate readiness-history.sqlite only; never the application database.
CREATE TABLE evaluations_versioned (
  date TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  score INTEGER,
  confidence INTEGER NOT NULL,
  recommendation TEXT NOT NULL,
  model_version TEXT NOT NULL,
  PRIMARY KEY (date, model_version)
);
INSERT INTO evaluations_versioned (date, observed_at, score, confidence, recommendation, model_version)
  SELECT date, observed_at, score, confidence, recommendation, 'legacy' FROM evaluations;
DROP TABLE evaluations;
ALTER TABLE evaluations_versioned RENAME TO evaluations;
