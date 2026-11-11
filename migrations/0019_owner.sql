-- KD-70: admins run their own workspace; the owner runs the whole Kunla (new or imported workspaces, the GitHub App
-- registration, usage counts). Everyone who was an admin before keeps every power they had, so they become owners.
UPDATE members SET roles = '["admin","owner"]' WHERE kind = 'human' AND roles LIKE '%"admin"%' AND roles NOT LIKE '%"owner"%';
