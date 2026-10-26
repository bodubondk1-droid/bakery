-- Backup database: same tables as schema.sql, plus when the last copy was taken.
-- Apply schema.sql first, then this file.

CREATE TABLE IF NOT EXISTS backup_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at TEXT NOT NULL,
  counts TEXT NOT NULL
);
