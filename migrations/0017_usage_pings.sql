-- Opt-in anonymous usage pings (KD-69). Only the Kunla that collects them (KUNLA_COLLECT_PINGS=true) writes here:
-- one row per installation, overwritten by its daily ping. No names, addresses or content, only counts.
CREATE TABLE IF NOT EXISTS usage_pings (
  install_id  TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  edition     TEXT NOT NULL,
  workspaces  INTEGER NOT NULL,
  people      INTEGER NOT NULL,
  agents      INTEGER NOT NULL,
  tasks       INTEGER NOT NULL,
  tasks_7d    INTEGER NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_pings_seen ON usage_pings(last_seen);
