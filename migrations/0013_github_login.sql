-- A person's GitHub username: a pull request merged from that account counts as their approval
-- of the task in Kunla, so nobody approves the same work twice (KD-38).
ALTER TABLE members ADD COLUMN github_login TEXT;
