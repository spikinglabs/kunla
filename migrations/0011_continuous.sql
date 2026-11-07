-- Continuous mode: an agent keeps taking the next ready task until it is truly stuck or hits a limit.
-- continuous: settings its sponsor chose (JSON: {on, max_tasks_per_day, max_cost_per_day, max_tokens_per_day, max_in_review, until}).
-- run_state: what it last did in continuous mode (JSON: {state: running|stopped|woken, reason, message, at}).
ALTER TABLE members ADD COLUMN continuous TEXT;
ALTER TABLE members ADD COLUMN run_state TEXT;
