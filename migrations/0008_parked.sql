-- "Later": a parked task is out of the decision inbox, the briefing and agents' next_task until someone
-- brings it back, or until snoozed_until passes. parked_from is the status it returns to.
-- SQLite cannot change a CHECK constraint in place, so the tasks table is rebuilt with 'parked' allowed.
-- Every row and id is copied as is; foreign keys are checked once at the end.
PRAGMA defer_foreign_keys = on;

CREATE TABLE tasks_new (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  key              TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  brief            TEXT NOT NULL DEFAULT '',
  criteria         TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL CHECK (status IN ('inbox','ready','in_progress','blocked','review','done','declined','parked')),
  priority         INTEGER NOT NULL DEFAULT 2,
  origin           TEXT NOT NULL DEFAULT 'queue',
  created_by       TEXT REFERENCES members(id),
  assignee_id      TEXT REFERENCES members(id),
  reviewer_id      TEXT REFERENCES members(id),
  lease_expires_at TEXT,
  blocked_question TEXT,
  blocked_on_id    TEXT REFERENCES members(id),
  review_rounds    INTEGER NOT NULL DEFAULT 0,
  parent_id        TEXT REFERENCES tasks(id),
  due_at           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  parked_from      TEXT,
  snoozed_until    TEXT
);

INSERT INTO tasks_new (id, project_id, key, title, brief, criteria, status, priority, origin, created_by, assignee_id, reviewer_id,
                       lease_expires_at, blocked_question, blocked_on_id, review_rounds, parent_id, due_at, created_at, updated_at)
SELECT id, project_id, key, title, brief, criteria, status, priority, origin, created_by, assignee_id, reviewer_id,
       lease_expires_at, blocked_question, blocked_on_id, review_rounds, parent_id, due_at, created_at, updated_at FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_project ON tasks(project_id, status);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE INDEX tasks_updated ON tasks(updated_at);
CREATE INDEX tasks_snoozed ON tasks(snoozed_until) WHERE status = 'parked';

PRAGMA defer_foreign_keys = off;
