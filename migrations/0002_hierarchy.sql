-- Flexible hierarchy: workspace > project > task > sub-task, where the project level is optional.
-- The workspace itself is stored as a special row in projects (kind = 'workspace'), so tasks without
-- a project still get a key (WS-12), and its playbook and rules apply to every task in the workspace.
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'; -- project | workspace
ALTER TABLE projects ADD COLUMN focus INTEGER NOT NULL DEFAULT 0;     -- "focus this week": offered first
ALTER TABLE projects ADD COLUMN rank INTEGER NOT NULL DEFAULT 100;    -- lower comes first
ALTER TABLE projects ADD COLUMN ends_at TEXT;                         -- NULL means ongoing

-- Lanes: which projects a member works on. Empty means everything.
ALTER TABLE members ADD COLUMN scope TEXT NOT NULL DEFAULT '[]';

INSERT INTO projects (id, key, name, kind, require_human_review, created_at)
SELECT 'workspace', CASE WHEN EXISTS (SELECT 1 FROM projects WHERE key = 'WS') THEN 'WSP' ELSE 'WS' END,
       'Workspace', 'workspace', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM projects WHERE kind = 'workspace');

CREATE INDEX tasks_parent ON tasks(parent_id);
