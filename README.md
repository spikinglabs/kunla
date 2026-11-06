# Kunla

**Every AI's work for the team, in one record, and the decisions it needs from you.**

Kunla (from Esperanto *kunlabori*, "to work together") is an open source record of work for teams where people and AIs work side by side. Each person and each AI connection is a member. Every task has a key like `MKT-42` that follows the work into commits, PRs, docs and messages. People see one screen, the **decision inbox**: reviews, questions and proposals. Everything else updates itself from what the agents do.

It runs on Cloudflare (one Worker, one D1 database, static files) and costs close to nothing for a small team.

## What's in v1

- **Decision inbox** as the home screen: approve or request changes, answer an AI's question, accept or decline a proposal.
- **Structured reviews.** When you request changes you say what was wrong and can tick *apply next time*. That becomes a project rule, sent to every agent with every future task.
- **Record of work.** Tasks with briefs, acceptance criteria, deliverables, a full history, and per-project playbooks. Board, progress and team views.
- **People and AIs as members.** Each AI connection has its own identity and a human sponsor. The team page shows each AI's track record (tasks done, first-pass approval rate).
- **Claims with leases.** An AI's claim lapses after 30 quiet minutes and the task goes back to Ready with a note. No cron job: leases expire lazily on read.
- **Remote MCP server** at `/mcp` for any MCP agent (Claude Code, Codex, Cursor, Gemini CLI, Goose…), with OAuth so claude.ai can add it as a custom connector.
- **Claude Code plugin** whose hooks load the task's brief and rules at session start, add a `Task:` trailer to commits, log commits as progress, and keep the claim alive. Nothing depends on the model remembering.
- **`kunla` CLI** for people and for any command-line agent: `kunla run MKT-42 -- codex` starts an agent on a task and records the session.
- **REST API.** Every MCP tool is also `POST /api/tools/<name>`.

## Quick start (local)

```sh
npm install
npm run dev                                   # Worker + local D1 at http://localhost:8787
node scripts/demo-seed.mjs http://localhost:8787   # optional demo team; prints tokens
npm test
```

Open http://localhost:8787. On a fresh database you'll see the setup screen: your name and a first project. Kunla shows your personal token once; keep it in a password manager.

## Deploy to your Cloudflare account

```sh
npx wrangler login
npx wrangler d1 create kunla          # copy the database_id into wrangler.toml
npx wrangler secret put SETUP_TOKEN   # so only you can run first-time setup
npm run deploy                        # applies migrations, then deploys
```

Open your Worker's URL and complete setup with the setup token.

**Upgrading:** pull the new release and run `npm run deploy` again, or use the included GitHub Action (`.github/workflows/deploy.yml`) in your copy. Migrations only ever add tables or columns, so rolling back to the previous Worker version (`npx wrangler rollback`) is safe.

## Connect your agents

On the **Team** page, click **Connect an AI**. Each connection becomes its own AI member with you as sponsor, and gets its own token.

**Claude Code**

```sh
export KUNLA_URL=https://kunla.example.com
export KUNLA_TOKEN=kun_...
claude plugin marketplace add spikinglabs/kunla
claude plugin install kunla@kunla
```

The plugin adds the MCP server, the working-agreement skill, commands (`/kunla:next`, `/kunla:use MKT-42`, `/kunla:submit`, `/kunla:log`, `/kunla:status`) and hooks. On first session start it installs a `commit-msg` git hook in the repo unless one already exists (set `KUNLA_GIT_HOOK=0` to skip).

**claude.ai** (web, desktop, mobile): Settings → Connectors → Add custom connector → `https://kunla.example.com/mcp`. You approve it on a Kunla page, and it joins as e.g. "L's claude.ai". Add `skills/kunla-chat/SKILL.md` as a skill so it cites keys and logs work.

**Codex, Cursor, Gemini CLI, Goose and other MCP agents:** an HTTP MCP server at `<url>/mcp` with header `Authorization: Bearer <token>`. Point the agent at `AGENTS.md` for the working agreement.

**Any command-line agent, even without MCP:**

```sh
npm install -g github:spikinglabs/kunla   # or run plugins/claude-code/bin/kunla.mjs with node
kunla login https://kunla.example.com kun_...
kunla run MKT-42 -- codex                # passes the brief as the prompt, records the session
kunla submit "Drafted the page" --link https://github.com/org/repo/pull/7
```

## MCP tools

| Tool | What it does |
|---|---|
| `whoami` | Your member profile, sponsor and projects |
| `next_task` | Your task in progress, then assigned work, then reviews for you, then open Ready work |
| `list_tasks`, `get_task` | Search; one task with brief, playbook, rules, history and citation text |
| `claim_task`, `heartbeat` | Take a task atomically; keep the lease alive |
| `update_task` | Note, status, or `blocked_question` for a person |
| `log_work` | One sentence of progress; creates a task with a key if there is none |
| `submit_for_review` | Summary plus at least one deliverable link |
| `review_task` | Approve or request changes, with an optional *apply next time* rule |
| `create_task` | New task; from an AI it lands in the inbox as a proposal |
| `decision_inbox`, `answer_question`, `triage_proposal` | The decisions waiting on people |
| `project_status` | Counts, who is on what, blockers, recent activity, share of updates recorded by agents |

Tool replies can carry a one-line reminder (for example "MKT-51 has no update for 2+ hours"), so nobody has to chase.

## Architecture

```
public/            static web app (no build step), served free by Workers static assets
src/index.ts       Hono Worker: REST API, MCP endpoint, OAuth routes
src/core.ts        the record of work: plain SQL, no Cloudflare-only features
src/mcp.ts         MCP tools (Streamable HTTP, stateless)
src/oauth.ts       OAuth 2.1 + PKCE + dynamic client registration for chat connectors
migrations/        D1 schema (additive only)
plugins/claude-code/  Claude Code plugin and the kunla CLI
skills/kunla-chat/ skill for claude.ai
ee/                enterprise features, separate license (empty in v1)
```

Live views poll every 20 seconds; no Durable Objects or open connections. AI work such as drafting briefs is done by the team's own agents through MCP, so Kunla pays nothing for model use.

## Not in v1 yet

In-chat interactive views (MCP Apps), Tiny Foundation and other knowledge providers, GitHub app webhooks, Jira mirroring, Docker and Postgres, Codex-specific hooks, refresh tokens for OAuth, and per-project permissions.

## License

The core is [Apache-2.0](LICENSE). Code under [`ee/`](ee/) is covered by its own license.
