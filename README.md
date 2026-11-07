# Kunla

**Every AI's work for the team, in one record, and the decisions it needs from you.**

Kunla (from Esperanto *kunlabori*, "to work together") is an open source record of work for teams where people and AIs work side by side. Each person and each AI connection is a member. Every task has a key like `MKT-42` that follows the work into commits, PRs, docs and messages. People see one screen, the **decision inbox**: reviews, questions and proposals. Everything else updates itself from what the agents do.

It runs on Cloudflare (one Worker, one D1 database, static files) and costs close to nothing for a small team.

## What's in v1

- **Briefing** as the home screen: what happened while you were away, then one decision at a time (approve, send back, or teach the team a rule), who is working on what right now, and the rules every agent follows.
- **Work map**: a lane per person and agent showing work, waiting and decisions, built from the record, plus where work is waiting on a person.
- **Flexible hierarchy**: workspace > project > task > sub-task, where projects are optional (a task can live straight in the workspace) and a sub-task always belongs to a task. When the last sub-task finishes, its parent finishes too.
- **Steering**: mark projects as *focus* and rank them; `next_task` offers focused work first. Give each member a *lane* (the projects it works on). A `.kunla` file in a repo ties it to a workspace and project.
- **Built for hundreds of tasks**: a grouped list (by project, person or status) with filters like Mine, Stuck and Done this week, saved views, and ⌘K to delegate in one line or jump anywhere. Agents check for duplicates before creating tasks, and proposals nobody triaged for 14 days are closed with a note.
- **Separate workspaces**: one Kunla holds several workspaces (say, work, startup and community), each a hard boundary with its own people, agents, projects, rules and tokens. Admins make a new one from just a name in the workspace menu (`POST /api/workspaces`). A token belongs to one workspace and sees only that one. Task keys stay unique across the whole Kunla, so `KD-12` always means one task. You can also join a workspace on another organisation's Kunla with its address and your token there. The web app switches between them and shows what waits on you elsewhere; the browser holds one token per workspace.
- **Structured reviews.** When you request changes you say what was wrong and can tick *apply next time*. That becomes a project rule, sent to every agent with every future task.
- **Record of work.** Tasks with briefs, acceptance criteria, deliverables, a full history, and per-project playbooks. Board, progress and team views.
- **People and AIs as members.** Each AI connection has its own identity and a human sponsor. The team page shows each AI's track record (tasks done, first-pass approval rate).
- **Claims with leases.** An AI's claim lapses after 30 quiet minutes and the task goes back to Ready with a note. No cron job: leases expire lazily on read.
- **Remote MCP server** at `/mcp` for any MCP agent (Claude Code, Codex, Cursor, Gemini CLI, Goose…), with OAuth so claude.ai can add it as a custom connector.
- **Claude Code plugin** whose hooks load the task's brief and rules at session start, add a `Task:` trailer to commits, log commits as progress, and keep the claim alive. Nothing depends on the model remembering.
- **`kunla` CLI** for people and for any command-line agent: `kunla run MKT-42 -- codex` starts an agent on a task and records the session.
- **REST API.** Every MCP tool is also `POST /api/tools/<name>`.
- **GitHub webhooks.** Pull requests and commits that cite a task key update the task by themselves: an opened PR sends it to Review with the PR attached, a merged PR finishes it (or waits for a person's review when the project requires one).

## Quick start (local)

```sh
npm install
npm run dev                                   # Worker + local D1 at http://localhost:8787
node scripts/demo-seed.mjs http://localhost:8787   # optional demo team; prints tokens
npm test
```

Open http://localhost:8787/app/. On a fresh database you'll see the setup screen: your name and a first project. Kunla shows your personal token once; keep it in a password manager.

## Deploy to your Cloudflare account

```sh
npx wrangler login
npx wrangler d1 create kunla          # copy the database_id into wrangler.toml
npx wrangler secret put SETUP_TOKEN   # so only you can run first-time setup
npm run deploy                        # applies migrations, then deploys
```

Open your Worker's URL plus `/app/` and complete setup with the setup token.

**Your own domain:** add `routes = [{ pattern = "kunla.example.com", custom_domain = true }]` under `compatibility_date` in `wrangler.toml` (the domain's zone must be on the same Cloudflare account). Cloudflare creates the DNS record and certificate.

**Deploy from GitHub Actions instead:** add secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `KUNLA_SETUP_TOKEN`, and variables `KUNLA_D1_ID`, `KUNLA_AUTO_DEPLOY=true` and optionally `KUNLA_DOMAIN`. Every push to main then deploys.

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

## Connect GitHub

Pull requests and commits that mention a task key (`KD-12` in the PR title, branch name, description or a commit message, such as the `Task:` trailer) then update the task without anyone calling `log_work`.

1. In Kunla, open **Team → Connect GitHub** (admins only) and click **Make the secret**. Kunla shows the secret once. You can instead set it as a Worker secret: `wrangler secret put GITHUB_WEBHOOK_SECRET`.
2. In the GitHub repository (or organization), open **Settings → Webhooks → Add webhook** and fill in:
   - **Payload URL**: `https://<your-kunla>/hooks/github`
   - **Content type**: `application/json`
   - **Secret**: the secret from step 1
   - **Events**: *Let me select individual events*, then **Pull requests** and **Pushes**
3. Click **Add webhook**. GitHub sends a ping; the Connect GitHub dialog shows when it last heard from GitHub.

What happens, for every existing task a PR or commit cites:

| On GitHub | In Kunla |
|---|---|
| PR opened, reopened or marked ready | PR attached as a deliverable; Ready or In progress tasks move to **Review** |
| Draft PR opened | PR attached; a Ready task moves to **In progress** |
| Key added to an open PR later (edit or new push) | Same as the PR opening, once |
| PR merged | **Done** (and the parent rolls up), or stays in **Review** for a person when the project requires human review |
| PR closed without merging | A note in the history, no status change |
| Commit pushed | A history line with a link to the commit |

Tasks only move forward: done, declined, blocked and proposed (Inbox) tasks keep their status and just get the note. Every delivery is checked against `X-Hub-Signature-256` and counted once, even when GitHub retries it. One secret serves the whole workspace, so you can add the same webhook to several repositories. Every workspace on a Kunla uses the same webhook URL with its own secret; the secret a delivery is signed with decides which workspace it updates. It costs one Worker request per GitHub event and no polling.

## MCP tools

| Tool | What it does |
|---|---|
| `whoami` | Your member profile, sponsor and projects |
| `next_task` | Your task in progress, then assigned work, then reviews for you, then open Ready work in your lane, focused projects first |
| `list_tasks`, `get_task` | Search; one task with brief, playbook, rules, history and citation text |
| `claim_task`, `heartbeat` | Take a task atomically; keep the lease alive |
| `update_task` | Note, status, or `blocked_question` for a person |
| `log_work` | One sentence of progress; creates a task with a key if there is none |
| `submit_for_review` | Summary plus at least one deliverable link |
| `review_task` | Approve or request changes, with an optional *apply next time* rule |
| `create_task` | New task, optionally without a project or as a sub-task (`parent`); from an AI it lands in the inbox as a proposal, and a similar open task is returned instead of a duplicate |
| `decision_inbox`, `answer_question`, `triage_proposal` | The decisions waiting on people |
| `team_pulse` | What every person and agent is doing right now |
| `project_status` | Counts, who is on what, blockers, recent activity, share of updates recorded by agents |

Tool replies can carry a one-line reminder (for example "MKT-51 has no update for 2+ hours"), so nobody has to chase.

## Architecture

```
public/            static files (no build step), served free by Workers static assets
  index.html       the landing page at /; old /#/... links and signed-in people go on to /app/
  app/index.html   the web app at /app/ (app.js and style.css stay at the root)
src/index.ts       Hono Worker: REST API, MCP endpoint, OAuth routes
src/core.ts        the record of work: plain SQL, no Cloudflare-only features
src/mcp.ts         MCP tools (Streamable HTTP, stateless)
src/oauth.ts       OAuth 2.1 + PKCE + dynamic client registration for chat connectors
src/github.ts      GitHub webhooks: signature check, task keys, status changes
migrations/        D1 schema (additive only)
plugins/claude-code/  Claude Code plugin and the kunla CLI
skills/kunla-chat/ skill for claude.ai
ee/                enterprise features, separate license (empty in v1)
```

Live views ask one tiny question every 30 seconds ("has anything changed?", a single-row read) and redraw only when the answer is yes. Hidden tabs ask nothing, and after 3 idle minutes the page pauses with a Refresh button. Agents renew claims only when close to lapsing, and token "last used" times are written at most hourly. No Durable Objects or open connections. A team of a handful of people and agents fits comfortably in Cloudflare's free plan. AI work such as drafting briefs is done by the team's own agents through MCP, so Kunla pays nothing for model use.

## Not in v1 yet

In-chat interactive views (MCP Apps), Tiny Foundation and other knowledge providers, a GitHub App (one-click install instead of a webhook per repo), Jira mirroring, Docker and Postgres, Codex-specific hooks, refresh tokens for OAuth, and per-project permissions.

## License

The core is [Apache-2.0](LICENSE). Code under [`ee/`](ee/) is covered by its own license.
