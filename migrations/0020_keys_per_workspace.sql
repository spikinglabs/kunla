-- KD-70: keys are short inside a workspace and full across workspaces (ACME-MKT-42). A project key only has to be
-- unique in its workspace, and so do task keys; workspace keys stay unique across the whole Kunla, because they
-- are the prefix of every full key and the address of the workspace's connector (/mcp/ACME).
-- SQLite cannot drop a UNIQUE in place, so projects and tasks are rebuilt under their own names; every row and id is
-- copied as is. Foreign keys are deferred: dropping a table leaves the rows that point at it dangling for a moment,
-- and putting each row back into the new table under the same name settles them again before the end. (Renaming a
-- new table into place would not: SQLite keeps counting those rows as dangling, and the migration would fail.)
PRAGMA defer_foreign_keys = on;

CREATE TABLE projects_copy AS SELECT * FROM projects;
CREATE TABLE tasks_copy AS SELECT * FROM tasks;
DROP TABLE tasks;
DROP TABLE projects;

CREATE TABLE projects (
  id                   TEXT PRIMARY KEY,
  key                  TEXT NOT NULL,
  name                 TEXT NOT NULL,
  playbook             TEXT NOT NULL DEFAULT '',
  require_human_review INTEGER NOT NULL DEFAULT 1,
  next_seq             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  kind                 TEXT NOT NULL DEFAULT 'project',
  focus                INTEGER NOT NULL DEFAULT 0,
  rank                 INTEGER NOT NULL DEFAULT 100,
  ends_at              TEXT,
  space_id             TEXT NOT NULL DEFAULT 'workspace',
  kinds                TEXT,
  repo_url             TEXT,
  repo_forge           TEXT,
  digest               TEXT,
  UNIQUE (space_id, key)
);
INSERT INTO projects (id, key, name, playbook, require_human_review, next_seq, created_at, kind, focus, rank, ends_at, space_id, kinds, repo_url, repo_forge, digest)
  SELECT id, key, name, playbook, require_human_review, next_seq, created_at, kind, focus, rank, ends_at, space_id, kinds, repo_url, repo_forge, digest FROM projects_copy;
DROP TABLE projects_copy;
CREATE INDEX projects_space ON projects(space_id, kind);
CREATE UNIQUE INDEX projects_workspace_key ON projects(key) WHERE kind = 'workspace';

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  key              TEXT NOT NULL,
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
  snoozed_until    TEXT,
  space_id         TEXT NOT NULL DEFAULT 'workspace',
  kind             TEXT,
  UNIQUE (space_id, key)
);
INSERT INTO tasks (id, project_id, key, title, brief, criteria, status, priority, origin, created_by, assignee_id, reviewer_id,
  lease_expires_at, blocked_question, blocked_on_id, review_rounds, parent_id, due_at, created_at, updated_at, parked_from, snoozed_until, space_id, kind)
  SELECT id, project_id, key, title, brief, criteria, status, priority, origin, created_by, assignee_id, reviewer_id,
  lease_expires_at, blocked_question, blocked_on_id, review_rounds, parent_id, due_at, created_at, updated_at, parked_from, snoozed_until, space_id, kind FROM tasks_copy;
DROP TABLE tasks_copy;
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_project ON tasks(project_id, status);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE INDEX tasks_updated ON tasks(updated_at);
CREATE INDEX tasks_snoozed ON tasks(snoozed_until) WHERE status = 'parked';
CREATE INDEX tasks_space ON tasks(space_id, status);
CREATE INDEX tasks_kind ON tasks(space_id, kind);
