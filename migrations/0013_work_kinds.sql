-- Kinds of work (KD-37): Kunla records all the team's work, not only code.
-- kind: code | writing | research | reading | learning | discussion | marketing | sales | data | design | other.
-- NULL (older tasks) means Kunla guesses it from the title and links when it reads the task.
ALTER TABLE tasks ADD COLUMN kind TEXT;
CREATE INDEX IF NOT EXISTS tasks_kind ON tasks(space_id, kind);

-- Written outcomes handed in instead of (or next to) a link: paper notes, the decisions from a
-- discussion, research findings. Markdown. Scoped through the task, like deliverables.
CREATE TABLE IF NOT EXISTS task_notes (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  title      TEXT,
  body       TEXT NOT NULL,
  added_by   TEXT REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(task_id, created_at);
