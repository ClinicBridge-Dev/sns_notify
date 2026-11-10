-- Notices carry counts ("새로운 N건 / 확인하지 않은 M건") and one Slack message covers a burst.
ALTER TABLE notices ADD COLUMN new_count INTEGER NOT NULL DEFAULT 1;

-- List rows are now tracked per folder: two Instagram chats with the same display name in Primary
-- and General must not overwrite each other. Old rows are dropped on purpose; every list starts
-- again from a silent baseline snapshot.
DROP TABLE notice_threads;
CREATE TABLE notice_threads (
  channel TEXT NOT NULL,
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  thread_name TEXT NOT NULL,
  last_preview TEXT,                 -- change-detection cursor of the row
  unread INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  -- Stamp of the last snapshot that contained the row. Unread totals only count rows of the latest
  -- snapshot, so rows that scrolled out of a virtualized list never inflate the total forever.
  seen_at TEXT,
  PRIMARY KEY (channel, account, folder, thread_name)
);

-- One row per watched list. Notices start once the baseline window after created_at has passed.
CREATE TABLE notice_folders (
  channel TEXT NOT NULL,
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  created_at TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  PRIMARY KEY (channel, account, folder)
);
