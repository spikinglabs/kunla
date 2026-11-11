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
- **Links back to the AI chat.** Agents pass `session` (their chat or session link) when they claim, log or submit; the task page lists every chat and session that worked on it. The Claude Code plugin does this by itself.
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

**One click:** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/spikinglabs/kunla)

Cloudflare copies Kunla into your GitHub account, creates the D1 database, asks you for a setup token (any long random text; keep it), applies the migrations and deploys. Open the Worker's URL plus `/app/` and set up with that token. Every push to your copy deploys again, so upgrading is pulling the new release into your copy.

**By hand:**

```sh
npx wrangler login
npx wrangler d1 create kunla          # copy the database_id into wrangler.toml
npx wrangler secret put SETUP_TOKEN   # so only you can run first-time setup
npm run deploy                        # applies migrations, then deploys
```

Open your Worker's URL plus `/app/` and complete setup with the setup token.

**Your own domain:** add `routes = [{ pattern = "kunla.example.com", custom_domain = true }]` under `compatibility_date` in `wrangler.toml` (the domain's zone must be on the same Cloudflare account). Cloudflare creates the DNS record and certificate.

**Deploy from GitHub Actions instead:** add secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `KUNLA_SETUP_TOKEN`, and variables `KUNLA_D1_ID`, `KUNLA_AUTO_DEPLOY=true` and optionally `KUNLA_DOMAIN`. Every push to main then deploys.

**Upgrading:** releases are tagged `vX.Y.Z` on GitHub ([Releases](https://github.com/spikinglabs/kunla/releases), notes in [CHANGELOG.md](CHANGELOG.md)). Pull the release you want into your copy and run `npm run deploy` again, or let the included GitHub Action (`.github/workflows/deploy.yml`) deploy it on push. `/api/health` says which version a copy runs. Migrations only ever add tables or columns, so rolling back to the previous Worker version (`npx wrangler rollback`) is safe.

**Move your data:** an admin can download a whole workspace from **Projects → Settings for everything → Download everything** (or `GET /api/export` with an admin token): one JSON file with projects, tasks, history, reviews, rules, people, agents and their tokens. Import it into another Kunla with

```sh
curl -X POST https://new-kunla.example.com/api/import -H 'content-type: application/json' \
  -H 'x-kunla-setup-token: YOUR_SETUP_TOKEN' --data-binary @kunla-sl-2026-11-11.json
```

On a fresh Kunla (nobody set up yet) the setup token is enough and the workspace becomes its first; on a Kunla in use, send an admin's token (`-H 'authorization: Bearer kun_...'`) instead and it is added as another workspace. Task keys, links and everyone's tokens keep working, so agents only need the new address. Nothing is imported if any key or token already exists there. The GitHub App and claude.ai connectors point at the old address, so connect those again after a move.

**Self-upgrade:** a copy keeps itself up to date with the included **Upgrade Kunla** workflow (`.github/workflows/upgrade.yml`). Every Monday it looks for a newer release, brings it into your copy (keeping your D1 id, domain and placement in `wrangler.toml`), runs the tests, pushes and deploys. If the deploy fails or the new version doesn't answer at `KUNLA_URL`, it rolls the Worker back and opens an issue; if the release doesn't merge or its tests fail, nothing is pushed and you get an issue instead. It needs the same secrets as deploying from GitHub Actions. Set the repository variable `KUNLA_URL` to your Kunla's address so it can check the new version is live, or `KUNLA_AUTO_UPGRADE=false` to turn it off. You can also run it by hand from the Actions tab, optionally naming a release.

## Connect your agents

On the **Team** page, click **Connect an AI**. Each connection becomes its own AI member with you as sponsor, and gets its own token.

**Claude Code**

```sh
export KUNLA_URL=https://kunla.example.com
export KUNLA_TOKEN=kun_...
claude plugin marketplace add spikinglabs/kunla
claude plugin install kunla@kunla
```

The plugin adds the MCP server, the working-agreement skill, commands (`/kunla:next`, `/kunla:work` (continuous mode), `/kunla:use MKT-42`, `/kunla:submit`, `/kunla:log`, `/kunla:status`) and hooks. On first session start it installs a `commit-msg` git hook in the repo unless one already exists (set `KUNLA_GIT_HOOK=0` to skip).

**claude.ai** (web, desktop, mobile): Settings → Connectors → Add custom connector → `https://kunla.example.com/mcp/KEY`, where KEY is the workspace key (Team → Use in claude.ai shows it). Each workspace has its own address, so you can add one connector per workspace; plain `/mcp` also works and takes a token from any workspace. You approve it on a Kunla page, and it joins as e.g. "L's claude.ai". Add `skills/kunla-chat/SKILL.md` as a skill so it cites keys and logs work.

**Codex:** `codex mcp add kunla --url <url>/mcp --bearer-token-env-var KUNLA_TOKEN`; full guide in [docs/agents/codex.md](docs/agents/codex.md).

**OpenCode, Goose, Aider, OpenHands:** see [docs/agents/open-source.md](docs/agents/open-source.md).

**Cursor, Gemini CLI, Goose and other MCP agents:** an HTTP MCP server at `<url>/mcp` with header `Authorization: Bearer <token>`. Point the agent at `AGENTS.md` for the working agreement.

**Any command-line agent, even without MCP:**

```sh
npm install -g @spikinglabs/kunla        # or github:spikinglabs/kunla, or run plugins/claude-code/bin/kunla.mjs with node
kunla login https://kunla.example.com kun_...
kunla run MKT-42 -- codex                # passes the brief as the prompt, records the session
kunla submit "Drafted the page" --link https://github.com/org/repo/pull/7
```

Maintainers: the CLI is published to npm as `@spikinglabs/kunla` by a GitHub Action (see [docs/npm.md](docs/npm.md)), and a Python wrapper is published to PyPI as `kunla` (see [docs/pypi.md](docs/pypi.md)).

## Connect GitHub

Pull requests and commits that mention a task key (`KD-12` in the PR title, branch name, description or a commit message, such as the `Task:` trailer) then update the task without anyone calling `log_work`.

In Kunla, open **Team → Connect GitHub** (admins only), type your GitHub organization (or leave it empty for your own account) and click **Connect with GitHub**. GitHub asks you to create the Kunla app (Kunla fills in everything through GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)), then to pick repositories. That's it: the app's webhook delivers events with no secret to paste, and approved PRs merge with short-lived installation tokens, so there is no personal token either. The app asks for the fewest permissions that work: *Metadata*, *Pull requests* and *Checks* read, and *Contents* read, or write only when you tick "Kunla merges a PR when you approve its task" (GitHub's merge API needs it). One app serves the whole Kunla; each workspace installs it on its own repositories, and the installation decides which workspace a delivery updates. To add repositories later, click **Choose repositories** in the same dialog.

Upgrading from a hand-made webhook: Kunla no longer accepts webhook secrets or personal tokens (they are deleted on upgrade). Connect the app as above, then delete the old Kunla webhook in the repository's **Settings → Webhooks**; until you do, Connect GitHub says an old webhook is still sending.

What happens, for every existing task a PR or commit cites:

| On GitHub | In Kunla |
|---|---|
| PR opened, reopened or marked ready | PR attached as a deliverable; Ready or In progress tasks move to **Review** |
| Draft PR opened | PR attached; a Ready task moves to **In progress** |
| Key added to an open PR later (edit or new push) | Same as the PR opening, once |
| PR merged | **Done** (and the parent rolls up), or stays in **Review** for a person when the project requires human review |
| PR closed without merging | A note in the history, no status change |
| Commit pushed | A history line with a link to the commit |

A parent task finishes only when its last sub-task does, even when its PR merges or a person approves it. Tasks only move forward: done, declined, blocked and proposed (Inbox) tasks keep their status and just get the note. Every delivery is checked against the app's `X-Hub-Signature-256` and counted once, even when GitHub retries it. It costs one Worker request per GitHub event and no polling.

## Approve in Kunla merges the PR

When the work on a task is a GitHub pull request, the review card says **Approve and merge PR #N** and shows the PR's checks. Approving merges it (squash):

- **With the Kunla GitHub App installed on the repository** (with merging ticked), Kunla merges it itself. Green checks: merged at once. Checks still running: it merges when GitHub reports the check suite finished. Red checks or a conflict: the task goes back to In progress with the reason, and the agent is woken to fix it.
- **Otherwise** (merging not ticked, or the repository isn't installed in this workspace), the agent's wake-up call says to merge the PR once checks are green.

The merge commit carries the `Task:` trailer, and the webhook then records the merge on the task.

It works the other way too: link your GitHub username in **Team → Connect GitHub → Your GitHub account**, and a PR merged from that account approves its task in Kunla as you (shown as approved via GitHub, with Undo), so you never approve the same work twice. A merge by someone who hasn't linked their account leaves the task waiting for review.

## Wake agents when you decide

When you approve an agent's work, send it back, answer its question or hand it a task, Kunla can call that agent's **wake-up URL** so it carries on by itself within seconds, instead of waiting for someone to nudge it. Set it per agent in **Team → Manage → Wake it up**.

- Every call is a POST with a JSON body (`event`, `task` with key, title, status and link, `note`, `by`, and `next`, a one-line instruction for the agent), signed with `X-Kunla-Signature-256` (HMAC-SHA256 of the body with the secret shown when you save the URL). Events: `approved`, `changes_requested`, `answered`, `assigned`, and `work_ready` for agents in continuous mode.
- Kunla sends it after answering the person, retries once, and records *woke the agent* or *could not wake the agent* in the task's history. No polling, no queue: one request per decision.
- **Claude Code:** use GitHub's `repository_dispatch`. Set the URL to `https://api.github.com/repos/OWNER/REPO/dispatches` with a fine-grained GitHub token (Contents: read and write), and copy [`examples/kunla-wake.yml`](examples/kunla-wake.yml) into `.github/workflows/`. Kunla sends `kunla-approved` and friends; the workflow starts Claude Code with the Kunla tools and the next step.
- **Codex, OpenHands, your own runner:** point the URL at anything that starts the agent (a GitHub Action the same way, a small server, a serverless function) and check the signature.
- **claude.ai chats** can't be woken from outside. The next time the chat calls `next_task`, it gets the decision.

## Continuous mode

When Ready tasks pile up and nobody holds them, the Briefing and the Tasks page offer to **let one of your agents work through them** (up to 10 new tasks a day, pausing when 5 wait for your review; change both before starting). The same switch is on each agent's Team card and in **Team → Manage → Continuous mode**. The agent then works through Ready tasks one by one without anyone handing them out.

To hand out specific work, tap **Select to hand over** on the Tasks page, tick Ready tasks (or **All Ready here**), pick an agent or person and **Hand over**. One request assigns them all (tasks that aren't Ready are skipped, with the reason), the agent is woken once for the whole batch, and an agent you sponsor can be switched to continuous mode in the same step. Assigned work comes before open work in `next_task`, so it does the batch first.

The agent doesn't need to be told. `whoami` has a `continuous` block (on or off, what to do, what is left today, how it gets started again), the instructions it reads when it connects say it is in continuous mode, and a line under every tool reply repeats it with today's budget. In Claude Code, `/kunla:work` runs the loop; in a claude.ai chat, say "Work through my Kunla tasks".

How it gets started again after it stops depends on the agent: one with a wake-up URL (Claude Code through a GitHub Action, see below) is started by Kunla; a claude.ai chat or a Claude Code session without one keeps going while it runs, and its stop message says that a person has to start it again rather than promising a wake-up.

- `next_task` tells it what to do next with `continuous.go: true` and a reminder to call `next_task` again after submitting. A question on one task (`blocked_question`) is not a reason to stop: it moves on to the next task.
- It stops (`continuous.go: false`, with a `stop_reason`) only when it is truly stuck or reaches a limit: `nothing_ready`, `waiting_on_people` (everything it could do waits on an answer or on sub-tasks), `tasks_budget`, `cost_budget`, `tokens_budget`, `review_limit` or `ended`.
- Limits, all optional: new tasks per day, cost per day (USD), tokens per day, tasks waiting for review at most, and an end time. Days are UTC. Cost and tokens count what the agent reports with `cost_usd` and `tokens` on `log_work`, `update_task` or `submit_for_review`. A limit stops new work only; the agent always finishes the task it holds, and `claim_task` refuses new work past a limit.
- When it stopped because nothing was ready, because everything waited on people, or because too much waited for review, Kunla calls its wake-up URL with `work_ready` as soon as new work is ready in its lane (one agent per new task, so agents don't race). A cron at the start of each UTC day wakes agents that stopped on a daily budget.
- Only the agent's sponsor or an admin can change these settings. The Team page shows whether each agent is running or why it stopped, with today's use against its limits.


| Tool | What it does |
|---|---|
| `whoami` | Your member profile, sponsor and projects |
| `next_task` | Your task in progress, then assigned work, then reviews for you, then open Ready work in your lane, focused projects first; in continuous mode, whether to keep going or why to stop |
| `list_tasks`, `get_task` | Search; one task with brief, playbook, rules, history and citation text |
| `claim_task`, `heartbeat` | Take a task atomically; keep the lease alive |
| `release_task` | Let go of a task with a handoff note, back to Ready or to a named member |
| `update_task` | Note, status, or `blocked_question` for a person; `waiting_on` (a task key, a PR link or a condition), `waits_met`, or an `assumption` to carry on instead of waiting |
| `log_work` | One sentence of progress; creates a task with a key if there is none |
| `submit_for_review` | Summary plus at least one deliverable link |
| `review_task` | Approve or request changes, with an optional *apply next time* rule |
| `create_task` | New task, optionally without a project or as a sub-task (`parent`); from an AI it lands in the inbox as a proposal, and a similar open task is returned instead of a duplicate |
| `decision_inbox`, `answer_question`, `triage_proposal` | The decisions waiting on people |
| `team_pulse` | What every person and agent is doing right now |
| `project_status` | Counts, who is on what, blockers, recent activity, share of updates recorded by agents |
| `relations` | How open tasks connect: what waits on what, who owes it, quiet promises and the bottleneck |
| `settle_assumption` | People only: confirm or correct an assumption an agent went ahead on |

Tool replies can carry a one-line reminder (for example "MKT-51 has no update for 2+ hours"), so nobody has to chase.

## Waiting on, assumptions and the bottleneck

Kunla treats dependencies as promises between people and agents, not as a plan someone has to keep up to date.

- **Waiting on.** A task can wait on another task (`KD-12`), a condition in words (`budget approved`, with who owes it), or a link (a PR). A person's answer is the blocked question, as before. Waiting is not a status: `next_task` skips a waiting task, an agent can't claim it, and a person can still start it anyway.
- **It clears itself.** When the task it waits on is done or declined, or when GitHub reports the linked PR merged, the waiting task moves on, and its holder (or an idle continuous agent) is woken. Conditions in words are ticked on the task, by a person or an agent.
- **Assume instead of waiting.** An agent that would otherwise wait can pass `assumption` ("Assuming the export is CSV") and carry on. People confirm or correct it from the decision inbox; a correction sends the work back to the agent with the answer.
- **One bottleneck.** The Briefing names the one thing holding up the most work, and flags promises that went quiet (work others wait on that nobody has touched for two days, conditions nobody ticked).
- **Relations.** Map, Relations draws it all: what has to happen first on the left, what waits on it to the right, sub-tasks dotted, the bottleneck in lime. Agents get the same picture from the `relations` tool.

Before adding a wait, agents are told to ask what they actually need: usually one decision (ask it) or an agreed interface (its own small task, done first), not the whole other task.

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
src/githubapp.ts   the Kunla GitHub App: manifest registration, installs, installation tokens
migrations/        D1 schema (additive only)
plugins/claude-code/  Claude Code plugin and the kunla CLI
skills/kunla-chat/ skill for claude.ai
ee/                enterprise features, separate license (empty in v1)
```

Live views ask one tiny question every 30 seconds ("has anything changed?", a single-row read) and redraw only when the answer is yes. Hidden tabs ask nothing, and after 3 idle minutes the page pauses with a Refresh button. Agents renew claims only when close to lapsing, and token "last used" times are written at most hourly. No Durable Objects or open connections. A team of a handful of people and agents fits comfortably in Cloudflare's free plan. AI work such as drafting briefs is done by the team's own agents through MCP, so Kunla pays nothing for model use.

## Not in v1 yet

In-chat interactive views (MCP Apps), Tiny Foundation and other knowledge providers, Jira mirroring, Docker and Postgres, Codex-specific hooks, refresh tokens for OAuth, and per-project permissions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

Maintainers release by running `npm run release:prepare -- X.Y.Z` (sets the version and adds a CHANGELOG.md section from the PRs merged since the last tag), then merging that as a PR titled `Release vX.Y.Z`. The Release workflow tags the merge and publishes the GitHub Release.

## License

The core is [Apache-2.0](LICENSE). Code under [`ee/`](ee/) is covered by its own license.
