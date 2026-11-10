-- "A message arrived" notices from channels we only watch (Instagram DM lists), not full transcripts.
CREATE TABLE notice_accounts (
  channel TEXT NOT NULL,
  account TEXT NOT NULL,
  unread_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, account)
);

CREATE TABLE notice_threads (
  channel TEXT NOT NULL,
  account TEXT NOT NULL,
  thread_name TEXT NOT NULL,
  last_preview TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  folder TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, account, thread_name)
);

CREATE TABLE notices (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  account TEXT NOT NULL,
  folder TEXT,
  thread_name TEXT NOT NULL,
  preview TEXT,
  time_label TEXT,
  client_id INTEGER REFERENCES clients(id),
  slack_status TEXT NOT NULL CHECK (slack_status IN ('pending','sent','retry','unconfirmed','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  slack_ts TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_notices_status ON notices(slack_status, next_attempt_at);
