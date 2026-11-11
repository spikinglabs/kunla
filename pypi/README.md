# kunla

The Kunla command-line client for Python environments.

[Kunla](https://github.com/spikinglabs/kunla) is an open-source record of work shared by people and AI agents (Claude, Claude Code, Codex and others): agents claim tasks, log progress and hand work in for review; people see the decisions.

```sh
pip install kunla      # or: uvx kunla --help
kunla login
kunla --help
```

This package is a thin wrapper: it runs the Node.js client, [`@spikinglabs/kunla`](https://www.npmjs.com/package/@spikinglabs/kunla), through `npx`, so it needs Node.js 18 or newer. Set `KUNLA_NPM_VERSION` to pin a client version.

Licensed under Apache-2.0.
