-- Aggregate player stats keyed by display_name. Names entered on round wins
-- are upserted here; best_score climbs monotonically.
CREATE TABLE IF NOT EXISTS players (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT    NOT NULL UNIQUE,
  total_rounds INTEGER NOT NULL DEFAULT 0,
  best_score   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- One row per completed round. winner_* are nullable because timed-out name
-- entry leaves us with a score but no committed name.
CREATE TABLE IF NOT EXISTS rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL,
  winner_name    TEXT,
  winner_score   INTEGER,
  player_count   INTEGER NOT NULL DEFAULT 0
);

-- Per-player per-round score snapshot. Useful for future "your history" views.
CREATE TABLE IF NOT EXISTS scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id      INTEGER NOT NULL,
  display_name  TEXT    NOT NULL,
  score         INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);

CREATE INDEX IF NOT EXISTS idx_scores_round_id ON scores(round_id);
CREATE INDEX IF NOT EXISTS idx_players_best   ON players(best_score DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_ended   ON rounds(ended_at DESC);

-- Map definitions — both server-generated random parks and user-saved
-- creations from the editor. `code` is a short 6-char shareable ID, `data`
-- is the map JSON blob (pieces + spawn). `source` distinguishes origins.
CREATE TABLE IF NOT EXISTS maps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'user',  -- 'random' | 'user'
  data        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_maps_code     ON maps(code);
CREATE INDEX IF NOT EXISTS idx_maps_created  ON maps(created_at DESC);
