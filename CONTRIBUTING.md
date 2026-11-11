# Contributing to Kunla

Thanks for helping. Kunla is small on purpose: one Cloudflare Worker, one D1 database, static files with no build step. Contributions that keep it that way are the easiest to merge.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue first if you are not sure it is a bug.
- **New features:** open an issue (or a discussion) first so we can agree on the shape before you write code. Kunla's rule of thumb: anything one team needs stays free in the core; only company-wide controls (SSO/SCIM, audit export, org policies) go in `ee/`.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node 22.

```sh
npm install
npm run dev          # Worker + local D1 at http://localhost:8787 (open /app/)
node scripts/demo-seed.mjs http://localhost:8787   # optional demo data
npm run typecheck
npm test             # Vitest; runs the Worker against an in-memory SQLite D1 shim
```

CI runs `npm run typecheck` and `npm test` on every pull request. Please run both before you push.

## Where things live

`AGENTS.md` has the full map. In short: `src/core.ts` holds the record-of-work logic as plain SQL, `src/mcp.ts` the MCP tools, `src/index.ts` the REST API, `public/` the web app, `plugins/claude-code/` the Claude Code plugin and the `kunla` CLI, `migrations/` the schema.

## Rules that keep self-hosted copies safe

- **Migrations only add.** A migration in `migrations/` may add tables or columns, never rename or drop them in the same release, so `wrangler rollback` to the previous Worker stays safe for everyone who self-hosts.
- **Workspaces are hard boundaries.** Every query and insert on `members`, `projects`, `tasks`, `events` and `webhook_deliveries` is limited to the caller's workspace (`space_id`). A pull request that reads or writes across workspaces will not be merged.
- **No Cloudflare-only features in the core** (no Durable Objects, KV or queues), so the core can run on SQLite or Postgres later.
- **Cheap by default.** No polling loops, no open connections, no paid APIs called by Kunla itself.
- **Add a test** in `test/` for behaviour you change.

## Pull requests

- Keep each pull request to one change, with a title that says what changes for a user.
- If your work is tracked in a Kunla board, cite the task key: `KEY: title` in the PR title and a `Task: KEY <link>` trailer in commits. Kunla's own development is tracked this way (keys like `KD-65`). Outside contributors don't need a key.
- Screenshots help for anything in the web app, at desktop and phone width, in light and dark mode.
- Agents are welcome as contributors. A person is still responsible for each pull request they open, and the working agreement in `AGENTS.md` applies.

## Licensing of contributions

The repository has two licences:

- Everything **outside `ee/`** is under the [Apache License 2.0](LICENSE). By contributing there you agree your contribution is licensed under Apache-2.0 (as in section 5 of the licence). No separate CLA is needed.
- Everything **in `ee/`** is under the [Kunla Enterprise License](ee/LICENSE), which is not open source. Please don't send changes to `ee/` without talking to us first; the core must never import from `ee/`.

Sign your commits with your real name or a stable handle you are happy to have in the history.

## Conduct

Be kind and specific. Criticise code, not people. Maintainers may remove comments, issues or pull requests that are abusive, and block people who keep it up.
