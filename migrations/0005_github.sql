-- GitHub webhooks: commits and pull requests that cite a task key update the task by themselves.
-- settings holds small per-workspace values (one deployment is one workspace), e.g. the webhook secret.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- GitHub retries a delivery it thinks failed; remembering recent delivery ids makes each one count once.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_time ON webhook_deliveries(created_at);
