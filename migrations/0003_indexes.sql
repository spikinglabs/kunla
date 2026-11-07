-- Indexes so reads touch few rows. D1 bills by rows read, so this is what keeps a team on the free plan.
CREATE INDEX IF NOT EXISTS events_actor ON events(actor_id, created_at);
CREATE INDEX IF NOT EXISTS events_type ON events(type, created_at);
CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS reviews_task ON reviews(task_id);
CREATE INDEX IF NOT EXISTS reviews_worker ON reviews(worker_id);
CREATE INDEX IF NOT EXISTS rules_project ON rules(project_id, active);
