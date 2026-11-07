-- Every delivery GitHub sends (pings and rejected ones too), so Connect GitHub can show which
-- repositories are sending events and how the last ones went. space_id is NULL when the signature
-- matched no workspace's secret. Rows older than 30 days are pruned on each delivery.
CREATE TABLE IF NOT EXISTS webhook_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id   TEXT,
  event      TEXT NOT NULL,
  repo       TEXT,
  status     INTEGER NOT NULL,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_log_space ON webhook_log(space_id, created_at);
