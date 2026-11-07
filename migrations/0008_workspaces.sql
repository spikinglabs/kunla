-- Several workspaces in one deployment. A workspace is still its row in projects (kind = 'workspace');
-- space_id says which workspace a row belongs to and equals that row's id. Everything existing
-- belongs to the first workspace, so existing tokens, agents and connectors keep working unchanged.
-- Members, and so tokens, belong to exactly one workspace: the token decides what a caller can see.
-- Numbered 0008 so it never collides with 0006/0007 from open work; D1 applies whatever is missing.
ALTER TABLE members ADD COLUMN space_id TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE projects ADD COLUMN space_id TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE tasks ADD COLUMN space_id TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE events ADD COLUMN space_id TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE webhook_deliveries ADD COLUMN space_id TEXT NOT NULL DEFAULT 'workspace';

-- The first workspace's row id is 'workspace' on every deployment made by migration 0002, but don't rely on it.
UPDATE members SET space_id = (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1)
  WHERE space_id != (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1);
UPDATE projects SET space_id = (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1)
  WHERE space_id != (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1);
UPDATE tasks SET space_id = (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1)
  WHERE space_id != (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1);
UPDATE events SET space_id = (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1)
  WHERE space_id != (SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1);

CREATE INDEX IF NOT EXISTS members_space ON members(space_id);
CREATE INDEX IF NOT EXISTS projects_space ON projects(space_id, kind);
CREATE INDEX IF NOT EXISTS tasks_space ON tasks(space_id, status);
CREATE INDEX IF NOT EXISTS events_space ON events(space_id);              -- MAX(id) per workspace, for the change check
CREATE INDEX IF NOT EXISTS events_space_time ON events(space_id, created_at);
