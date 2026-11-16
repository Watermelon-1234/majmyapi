CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chart_id TEXT NOT NULL,
  difficulty INTEGER,
  score REAL,
  rank TEXT,
  combo INTEGER,
  max_combo INTEGER,
  played_at INTEGER DEFAULT (unixepoch()),
  extra TEXT
);

CREATE INDEX IF NOT EXISTS idx_scores_chart ON scores(chart_id);
CREATE INDEX IF NOT EXISTS idx_scores_played ON scores(played_at DESC);
