-- Saved Channels library: stores reusable source and target channels/groups
-- so users can select channels from a dropdown/multi-select list just like saved bots.
CREATE TABLE IF NOT EXISTS saved_channels (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  username TEXT,
  chat_type TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_saved_channels_created_at ON saved_channels(created_at DESC);
