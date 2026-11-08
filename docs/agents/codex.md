# Codex CLI with Kunla

Source: KD-11 (Kunla Dev) https://kunla.lab.spikinglabs.com/t/KD-11

Codex talks to Kunla through the same MCP server as Claude Code, so it gets the same tools
(`next_task`, `claim_task`, `log_work`, `submit_for_review`, …) and the same working agreement.
It takes about two minutes.

## 1. Give Codex its own member and token

In Kunla: **Team → Connect an agent**, name it (e.g. "L's Codex"), pick **Codex**, and
**Create connection**. Copy the token; Kunla shows it once. You are the agent's sponsor, so its
work is credited to it and its decisions come to you.

## 2. Add the MCP server

```sh
export KUNLA_TOKEN=kun_...            # put this in your shell profile
codex mcp add kunla --url https://kunla.example.com/mcp/SL --bearer-token-env-var KUNLA_TOKEN
codex mcp list                        # kunla  …  KUNLA_TOKEN  enabled  Bearer token
```

`SL` is the workspace key (Team → Use in claude.ai shows the address). Plain `/mcp` works too.
The command writes this to `~/.codex/config.toml`, which you can also edit by hand:

```toml
[mcp_servers.kunla]
url = "https://kunla.example.com/mcp/SL"
bearer_token_env_var = "KUNLA_TOKEN"
# optional
tool_timeout_sec = 60
```

One setup covers every repo. For a second workspace, add a second server with its own name and
token variable (e.g. `kunla_community` with `KUNLA_COMMUNITY_TOKEN`). Keep tokens in environment
variables, never in a committed file.

## 3. Tell Codex the working agreement

Codex reads `AGENTS.md` from the repo. Kunla's own repo already has one. In your repos, add:

```md
## Kunla
Work is tracked in Kunla (MCP server `kunla`).
1. Before starting, call `next_task` (or `get_task KEY`) and follow the brief, playbook and rules.
2. Claim before working (`claim_task`, pass `repo` = your git remote). Never work on a task someone else holds.
3. Cite the key everywhere: commit trailer `Task: KEY <link>`, branch `key-slug`, PR title `KEY: title`.
4. Record progress with `log_work` (one sentence). Finish with `submit_for_review` and the PR link.
5. Stuck? `update_task` with `blocked_question`. Stopping partway? `release_task` with a handoff note.
```

The server also sends the full agreement as MCP instructions when Codex connects.

## 4. Use it

```sh
codex "Take the next Kunla task and do it."
codex "Work through my Kunla tasks."          # continuous mode, if your sponsor turned it on
codex exec "Do KD-12 from Kunla, then submit it for review."   # non-interactive, e.g. in CI
```

Codex asks before it runs MCP tools unless you approve them for the session. Read-only tools
(`whoami`, `next_task`, `get_task`, `list_tasks`, `project_status`, `team_pulse`, `decision_inbox`)
are marked `readOnlyHint`, so approval policies can let them through.

Without MCP, the `kunla` CLI starts Codex on a task and records the session:

```sh
kunla login https://kunla.example.com kun_...
kunla run KD-12 -- codex
```

## Starting Codex from Kunla

Kunla can wake an agent when work is Ready if the agent has a wake-up URL (Team → Manage → Wake-up).
Point it at anything that starts Codex, for example a GitHub Actions workflow that runs
`codex exec "Work through my Kunla tasks."`; see [examples/kunla-wake.yml](../../examples/kunla-wake.yml).

## Troubleshooting

- `codex mcp list` shows the server but tools fail with 401: `KUNLA_TOKEN` isn't set in the shell
  that started Codex, or the token was retired (Team → Manage → New token).
- Tools time out on a slow network: raise `tool_timeout_sec` / `startup_timeout_sec`.
- Codex doesn't cite keys: check `AGENTS.md` is in the repo root and `get_task` returns `references`.
