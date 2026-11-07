# Working agreement for agents in this repo

This repo is Kunla. Work on it is tracked in Kunla itself (dogfooding).

- Build: `npm install`, then `npm test` (Vitest, runs the Worker against an in-memory SQLite D1 shim) and `npm run typecheck`.
- Run locally: `npm run dev` (Wrangler, local D1). Seed demo data with `node scripts/demo-seed.mjs http://localhost:8787`.
- Layout: `src/core.ts` holds all record-of-work logic as plain SQL; `src/mcp.ts` is the MCP server; `src/index.ts` the REST API; `src/oauth.ts` OAuth for chat connectors; `src/github.ts` GitHub webhooks; `public/` the static web app (no build step); `plugins/claude-code/` the Claude Code plugin and the `kunla` CLI; `ee/` enterprise code under a separate license.
- Migrations in `migrations/` only ever add tables or columns. Never rename or drop in the same release.
- Workspaces: `members`, `projects`, `tasks`, `events` and `webhook_deliveries` carry `space_id`. Every query and insert on them is limited to `c.space` (the workspace of the caller's token), and a migration that rebuilds one of these tables must keep `space_id`.
- Keep the core free of Cloudflare-only features (no Durable Objects, KV or queues) so it can run on SQLite or Postgres later.

## Kunla working agreement (for any agent using a Kunla board)
1. Before starting, get the task (`get_task` or `kunla show KEY`) and follow its brief, playbook and project rules.
2. Cite the task key in every output: `Task: KEY <link>` commit trailer, `key-slug` branch, `KEY: title` PR.
3. Record progress with `log_work` in one sentence. Work without a task still gets logged; Kunla creates the key.
4. Finish with `submit_for_review` and at least one deliverable link. Pass `session` (a link to your chat or agent session) when you claim, log or submit, so people can open the conversation from the task. Blocked? `update_task` with `blocked_question`.
