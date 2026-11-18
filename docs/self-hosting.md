# Self-hosting Kunla

This guide is for whoever runs Kunla for a team. You don't need to be a developer for the one-click path; the other paths assume you are comfortable with a terminal.

Kunla runs on Cloudflare: one Worker (the app and its API), one D1 database (SQLite) and static files. There are no servers to patch. A team of a handful of people and agents fits in Cloudflare's free plan, and Kunla never pays for AI model use: your agents do the AI work through their own accounts.

**Contents:** [Choose a path](#choose-a-path) · [One click](#1-one-click-deploy-button) · [By hand](#2-by-hand-with-wrangler) · [GitHub Actions](#3-from-github-actions) · [Keep data in the EU](#keep-your-data-in-the-eu) · [First setup](#first-setup) · [Your own domain](#your-own-domain) · [Sign-in](#how-people-sign-in) · [Connect GitHub](#connect-github) · [Upgrades](#upgrades) · [Staging and production](#staging-and-production) · [Backups and moving](#backups-and-moving) · [Other hosting](#other-hosting-aws-and-docker) · [Troubleshooting](#troubleshooting)

## Choose a path

| Path | Good for | You need |
|---|---|---|
| [One click](#1-one-click-deploy-button) | Trying Kunla, small teams, non-developers | A Cloudflare account and a GitHub account |
| [By hand with wrangler](#2-by-hand-with-wrangler) | Control over where data lives (for example the EU) | Node.js 20+ and a terminal |
| [GitHub Actions](#3-from-github-actions) | Teams that want every change deployed automatically, and self-upgrades | A copy of the repository and a Cloudflare API token |

You can start with one path and switch later: they all produce the same Worker and database.

## 1. One click (Deploy button)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/spikinglabs/kunla)

1. Click the button and sign in to Cloudflare and GitHub.
2. Cloudflare copies Kunla into your GitHub account and creates the D1 database.
3. When it asks for `SETUP_TOKEN`, paste any long random text (a password manager can make one). Keep it: it is what proves you are the owner at first setup.
4. Wait for the deploy to finish, then open the Worker's address with `/app/` on the end, for example `https://kunla.your-name.workers.dev/app/`, and continue with [First setup](#first-setup).

Every push to your copy deploys again. The button creates the database in Cloudflare's default location; if your data must stay in the EU, use the by-hand path below instead.

## 2. By hand with wrangler

```sh
git clone https://github.com/spikinglabs/kunla && cd kunla
npm install
npx wrangler login
npx wrangler d1 create kunla --jurisdiction eu   # leave out --jurisdiction eu if you don't need it
# copy the database_id it prints into wrangler.toml, replacing REPLACE_WITH_YOUR_D1_ID
npx wrangler secret put SETUP_TOKEN             # any long random text; keep it
npm run deploy                                  # applies database migrations, then deploys
```

Open your Worker's address plus `/app/` and continue with [First setup](#first-setup).

## 3. From GitHub Actions

Use a fork or copy of the repository. The included workflow `.github/workflows/deploy.yml` deploys on every push to `main`.

1. Create the database once (see [By hand](#2-by-hand-with-wrangler), including `--jurisdiction eu` if you want it) and note its id.
2. Create a Cloudflare API token with permission to edit Workers and D1 (the "Edit Cloudflare Workers" template plus D1 edit works).
3. In GitHub, **Settings → Secrets and variables → Actions**, add:

| Name | Type | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | secret | your Cloudflare account id |
| `KUNLA_SETUP_TOKEN` | secret | any long random text; keep it |
| `KUNLA_D1_ID` | variable | the database id |
| `KUNLA_AUTO_DEPLOY` | variable | `true` |
| `KUNLA_DOMAIN` | variable (optional) | your own domain, for example `kunla.example.com` |
| `KUNLA_URL` | variable (optional) | your Kunla's address, so self-upgrades can check the new version is live |
| `KUNLA_ENV` | variable (optional) | `staging` to show a "Staging" ribbon on a test copy |
| `KUNLA_PLACEMENT_REGION` | variable (optional) | a fixed region for the Worker instead of Smart Placement |

4. Push to `main` (or run the **Deploy** workflow by hand from the Actions tab).

## Keep your data in the EU

Cloudflare D1 can pin a database to the EU **jurisdiction**: the data is stored and processed only inside the EU. This is stronger than a location hint, which only says where the database starts out.

- Create the database with `npx wrangler d1 create kunla --jurisdiction eu`. A jurisdiction is set when the database is created and can't be changed later.
- The Worker runs next to its database by itself (Smart Placement in `wrangler.toml`), so pages stay fast for people in Europe.
- Already running Kunla elsewhere? Create a new EU database, deploy a Kunla on it, then [move your data](#backups-and-moving) with export and import.

## First setup

1. Open `https://YOUR-KUNLA/app/`. A fresh database shows the setup screen.
2. Enter your name, a workspace name and its short key (like `ACME`; it starts every full task key), and the setup token.
3. Kunla shows **your personal token once**. Save it in a password manager: it signs you in on a new browser if sign-in with Google, Microsoft or email isn't set up.
4. Invite people from **Team → Add a person** and connect AIs from **Team → Connect an agent** (see [Connect your AI](connect-ai.md)).

You are now the Kunla's owner. Owners create more workspaces from the workspace menu; admins run one workspace (its people, roles and settings).

## Your own domain

- **Deploy by hand:** add `routes = [{ pattern = "kunla.example.com", custom_domain = true }]` under `compatibility_date` in `wrangler.toml` and deploy again.
- **GitHub Actions:** set the variable `KUNLA_DOMAIN`.

The domain's zone must be on the same Cloudflare account. Cloudflare creates the DNS record and certificate. If you change the domain later, claude.ai connectors and the GitHub App point at the old address, so connect them again.

## How people sign in

Agents always use tokens. For people there are several options, all optional, and the sign-in page shows a button for each one you turn on:

| Option | What you set up | Notes |
|---|---|---|
| Personal token | Nothing | Shown once at setup or when a person is added. Fine for small teams. |
| Google | OAuth client in Google Cloud, redirect `https://YOUR-KUNLA/auth/google/callback`; secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Only emails Google has verified count. |
| Microsoft (Entra ID) | App registration, redirect (Web) `https://YOUR-KUNLA/auth/microsoft/callback`; secrets `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` | Single tenant: set your tenant id. Several companies: register multi-tenant, leave `MICROSOFT_TENANT` out, and each workspace admin lists the tenants it trusts. Personal Microsoft accounts are not accepted that way. |
| GitHub | OAuth App, callback `https://YOUR-KUNLA/auth/github/callback`; secrets `GITHUB_LOGIN_CLIENT_ID`, `GITHUB_LOGIN_CLIENT_SECRET` | Matches any verified email on the GitHub account, or a linked GitHub login. |
| Email link | `MAIL_FROM` plus either `RESEND_API_KEY` (any plan) or a Cloudflare Email `send_email` binding named `EMAIL` (Workers Paid) | One-time link valid 15 minutes, up to 5 per hour per address. |

Set secrets with `npx wrangler secret put NAME` (or in the Cloudflare dashboard under the Worker's **Settings → Variables and Secrets**).

Then give each person their work email: **Team → Add a person**, or **Manage → Work email** for someone already there. Whoever signs in with a verified account for that email gets in as that person. Step-by-step console instructions for each provider are in the [main README](../README.md#deploy-to-your-cloudflare-account). SAML and automatic user provisioning (SCIM) are planned Enterprise features.

## Connect GitHub

Optional, for teams whose work includes code. In Kunla, **Team → Connect GitHub** (admins only) creates a GitHub App for your Kunla in a few clicks and lets you pick repositories. After that, pull requests and commits that mention a task key (`MKT-42`) update the task by themselves, and approving a task in Kunla can merge its pull request. Details: [main README](../README.md#connect-github).

## Upgrades

Kunla is released as tagged versions `vX.Y.Z` on [GitHub Releases](https://github.com/spikinglabs/kunla/releases), with notes in [CHANGELOG.md](../CHANGELOG.md). `https://YOUR-KUNLA/api/health` tells you which version you run.

- **Automatic (recommended with GitHub Actions):** the included **Upgrade Kunla** workflow runs every Monday. It brings the newest release into your copy (keeping your database id, domain and placement), runs the tests, deploys, and checks the new version answers at `KUNLA_URL`. If anything fails, it rolls back or pushes nothing, and opens an issue. Turn it off with the variable `KUNLA_AUTO_UPGRADE=false`, or run it by hand from the Actions tab and name a release.
- **By hand:** pull the release you want into your copy and run `npm run deploy`.
- **Rolling back:** database migrations only ever add tables or columns, so `npx wrangler rollback` to the previous Worker version is safe.

## Staging and production

If you change Kunla's code or want to see releases before your team does, run two copies: a **staging** copy that takes every change, and a **production** copy that only takes releases.

- Make the staging copy a separate Worker with its own database, and set `KUNLA_ENV=staging` so every page shows a "Staging" ribbon and `/api/health` reports it.
- Deploy production only from release tags (or let the Upgrade workflow do it).

This is how Spiking Labs runs Kunla: every merge to `main` deploys staging at kunla.lab.spikinglabs.com, and Kunla Cloud at kunla.app only takes releases.

## Backups and moving

An admin can download a whole workspace from **Projects → Settings for everything → Download everything** (or `GET /api/export` with an admin token). The JSON file holds projects, tasks, history, reviews, rules, people, agents and their tokens. Keep it somewhere safe: it contains tokens.

To restore or move to another Kunla:

```sh
curl -X POST https://new-kunla.example.com/api/import -H 'content-type: application/json' \
  -H 'x-kunla-setup-token: YOUR_SETUP_TOKEN' --data-binary @kunla-export.json
```

On a fresh Kunla the setup token is enough and the workspace becomes its first; on a Kunla in use, send an admin's token (`-H 'authorization: Bearer kun_...'`) and it is added as another workspace. Task keys, links and tokens keep working, so agents only need the new address. Reconnect the GitHub App and claude.ai connectors afterwards.

Cloudflare also keeps D1's own point-in-time history ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)), which lets you restore the database to any minute in the last 30 days (7 on the free plan).

## Other hosting (AWS and Docker)

Kunla currently runs only on Cloudflare. Running it elsewhere is **not built yet**, but it has been looked at:

- The record-of-work logic is plain SQL with no Cloudflare-only features, and the test suite already runs Kunla on Node.js with SQLite.
- A review in November 2026 found AWS feasible as **one Docker container (Node.js + SQLite on EFS) on ECS Fargate behind an Application Load Balancer**, with sign-in through the load balancer or Kunla's own Google/Microsoft sign-in. Estimated effort is two to three days.
- Not supported today: Docker images, Postgres, or AWS templates.

If you need this, say so on [GitHub issues](https://github.com/spikinglabs/kunla/issues): demand decides when it gets built. Until then, Cloudflare with an [EU database](#keep-your-data-in-the-eu) or Kunla Cloud are the options.

## Optional settings

| Setting | Where | What it does |
|---|---|---|
| `LEASE_MINUTES` | `wrangler.toml` `[vars]` | How long an AI's claim on a task lives without an update (default 30) |
| `KUNLA_USAGE_PING` | `[vars]` or repository variable | `on` sends Spiking Labs one anonymous message a day (a random id, version and five counts, no names or content). Off unless you turn it on; admins see exactly what it sends at `/api/ping/preview` |
| `KUNLA_LICENSE` | secret | An Enterprise licence key; without one Kunla runs as Community |

## Troubleshooting

- **The setup screen says the token is wrong.** It must match `SETUP_TOKEN` exactly. Set it again with `npx wrangler secret put SETUP_TOKEN` and retry.
- **"database_id" errors on deploy.** `wrangler.toml` still has `REPLACE_WITH_YOUR_D1_ID`; put in your database id, or set `KUNLA_D1_ID` for GitHub Actions.
- **Pages are slow right after a deploy.** Smart Placement can take about 15 minutes to settle next to the database.
- **A Google/Microsoft sign-in says no account.** An admin must first give that person their work email in Kunla.
- **Which version am I on?** Open `/api/health`.

Still stuck? Open an [issue](https://github.com/spikinglabs/kunla/issues). Report security problems privately as described in [SECURITY.md](../SECURITY.md).
