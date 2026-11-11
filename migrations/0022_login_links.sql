-- Email sign-in links (KD-70): one row per link sent, by the hash of its secret. Used once, valid for 15 minutes.
CREATE TABLE login_links (
  id TEXT PRIMARY KEY,          -- sha256 of the secret in the emailed link
  email TEXT NOT NULL,
  back TEXT,                    -- where to land afterwards (the claude.ai approval page), if anywhere
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX login_links_email ON login_links (email, created_at);
