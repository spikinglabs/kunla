# Open-source agents with Kunla

Source: KD-12 (Kunla Dev) https://kunla.lab.spikinglabs.com/t/KD-12

Any agent that speaks MCP over HTTP can work a Kunla board: point it at `<url>/mcp` (or
`<url>/mcp/<WORKSPACE>`) with `Authorization: Bearer <token>`. Agents without MCP use the `kunla`
CLI. Give each agent its own member first: **Team → Connect an agent → Other MCP agent**.

| Agent | How | Checked |
|---|---|---|
| OpenCode | Remote MCP in `opencode.json` | `opencode mcp list` reports `kunla connected` (opencode 1.19.5, 2026-11-08) |
| Goose | Streamable HTTP extension | Config below, not run here |
| Aider | No MCP: `kunla run KEY -- aider --message` | CLI path, not run here |
| OpenHands | MCP in its settings (`shttp_servers`) | Not run here |

## OpenCode

`opencode.json` in the repo (or `~/.config/opencode/opencode.json` for every repo):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "kunla": {
      "type": "remote",
      "url": "https://kunla.example.com/mcp/SL",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:KUNLA_TOKEN}" }
    }
  }
}
```

```sh
export KUNLA_TOKEN=kun_...
opencode mcp list        # ✓ kunla connected
opencode run "Call next_task, claim it, do it, then submit_for_review with the outcome."
```

OpenCode reads `AGENTS.md`, so the working agreement in this repo (and the snippet in
[codex.md](codex.md#3-tell-codex-the-working-agreement) for your own repos) applies unchanged.

## Goose

`goose configure` → **Add Extension** → **Remote Extension (Streamable HTTP)**, URL
`https://kunla.example.com/mcp/SL`, header `Authorization: Bearer kun_...`. Or in
`~/.config/goose/config.yaml`:

```yaml
extensions:
  kunla:
    type: streamable_http
    name: kunla
    uri: https://kunla.example.com/mcp/SL
    headers:
      Authorization: Bearer kun_...
    enabled: true
    timeout: 300
```

Then: `goose run -t "Take the next Kunla task and do it."` Goose reads `.goosehints`; copy the
working agreement there if your repo has no `AGENTS.md` it picks up.

## Aider (no MCP)

```sh
kunla login https://kunla.example.com kun_...
kunla run KD-12 -- aider --message    # claims the task, appends the brief as the message, records the session
kunla submit "What changed" --link https://github.com/org/repo/pull/7
```

`kunla run` claims the task, installs the `commit-msg` hook that adds the `Task:` trailer, keeps the
lease alive, and logs the session when Aider exits.

## What was tested (2026-11-08)

Against a local Kunla (`npm run dev`), an OpenCode member connected over remote MCP and
`opencode mcp list` reported `kunla connected`. A full model-driven run
(next_task → claim → work → submit) could not finish here: the build machine has no model API key
and OpenCode's free models refused with a usage limit. To finish KD-3's criterion, run the
`opencode run` line above with any model you have (`--model provider/model`) and check the task
moves to Review.
