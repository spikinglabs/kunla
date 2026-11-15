-- KD-88: a task can move into a project, to another project or back to the workspace level. It takes a key in its
-- new project (SL-3 becomes PBI-1), and every key it had before stays here, so commits, PR titles, links and chats
-- that cite the old key still find it. Keys are never handed out twice (next_seq only goes up), so an old key can't
-- point at two tasks; if one ever did, the task that has the key now wins.
CREATE TABLE task_aliases (
  space_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, key)
);
CREATE INDEX task_aliases_task ON task_aliases (task_id);
