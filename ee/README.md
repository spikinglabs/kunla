# Kunla Enterprise

Code in this folder is **not** under the Apache-2.0 license that covers the rest of the repository. It is source-available under the Kunla Enterprise License (see `LICENSE` in this folder) and requires a commercial agreement for production use.

Planned here (nothing yet; code lands only once the licence terms are final, KD-76):

- SSO (SAML, OIDC) and SCIM provisioning
- Audit log export
- Policies: which AIs may join, which data they may see, approval rules
- Data residency and Postgres for large installs

## How ee/ plugs into the core

The Apache-2.0 core never imports from `ee/`. It exposes plug-in points in `src/extensions.ts`, and enterprise code registers into them from its own Worker entry:

```ts
// ee/worker.ts (set `main = "ee/worker.ts"` in wrangler.toml to run the Enterprise edition)
import kunla from '../src/index';
import { register } from '../src/extensions';
import { oktaSignIn } from './sso/okta';
import { splunkAudit } from './audit/splunk';
import { agentAllowList } from './policies/agents';

register({ signIn: [oktaSignIn], audit: [splunkAudit], policies: [agentAllowList] });
export default kunla;
```

| Plug-in point | What the core does with it |
|---|---|
| `Policy` | Asked before a member is added, a workspace is created and an agent or person claims a task; a sentence refuses the action and is shown to whoever tried. |
| `AuditSink` | Gets every new event of the record (with task key and actor) from the daily cron, oldest first, in batches; a failed send is retried from the same place. |
| `SignInProvider` | Handles `/auth/<id>/...`; returns the member to sign in, and Kunla issues a token and opens the web app. Listed by `GET /api/edition` for the sign-in page. |
| Seats | A licence's `seats` limits how many people the Kunla has; AI members are always free. Enforced in the core. |

Each extension names a licence feature (`sso`, `audit`, `policies`, ...) and runs only when the licence includes it. With no licence, every Kunla is the complete Community edition, whatever is registered.

## Licence keys

Set the key as a secret: `npx wrangler secret put KUNLA_LICENSE`. A key is a signed statement (licensee, features, seats, expiry), checked offline against Spiking Labs' public key in `src/licence.ts`; Kunla never phones home. `GET /api/edition` shows what a copy runs and, for a key that doesn't count, why. Kunla Cloud sets the same kind of key per team.

Spiking Labs makes keys with `node scripts/licence.mjs keygen` (once; the private key stays in a password manager) and `node scripts/licence.mjs sign`.
