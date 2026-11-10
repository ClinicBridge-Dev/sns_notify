-- All timestamps: UTC ISO8601 strings.
CREATE TABLE clients (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,              -- stable id from config.yaml
  name TEXT NOT NULL,
  slack_channel_id TEXT,
  slack_token_ref TEXT,                  -- name of the .env key, never the token
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  collect_method TEXT NOT NULL CHECK (collect_method IN ('ax','web','fake')),
  session_key TEXT,
  initial_sync_done INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','disconnected','locked','unknown')),
  status_detail TEXT
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  external_key TEXT,
  display_name TEXT NOT NULL,
  participant_hint TEXT,
  baseline_done INTEGER NOT NULL DEFAULT 0,
  history_complete INTEGER NOT NULL DEFAULT 0, -- stored history starts at the first message on the device
  last_seen_cursor TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_conv_external ON conversations(account_id, external_key) WHERE external_key IS NOT NULL;
CREATE INDEX ix_conv_name ON conversations(account_id, display_name);
CREATE INDEX ix_conv_activity ON conversations(last_activity_at DESC);

CREATE TABLE conversation_name_history (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  conv_seq INTEGER NOT NULL,             -- order within conversation (1..n)
  external_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','unknown','system')),
  kind TEXT NOT NULL CHECK (kind IN ('text','caption','attachment','voice','sticker','other')),
  body TEXT,
  attachment_label TEXT,
  sender_hint TEXT,
  shown_time TEXT,
  shown_date_hint TEXT,
  time_precision TEXT NOT NULL CHECK (time_precision IN ('exact','minute','date_only','unknown')),
  observed_at TEXT NOT NULL,
  collect_mode TEXT NOT NULL CHECK (collect_mode IN ('baseline','live','catchup')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','review')),
  review_reason TEXT,
  content_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  seq_in_batch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_msg_external ON messages(conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX ux_msg_fp ON messages(conversation_id, fingerprint) WHERE external_id IS NULL;
CREATE UNIQUE INDEX ux_msg_seq ON messages(conversation_id, conv_seq);

CREATE TABLE translations (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  lang TEXT,
  status TEXT NOT NULL CHECK (status IN ('not_needed','pending','done','failed','retry')),
  ko_text TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  translated_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_tr_status ON translations(status, next_attempt_at);

CREATE TABLE slack_outbox (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  channel_id TEXT NOT NULL,
  token_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','retry','unconfirmed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  slack_ts TEXT,
  translation_included INTEGER NOT NULL DEFAULT 0,
  -- follow-up chat.update once the translation lands after a "번역 대기" post
  update_status TEXT NOT NULL DEFAULT 'none' CHECK (update_status IN ('none','pending','done','failed')),
  last_error TEXT,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX ix_outbox_status ON slack_outbox(status, next_attempt_at);

CREATE TABLE ops_events (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info','warning','error')),
  kind TEXT NOT NULL,
  detail TEXT,
  account_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_ops_created ON ops_events(created_at);

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
