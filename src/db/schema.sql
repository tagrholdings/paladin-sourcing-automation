CREATE TABLE IF NOT EXISTS conversations (
  contact_id      TEXT PRIMARY KEY,
  name            TEXT,
  state           TEXT,
  city            TEXT,
  category        TEXT,
  starred         BOOLEAN,
  archived        BOOLEAN,
  last_message_at TIMESTAMPTZ,
  last_text       TEXT,
  last_suggestion TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  contact_id TEXT NOT NULL,
  message_id TEXT UNIQUE,
  direction  TEXT NOT NULL,          -- inbound | outbound
  text       TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source     TEXT,                   -- webhook | panel | slack | ai
  category   TEXT,                   -- so inbound
  reasoning  TEXT,                   -- so inbound
  suggestion TEXT                    -- so inbound
);
CREATE INDEX IF NOT EXISTS messages_contact_ts ON messages (contact_id, ts);
CREATE INDEX IF NOT EXISTS conversations_last ON conversations (last_message_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
