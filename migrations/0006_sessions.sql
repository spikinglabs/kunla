-- The AI chat or agent session that worked on a task, so a person can open it later.
-- ref is a link (https://claude.ai/...) or a plain reference such as "claude --resume <id>".
CREATE TABLE IF NOT EXISTS task_sessions (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  ref        TEXT NOT NULL,
  member_id  TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, ref)
);
