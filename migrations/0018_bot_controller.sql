CREATE TABLE IF NOT EXISTS bot_controller_sessions (
  chat_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
