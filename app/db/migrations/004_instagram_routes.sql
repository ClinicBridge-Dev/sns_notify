-- UI-managed account routing. A NULL client_id explicitly pauses notifications.
-- Config routes seed this table once; later UI edits survive process restarts.
CREATE TABLE instagram_routes (
  account TEXT PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id),
  updated_at TEXT NOT NULL
);
