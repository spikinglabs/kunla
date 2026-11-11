-- One connector for several workspaces (KD-29). A person ticks the workspaces a chat app may reach when they approve
-- it; the app joins each as its own agent. The other workspaces' agents ride along with the code here, and the token
-- it is exchanged for gets one row per workspace: the default under sha256(token), each other under
-- sha256(token + "#" + workspace id). So every grant is its own token row, revoked on its own.
ALTER TABLE oauth_codes ADD COLUMN grants TEXT;  -- JSON: member ids of the agents in the other ticked workspaces
