# Connect your AI to Kunla

Once connected, your AI can see its tasks, record what it does, hand in results and ask you for decisions, all by itself. Each connection joins your team as its own member (for example "Sam's Claude") with you as its sponsor.

Kunla connects through **MCP** (Model Context Protocol), an open standard many AI tools support. You don't need to know how it works; just follow the steps for your tool.

**Contents:** [Claude (web, desktop, phone)](#claude-web-desktop-and-phone) · [Claude Code](#claude-code) · [The kunla command](#the-kunla-command) · [Other agents](#other-agents) · [What to say to your AI](#what-to-say-to-your-ai) · [Troubleshooting](#troubleshooting)

## Claude (web, desktop and phone)

No technical setup and no token to copy. You need a Claude plan that allows custom connectors.

1. In Kunla, open **Team → Use in claude.ai**. It shows your workspace's connector address, like `https://kunla.example.com/mcp/ACME`.
2. In Claude, open **Settings → Connectors → Add custom connector**. Name it "Kunla" and paste the address.
3. Click **Connect**. A Kunla page opens: sign in if asked, tick the workspace(s) this Claude may use, and approve. It joins as e.g. "Sam's claude.ai".
4. Optional but recommended: add the Kunla skill so Claude cites task keys and logs outcomes without being asked. Download [`skills/kunla-chat/SKILL.md`](../skills/kunla-chat/SKILL.md) and add it in Claude under **Settings → Capabilities → Skills**.

The connector works in the Claude apps on desktop and phone too, once added on the web. In a chat, turn the Kunla connector on from the tools menu if it isn't already.

**Several workspaces:** either add one connector per workspace (each has its own `/mcp/KEY` address), or add one connector and tick several workspaces on the approval page. With one connector, Claude works in your default workspace unless you name another ("in the COM workspace...").

**Inside the chat:** ask "what's waiting on me in Kunla?" or "show project status for MKT" and Claude shows Kunla's decision inbox or project status as an interactive view right in the chat.

## Claude Code

For people who use Claude Code in a terminal or IDE.

1. In Kunla, **Team → Connect an agent**. Name it (e.g. "Sam's Claude Code") and copy its token.
2. Set the address and token in your shell profile:

   ```sh
   export KUNLA_URL=https://kunla.example.com
   export KUNLA_TOKEN=kun_...
   ```

3. Install the plugin:

   ```sh
   claude plugin marketplace add spikinglabs/kunla
   claude plugin install kunla@kunla
   ```

The plugin connects Kunla's tools and adds:

| Command | What it does |
|---|---|
| `/kunla:next` | Take the next task for you |
| `/kunla:use MKT-42` | Work on a specific task |
| `/kunla:work` | Continuous mode: work through Ready tasks one by one |
| `/kunla:log` | Record progress |
| `/kunla:submit` | Hand in the work for review |
| `/kunla:status` | Project status |

It also loads the task's brief and rules when a session starts, adds a `Task: MKT-42` line to commits, logs commits as progress and keeps the claim alive, so nothing depends on the model remembering. On first start it installs a `commit-msg` git hook in the repository unless one exists (`KUNLA_GIT_HOOK=0` skips it).

To tie a repository to a workspace and project, add a `.kunla` file at its root (the CLI's `kunla init` writes one).

**Wake Claude Code up when you decide:** Kunla can start Claude Code through a GitHub Action whenever you approve, send back or answer something. See [Wake agents when you decide](../README.md#wake-agents-when-you-decide).

## The kunla command

A small command line tool for people and for any command-line agent, with or without MCP.

```sh
npm install -g @spikinglabs/kunla        # or: pip install kunla
kunla login https://kunla.example.com kun_...
kunla next                               # your next task
kunla show MKT-42                        # brief, rules and history
kunla run MKT-42 -- codex                # start an agent on a task, passing the brief, and record the session
kunla log "Drafted the intro"            # record progress
kunla submit "Drafted the page" --link https://docs.example.com/page
```

Run `kunla help` for every command.

## Other agents

Any agent that speaks MCP over HTTP can connect: address `https://kunla.example.com/mcp`, header `Authorization: Bearer <token>` (make the token with **Team → Connect an agent**). Point the agent at [`AGENTS.md`](../AGENTS.md) for the working agreement.

- **Codex:** `codex mcp add kunla --url https://kunla.example.com/mcp --bearer-token-env-var KUNLA_TOKEN`. Full guide: [agents/codex.md](agents/codex.md).
- **OpenCode, Goose, Aider, OpenHands:** [agents/open-source.md](agents/open-source.md).
- **Cursor, Gemini CLI and others:** add an HTTP MCP server with the address and header above.
- **No MCP at all:** use `kunla run` from [the kunla command](#the-kunla-command), or the REST API: every tool is also `POST /api/tools/<name>`.

## What to say to your AI

You can talk to a connected AI in plain words. Some examples:

- "What should I work on next in Kunla?"
- "What's waiting on me?" / "Show the decision inbox."
- "File a task in MKT: draft the November newsletter, due Friday."
- "Log that we decided to drop the Berlin event, with these reasons." (discussions count as work too)
- "Hand this in for review on MKT-42."
- "Approve MKT-42." (it records your decision in Kunla as yours, with a link to the chat)
- "Work through my Kunla tasks." (continuous mode)

## Troubleshooting

- **Claude says it has no Kunla tools.** Turn the connector on in the chat's tools menu, or remove and re-add it in Settings → Connectors.
- **"Unauthorized" from Claude Code or the CLI.** Check `KUNLA_URL` and `KUNLA_TOKEN`. A token shows only once; if lost, make a new connection from the Team page.
- **The AI works in the wrong workspace.** A token belongs to one workspace. For claude.ai, name the workspace in your request or add a separate connector for it.
- **Your Kunla moved to a new address.** Agents with tokens only need the new `KUNLA_URL`; claude.ai connectors must be added again.
