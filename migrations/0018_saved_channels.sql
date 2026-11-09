CREATE TABLE IF NOT EXISTS saved_channels (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('source', 'target')),
  chat_id TEXT NOT NULL,
  title TEXT,
  username TEXT,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_saved_channels_role ON saved_channels(role, created_at DESC);
