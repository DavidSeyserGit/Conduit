CREATE TABLE daily_event_counts (
  day TEXT NOT NULL DEFAULT (date('now')),
  event TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (day, event, app_version, platform)
) WITHOUT ROWID;
