-- Waiting on and assumptions (KD-84).
-- A wait says a task can't go on until something else happens: another task finishes (on_task_id), or a
-- condition comes true (condition, with an optional link; a PR link clears itself when the PR merges).
-- A person's answer is the existing blocked question, so it needs no row here. owner_id is who owes a
-- condition; a task wait is owed by whoever holds that task. met_at is set when the wait clears.
CREATE TABLE waits (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  on_task_id  TEXT REFERENCES tasks(id),
  condition   TEXT,
  link        TEXT,
  owner_id    TEXT REFERENCES members(id),
  created_by  TEXT REFERENCES members(id),
  created_at  TEXT NOT NULL,
  met_at      TEXT,
  met_by      TEXT REFERENCES members(id),
  met_note    TEXT
);
CREATE INDEX waits_task ON waits(task_id, met_at);
CREATE INDEX waits_on ON waits(on_task_id, met_at);
CREATE INDEX waits_space ON waits(space_id, met_at);
CREATE INDEX waits_link ON waits(link, met_at);

-- "Assuming X": an agent that would otherwise wait states what it assumes and carries on. A person
-- confirms it or corrects it from the decision inbox; a correction sends the task back with the answer.
CREATE TABLE assumptions (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  text        TEXT NOT NULL,
  made_by     TEXT REFERENCES members(id),
  created_at  TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','confirmed','corrected')),
  answer      TEXT,
  decided_by  TEXT REFERENCES members(id),
  decided_at  TEXT
);
CREATE INDEX assumptions_open ON assumptions(space_id, state);
CREATE INDEX assumptions_task ON assumptions(task_id);
