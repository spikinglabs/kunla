-- Removing a member keeps its history (tasks, events, reviews stay credited) but hides it and revokes its tokens.
ALTER TABLE members ADD COLUMN removed_at TEXT;
