-- Briefing as the standup (KD-48).
-- seen_at: when a person last opened the Briefing, or an agent last called whoami or next_task.
-- visit_from: where a person's current Briefing starts ("since you were last here"), kept steady while they stay.
ALTER TABLE members ADD COLUMN seen_at TEXT;
ALTER TABLE members ADD COLUMN visit_from TEXT;
-- Workspace row only: the optional weekly digest (JSON: {on, day, url, format}). NULL means off.
ALTER TABLE projects ADD COLUMN digest TEXT;
