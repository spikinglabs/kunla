-- Kunla record of work: schema v1.
-- Migrations only ever add (new tables or columns), so the previous release still runs after a rollback.

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('human', 'ai')),
  platform    TEXT,                 -- for AIs: claude-code, claude-ai, codex, ...
  sponsor_id  TEXT REFERENCES members(id), -- the accountable human for an AI
  roles       TEXT NOT NULL DEFAULT '[]',  -- JSON array, e.g. ["admin","writer"]
  created_at  TEXT NOT NULL
);

-- One credential per connection. Attribution comes from the token, never from what an AI says.
CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id),
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE projects (
  id                   TEXT PRIMARY KEY,
  key                  TEXT NOT NULL UNIQUE,  -- task key prefix, e.g. MKT
  name                 TEXT NOT NULL,
  playbook             TEXT NOT NULL DEFAULT '', -- Markdown sent with every task
  require_human_review INTEGER NOT NULL DEFAULT 1,
  next_seq             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  key              TEXT NOT NULL UNIQUE,     -- MKT-42, never changes
  title            TEXT NOT NULL,
  brief            TEXT NOT NULL DEFAULT '',
  criteria         TEXT NOT NULL DEFAULT '[]', -- JSON array of acceptance criteria
  status           TEXT NOT NULL CHECK (status IN ('inbox','ready','in_progress','blocked','review','done','declined')),
  priority         INTEGER NOT NULL DEFAULT 2, -- 0 urgent .. 3 low
  origin           TEXT NOT NULL DEFAULT 'queue', -- queue | logged (work started in a chat)
  created_by       TEXT REFERENCES members(id),
  assignee_id      TEXT REFERENCES members(id),
  reviewer_id      TEXT REFERENCES members(id),
  lease_expires_at TEXT,                     -- NULL while held means no expiry (humans)
  blocked_question TEXT,
  blocked_on_id    TEXT REFERENCES members(id),
  review_rounds    INTEGER NOT NULL DEFAULT 0,
  parent_id        TEXT REFERENCES tasks(id),
  due_at           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_project ON tasks(project_id, status);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT REFERENCES tasks(id),
  actor_id   TEXT REFERENCES members(id),  -- NULL means Kunla itself (e.g. lease expiry)
  type       TEXT NOT NULL,
  note       TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX events_task ON events(task_id, id);
CREATE INDEX events_time ON events(created_at);

CREATE TABLE deliverables (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  url        TEXT NOT NULL,
  title      TEXT,
  added_by   TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, url)
);

-- Structured reviews: the judgment record. Free text alone can't become rules.
CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  reviewer_id    TEXT NOT NULL REFERENCES members(id),
  worker_id      TEXT REFERENCES members(id),
  verdict        TEXT NOT NULL CHECK (verdict IN ('approved','changes_requested')),
  comment        TEXT,
  what_was_wrong TEXT,
  created_at     TEXT NOT NULL
);

-- "Apply next time" rules, sent with every future task in the project.
CREATE TABLE rules (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  text       TEXT NOT NULL,
  review_id  TEXT REFERENCES reviews(id),
  created_by TEXT REFERENCES members(id),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- OAuth for chat connectors (claude.ai). Short-lived codes, registered clients.
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  redirect_uris TEXT NOT NULL, -- JSON array
  created_at    TEXT NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  member_id      TEXT NOT NULL REFERENCES members(id), -- the AI member the connection becomes
  expires_at     TEXT NOT NULL
);
