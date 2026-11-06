# Kunla Enterprise

Code in this folder is **not** under the Apache-2.0 license that covers the rest of the repository. It is source-available under the Kunla Enterprise License (see `LICENSE` in this folder) and requires a commercial agreement for production use.

Planned here (nothing yet in v1):

- SSO (SAML, OIDC) and SCIM provisioning
- Audit log export
- Policies: which AIs may join, which data they may see, approval rules
- Data residency and Postgres for large installs

The Apache-2.0 core never imports from `ee/`. Enterprise features plug in through the same interfaces the core exposes.
