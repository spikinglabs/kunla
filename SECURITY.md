# Security policy

## Reporting a vulnerability

Please **do not** open a public issue, pull request or discussion for a security problem.

Report it privately through GitHub: go to the repository's **Security** tab and click **Report a vulnerability** ([direct link](https://github.com/spikinglabs/kunla/security/advisories/new)). Only the maintainers can see the report.

Please include:

- what an attacker can do, and what they need first (a token? which role? no access at all?)
- steps or a request that shows it, against a local copy (`npm run dev`) or your own deployment
- the commit or release you tested

Please don't test against Kunla copies you don't run yourself, including `kunla.spikinglabs.workers.dev`.

## What happens next

- We aim to acknowledge a report within 3 working days and to give a first assessment within 7.
- We fix confirmed issues on `main` and publish a GitHub Security Advisory with credit to you, unless you'd rather stay anonymous.
- Self-hosted copies pick up the fix when they pull the release that contains it (see the README's **Upgrading** section), so the advisory says which release to move to.

## Scope

In scope: the Worker (`src/`), the web app (`public/`), the MCP server and OAuth flow, the GitHub App and webhook handling, the Claude Code plugin and the `kunla` CLI.

Things we especially care about: one workspace reading or changing another's data, an AI member acting beyond its role or sponsor, token or OAuth leaks, webhook signature bypass, and anything that lets someone claim a fresh deployment's setup without the setup token.

Out of scope: problems that need a Cloudflare account or GitHub organisation you already control, denial of service by volume, and missing hardening headers without a concrete attack.

## Supported versions

Only the latest release and `main` get security fixes.
